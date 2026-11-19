/**
 * 剧情自动总结 - 纯逻辑层
 *
 * 不依赖 DOM / SillyTavern，方便单独测试：
 * - 里程碑判定（50 小总结 / 100 大总结）
 * - 聊天片段裁剪与提示词拼装
 * - 世界书条目构造、识别、清理
 */

export const MODULE_ID = 'st-auto-summary';
export const ENTRY_PREFIX = '[自动总结]';
export const AUTOMATION_ID = 'st-auto-summary';

export const DEFAULT_SETTINGS = {
    enabled: false,
    /** 每多少条消息做一次小总结 */
    smallEvery: 50,
    /** 每多少条消息做一次大总结 */
    bigEvery: 100,
    /** 世界书里最多保留几条小总结 */
    keepSmall: 3,
    /** depth = 聊天记录末尾；before = 角色定义前 */
    injectMode: 'depth',
    smallDepth: 4,
    bigDepth: 8,
    /** 留空表示自动创建并绑定聊天世界书 */
    customBook: '',
    /** 单次总结最多喂给模型多少字符 */
    maxInputChars: 8000,
};

function toInt(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.floor(number) : fallback;
}

export function clampInt(value, min, max, fallback) {
    const number = toInt(value, fallback);
    return Math.min(max, Math.max(min, number));
}

/**
 * 规范化设置，保证大小总结间隔合理。
 * @param {object} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };

    settings.enabled = Boolean(settings.enabled);
    settings.smallEvery = clampInt(settings.smallEvery, 5, 500, DEFAULT_SETTINGS.smallEvery);
    settings.bigEvery = clampInt(settings.bigEvery, 10, 2000, DEFAULT_SETTINGS.bigEvery);
    if (settings.bigEvery < settings.smallEvery) {
        settings.bigEvery = settings.smallEvery;
    }
    settings.keepSmall = clampInt(settings.keepSmall, 0, 20, DEFAULT_SETTINGS.keepSmall);
    settings.smallDepth = clampInt(settings.smallDepth, 0, 200, DEFAULT_SETTINGS.smallDepth);
    settings.bigDepth = clampInt(settings.bigDepth, 0, 200, DEFAULT_SETTINGS.bigDepth);
    settings.maxInputChars = clampInt(settings.maxInputChars, 1000, 60000, DEFAULT_SETTINGS.maxInputChars);
    settings.injectMode = settings.injectMode === 'before' ? 'before' : 'depth';
    settings.customBook = String(settings.customBook ?? '').trim();

    return settings;
}

/**
 * 计算当前聊天长度对应的里程碑。
 * @param {number} length
 * @param {number} smallEvery
 * @param {number} bigEvery
 */
export function computeMilestones(length, smallEvery, bigEvery) {
    const safeLength = Math.max(0, toInt(length, 0));
    const small = Math.max(0, toInt(smallEvery, DEFAULT_SETTINGS.smallEvery));
    const big = Math.max(small, toInt(bigEvery, DEFAULT_SETTINGS.bigEvery));

    return {
        small: small > 0 ? Math.floor(safeLength / small) * small : 0,
        big: big > 0 ? Math.floor(safeLength / big) * big : 0,
    };
}

/**
 * 决定这次该不该总结、总结哪一段。
 * 大总结优先；大总结已经覆盖的区间不再重复做小总结。
 *
 * @param {number} length 当前消息条数
 * @param {{lastSmallAt?: number, lastBigAt?: number}} state
 * @param {{smallEvery:number, bigEvery:number}} settings
 * @returns {{kind:'small'|'big', start:number, end:number}|null}
 */
export function decideAction(length, state = {}, settings = DEFAULT_SETTINGS) {
    const smallEvery = clampInt(settings.smallEvery, 5, 500, DEFAULT_SETTINGS.smallEvery);
    const bigEvery = Math.max(smallEvery, clampInt(settings.bigEvery, 10, 2000, DEFAULT_SETTINGS.bigEvery));
    const lastSmall = Math.max(0, toInt(state.lastSmallAt, 0));
    const lastBig = Math.max(0, toInt(state.lastBigAt, 0));
    const milestones = computeMilestones(length, smallEvery, bigEvery);

    if (milestones.big >= bigEvery && milestones.big > lastBig) {
        return { kind: 'big', start: lastBig, end: milestones.big };
    }

    const covered = Math.max(lastSmall, lastBig);
    if (milestones.small >= smallEvery && milestones.small > covered) {
        return { kind: 'small', start: covered, end: milestones.small };
    }

    return null;
}

