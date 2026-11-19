/**
 * 剧情自动总结 / Auto Summary  v1.0
 *
 * 每 N 条聊天做一次小总结，每 M 条做一次大总结，并写入当前聊天绑定的世界书，
 * 作为常驻条目辅助后续生成。
 *
 * - 只统计真实聊天消息，跳过已排除（is_system）的消息
 * - 大总结会合并上一份大总结，形成滚动的主线梗概
 * - 自动创建并绑定聊天世界书（没有的话），不污染全局世界书
 * - 兼容 SillyTavern 1.13.x ~ 1.18.x，桌面与手机
 */

import {
    DEFAULT_SETTINGS,
    MODULE_ID,
    SYSTEM_PROMPT,
    buildBigPrompt,
    buildSmallPrompt,
    buildTranscript,
    cleanSummary,
    decideAction,
    getFreeUid,
    hashString,
    isSummaryEntry,
    makeSummaryEntry,
    manualRange,
    normalizeSettings,
    parseSummaryEntry,
    pruneSummaryEntries,
    sanitizeBookName,
} from './core.js';

const LOG_PREFIX = '[剧情自动总结]';
const STATE_KEY = 'st_auto_summary';
const BOOK_PREFIX = '自动总结';

/** @type {(() => any)|null} */
let contextGetter = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let scheduleTimer = null;
let busy = false;
let errorCooldownUntil = 0;

/* ---------------------------------- 环境 ---------------------------------- */

function isTouchDevice() {
    try {
        return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
    } catch {
        return window.innerWidth <= 768;
    }
}

function getCtx() {
    try {
        if (contextGetter) {
            return contextGetter();
        }
        return globalThis.SillyTavern?.getContext?.() ?? null;
    } catch (error) {
        console.warn(LOG_PREFIX, '无法获取 SillyTavern 上下文', error);
        return null;
    }
}

async function resolveContext() {
    if (typeof globalThis.SillyTavern?.getContext === 'function') {
        contextGetter = () => globalThis.SillyTavern.getContext();
        return true;
    }

    try {
        const path = ['..', '..', '..', 'st-context.js'].join('/');
        const module = await import(/* @vite-ignore */ path);
        if (typeof module?.getContext === 'function') {
            contextGetter = module.getContext;
            return true;
        }
    } catch (error) {
        console.warn(LOG_PREFIX, '动态加载 st-context.js 失败', error);
    }

    return false;
}

function notify(type, message) {
    const toastr = globalThis.toastr;
    const handler = toastr?.[type] ?? toastr?.info;
    if (typeof handler === 'function') {
        handler(message);
    }
}

/* ---------------------------------- 设置与状态 ---------------------------------- */

function getSettings() {
    const store = getCtx()?.extensionSettings;
    if (!store) {
        return { ...DEFAULT_SETTINGS };
    }

    if (!store[MODULE_ID] || typeof store[MODULE_ID] !== 'object') {
        store[MODULE_ID] = { ...DEFAULT_SETTINGS };
    }

    const normalized = normalizeSettings(store[MODULE_ID]);
    Object.assign(store[MODULE_ID], normalized);
    return store[MODULE_ID];
}

function persistSettings() {
    try {
        getCtx()?.saveSettingsDebounced?.();
    } catch (error) {
        console.warn(LOG_PREFIX, '保存设置失败', error);
    }
}

function freshState() {
    return { lastSmallAt: 0, lastBigAt: 0, smallSeq: 0, lastKind: '', lastAt: 0, book: '' };
}

