import {isMasked, mergeRanges, splitLines} from "./markdown-mask";
import type {HandlerLineProjection, HandlerScanContext, MaskedRange, ResolvedScanScope, ScanContext, ScanLine} from "./types";

// 扫描上下文构建：引号分域、三层等长视图、结构行标记、词级白名单区间。
// 与 markdown-mask 同为纯函数层——不读文件系统，浏览器端可打包消费。
// 活契约：skill/references/rule-model.md。任务目录里的 v3 design 只保留历史决策。

/**
 * 成对引号表：行内配对（不跨换行），未闭合不遮罩。
 * ASCII 直引号 " ' 因无方向性易误配，v1 不入表（后续按语料反馈再议）。
 */
const QUOTE_PAIRS: Record<string, string> = {
    "「": "」",
    "『": "』",
    "【": "】",
    "“": "”",
    "‘": "’",
};
const QUOTE_CLOSERS = new Set(Object.values(QUOTE_PAIRS));

/**
 * markdown 结构行判定：标题 / 引用 / 无序与有序列表 / 表格行 / 分隔线。
 * 围栏代码块行已被 maskedRanges 覆盖，不在此重复判定。
 */
const STRUCTURAL_LINE_PATTERN = /^\s{0,3}(?:#{1,6}\s|>|[-*+]\s|\d{1,3}[.)]\s|\|)/;
const HORIZONTAL_RULE_PATTERN = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
/** 章节标题行（`第N章 …`），density/handler 统计跳过，逐处 regex 规则不受影响。 */
const CHAPTER_HEADING_PATTERN = /^\s*第[0-9一二三四五六七八九十百千万零两]+[章节卷回幕]/;

export type PrepareScanOptions = {
    /** markdown 结构遮罩区间；缺省 = 不遮罩。 */
    maskedRanges?: MaskedRange[];
    /** 项目级豁免词（世界观术语、绰号、章名）；命中区间与其出现区间重叠即丢弃。 */
    ignoreTerms?: string[];
};

/**
 * 构建扫描上下文：一次算好遮罩、引号分域、三层视图与行切分，供三种 detector 共享。
 * 视图与原文严格等长（按 UTF-16 code unit），`match.index` 可直接回原文取 excerpt。
 */
export function prepareScanContext(content: string, options: PrepareScanOptions = {}): ScanContext {
    const maskedRanges = options.maskedRanges ?? [];
    const lines = splitScanLines(content);
    const quotedRanges = computeQuotedRanges(lines, maskedRanges);
    return {
        content,
        layers: {
            all: content,
            narrative: buildPlaceholderView(content, quotedRanges, "inside"),
            quoted: buildPlaceholderView(content, quotedRanges, "outside"),
        },
        maskedRanges,
        ignoreRanges: computeIgnoreTermRanges(content, options.ignoreTerms ?? []),
        quotedRanges,
        lines,
    };
}

/** 行切分并打结构标记。 */
export function splitScanLines(content: string): ScanLine[] {
    return splitLines(content).map((line) => ({
        ...line,
        structural: isStructuralLine(line.text),
    }));
}

function isStructuralLine(text: string): boolean {
    return STRUCTURAL_LINE_PATTERN.test(text)
        || HORIZONTAL_RULE_PATTERN.test(text)
        || CHAPTER_HEADING_PATTERN.test(text);
}

/**
 * 成对引号区间计算：逐行栈式配对（含嵌套），未闭合的引号在行尾丢弃（不遮罩，防止
 * 一个漏引号把后半篇全吞进对白层）。落在 maskedRanges 内的引号字符不参与配对——
 * 代码块 / frontmatter 里的 `「` 不能制造假对白区。
 */
export function computeQuotedRanges(lines: ScanLine[], maskedRanges: MaskedRange[]): MaskedRange[] {
    const ranges: MaskedRange[] = [];
    for (const line of lines) {
        // 栈内是尚未闭合的开引号；close 只与栈顶同类配对，错配的闭引号当普通字符忽略。
        const stack: Array<{closer: string; index: number}> = [];
        for (let offset = 0; offset < line.text.length; offset++) {
            const char = line.text[offset]!;
            const absolute = line.start + offset;
            if (!(char in QUOTE_PAIRS) && !QUOTE_CLOSERS.has(char)) {
                continue;
            }
            if (maskedRanges.length > 0 && isMasked(absolute, maskedRanges)) {
                continue;
            }
            const closer = QUOTE_PAIRS[char];
            if (closer !== undefined) {
                stack.push({closer, index: absolute});
                continue;
            }
            const top = stack.at(-1);
            if (top && top.closer === char) {
                stack.pop();
                ranges.push([top.index, absolute + 1]);
            }
        }
    }
    return mergeRanges(ranges);
}

/** 为单条 handler 绑定 resolved scope，并提供统一的视图、窗口、投影和区间判定。 */
export function prepareHandlerScanContext(ctx: ScanContext, scope: ResolvedScanScope): HandlerScanContext {
    const positionWindow = scope.position ? computePositionWindow(ctx, scope) : null;
    const allowsIndex = (index: number): boolean => {
        if (index < 0 || index >= ctx.content.length) {
            return false;
        }
        if (scope.layer === "all") {
            return true;
        }
        const quoted = overlapsRanges(index, index + 1, ctx.quotedRanges);
        return scope.layer === "quoted" ? quoted : !quoted;
    };

    return {
        ...ctx,
        scope,
        view: ctx.layers[scope.layer],
        positionWindow,
        allowsFinding: (start, end) => scopeAllowsFinding(ctx, scope, positionWindow, start, end),
        shortAnchor: (start, maxCodePoints = 12) => shortAnchor(ctx, scope, start, maxCodePoints),
        projectLine: (line) => projectHandlerLine(line, allowsIndex),
        layerRangesOfLine: (line) => layerRangesOfLine(ctx, line, scope.layer),
    };
}

/** 按当前 layer/window 紧凑投影一行，同时保留每个字符的原文 UTF-16 offset。 */
function projectHandlerLine(line: ScanLine, allowsIndex: (index: number) => boolean): HandlerLineProjection {
    let text = "";
    const map: number[] = [];
    for (let offset = 0; offset < line.text.length; offset++) {
        const absolute = line.start + offset;
        if (!allowsIndex(absolute)) {
            continue;
        }
        text += line.text[offset]!;
        map.push(absolute);
    }
    return {text, map};
}

/** 当前行属于 layer/window 的连续原文区间，供 quoted 等逐段 handler 使用。 */
function layerRangesOfLine(
    ctx: ScanContext,
    line: ScanLine,
    layer: ResolvedScanScope["layer"],
): MaskedRange[] {
    const lineEnd = line.start + line.text.length;
    const source = layer === "quoted"
        ? ctx.quotedRanges
        : layer === "all"
            ? [[line.start, lineEnd] as MaskedRange]
            : complementRanges(ctx.quotedRanges, line.start, lineEnd);
    const ranges: MaskedRange[] = [];
    for (const [start, end] of source) {
        const clippedStart = Math.max(start, line.start);
        const clippedEnd = Math.min(end, lineEnd);
        if (clippedStart < clippedEnd) {
            ranges.push([clippedStart, clippedEnd]);
        }
    }
    return ranges;
}

/**
 * 三种 detector 共用的 scope 防线：position 只约束命中起点；非 all layer 要求完整
 * [start,end) 都属于声明层，不能从叙述跨进引号或从引号跨回叙述。
 */
export function scopeAllowsFinding(
    ctx: ScanContext,
    scope: ResolvedScanScope,
    positionWindow: MaskedRange | null,
    start: number,
    end: number,
): boolean {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > ctx.content.length) {
        return false;
    }
    if (positionWindow && (start < positionWindow[0] || start >= positionWindow[1])) {
        return false;
    }
    if (positionWindow && ctx.lines.some((line) => line.structural && start >= line.start && start < line.end)) {
        return false;
    }
    if (scope.layer === "all") {
        return true;
    }
    if (scope.layer === "narrative") {
        return !overlapsRanges(start, end, ctx.quotedRanges);
    }
    return rangeContainedBy(start, end, ctx.quotedRanges);
}

