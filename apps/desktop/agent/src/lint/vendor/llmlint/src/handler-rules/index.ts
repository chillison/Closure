import {isMasked} from "../markdown-mask";
import {visibleLength} from "../scan-context";
import type {HandlerFinding, HandlerScanContext, MaskedRange, RuleHandler} from "../types";

// 具名 handler 注册表：声明式模型表达不了的状态机/统计逻辑，编译进 skill 包分发。
// 全部纯函数，浏览器可打包；第三方规则包引用未注册的键名会在 loader 被跳过 + 诊断。
//
// 首批 4 个 handler 从 oh-story-claudecode/skills/story-deslop 的 check-ai-patterns.js
// 移植（MIT），阈值、排除矩阵与校准注释一并搬运。
// 校准基线（2026-07，story-deslop 原注释）：《万疆》真人正文 20 章 + demo 前 20 章；
// blocking 规则要求真人语料命中 ≈0。

/** handler 注册表：键名是规则 JSON 里 handler.name 的合法取值。 */
export const HANDLER_REGISTRY: Record<string, RuleHandler> = {
    "not-is-comparison": findNotIsComparisons,
    "period-stutter": findPeriodStutter,
    "overcompressed-prose": findOvercompressedProse,
    "low-connective-density": findLowConnectiveDensity,
    "quote-emphasis": findQuoteEmphasis,
    "long-paragraph": findLongParagraph,
};

// ---- 共享常量（移植自 check-ai-patterns.js）----

const STOP_CHARS = new Set(["。", "！", "？", "!", "?", "\n"]);
const SOFT_SEPARATORS = new Set(["，", ",", "、", "；", ";", "：", ":"]);
const HARD_SEPARATORS = new Set(["。", ".", "！", "!", "？", "?"]);
const MAX_NEGATIVE_SPAN = 80;
const MAX_POSITIVE_SPAN = 80;

// either-or「不是A就是B / 不是A也是B」里紧贴的「是」是连词的一部分，不是肯定项系动词。
// 含「不」以沿用「不是A，也不是B」第二个否定段不算翻转的旧排除。
const COMPACT_EITHER_OR_PREV = new Set(["不", "就", "也"]);
// 句尾语气/反问助词；「…，是吗 / 是吧 / 是嘛」是反问尾巴，不是否定后的肯定翻转。
const TAG_PARTICLES = new Set(["吗", "吧", "嘛"]);
// 段首确认语；「不是第一次来。是的，他还记得……」里的「是的/是啊」
// 是承接确认，不是「不是 A，是 B」的肯定翻转。
const AFFIRMATION_TAG_PARTICLES = new Set(["的", "啊", "呀", "呢"]);
const AFFIRMATION_TAG_BOUNDARY = new Set(["", "，", ",", "。", ".", "！", "!", "？", "?", "、", "；", ";", "：", ":", "\n", "\r", "\t", " "]);

// ---- not-is-comparison（blocking）----
// 「不是A，(而)是B」状态机：确认语/either-or/「X是」合成词/反问尾巴/跨空行揭示句
// 全套排除。引号内是台词/系统播报——口语里「不是A，是B」是自然辩解，不算叙述层
// AI 对比句式。校准：《万疆》20 章 ≈0 命中。

function findNotIsComparisons(ctx: HandlerScanContext): HandlerFinding[] {
    const text = ctx.view;
    const findings: HandlerFinding[] = [];
    let offset = 0;

    while (offset < text.length) {
        const start = text.indexOf("不是", offset);
        if (start === -1) {
            break;
        }
        // layer 由统一 scope view 处理；这里只保留「是不是」问句起头排除。
        if ((start > 0 && text[start - 1] === "是")) {
            offset = start + 2;
            continue;
        }

        const candidate = text.slice(start);
        const markerEnd = findPositiveFlipEnd(candidate);
        if (markerEnd === -1) {
            offset = start + 2;
            continue;
        }

        const raw = trimTrailingNoise(extractFinding(candidate, markerEnd));
        if (raw.length >= 4) {
            findings.push({index: start, length: raw.length});
        }
        offset = start + Math.max(raw.length, 2);
    }

    return findings;
}

