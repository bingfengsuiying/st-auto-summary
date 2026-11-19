/**
 * 剧情自动总结 / Auto Summary  v1.1
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
    findLatestSummaryEntry,
    getFreeUid,
    hashString,
    isSummaryEntry,
    makeSummaryEntry,
    manualRange,
    normalizeSettings,
    parseSummaryEntry,
    pruneSummaryEntries,
    sanitizeBookName,
    stripSummaryHeader,
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

    pruneSummaryEntries(data, settings.keepSmall, { keepBigUid: action.kind === 'big' ? uid : null, protectUids: [uid] });

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

async function markState(action, endUsed, book) {
    const state = getState();
    if (action.kind === 'big') {
        state.lastBigAt = Math.max(state.lastBigAt, endUsed);
    } else {
        state.lastSmallAt = Math.max(state.lastSmallAt, endUsed);
        state.smallSeq += 1;
    }
    state.lastKind = action.kind;
    state.lastAt = Date.now();
    state.book = book;
    await persistMetadata();
}

/**
 * 调用模型生成一段总结（不写世界书）。
 * @param {{kind:'small'|'big', start:number, end:number}} action
 * @param {{includePrevious?: boolean}} [options]
 */
async function generateForRange(action, { includePrevious = false } = {}) {
    const context = getCtx();
    const settings = getSettings();
    const book = await resolveBook();

    const transcript = buildTranscript(context.chat, action.start, action.end, {
        maxChars: settings.maxInputChars,
        defaultName: getEntityName(),
    });

    if (!transcript.text) {
        throw new Error('这段聊天没有可总结的正文');
    }

    notify('info', action.kind === 'big' ? '正在生成剧情大总结…' : '正在生成剧情小总结…');

    const previous = includePrevious && action.kind === 'big' ? await readBigSummary(book) : '';
    const prompt = action.kind === 'big'
        ? buildBigPrompt({ start: action.start, end: action.end, transcript: transcript.text, previous })
        : buildSmallPrompt({ start: action.start, end: action.end, transcript: transcript.text });

    const raw = await callModel(prompt, action.kind);
    const content = cleanSummary(raw, action.kind === 'big' ? 1000 : 500);
    if (!content) {
        throw new Error('模型没有返回有效内容');
    }

    return { book, action, content, transcript };
}

/**
 * 自动总结：生成后直接写入世界书。
 * @param {{kind:'small'|'big', start:number, end:number}} action
 */