/** 从指定起点取连续短锚点；统计型 handler 用 detail 报全量结论，match 只负责定位。 */
function shortAnchor(ctx: ScanContext, scope: ResolvedScanScope, start: number, maxCodePoints: number): MaskedRange | null {
    if (!Number.isInteger(maxCodePoints) || maxCodePoints < 1 || start < 0 || start >= ctx.content.length) {
        return null;
    }
    const line = ctx.lines.find((candidate) => start >= candidate.start && start < candidate.start + candidate.text.length);
    if (!line || isMasked(start, ctx.maskedRanges)) {
        return null;
    }
    const containing = layerRangesOfLine(ctx, line, scope.layer).find(([rangeStart, rangeEnd]) => start >= rangeStart && start < rangeEnd);
    if (!containing) {
        return null;
    }
    let limit = containing[1];
    for (const [maskStart, maskEnd] of ctx.maskedRanges) {
        if (maskEnd <= start) {
            continue;
        }
        if (maskStart <= start) {
            return null;
        }
        limit = Math.min(limit, maskStart);
        break;
    }
    let end = start;
    let count = 0;
    for (const char of ctx.content.slice(start, limit)) {
        end += char.length;
        count += 1;
        if (count >= maxCodePoints) {
            break;
        }
    }
    return end > start ? [start, end] : null;
}

