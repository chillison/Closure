import {isMasked} from "./markdown-mask";
import {HANDLER_REGISTRY} from "./handler-rules";
import {computePositionWindow, overlapsRanges, prepareHandlerScanContext, prepareScanContext, scopeAllowsFinding} from "./scan-context";
import type {ActiveHandlerRuleRecord, Issue, MaskedRange, RegexRuleRecord, ScanContext} from "./types";

export type ScanOptions = {
    /** Markdown 遮罩区间；命中起点落入其中时跳过（代码块/frontmatter/链接等）。缺省=不遮罩。 */
    maskedRanges?: MaskedRange[];
};

/**
 * 使用 regex detector 扫描全文。命中只表示候选，是否修复仍由 Agent 结合上下文判断。
 * 旧签名薄包装：内部自建 ScanContext；需要多次重扫或引号分域时改用
 * `prepareScanContext` + `scanWithContext`（视图只算一次）。
 */
export function scanText(content: string, rules: RegexRuleRecord[], options: ScanOptions = {}): Issue[] {
    return scanWithContext(prepareScanContext(content, {maskedRanges: options.maskedRanges}), rules);
}

/**
 * 在扫描上下文上执行 regex 规则：按 `rule.scope.layer` 选等长视图 exec，视图偏移与原文
 * 一致，命中定位与 excerpt 一律取原文。跳过条件：命中起点落 maskedRanges、命中区间与
 * ignoreRanges 重叠、命中起点落 position 窗口外。
 */
export function scanWithContext(ctx: ScanContext, rules: RegexRuleRecord[]): Issue[] {
    const content = ctx.content;
    const lineStarts = buildLineStarts(content);
    const issues: Issue[] = [];

    for (const rule of rules) {
        const view = ctx.layers[rule.scope.layer];
        const window = rule.scope.position ? computePositionWindow(ctx, rule.scope) : null;
        for (const target of rule.detector.targets) {
            let regex: RegExp;
            try {
                regex = new RegExp(target, ensureGlobalFlags(rule.detector.flags));
            } catch (error) {
                throw new Error(`规则 ${rule.id} 的正则无效: ${error instanceof Error ? error.message : String(error)}`);
            }

            let match: RegExpExecArray | null;
            while ((match = regex.exec(view)) !== null) {
                const matchIndex = match.index;
                const matchLength = match[0].length;
                // 零长匹配先推进 lastIndex，避免死循环；遮罩判断与下面的 continue 不影响推进。
                if (matchLength === 0) {
                    regex.lastIndex++;
                }
                if (ctx.maskedRanges.length > 0 && isMasked(matchIndex, ctx.maskedRanges)) {
                    continue;
                }
                if (ctx.ignoreRanges.length > 0 && overlapsRanges(matchIndex, matchIndex + matchLength, ctx.ignoreRanges)) {
                    continue;
                }
                if (!scopeAllowsFinding(ctx, rule.scope, window, matchIndex, matchIndex + matchLength)) {
                    continue;
                }
                // 视图与原文等长，回原文切片保证 excerpt 是真实文本（视图里可能含 `。` 占位）。
                const matchText = content.slice(matchIndex, matchIndex + matchLength);
                const position = locatePosition(content, lineStarts, matchIndex);
                const endPosition = locateEndPosition(content, lineStarts, matchIndex, matchLength);
                issues.push({
                    rule,
                    line: position.line,
                    column: position.column,
                    endLine: endPosition.line,
                    endColumn: endPosition.column,
                    match: matchText,
                    target,
                    context: extractContext(content, matchIndex, matchLength),
                });
            }
        }
    }

    return issues;
}

/** 把规则 detector 的 flags 合并出一定含 g 的标志串，供扫描与机械修复共用。 */
export function ensureGlobalFlags(flags: string | undefined): string {
    const merged = new Set((flags ?? "").split("").filter((flag) => flag.length > 0));
    merged.add("g");
    return [...merged].join("");
}

/**
 * 执行 handler 规则：从编译期注册表按名取算法，findings 过 masked/ignore 过滤后映射
 * 为 Issue。每条规则先绑定统一 handler scope 上下文，执行器再对 finding 做 layer/window
 * 防御性过滤。loader 已拒绝未注册名，这里遇到（防御）直接跳过。
 */
