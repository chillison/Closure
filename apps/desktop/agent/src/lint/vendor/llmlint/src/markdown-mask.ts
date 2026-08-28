import type {MaskedRange} from "./types";

/**
 * Markdown 区域遮罩：算出「不该被 regex 规则扫描」的源码区间。
 *
 * 动机：llmlint 规则面向自然语言正文，但稿件是 Markdown。代码块里的 `其实`、链接
 * `[note](url)` 的标签都会被规则误杀（已实测）。这里把这些结构区域标出来，由 scanner
 * 跳过落在其中的命中。只做「标出该跳过的区域」这一窄任务，不引入完整 CommonMark 解析器。
 *
 * 返回半开区间 `[start, end)`，与 scanner 的 `match.index` 同一字符索引空间。
 * 容忍误差（v1）：裸 shortcut `[ref]`、跨区间边界的结构等边角不保证，留给规则自身判断。
 */
export function computeMaskedRanges(content: string): MaskedRange[] {
    const lines = splitLines(content);
    const ranges: MaskedRange[] = [];

    // 1. YAML frontmatter：仅当文件首行是 `---` 时，遮罩到下一条 `---` / `...` 分隔行。
    let cursor = 0;
    const frontmatterEnd = maskFrontmatter(lines, ranges);
    if (frontmatterEnd >= 0) {
        cursor = frontmatterEnd;
    }

    // 2. 逐行扫描围栏代码块；非代码块行再做行内检测（代码块内不做行内检测）。
    let fence: {char: string; length: number; start: number} | null = null;
    for (let index = cursor; index < lines.length; index++) {
        const line = lines[index];
        if (!line) {
            continue;
        }
        const fenceMatch = line.text.match(/^(\s{0,3})(`{3,}|~{3,})(.*)$/);
        if (fence) {
            // 已在围栏内：遇到同类型、长度不小于开栏且无信息串的行即闭合。
            if (fenceMatch && fenceMatch[2]?.[0] === fence.char && fenceMatch[2].length >= fence.length && fenceMatch[3]?.trim() === "") {
                ranges.push([fence.start, line.end]);
                fence = null;
            }
            continue;
        }
        if (fenceMatch && fenceMatch[2]) {
            // 开栏：记录围栏字符与长度，区块起点。
            fence = {char: fenceMatch[2][0] ?? "`", length: fenceMatch[2].length, start: line.start};
            continue;
        }
        maskInline(line.text, line.start, ranges);
    }
    // 未闭合的围栏：遮罩到文件末尾。
    if (fence) {
        ranges.push([fence.start, content.length]);
    }

    return mergeRanges(ranges);
}

/** 判断某个匹配起点是否落在任一遮罩区间内。区间已排序、已合并。 */
export function isMasked(index: number, ranges: MaskedRange[]): boolean {
    for (const [start, end] of ranges) {
        if (index < start) {
            return false;
        }
        if (index < end) {
            return true;
        }
    }
    return false;
}

export type LineSpan = {start: number; end: number; text: string};

/** 按行切分，保留每行在原文中的起止偏移（end 含换行符，指向下一行起点）。 */
export function splitLines(content: string): LineSpan[] {
    const lines: LineSpan[] = [];
    let start = 0;
    for (let index = 0; index < content.length; index++) {
        if (content[index] === "\n") {
            lines.push({start, end: index + 1, text: stripCarriageReturn(content.slice(start, index))});
            start = index + 1;
        }
    }
    if (start < content.length) {
        lines.push({start, end: content.length, text: stripCarriageReturn(content.slice(start))});
    }
    return lines;
}

function stripCarriageReturn(text: string): string {
    return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/**
 * 遮罩文件首部 frontmatter。返回 frontmatter 结束后的下一行下标；非 frontmatter 时返回 -1。
 */
function maskFrontmatter(lines: LineSpan[], ranges: MaskedRange[]): number {
    const first = lines[0];
    if (!first || first.text.trim() !== "---") {
        return -1;
    }
    for (let index = 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line) {
            continue;
        }
        if (line.text.trim() === "---" || line.text.trim() === "...") {
            ranges.push([first.start, line.end]);
            return index + 1;
        }
    }
    return -1;
}

/** 在单行正文里遮罩行内代码、链接/图片、autolink 与裸 URL。offset 为该行在原文中的起点。 */
function maskInline(text: string, offset: number, ranges: MaskedRange[]): void {
    pushMatches(text, offset, ranges, /(`+)(.+?)\1/g);
    pushMatches(text, offset, ranges, /!?\[[^\]\n]*\]\([^)\n]*\)/g);
    pushMatches(text, offset, ranges, /<[a-z][a-z0-9+.-]*:[^>\n]*>/gi);
    pushMatches(text, offset, ranges, /\bhttps?:\/\/[^\s)]+/gi);
}

function pushMatches(text: string, offset: number, ranges: MaskedRange[], regex: RegExp): void {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
        ranges.push([offset + match.index, offset + match.index + match[0].length]);
        if (match[0].length === 0) {
            regex.lastIndex++;
        }
    }
}

/** 排序并合并重叠 / 相邻区间，得到不相交、按起点升序的区间列表。 */
export function mergeRanges(ranges: MaskedRange[]): MaskedRange[] {
    if (ranges.length <= 1) {
        return ranges;
    }
    const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
    const merged: MaskedRange[] = [];
    for (const range of sorted) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) {
            last[1] = Math.max(last[1], range[1]);
            continue;
        }
        merged.push([range[0], range[1]]);
    }
    return merged;
}