async function runSummary(action, { auto = false } = {}) {
    if (!action || busy) {
        return false;
    }

    const context = getCtx();
    if (!context || !Array.isArray(context.chat) || context.chat.length === 0) {
        return false;
    }

    busy = true;
    try {
        const generated = await generateForRange(action, { includePrevious: action.kind === 'big' });
        await writeSummaryEntry(generated.book, action, generated.content);

        await markState(action, action.end, generated.book);
        refreshStatus();

        notify('success', `${action.kind === 'big' ? '大' : '小'}总结完成（第 ${action.start + 1}-${action.end} 条），已写入《${generated.book}》`);
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

/* ------------------------------- 手动总结的弹窗 ------------------------------- */

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function waitForPopupElement(selector, callback, attempts = 15) {
    let tries = 0;
    const tick = () => {
        const element = document.querySelector(selector);
        if (element) {
            callback(element);
            return;
        }
        if (tries++ < attempts) {
            setTimeout(tick, 100);
        }
    };
    tick();
}

/**
 * 手动总结第一步：选择楼层范围。
 * @param {'small'|'big'} kind
 * @param {number} total
 * @returns {Promise<{kind:'small'|'big', start:number, end:number}|null>}
 */
async function openRangeDialog(kind, total) {
    const context = getCtx();
    const suggested = manualRange(kind, total, getState());
    const defaultStart = Math.min(total, (suggested ? suggested.start : total - 1) + 1);
    const defaultEnd = total;
    const draft = { start: defaultStart, end: defaultEnd };

    if (!context?.callGenericPopup || !context?.POPUP_TYPE) {
        return { kind, start: defaultStart - 1, end: defaultEnd };
    }

    const html = `
        <div class="as-dialog">
            <div class="as-dialog-info">共 ${total} 条消息，选择要总结的楼层（从 1 开始，含首尾）。</div>
            <div class="as-dialog-row">
                <label>起始楼层
                    <input type="number" id="as_range_start" class="text_pole as-num" min="1" max="${total}" step="1" inputmode="numeric" value="${defaultStart}">
                </label>
                <label>结束楼层
                    <input type="number" id="as_range_end" class="text_pole as-num" min="1" max="${total}" step="1" inputmode="numeric" value="${defaultEnd}">
                </label>
            </div>
            <div class="as-dialog-preview" id="as_range_preview">将总结第 ${defaultStart}-${defaultEnd} 条，共 ${defaultEnd - defaultStart + 1} 条</div>
        </div>`;

    const promise = context.callGenericPopup(html, context.POPUP_TYPE.CONFIRM, '', {
        okButton: '开始总结',
        cancelButton: '取消',
        wide: true,
    });

    waitForPopupElement('#as_range_start', (startEl) => {
        const endEl = document.getElementById('as_range_end');
        const preview = document.getElementById('as_range_preview');
        if (!endEl) {
            return;
        }

        const update = () => {
            draft.start = Number(startEl.value);
            draft.end = Number(endEl.value);
            const valid = Number.isInteger(draft.start) && Number.isInteger(draft.end)
                && draft.start >= 1 && draft.end <= total && draft.start <= draft.end;

            if (preview) {
                preview.textContent = valid
                    ? `将总结第 ${draft.start}-${draft.end} 条，共 ${draft.end - draft.start + 1} 条`
                    : `请输入 1-${total} 之间的有效范围`;
                preview.classList.toggle('as-invalid', !valid);
            }
        };

        startEl.addEventListener('input', update);
        endEl.addEventListener('input', update);
        update();
    });

    const result = await promise;
    if (result !== (context.POPUP_RESULT?.AFFIRMATIVE ?? 1)) {
        return null;
    }

    const { start, end } = draft;
    const valid = Number.isInteger(start) && Number.isInteger(end)
        && start >= 1 && end <= total && start <= end;

    if (!valid) {
        notify('error', `范围不合法，请输入 1-${total} 之间的楼层`);
        return null;
    }

    return { kind, start: start - 1, end };
}

/**
 * 手动总结第三步：展示生成内容，选择替换 / 融合 / 取消。
 * @param {{book:string, action:{kind:'small'|'big', start:number, end:number}, content:string}} generated
 * @returns {Promise<{mode:'replace'|'merge'|'cancel', text:string}>}
 */
async function openResultDialog(generated) {
    const context = getCtx();
    const target = findLatestSummaryEntry(await loadBook(generated.book), generated.action.kind);
    const draft = { text: generated.content };

    const targetLine = target
        ? `已有同类总结：${target.entry.comment}`
        : '当前没有同类总结，保存时会新建一条。';
    const hintLine = target
        ? '“替换总结”会用上面的内容覆盖它；“融合总结”会把旧内容和新内容合并成一条。'
        : '“替换总结”和“融合总结”都会新建一条。';

    if (!context?.callGenericPopup || !context?.POPUP_TYPE) {
        const ok = globalThis.confirm?.(`${targetLine}\n\n${generated.content}`);
        return ok ? { mode: 'replace', text: generated.content } : { mode: 'cancel', text: generated.content };
    }

    const html = `
        <div class="as-dialog">
            <div class="as-dialog-info">本次范围：第 ${generated.action.start + 1}-${generated.action.end} 条\n${escapeHtml(targetLine)}</div>
            <textarea id="as_result_text" class="text_pole as-result-text" rows="10" spellcheck="false">${escapeHtml(generated.content)}</textarea>
            <div class="as-dialog-preview">${escapeHtml(hintLine)}</div>
        </div>`;

    const customResult = context.POPUP_RESULT?.CUSTOM1 ?? 1001;
    const affirmative = context.POPUP_RESULT?.AFFIRMATIVE ?? 1;

    const promise = context.callGenericPopup(html, context.POPUP_TYPE.TEXT, '', {
        okButton: '替换总结',
        cancelButton: '取消总结',
        customButtons: [{ text: '融合总结', result: customResult }],
        wide: true,
    });

    waitForPopupElement('#as_result_text', (textarea) => {
        draft.text = textarea.value;
        textarea.addEventListener('input', () => {
            draft.text = textarea.value;
        });
    });

    const result = await promise;
    if (result === customResult) {
        return { mode: 'merge', text: draft.text };
    }
    if (result === affirmative) {
        return { mode: 'replace', text: draft.text };
    }
    return { mode: 'cancel', text: draft.text };
}

/**
 * 应用手动总结的结果。
 */
async function applyManualSummary(generated, decision) {
    const context = getCtx();
    const settings = getSettings();
    const { book, action, content } = generated;
    const text = String(decision.text ?? '').trim() || content;
    const data = await loadBook(book);
    const target = findLatestSummaryEntry(data, action.kind);

    let uid;
    let finalStart = action.start;
    let finalEnd = action.end;

    if (target && decision.mode === 'replace') {
        uid = target.uid;
        Object.assign(target.entry, makeSummaryEntry({
            uid,
            kind: action.kind,
            start: action.start,
            end: action.end,
            content: text,
            settings,
        }));
    } else if (target && decision.mode === 'merge') {
        uid = target.uid;
        const oldBody = stripSummaryHeader(target.entry.content);
        finalStart = Math.min(target.meta.start, action.start);
        finalEnd = Math.max(target.meta.end, action.end);
        const merged = oldBody ? `${oldBody}\n\n${text}` : text;

        Object.assign(target.entry, makeSummaryEntry({
            uid,
            kind: action.kind,
            start: finalStart,
            end: finalEnd,
            content: merged,
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
            content: text,
            settings,
        });
    }

    pruneSummaryEntries(data, settings.keepSmall, { keepBigUid: action.kind === 'big' ? uid : null, protectUids: [uid] });

    await context?.saveWorldInfo?.(book, data, true);
    context?.updateWorldInfoList?.();

    await markState(action, finalEnd, book);
    refreshStatus();

    const actionText = decision.mode === 'merge' ? '已融合' : target ? '已替换' : '已保存';
    notify('success', `${actionText}${action.kind === 'big' ? '大' : '小'}总结（第 ${finalStart + 1}-${finalEnd} 条）→《${book}》`);
}

async function runManual(kind) {
    if (busy) {
        notify('info', '正在总结中，请稍候');
        return false;
    }
    if (isGenerating()) {
        notify('info', '酒馆正在生成，请稍后再试');
        return false;
    }

    const context = getCtx();
    const total = context?.chat?.length ?? 0;
    if (!total) {
        notify('info', '当前没有聊天消息');
        return false;
    }

    if (!getSettings().enabled) {
        notify('info', '提示：自动总结开关是关的，本次只做手动总结');
    }

    busy = true;
    try {
        const action = await openRangeDialog(kind, total);
        if (!action) {
            return false;
        }

        const generated = await generateForRange(action, { includePrevious: false });
        const decision = await openResultDialog(generated);

        if (!decision || decision.mode === 'cancel') {
            notify('info', '已取消，本次总结没有写入世界书');
            return false;
        }

        await applyManualSummary(generated, decision);
        return true;
    } catch (error) {
        console.error(LOG_PREFIX, '手动总结失败', error);
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