function rangeContainedBy(start: number, end: number, ranges: MaskedRange[]): boolean {
    for (const [rangeStart, rangeEnd] of ranges) {
        if (rangeEnd <= start) {
            continue;
        }
        return rangeStart <= start && end <= rangeEnd;
    }
    return false;
}

function complementRanges(ranges: MaskedRange[], start: number, end: number): MaskedRange[] {
    const result: MaskedRange[] = [];
    let cursor = start;
    for (const [rangeStart, rangeEnd] of ranges) {
        if (rangeEnd <= cursor) {
            continue;
        }
        if (rangeStart >= end) {
            break;
        }
        if (rangeStart > cursor) {
            result.push([cursor, Math.min(rangeStart, end)]);
        }
        cursor = Math.max(cursor, Math.min(rangeEnd, end));
        if (cursor >= end) {
            return result;
        }
    }
    if (cursor < end) {
        result.push([cursor, end]);
    }
    return result;
}

/**
 * 等长占位视图：把 ranges 内（mask="inside"）或外（mask="outside"）的字符替换为等长 `。`，
 * 换行符（\n / \r）始终保留，维持行结构与偏移一致。选 `。` 是为了让 `[^。，]` 类字符类
 * 天然截断，规则不会跨引号拼出假命中——这是特性不是缺陷。
 */
function buildPlaceholderView(content: string, ranges: MaskedRange[], mask: "inside" | "outside"): string {
    if (ranges.length === 0) {
        return mask === "inside" ? content : toPlaceholder(content);
    }
    let result = "";
    let cursor = 0;
    for (const [start, end] of ranges) {
        const outside = content.slice(cursor, start);
        const inside = content.slice(start, end);
        result += mask === "inside" ? outside : toPlaceholder(outside);
        result += mask === "inside" ? toPlaceholder(inside) : inside;
        cursor = end;
    }
    const tail = content.slice(cursor);
    result += mask === "inside" ? tail : toPlaceholder(tail);
    return result;
}

function toPlaceholder(text: string): string {
    return text.replace(/[^\n\r]/g, "。");
}

/**
 * 词级白名单区间：每个豁免词在原文中的所有出现算成区间。命中区间与之「重叠」即丢弃
 * （与 maskedRanges 的「起点落入」判定不同，见 overlapsRanges）。
 */
export function computeIgnoreTermRanges(content: string, terms: string[]): MaskedRange[] {
    const ranges: MaskedRange[] = [];
    for (const term of terms) {
        if (term.length === 0) {
            continue;
        }
        let from = 0;
        let index: number;
        while ((index = content.indexOf(term, from)) !== -1) {
            ranges.push([index, index + term.length]);
            from = index + term.length;
        }
    }
    return mergeRanges(ranges);
}

/** 判断区间 [start, end) 是否与任一区间重叠。ranges 需已排序合并。 */
export function overlapsRanges(start: number, end: number, ranges: MaskedRange[]): boolean {
    for (const [rangeStart, rangeEnd] of ranges) {
        if (rangeEnd <= start) {
            continue;
        }
        return rangeStart < end;
    }
    return false;
}

const VISIBLE_CHAR_PATTERN = /[\p{L}\p{N}]/u;