function getState() {
    const context = getCtx();
    const metadata = context?.chatMetadata;
    if (!metadata || typeof metadata !== 'object') {
        return freshState();
    }

    if (!metadata[STATE_KEY] || typeof metadata[STATE_KEY] !== 'object') {
        metadata[STATE_KEY] = freshState();
    }

    const state = metadata[STATE_KEY];
    state.lastSmallAt = Math.max(0, Number(state.lastSmallAt) || 0);
    state.lastBigAt = Math.max(0, Number(state.lastBigAt) || 0);
    state.smallSeq = Math.max(0, Number(state.smallSeq) || 0);
    state.lastKind = state.lastKind === 'big' ? 'big' : state.lastKind === 'small' ? 'small' : '';
    state.lastAt = Math.max(0, Number(state.lastAt) || 0);
    state.book = typeof state.book === 'string' ? state.book : '';

    const chatLength = Array.isArray(context.chat) ? context.chat.length : 0;
    // 聊天被删短（回溯 / 清空）时把进度收回来，避免永远不再触发
    if (chatLength + 5 < state.lastBigAt) {
        state.lastBigAt = chatLength;
        state.lastSmallAt = Math.min(state.lastSmallAt, chatLength);
    } else if (chatLength + 5 < state.lastSmallAt) {
        state.lastSmallAt = chatLength;
    }

    return state;
}

async function persistMetadata() {
    const context = getCtx();
    try {
        await context?.saveMetadata?.();
    } catch (error) {
        console.warn(LOG_PREFIX, '保存聊天元数据失败', error);
    }
}

/* ---------------------------------- 世界书 ---------------------------------- */

function getEntityName() {
    const context = getCtx();
    if (!context) {
        return '聊天';
    }

    if (context.groupId) {
        const group = context.groups?.find?.((item) => item.id === context.groupId);
        if (group?.name) {
            return group.name;
        }
    }

    const character = context.characters?.[context.characterId];
    return character?.name || context.name2 || '聊天';
}

function buildBookName() {
    const context = getCtx();
    const chatId = context?.getCurrentChatId?.() || '';
    if (!chatId) {
        return '';
    }
    return sanitizeBookName(`${BOOK_PREFIX} - ${getEntityName()} - ${hashString(chatId)}`);
}

async function ensureBook(name) {
    const context = getCtx();
    if (!name) {
        return null;
    }

    const existing = await context?.loadWorldInfo?.(name);
    if (existing) {
        return existing;
    }

    const data = { entries: {} };
    await context?.saveWorldInfo?.(name, data, true);
    return data;
}

/**
 * 决定总结写到哪本书：
 * - 设置里指定了书 → 用它
 * - 聊天已绑定世界书 → 写进去
 * - 否则创建一本「自动总结 - 角色 - hash」并绑定到聊天
 */
async function resolveBook({ create = true } = {}) {
    const context = getCtx();
    const settings = getSettings();

    if (settings.customBook) {
        if (create) {
            await ensureBook(settings.customBook);
        }
        return settings.customBook;
    }

    const bound = context?.chatMetadata?.world_info;
    if (bound && typeof bound === 'string') {
        if (create) {
            await ensureBook(bound);
        }
        return bound;
    }

    if (!create) {
        return '';
    }

    const name = buildBookName();
    if (!name) {
        throw new Error('当前聊天还没有保存，无法创建世界书');
    }

    await ensureBook(name);

    if (context.chatMetadata) {
        context.chatMetadata.world_info = name;
        await persistMetadata();
        // 和酒馆自带的“聊天世界书”按钮保持一致的状态
        try {
            $('.chat_lorebook_button').addClass('world_set');
        } catch {
            /* 忽略 UI 细节 */
        }
    }
    context.updateWorldInfoList?.();

    return name;
}

async function loadBook(book) {
    const context = getCtx();
    const data = await context?.loadWorldInfo?.(book);
    if (!data || typeof data !== 'object') {
        return { entries: {} };
    }
    if (!data.entries || typeof data.entries !== 'object') {
        data.entries = {};
    }
    return data;
}

async function readBigSummary(book) {
    const data = await loadBook(book);
    let best = null;

    for (const entry of Object.values(data.entries)) {
        const meta = parseSummaryEntry(entry);
        if (meta?.kind === 'big' && (!best || meta.end > best.end)) {
            best = { ...meta, content: String(entry.content ?? '') };
        }
    }

    if (!best) {
        return '';
    }

    return best.content.replace(/^【剧情大总结[^\n]*】\n?/, '').trim();
}