/**
 * 从「不是」之后找肯定翻转「(而)是」的结束位置；找不到返回 -1。
 * 紧凑形态「不是A是B」只认第一分句（分隔符之前）——分隔符之后的「X是」多半是
 * 只是/可是/但是/还是/于是/倒是/总是 等连词的尾字，不是系动词（story-deslop
 * issue #166 误报类）。「，是 / ，而是」的分隔符邻接翻转由分隔符分支捕获。
 */
function findPositiveFlipEnd(candidate: string): number {
    let index = 2; // 跳过「不是」
    let scanned = 0;
    let crossedSeparator = false;

    while (index < candidate.length && scanned <= MAX_NEGATIVE_SPAN) {
        const char = candidate[index]!;

        if (startsWithAt(candidate, index, "而是")) {
            return index + 2;
        }

        if (SOFT_SEPARATORS.has(char)) {
            const next = skipGap(candidate, index + 1);
            if (startsWithAt(candidate, next, "而是")) {
                return next + 2;
            }
            if (candidate[next] === "是" && !TAG_PARTICLES.has(candidate[next + 1] ?? "") && !isAffirmationTagAt(candidate, next)) {
                return next + 1;
            }
            crossedSeparator = true;
        }

        if (HARD_SEPARATORS.has(char)) {
            const next = skipGap(candidate, index + 1);
            if (candidate[next] === "是" && !TAG_PARTICLES.has(candidate[next + 1] ?? "") && !isAffirmationTagAt(candidate, next)) {
                return next + 1;
            }
            if (char !== ".") {
                break;
            }
            crossedSeparator = true;
        }

        if (STOP_CHARS.has(char)) {
            break;
        }

        if (char === "是" && !COMPACT_EITHER_OR_PREV.has(candidate[index - 1] ?? "") && !crossedSeparator) {
            return index + 1;
        }

        index += 1;
        scanned += 1;
    }

    return -1;
}

function extractFinding(candidate: string, markerEnd: number): string {
    let end = markerEnd;
    const limit = Math.min(candidate.length, markerEnd + MAX_POSITIVE_SPAN);
    while (end < limit) {
        if (STOP_CHARS.has(candidate[end]!)) {
            break;
        }
        end += 1;
    }
    return candidate.slice(0, end);
}

function startsWithAt(text: string, index: number, needle: string): boolean {
    return text.slice(index, index + needle.length) === needle;
}

function isAffirmationTagAt(text: string, index: number): boolean {
    if (text[index] !== "是") {
        return false;
    }
    const particle = text[index + 1];
    if (particle === undefined || !AFFIRMATION_TAG_PARTICLES.has(particle)) {
        return false;
    }
    const boundary = text[index + 2] ?? "";
    return AFFIRMATION_TAG_BOUNDARY.has(boundary);
}

/** 跳过行内空白与换行（含空行）；「不是A。（空行）是B」这类分段揭示句也要抓到。 */
function skipGap(text: string, index: number): number {
    while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\r" || text[index] === "\n")) {
        index += 1;
    }
    return index;
}

function trimTrailingNoise(text: string): string {
    return text.replace(/[\s|）)】\]]+$/u, "");
}

// ---- period-stutter（advisory）----
// 碎句号：连续 STUTTER_MIN_RUN 个「叙述」短句（每句可见字数 ≤ STUTTER_MAX_SENTENCE）
// 无呼吸。只数引号外叙述句——纯对话/弹幕/系统播报成片短句是体裁正常形态（豁免并重
// 置计数）；「叙述 + 引号内物件/短台词」混合行的引号外叙述仍参与计数。

const STUTTER_MIN_RUN = 6;
const STUTTER_MAX_SENTENCE = 5;

function findPeriodStutter(ctx: HandlerScanContext): HandlerFinding[] {
    const findings: HandlerFinding[] = [];
    let run: Array<{start: number; end: number}> = [];

    const flush = () => {
        if (run.length >= STUTTER_MIN_RUN) {
            const first = run[0]!;
            const anchor = ctx.shortAnchor(first.start);
            if (!anchor) {
                run = [];
                return;
            }
            findings.push({
                index: anchor[0],
                length: anchor[1] - anchor[0],
                message: `连续 ${run.length} 个短句无呼吸`,
            });
        }
        run = [];
    };

    for (const line of ctx.lines) {
        const trimmed = line.text.trim();
        if (!trimmed) {
            continue; // 空行是一句一段排版，不打断叙述连贯
        }
        // 结构行 / 代码块等遮罩行：重置碎句计数
        if (line.structural || isMasked(line.start, ctx.maskedRanges)) {
            flush();
            continue;
        }
        const projection = ctx.projectLine(line);
        if (visibleLength(projection.text) === 0) {
            flush(); // 纯对话/弹幕/系统播报：成片短句是正常形态，重置碎句计数
            continue;
        }
        for (const sentence of splitSentenceSpans(projection.text)) {
            const visible = visibleLength(sentence.text);
            if (visible === 0) {
                continue;
            }
            if (visible <= STUTTER_MAX_SENTENCE) {
                run.push({
                    start: projection.map[sentence.start]!,
                    end: projection.map[sentence.end - 1]! + 1,
                });
            } else {
                flush();
            }
        }
    }
    flush();
    return findings;
}