/**
 * 手动总结的范围：从上次覆盖的位置到当前末尾。
 * @param {'small'|'big'} kind
 * @param {number} length
 * @param {{lastSmallAt?: number, lastBigAt?: number}} state
 */
export function manualRange(kind, length, state = {}) {
    const total = Math.max(0, toInt(length, 0));
    const lastSmall = Math.max(0, Math.min(toInt(state.lastSmallAt, 0), total));
    const lastBig = Math.max(0, Math.min(toInt(state.lastBigAt, 0), total));

    if (kind === 'big') {
        return total > lastBig ? { kind: 'big', start: lastBig, end: total } : null;
    }

    const start = Math.min(Math.max(lastSmall, lastBig), total);
    return total > start ? { kind: 'small', start, end: total } : null;
}

/* ---------------------------------- 文本处理 ---------------------------------- */

const ENTITY_MAP = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
};

/**
 * 去掉消息里的 HTML / 多余空白，保留可读文本。
 * @param {string} input
 */
export function stripHtml(input) {
    let text = String(input ?? '');
    text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
    text = text.replace(/<br\s*\/?>/gi, '\n');
    text = text.replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    text = text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (match) => ENTITY_MAP[match] ?? match);
    text = text.replace(/\r/g, '');
    text = text.replace(/[ \t]+\n/g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}

/**
 * 把一段聊天压成“名字：内容”的文本，并按字符上限裁剪。
 * 优先保留较新的消息；超长时前面的消息会被省略。
 *
 * @param {Array<object>} chat
 * @param {number} start 起始下标（含）
 * @param {number} end 结束下标（不含）
 * @param {{maxChars?: number, defaultName?: string}} [options]
 * @returns {{text: string, included: number, skipped: number, truncated: boolean}}
 */
export function buildTranscript(chat, start, end, { maxChars = 8000, defaultName = '角色' } = {}) {
    const list = Array.isArray(chat) ? chat : [];
    const from = Math.max(0, toInt(start, 0));
    const to = Math.min(list.length, Math.max(from, toInt(end, from)));
    const budget = clampInt(maxChars, 500, 60000, 8000);

    const items = [];
    let skipped = 0;

    for (let index = from; index < to; index++) {
        const message = list[index];
        if (!message || typeof message !== 'object' || message.is_system) {
            skipped++;
            continue;
        }
        const text = stripHtml(message.mes ?? '');
        if (!text) {
            skipped++;
            continue;
        }
        const name = String(message.name || defaultName).trim() || defaultName;
        items.push({ text: `${name}：${text}` });
    }

    if (items.length === 0) {
        return { text: '', included: 0, skipped, truncated: false };
    }

    const perMessageCap = Math.max(120, Math.min(800, Math.floor(budget / items.length)));

    // 从后往前装，保证最近的剧情优先保留
    const kept = [];
    let used = 0;
    let truncated = false;

    for (let i = items.length - 1; i >= 0; i--) {
        let line = items[i].text;
        if (line.length > perMessageCap) {
            line = `${line.slice(0, perMessageCap - 1)}…`;
            truncated = true;
        }
        const cost = line.length + 1;
        if (used + cost > budget && kept.length > 0) {
            truncated = true;
            skipped += (i + 1);
            break;
        }
        kept.push(line);
        used += cost;
    }

    kept.reverse();

    return {
        text: kept.join('\n'),
        included: kept.length,
        skipped,
        truncated,
    };
}

/**
 * 清理模型输出：去思考标签、标题、列表符号，限制长度。
 * @param {string} raw
 * @param {number} maxChars
 */