async function writeSummaryEntry(book, action, content) {
    const context = getCtx();
    const settings = getSettings();
    const data = await loadBook(book);

    // 同一范围重复总结（例如清理状态后又手动跑一次）时更新原条目，避免堆重复
    const duplicate = Object.values(data.entries).find((entry) => {
        const meta = parseSummaryEntry(entry);
        return meta && meta.kind === action.kind && meta.start === action.start && meta.end === action.end;
    });

    let uid;
    if (duplicate) {
        uid = Number(duplicate.uid);
        Object.assign(duplicate, makeSummaryEntry({
            uid,
            kind: action.kind,
            start: action.start,
            end: action.end,
            content,
            settings,
        }));
    } else {
        uid = getFreeUid(data.entries);
        if (uid === null) {
            throw new Error('世界书条目数量已满');
        }

        data.entries[uid] = makeSummaryEntry({
            uid,
            kind: action.kind,
            start: action.start,
            end: action.end,
            content,
            settings,
        });
    }

    pruneSummaryEntries(data, settings.keepSmall, { keepBigUid: action.kind === 'big' ? uid : null });

    await context?.saveWorldInfo?.(book, data, true);
    context?.updateWorldInfoList?.();

    return uid;
}

/* ---------------------------------- 总结流程 ---------------------------------- */

function isGenerating() {
    return document.body?.dataset?.generating === 'true';
}

async function callModel(prompt, kind) {
    const context = getCtx();
    if (typeof context?.generateRaw !== 'function') {
        throw new Error('当前酒馆版本不支持静默生成，请升级到 1.13 以上');
    }

    const raw = await context.generateRaw({
        prompt,
        systemPrompt: SYSTEM_PROMPT,
        responseLength: kind === 'big' ? 900 : 500,
        trimNames: false,
    });

    return String(raw ?? '');
}

/**
 * @param {{kind:'small'|'big', start:number, end:number}} action
 */
async function runSummary(action, { auto = false } = {}) {
    if (!action || busy) {
        return false;
    }

    const context = getCtx();
    const settings = getSettings();
    if (!context || !Array.isArray(context.chat) || context.chat.length === 0) {
        return false;
    }

    busy = true;
    try {
        const book = await resolveBook();
        const transcript = buildTranscript(context.chat, action.start, action.end, {
            maxChars: settings.maxInputChars,
            defaultName: getEntityName(),
        });

        if (!transcript.text) {
            throw new Error('这段聊天没有可总结的正文');
        }

        notify('info', action.kind === 'big' ? '正在生成剧情大总结…' : '正在生成剧情小总结…');

        const previous = action.kind === 'big' ? await readBigSummary(book) : '';
        const prompt = action.kind === 'big'
            ? buildBigPrompt({ start: action.start, end: action.end, transcript: transcript.text, previous })
            : buildSmallPrompt({ start: action.start, end: action.end, transcript: transcript.text });

        const raw = await callModel(prompt, action.kind);
        const content = cleanSummary(raw, action.kind === 'big' ? 1000 : 500);
        if (!content) {
            throw new Error('模型没有返回有效内容');
        }

        await writeSummaryEntry(book, action, content);

        const state = getState();
        if (action.kind === 'big') {
            state.lastBigAt = action.end;
        } else {
            state.lastSmallAt = action.end;
            state.smallSeq += 1;
        }
        state.lastKind = action.kind;
        state.lastAt = Date.now();
        state.book = book;
        await persistMetadata();

        refreshStatus();
        notify('success', `${action.kind === 'big' ? '大' : '小'}总结完成（第 ${action.start + 1}-${action.end} 条），已写入《${book}》`);
        return true;
    } catch (error) {
        console.error(LOG_PREFIX, '总结失败', error);
        errorCooldownUntil = Date.now() + 60000;
        notify('error', `剧情总结失败：${error?.message || error}`);
        return false;
    } finally {
        busy = false;
    }
}

function scheduleAuto(delay = 2500) {
    if (!getSettings().enabled) {
        return;
    }
    if (scheduleTimer) {
        clearTimeout(scheduleTimer);
    }
    scheduleTimer = setTimeout(() => {
        scheduleTimer = null;
        autoTick();
    }, delay);
}