// ---- overcompressed-prose（advisory，全文一条）----
// 过度精炼短段：长文本里 15 字以内叙述段过密，且「的/了/就/着/过/呢/吧/啊」等自然
// 连接偏少，读起来像处理过的梗概/分镜表。修法是通读后补断裂处，禁止机械注水。

const OVERCOMPRESSED_PARTICLE_PATTERN = /[的了就着过呢吧啊呀嘛]/g;
const OVERCOMPRESSED_MIN_CHARS = 1200;
const OVERCOMPRESSED_MIN_PARAS = 45;
const OVERCOMPRESSED_SHORT_MAX_CHARS = 15;
const OVERCOMPRESSED_SHORT_RATIO = 0.58;
const OVERCOMPRESSED_PARTICLE_PER_KILO = 85;

function findOvercompressedProse(ctx: HandlerScanContext): HandlerFinding[] {
    let narrativeChars = 0;
    let narrativeParas = 0;
    let shortParas = 0;
    let particles = 0;
    let anchor: number | null = null;

    for (const line of ctx.lines) {
        const trimmed = line.text.trim();
        if (!trimmed || line.structural || isMasked(line.start, ctx.maskedRanges) || /^【[^】]+】$/.test(trimmed)) {
            continue;
        }
        const projection = ctx.projectLine(line);
        const length = visibleLength(projection.text);
        if (length === 0) {
            continue;
        }
        if (anchor === null) {
            anchor = projection.map[0] ?? null;
        }
        narrativeParas += 1;
        narrativeChars += length;
        if (length <= OVERCOMPRESSED_SHORT_MAX_CHARS) {
            shortParas += 1;
        }
        OVERCOMPRESSED_PARTICLE_PATTERN.lastIndex = 0;
        while (OVERCOMPRESSED_PARTICLE_PATTERN.exec(projection.text) !== null) {
            particles += 1;
        }
    }

    if (anchor === null || narrativeChars < OVERCOMPRESSED_MIN_CHARS || narrativeParas < OVERCOMPRESSED_MIN_PARAS) {
        return [];
    }
    const shortRatio = shortParas / narrativeParas;
    if (shortRatio < OVERCOMPRESSED_SHORT_RATIO) {
        return [];
    }
    const particlePerKilo = (particles / narrativeChars) * 1000;
    if (particlePerKilo >= OVERCOMPRESSED_PARTICLE_PER_KILO) {
        return [];
    }

    const findingAnchor = ctx.shortAnchor(anchor);
    if (!findingAnchor) {
        return [];
    }
    return [{
        index: findingAnchor[0],
        length: findingAnchor[1] - findingAnchor[0],
        message: `叙述段 ${narrativeParas} 个，其中 ${shortParas} 个≤${OVERCOMPRESSED_SHORT_MAX_CHARS}字（${(shortRatio * 100).toFixed(0)}%），自然连接 ${particlePerKilo.toFixed(1)}/千字偏少`,
    }];
}

// ---- low-connective-density（advisory，全文一条）----
// 低连接密度：引号外叙述的功能词与白话连接同时偏低，且缺少中长承接句，呈现
// 「提纲/电报体」分布。单纯低功能词会误抓有大量中长句的文本，必须叠加「中长句
// 不足」双门槛。修法是恢复必要连接和句群，不是全局补词。