/** 可见字符数：CJK / 字母 / 数字。标点、空白与占位 `。` 不计。 */
export function visibleLength(text: string): number {
    let count = 0;
    for (const char of text) {
        if (VISIBLE_CHAR_PATTERN.test(char)) {
            count++;
        }
    }
    return count;
}

/**
 * 一份视图里「可计数」的可见字符数：跳过结构行与遮罩区。
 *
 * 这是 density 规则 `perKilo` 的分母，也是 `check` 报告的篇幅基准——两处必须同口径，
 * 否则同一份报告里「每千字命中」和「可见字数」会互相对不上。传 `ctx.layers.all` 得到
 * 全文篇幅；传某一层的视图得到该层篇幅（narrative 层台词是 `。` 占位，不计入）。
 */
export function countableVisibleChars(ctx: ScanContext, view: string, range: MaskedRange = [0, view.length]): number {
    let total = 0;
    for (const line of ctx.lines) {
        if (line.structural) {
            continue;
        }
        const start = Math.max(line.start, range[0]);
        const end = Math.min(line.end, range[1]);
        if (start < end) {
            total += visibleCharsInSpan(view, start, end, ctx.maskedRanges);
        }
    }
    return total;
}

/** 统计 [start, end) 内、不落遮罩区的可见字符数。 */
export function visibleCharsInSpan(view: string, start: number, end: number, maskedRanges: MaskedRange[]): number {
    if (maskedRanges.length === 0) {
        return visibleLength(view.slice(start, end));
    }
    let total = 0;
    let cursor = start;
    for (const [maskStart, maskEnd] of maskedRanges) {
        if (maskEnd <= cursor) {
            continue;
        }
        if (maskStart >= end) {
            break;
        }
        if (maskStart > cursor) {
            total += visibleLength(view.slice(cursor, Math.min(maskStart, end)));
        }
        cursor = Math.max(cursor, Math.min(maskEnd, end));
        if (cursor >= end) {
            return total;
        }
    }
    if (cursor < end) {
        total += visibleLength(view.slice(cursor, end));
    }
    return total;
}

/**
 * 位置窗口：从文首（opening）/ 文末（ending）按规则当前 layer 的可见 Unicode 码点计数，
 * 跳过 Markdown 遮罩、frontmatter、标题和结构行，返回允许的 UTF-16 索引区间。
 * 命中只要求起点落在窗口内，结束位置可越过窗口边界。
 */
export function computePositionWindow(ctx: ScanContext, scope: ResolvedScanScope): MaskedRange {
    const view = ctx.layers[scope.layer];
    const position = scope.position;
    if (!position) {
        return [0, view.length];
    }
    if (position.kind === "opening") {
        let count = 0;
        for (const line of ctx.lines) {
            if (line.structural) {
                continue;
            }
            let absolute = line.start;
            for (const char of view.slice(line.start, line.start + line.text.length)) {
                if (!isMasked(absolute, ctx.maskedRanges) && VISIBLE_CHAR_PATTERN.test(char)) {
                    count += 1;
                    if (count >= position.chars) {
                        return [0, absolute + char.length];
                    }
                }
                absolute += char.length;
            }
        }
        return [0, view.length];
    }
    let count = 0;
    for (let lineIndex = ctx.lines.length - 1; lineIndex >= 0; lineIndex--) {
        const line = ctx.lines[lineIndex]!;
        if (line.structural) {
            continue;
        }
        const lineStart = line.start;
        let absoluteEnd = line.start + line.text.length;
        while (absoluteEnd > lineStart) {
            let absoluteStart = absoluteEnd - 1;
            const tail = view.charCodeAt(absoluteStart);
            if (tail >= 0xDC00 && tail <= 0xDFFF && absoluteStart > lineStart) {
                const head = view.charCodeAt(absoluteStart - 1);
                if (head >= 0xD800 && head <= 0xDBFF) {
                    absoluteStart -= 1;
                }
            }
            const char = view.slice(absoluteStart, absoluteEnd);
            if (!isMasked(absoluteStart, ctx.maskedRanges) && VISIBLE_CHAR_PATTERN.test(char)) {
                count += 1;
                if (count >= position.chars) {
                    return [absoluteStart, view.length];
                }
            }
            absoluteEnd = absoluteStart;
        }
    }
    return [0, view.length];
}