async function autoTick() {
    if (!getSettings().enabled || busy) {
        return;
    }
    if (Date.now() < errorCooldownUntil) {
        return;
    }
    if (isGenerating()) {
        scheduleAuto(4000);
        return;
    }

    const context = getCtx();
    const settings = getSettings();
    const action = decideAction(context?.chat?.length ?? 0, getState(), settings);
    if (!action) {
        refreshStatus();
        return;
    }

    await runSummary(action, { auto: true });
}

async function runManual(kind) {
    const context = getCtx();
    const settings = getSettings();
    if (!settings.enabled) {
        notify('info', '请先打开「自动总结」开关，或直接点按钮也会执行一次');
    }
    if (busy) {
        notify('info', '正在总结中，请稍候');
        return;
    }

    const action = manualRange(kind, context?.chat?.length ?? 0, getState());
    if (!action) {
        notify('info', '没有新的聊天内容可以总结');
        return;
    }

    await runSummary(action, { auto: false });
}

async function clearSummaries() {
    const context = getCtx();
    const book = await resolveBook({ create: false });
    if (!book) {
        notify('info', '当前聊天还没有绑定世界书，也没有可清理的总结');
        return;
    }

    const data = await loadBook(book);
    let removed = 0;

    for (const [uid, entry] of Object.entries(data.entries)) {
        if (isSummaryEntry(entry)) {
            delete data.entries[uid];
            removed++;
        }
    }

    if (removed > 0) {
        await context?.saveWorldInfo?.(book, data, true);
        context?.updateWorldInfoList?.();
    }

    const state = getState();
    state.lastSmallAt = 0;
    state.lastBigAt = 0;
    state.smallSeq = 0;
    state.lastKind = '';
    state.lastAt = 0;
    state.book = book;
    await persistMetadata();
    refreshStatus();

    notify('success', removed > 0 ? `已删除 ${removed} 条总结条目（《${book}》）` : '这本书里没有本插件的总结条目');
}

/* ---------------------------------- 界面 ---------------------------------- */

function settingsHtml() {
    return `
        <div class="auto-summary">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>剧情自动总结</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label" for="as_enabled">
                        <input type="checkbox" id="as_enabled">
                        <span>自动生成剧情总结并写入世界书</span>
                    </label>

                    <div class="as-row">
                        <span>每</span>
                        <input type="number" id="as_small_every" class="text_pole" min="5" max="500" step="1" inputmode="numeric">
                        <span>条做一次小总结</span>
                    </div>
                    <div class="as-row">
                        <span>每</span>
                        <input type="number" id="as_big_every" class="text_pole" min="10" max="2000" step="1" inputmode="numeric">
                        <span>条做一次大总结</span>
                    </div>
                    <div class="as-row">
                        <span>世界书里保留最近</span>
                        <input type="number" id="as_keep_small" class="text_pole" min="0" max="20" step="1" inputmode="numeric">
                        <span>条小总结</span>
                    </div>

                    <label class="as-field" for="as_inject_mode">
                        <span>注入位置</span>
                        <select id="as_inject_mode" class="text_pole">
                            <option value="depth">聊天记录末尾（推荐）</option>
                            <option value="before">角色定义前</option>
                        </select>
                    </label>

                    <label class="as-field" for="as_custom_book">
                        <span>指定世界书（留空自动）</span>
                        <input type="text" id="as_custom_book" class="text_pole" placeholder="自动创建并绑定聊天世界书">
                    </label>

                    <div id="as_status" class="as-status">—</div>

                    <div class="as-actions">
                        <div id="as_manual_small" class="menu_button">立即小总结</div>
                        <div id="as_manual_big" class="menu_button">立即大总结</div>
                    </div>
                    <div class="as-actions">
                        <div id="as_clear" class="menu_button">清理总结条目</div>
                    </div>

                    <small class="as-hint">
                        总结会写进当前聊天绑定的世界书（没有就自动创建并绑定），以“常驻条目”注入提示词，不修改聊天记录。
                        生成总结会调用当前接口，消耗少量 token；大总结会合并上一份大总结。
                    </small>
                </div>
            </div>
        </div>
    `;
}