const LOW_CONNECTIVE_FUNCTION_TERMS = ["的", "了", "就", "在", "是", "也", "都", "还", "又", "把", "被", "给", "这个", "那个", "里面", "以后", "时候", "现在", "因为", "所以", "但是", "不过", "然后", "已经", "还是", "起来", "出来", "下去"];
const LOW_CONNECTIVE_PLAIN_TERMS = ["的", "了", "就", "也", "还", "又", "这个", "那个", "东西", "事情", "时候", "里面", "以后", "一下", "一点", "有点", "还是"];
const LOW_CONNECTIVE_MIN_CHARS = 800;
const LOW_CONNECTIVE_FUNCTION_PER_KILO = 100;
const LOW_CONNECTIVE_PLAIN_PER_KILO = 65;
const LOW_CONNECTIVE_LONG_SENTENCE_CHARS = 30;
const LOW_CONNECTIVE_LONG_SENTENCE_RATIO = 0.08;

function findLowConnectiveDensity(ctx: HandlerScanContext): HandlerFinding[] {
    let bodyChars = 0;
    let functionHits = 0;
    let plainHits = 0;
    let anchor: number | null = null;
    const sentenceLengths: number[] = [];

    for (const line of ctx.lines) {
        const trimmed = line.text.trim();
        if (!trimmed || line.structural || isMasked(line.start, ctx.maskedRanges)) {
            continue;
        }
        const projection = ctx.projectLine(line);
        const projectedLength = visibleLength(projection.text);
        if (projectedLength === 0) {
            continue;
        }
        if (anchor === null) {
            anchor = projection.map[0] ?? null;
        }
        bodyChars += projectedLength;
        functionHits += countTerms(projection.text, LOW_CONNECTIVE_FUNCTION_TERMS);
        plainHits += countTerms(projection.text, LOW_CONNECTIVE_PLAIN_TERMS);
        for (const sentence of splitSentenceSpans(projection.text)) {
            const length = visibleLength(sentence.text);
            if (length > 0) {
                sentenceLengths.push(length);
            }
        }
    }

    if (anchor === null || bodyChars < LOW_CONNECTIVE_MIN_CHARS || sentenceLengths.length === 0) {
        return [];
    }
    const functionPerKilo = (functionHits / bodyChars) * 1000;
    if (functionPerKilo >= LOW_CONNECTIVE_FUNCTION_PER_KILO) {
        return [];
    }
    const plainPerKilo = (plainHits / bodyChars) * 1000;
    if (plainPerKilo >= LOW_CONNECTIVE_PLAIN_PER_KILO) {
        return [];
    }
    const longSentenceRatio = sentenceLengths.filter((length) => length >= LOW_CONNECTIVE_LONG_SENTENCE_CHARS).length / sentenceLengths.length;
    if (longSentenceRatio >= LOW_CONNECTIVE_LONG_SENTENCE_RATIO) {
        return [];
    }

    const findingAnchor = ctx.shortAnchor(anchor);
    if (!findingAnchor) {
        return [];
    }
    return [{
        index: findingAnchor[0],
        length: findingAnchor[1] - findingAnchor[0],
        message: `引号外叙述功能词 ${functionPerKilo.toFixed(1)}/千字、白话连接 ${plainPerKilo.toFixed(1)}/千字，≥${LOW_CONNECTIVE_LONG_SENTENCE_CHARS}字承接句仅 ${(longSentenceRatio * 100).toFixed(0)}%`,
    }];
}

// ---- long-paragraph（advisory，逐段一条）----
// 单段过长：叙述层单段可见字数超阈值就提示按镜头断段。手机阅读的保守阈值。
//
// 这条规则原本用 density detector 表达（pattern `[\p{L}\p{N}]` 逐字计数 + minHits 200），
// 但那样 `perKilo` 恒为 1000、`samples` 是段落头几个单字，两个字段都没有信息量，
// 报告照 density 口径写出来就是废话。段落长度是统计量而不是分布指纹，属于 handler。
// 逐行紧凑投影保持原 density 版「纯非当前层段落不触发」的行为。

const LONG_PARAGRAPH_CHARS = 200;
/** 命中锚定长度：只要够定位到段首，不取整段——整段会把 200+ 字塞进 Issue.match 与 context。 */
const LONG_PARAGRAPH_ANCHOR_CHARS = 12;