export function cleanSummary(raw, maxChars = 900) {
    let text = String(raw ?? '');

    text = text.replace(/<think[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '');
    text = text.replace(/^\s*(剧情)?(小|大)?总结\s*[:：]\s*/i, '');
    text = text.replace(/^#{1,6}\s*/gm, '');
    text = text.replace(/^\s*[-*•]\s+/gm, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    text = text.trim();

    // 去掉整体包裹的引号 / 代码块
    text = text.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
    text = text.replace(/^["“']([\s\S]*)["”']$/, '$1').trim();

    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars - 1)}…`;
    }

    return text;
}

/* ---------------------------------- 提示词 ---------------------------------- */

export const SYSTEM_PROMPT = '你是一个严谨的剧情记录员，只做客观压缩和归纳，不续写、不评价、不编造未出现的内容。';

export function buildSmallPrompt({ start, end, transcript }) {
    return [
        '请把下面这段角色扮演聊天压缩成一段“剧情小总结”，供后续写作参考。',
        '',
        '要求：',
        '- 使用与聊天相同的语言；',
        '- 250 字以内，第三人称，客观陈述；',
        '- 必须保留：关键事件与结果、人物关系或态度变化、承诺与约定、重要物品与地点、尚未解决的伏笔；',
        '- 不要评价、不要续写、不要编造未出现的内容；',
        '- 直接输出总结正文，不要标题、不要编号、不要列表符号。',
        '',
        `聊天片段（第 ${start + 1}-${end} 条）：`,
        transcript,
    ].join('\n');
}

export function buildBigPrompt({ start, end, transcript, previous = '' }) {
    return [
        '请把【已有大总结】和【最近的聊天片段】合并成一份新的“剧情大总结”，供后续写作参考。',
        '',
        '要求：',
        '- 使用与聊天相同的语言；',
        '- 500 字以内，第三人称；',
        '- 按时间顺序概括主线：起因、关键转折、当前局势、人物关系与动机、尚未解决的伏笔；',
        '- 保留已有大总结里仍然重要的信息，删掉已经过时的细节；',
        '- 不要评价、不要续写、不要编造未出现的内容；',
        '- 直接输出正文，不要标题、不要列表符号。',
        '',
        '【已有大总结】',
        previous.trim() ? previous.trim() : '（无）',
        '',
        `【聊天片段（第 ${start + 1}-${end} 条）】`,
        transcript,
    ].join('\n');
}

/* ---------------------------------- 世界书条目 ---------------------------------- */

/** 兼容 1.13 与 1.18 的条目字段（1.18 多出的字段在 1.13 里会被忽略） */
export function entryDefaults() {
    return {
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: true,
        vectorized: false,
        selective: false,
        selectiveLogic: 0,
        addMemo: false,
        order: 100,
        position: 4,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: true,
        preventRecursion: true,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: false,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: AUTOMATION_ID,
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
    };
}

export function summaryComment(kind, start, end) {
    return `${ENTRY_PREFIX}[${kind === 'big' ? '大' : '小'}] 第 ${start + 1}-${end} 条`;
}

/**
 * @param {{uid:number, kind:'small'|'big', start:number, end:number, content:string, settings:object}} args
 */
export function makeSummaryEntry({ uid, kind, start, end, content, settings }) {
    const isBig = kind === 'big';
    const title = isBig ? '剧情大总结' : '剧情小总结';
    const position = settings.injectMode === 'before' ? 0 : 4;
    const depth = isBig ? settings.bigDepth : settings.smallDepth;

    return {
        ...entryDefaults(),
        uid,
        comment: summaryComment(kind, start, end),
        content: `【${title} · 第 ${start + 1}-${end} 条】\n${content}`,
        position,
        depth,
        order: isBig ? 90 : 100,
    };
}

/**
 * @param {object} entry
 * @returns {{kind:'small'|'big', start:number, end:number}|null}
 */
export function parseSummaryEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }
    if (typeof entry.comment !== 'string' || !entry.comment.startsWith(ENTRY_PREFIX)) {
        return null;
    }

    const match = entry.comment.match(/\[(大|小)\][^\d]*(\d+)\s*-\s*(\d+)/);
    if (!match) {
        return null;
    }

    return {
        kind: match[1] === '大' ? 'big' : 'small',
        // 注释里写的是给人看的 1-based 序号，这里还原成 0-based 下标
        start: Math.max(0, Number(match[2]) - 1),
        end: Number(match[3]),
    };
}

export function isSummaryEntry(entry) {
    return parseSummaryEntry(entry) !== null;
}

/**
 * 去掉条目正文开头的【剧情小/大总结 · 第 x-y 条】标题，只留内容。
 * @param {string} content
 */
export function stripSummaryHeader(content) {
    return String(content ?? '').replace(/^【剧情(?:大|小)?总结[^\n]*】\n?/, '').trim();
}

/**
 * 找到某一类型（小/大）里结束范围最靠后的那条总结。
 * @param {{entries: Record<string, object>}} data
 * @param {'small'|'big'} kind
 * @returns {{uid: number, meta: {kind:'small'|'big', start:number, end:number}, entry: object}|null}
 */
export function findLatestSummaryEntry(data, kind) {
    const entries = data && typeof data === 'object' ? data.entries : null;
    if (!entries || typeof entries !== 'object') {
        return null;
    }

    let best = null;
    for (const [uid, entry] of Object.entries(entries)) {
        const meta = parseSummaryEntry(entry);
        if (!meta || meta.kind !== kind) {
            continue;
        }
        if (!best || meta.end > best.meta.end) {
            best = { uid: Number(uid), meta, entry };
        }
    }

    return best;
}

/**
 * 只保留最近 keepSmall 条小总结，以及唯一一条大总结。
 * 直接修改传入的 data.entries，并返回删除的 uid 列表。
 *
 * @param {{entries: Record<string, object>}} data
 * @param {number} keepSmall
 * @param {{keepBigUid?: number|null, protectUids?: number[]}} [options]
 * @returns {number[]}
 */
export function pruneSummaryEntries(data, keepSmall, { keepBigUid = null, protectUids = [] } = {}) {
    if (!data || typeof data !== 'object' || !data.entries) {
        return [];
    }

    const removed = [];
    const smalls = [];
    const bigs = [];
    const protectedSet = new Set((protectUids ?? []).map((uid) => Number(uid)));

    for (const [uid, entry] of Object.entries(data.entries)) {
        const meta = parseSummaryEntry(entry);
        if (!meta) {
            continue;
        }
        if (meta.kind === 'small') {
            smalls.push({ uid: Number(uid), end: meta.end, start: meta.start });
        } else {
            bigs.push({ uid: Number(uid), end: meta.end });
        }
    }

    smalls.sort((a, b) => a.end - b.end || a.uid - b.uid);
    const keep = clampInt(keepSmall, 0, 20, 3);
    const excess = Math.max(0, smalls.length - keep);
    const removable = smalls.filter((item) => !protectedSet.has(item.uid));
    for (const item of removable.slice(0, excess)) {
        removed.push(item.uid);
    }

    bigs.sort((a, b) => b.end - a.end || b.uid - a.uid);
    for (const item of bigs) {
        if (keepBigUid !== null && item.uid === keepBigUid) {
            continue;
        }
        if (keepBigUid === null && item.uid === bigs[0].uid) {
            continue;
        }
        removed.push(item.uid);
    }

    for (const uid of removed) {
        delete data.entries[uid];
    }

    return removed;
}

export function getFreeUid(entries) {
    const used = new Set(Object.keys(entries ?? {}).map((key) => Number(key)));
    for (let uid = 0; uid < 1000000; uid++) {
        if (!used.has(uid)) {
            return uid;
        }
    }
    return null;
}

/* ---------------------------------- 命名 ---------------------------------- */

export function sanitizeBookName(name) {
    return String(name ?? '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60) || '自动总结';
}

export function hashString(input) {
    let hash = 0;
    const text = String(input ?? '');
    for (let i = 0; i < text.length; i++) {
        hash = (hash * 31 + text.charCodeAt(i)) | 0;
    }
    // 取低位的 4 位 base36，避免只差一两个字符的聊天名取到相同前缀
    return (Math.abs(hash) >>> 0).toString(36).padStart(4, '0').slice(-4);
}