function menuHtml() {
    return `
        <div class="list-group-item flex-container flexGap5 interactable as-menu-item as-off" id="as_menu_toggle" title="剧情自动总结：点击开关">
            <div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div>
            <span id="as_menu_label">剧情总结：关闭</span>
        </div>
        <div class="list-group-item flex-container flexGap5 interactable as-menu-item" id="as_menu_small" title="立即生成一次小总结">
            <div class="fa-solid fa-pen-nib extensionsMenuExtensionButton"></div>
            <span id="as_menu_small_label">立即小总结</span>
        </div>
    `;
}

function updateMenuLabel() {
    const settings = getSettings();
    $('#as_menu_label').text(settings.enabled ? `剧情总结：开（${settings.smallEvery}/${settings.bigEvery}）` : '剧情总结：关闭');
    $('#as_menu_toggle').toggleClass('as-off', !settings.enabled);
}

async function refreshStatus() {
    const context = getCtx();
    const settings = getSettings();
    const length = context?.chat?.length ?? 0;
    const state = getState();
    const milestones = {
        small: settings.smallEvery ? Math.floor(length / settings.smallEvery) * settings.smallEvery : 0,
        big: settings.bigEvery ? Math.floor(length / settings.bigEvery) * settings.bigEvery : 0,
    };

    if (length === 0) {
        $('#as_status').text('当前没有聊天消息。');
        return;
    }

    const nextSmall = milestones.small + (settings.smallEvery || 50);
    const nextBig = milestones.big + (settings.bigEvery || 100);

    const parts = [
        `共 ${length} 条`,
        `下次小总结在 ${nextSmall} 条（还差 ${Math.max(0, nextSmall - length)}）`,
        `下次大总结在 ${nextBig} 条（还差 ${Math.max(0, nextBig - length)}）`,
    ];

    let book = settings.customBook || context?.chatMetadata?.world_info || state.book || '';
    let smallCount = 0;
    let bigCount = 0;

    if (book) {
        try {
            const data = await loadBook(book);
            for (const entry of Object.values(data.entries)) {
                const meta = parseSummaryEntry(entry);
                if (!meta) continue;
                if (meta.kind === 'big') bigCount++; else smallCount++;
            }
        } catch (error) {
            console.warn(LOG_PREFIX, '读取世界书状态失败', error);
        }
    }

    const bookText = book ? `世界书：《${book}》（小 ${smallCount} / 大 ${bigCount}）` : '世界书：首次总结时自动创建并绑定';

    let lastText = '';
    if (state.lastAt) {
        const time = new Date(state.lastAt).toLocaleTimeString();
        lastText = `上次：${state.lastKind === 'big' ? '大总结' : '小总结'} · ${time}`;
    }

    const text = [parts.join(' · '), bookText, lastText].filter(Boolean).join('\n');
    $('#as_status').text(text);
}

function bindSettingsUi() {
    const settings = getSettings();

    $('#as_enabled').prop('checked', settings.enabled).on('change', function () {
        const current = getSettings();
        current.enabled = Boolean(this.checked);
        persistSettings();
        updateMenuLabel();
        refreshStatus();

        if (current.enabled) {
            notify('info', `剧情自动总结已开启：每 ${current.smallEvery} 条小总结，每 ${current.bigEvery} 条大总结`);
            scheduleAuto(1200);
        }
    });

    const numberBindings = [
        ['#as_small_every', 'smallEvery'],
        ['#as_big_every', 'bigEvery'],
        ['#as_keep_small', 'keepSmall'],
    ];

    for (const [selector, key] of numberBindings) {
        $(selector).val(String(settings[key])).on('change blur', function () {
            const input = this.value;
            if (!/^\d+$/.test(String(input).trim())) {
                $(this).val(String(getSettings()[key]));
                return;
            }
            const current = getSettings();
            current[key] = Number(input);
            const normalized = normalizeSettings(current);
            Object.assign(current, normalized);
            $(this).val(String(current[key]));
            persistSettings();
            updateMenuLabel();
            refreshStatus();
        });
    }

    $('#as_inject_mode').val(settings.injectMode).on('change', function () {
        const current = getSettings();
        current.injectMode = this.value === 'before' ? 'before' : 'depth';
        persistSettings();
        refreshStatus();
    });

    $('#as_custom_book').val(settings.customBook).on('change blur', function () {
        const current = getSettings();
        current.customBook = String(this.value ?? '').trim();
        $(this).val(current.customBook);
        persistSettings();
        refreshStatus();
    });

    $('#as_manual_small').on('click', () => runManual('small'));
    $('#as_manual_big').on('click', () => runManual('big'));
    $('#as_clear').on('click', () => {
        clearSummaries().catch((error) => {
            console.error(LOG_PREFIX, error);
            notify('error', `清理失败：${error?.message || error}`);
        });
    });
}