function findLongParagraph(ctx: HandlerScanContext): HandlerFinding[] {
    const findings: HandlerFinding[] = [];

    for (const line of ctx.lines) {
        if (!line.text.trim() || line.structural || isMasked(line.start, ctx.maskedRanges)) {
            continue;
        }
        const projection = ctx.projectLine(line);
        const chars = visibleLength(projection.text);
        if (chars <= LONG_PARAGRAPH_CHARS) {
            continue;
        }
        const anchorStart = projection.map[0];
        const anchor = anchorStart === undefined ? null : ctx.shortAnchor(anchorStart, LONG_PARAGRAPH_ANCHOR_CHARS);
        if (!anchor) {
            continue;
        }
        findings.push({
            index: anchor[0],
            length: anchor[1] - anchor[0],
            message: `本段叙述 ${chars} 字，超过 ${LONG_PARAGRAPH_CHARS} 字`,
        });
    }

    return findings;
}

// ---- quote-emphasis（advisory，全文一条）----
// 引号强调滥用：叙述层 1-4 字短词被成对引号标出，全文 ≥3 处才提示。台词、
// 系统面板、引号套引号与引语动词邻接的极短对白都不算。校准：story-deslop
// demo 前 20 章 0 章过阈值；《万疆》20 章 2 章过阈值，因此只进 human advisory。

const QUOTE_EMPHASIS_MIN_HITS = 3;
const QUOTE_EMPHASIS_MAX_VISIBLE = 4;
const QUOTE_EMPHASIS_PUNCTUATION_PATTERN = /[。！？!?…，,；;：:]/u;
const QUOTE_EMPHASIS_SPEECH_VERB_PATTERN = /[说道问喊答念叫回吼骂写读唱嘀咕]/u;

function findQuoteEmphasis(ctx: HandlerScanContext): HandlerFinding[] {
    let hits = 0;
    let firstRange: MaskedRange | null = null;
    const samples: string[] = [];

    for (const line of ctx.lines) {
        const trimmed = line.text.trim();
        if (!trimmed || line.structural || isMasked(line.start, ctx.maskedRanges)) {
            continue;
        }
        // 纯台词、弹幕流或独立系统面板没有叙述层强调问题。
        if (visibleLength(ctx.layers.narrative.slice(line.start, line.end)) === 0) {
            continue;
        }
        for (const range of ctx.layerRangesOfLine(line)) {
            const [start, end] = range;
            const open = ctx.content[start];
            if (open === "【") {
                continue;
            }
            const inner = ctx.content.slice(start + 1, end - 1);
            const visible = visibleLength(inner);
            if (visible < 1 || visible > QUOTE_EMPHASIS_MAX_VISIBLE) {
                continue;
            }
            if (QUOTE_EMPHASIS_PUNCTUATION_PATTERN.test(inner)) {
                continue;
            }
            const before = ctx.content.slice(Math.max(0, start - 6), start);
            const after = ctx.content.slice(end, end + 3);
            if (QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(before) || QUOTE_EMPHASIS_SPEECH_VERB_PATTERN.test(after)) {
                continue;
            }

            hits += 1;
            firstRange ??= range;
            if (samples.length < 6 && !samples.includes(inner)) {
                samples.push(inner);
            }
        }
    }

    if (hits < QUOTE_EMPHASIS_MIN_HITS || firstRange === null) {
        return [];
    }

    return [{
        index: firstRange[0],
        length: firstRange[1] - firstRange[0],
        message: `叙述里 1-4 字短词加引号强调 ${hits} 处；样本：${samples.join("、")}`,
    }];
}

// ---- 共享工具 ----

/** 按句读切分并保留片段在输入串中的 [start, end) 偏移；空片段已滤除。 */
function splitSentenceSpans(text: string): Array<{text: string; start: number; end: number}> {
    const spans: Array<{text: string; start: number; end: number}> = [];
    let start = 0;
    for (let index = 0; index <= text.length; index++) {
        const char = index < text.length ? text[index]! : "。";
        if (index === text.length || "。！？!?".includes(char)) {
            const fragment = text.slice(start, index).trim();
            if (fragment.length > 0) {
                // trim 后需要回推真实起止偏移。
                const lead = text.slice(start, index).indexOf(fragment);
                spans.push({text: fragment, start: start + lead, end: start + lead + fragment.length});
            }
            start = index + 1;
        }
    }
    return spans;
}

function countTerms(text: string, terms: string[]): number {
    let count = 0;
    for (const term of terms) {
        let index = text.indexOf(term);
        while (index !== -1) {
            count += 1;
            index = text.indexOf(term, index + term.length);
        }
    }
    return count;
}