export function scanHandlerRules(ctx: ScanContext, rules: ActiveHandlerRuleRecord[]): Issue[] {
    if (rules.length === 0) {
        return [];
    }
    const content = ctx.content;
    const lineStarts = buildLineStarts(content);
    const issues: Issue[] = [];

    for (const rule of rules) {
        const handler = HANDLER_REGISTRY[rule.handler.name];
        if (!handler) {
            continue;
        }
        const handlerContext = prepareHandlerScanContext(ctx, rule.scope);
        for (const finding of handler(handlerContext)) {
            const {index, length} = finding;
            if (!handlerContext.allowsFinding(index, index + length)) {
                continue;
            }
            if (ctx.maskedRanges.length > 0 && isMasked(index, ctx.maskedRanges)) {
                continue;
            }
            if (ctx.ignoreRanges.length > 0 && overlapsRanges(index, index + length, ctx.ignoreRanges)) {
                continue;
            }
            const position = locatePosition(content, lineStarts, index);
            const endPosition = locateEndPosition(content, lineStarts, index, length);
            issues.push({
                rule,
                line: position.line,
                column: position.column,
                endLine: endPosition.line,
                endColumn: endPosition.column,
                match: content.slice(index, index + length),
                target: rule.handler.name,
                ...(finding.message !== undefined ? {detail: finding.message} : {}),
                context: extractContext(content, index, length),
            });
        }
    }

    return issues;
}

/** 预计算各行起点偏移，供 locatePosition 二分定位；density/handler 锚定复用。 */
export function buildLineStarts(content: string): number[] {
    const lineStarts = [0];
    for (let index = 0; index < content.length; index++) {
        if (content[index] === "\n") {
            lineStarts.push(index + 1);
        }
    }
    return lineStarts;
}

/** 把字符偏移定位成 1-based 行/列（列按码点计）；density/handler 锚定复用。 */
export function locatePosition(content: string, lineStarts: number[], index: number): {line: number; column: number} {
    const lineIndex = locateLineIndex(lineStarts, index);
    const lineStart = lineStarts[lineIndex] ?? 0;
    return {
        line: lineIndex + 1,
        column: Array.from(content.slice(lineStart, index)).length + 1,
    };
}

function locateEndPosition(content: string, lineStarts: number[], matchIndex: number, matchLength: number): {line: number; column: number} {
    if (matchLength === 0) {
        return locatePosition(content, lineStarts, matchIndex);
    }

    const exclusiveEnd = matchIndex + matchLength;
    const lastCodeUnitIndex = exclusiveEnd - 1;
    if (content[lastCodeUnitIndex] === "\n") {
        return locatePosition(content, lineStarts, lastCodeUnitIndex);
    }

    const lineIndex = locateLineIndex(lineStarts, lastCodeUnitIndex);
    const lineStart = lineStarts[lineIndex] ?? 0;
    return {
        line: lineIndex + 1,
        column: Array.from(content.slice(lineStart, exclusiveEnd)).length,
    };
}

function locateLineIndex(lineStarts: number[], index: number): number {
    let low = 0;
    let high = lineStarts.length - 1;

    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const lineStart = lineStarts[middle] ?? 0;
        if (lineStart <= index) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return Math.max(0, high);
}

function extractContext(content: string, matchIndex: number, matchLength: number): Issue["context"] {
    const matchEnd = matchIndex + matchLength;
    const lineStart = content.lastIndexOf("\n", Math.max(0, matchIndex - 1)) + 1;
    const nextLineBreak = content.indexOf("\n", matchEnd);
    let lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
    if (lineEnd > lineStart && content[lineEnd - 1] === "\r") {
        lineEnd--;
    }
    const visibleMatchEnd = Math.min(matchEnd, lineEnd);

    return {
        before: renderInline(content.substring(lineStart, matchIndex)),
        current: renderInline(content.substring(matchIndex, visibleMatchEnd)),
        after: renderInline(content.substring(visibleMatchEnd, lineEnd)),
    };
}

function renderInline(text: string): string {
    return text
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
}