function bindMenuEvents() {
    $('#as_menu_toggle')
        .off('click.autoSummary')
        .on('click.autoSummary', () => {
            const current = getSettings();
            current.enabled = !current.enabled;
            persistSettings();
            $('#as_enabled').prop('checked', current.enabled);
            updateMenuLabel();
            refreshStatus();
            if (current.enabled) {
                scheduleAuto(1200);
            }
        });

    $('#as_menu_small')
        .off('click.autoSummary')
        .on('click.autoSummary', () => runManual('small'));
}

function ensureMenuItems(attempt = 0) {
    if ($('#as_menu_toggle').length) {
        updateMenuLabel();
        return;
    }

    const menu = $('#extensionsMenu');
    if (!menu.length) {
        if (attempt < 40) {
            setTimeout(() => ensureMenuItems(attempt + 1), 250);
        }
        return;
    }

    menu.append(menuHtml());
    bindMenuEvents();
    updateMenuLabel();
}

function mountPanel() {
    const container = $('#extensions_settings');
    if (!container.length) {
        return false;
    }
    if ($('.auto-summary').length) {
        return true;
    }

    if (isTouchDevice()) {
        container.prepend(settingsHtml());
    } else {
        container.append(settingsHtml());
    }
    return true;
}

/* ---------------------------------- 事件 ---------------------------------- */

function registerEvents() {
    const context = getCtx();
    const eventSource = context?.eventSource;
    const eventTypes = context?.eventTypes ?? context?.event_types;

    if (!eventSource || !eventTypes) {
        console.warn(LOG_PREFIX, '事件系统不可用，只能手动点按钮总结');
        return;
    }

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => scheduleAuto(2500));
    eventSource.on(eventTypes.GENERATION_ENDED, () => scheduleAuto(3000));

    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        if (scheduleTimer) {
            clearTimeout(scheduleTimer);
            scheduleTimer = null;
        }
        refreshStatus();
        updateMenuLabel();
    });

    eventSource.on(eventTypes.APP_READY, () => {
        refreshStatus();
        ensureMenuItems();
    });
}

/* ---------------------------------- 启动 ---------------------------------- */

async function bootstrap() {
    const resolved = await resolveContext();
    if (!resolved) {
        console.error(LOG_PREFIX, '未找到 SillyTavern 上下文接口');
        notify('error', '剧情自动总结：未找到酒馆接口，请确认版本');
        return;
    }

    getSettings();

    if (!mountPanel()) {
        return;
    }

    bindSettingsUi();
    ensureMenuItems();
    updateMenuLabel();
    refreshStatus();
    registerEvents();

    console.debug(LOG_PREFIX, `已加载（${isTouchDevice() ? '移动端' : '桌面端'}）`);
}

jQuery(() => {
    bootstrap().catch((error) => {
        console.error(LOG_PREFIX, '初始化失败', error);
        notify('error', '剧情自动总结初始化失败，请查看控制台');
    });
});

// 调试接口
globalThis.autoSummary = {
    getSettings,
    getState,
    runManual,
    clearSummaries,
    resolveBook,
    writeSummaryEntry,
    decideAction,
    buildTranscript,
};
