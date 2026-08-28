import {isMasked} from "./markdown-mask";
import {computePositionWindow, countableVisibleChars, overlapsRanges, scopeAllowsFinding, visibleCharsInSpan} from "./scan-context";
import {buildLineStarts, ensureGlobalFlags, locatePosition} from "./scanner";
import type {DensityIssue, DensityRuleRecord, MaskedRange, ScanContext} from "./types";

// 密度型 detector 执行器。逐处正则报不了「套词 12 处/千字」这类分布指纹，这里把
// pattern 命中聚合后过门槛（AND 语义）。计数与分母（可见字数）跳过遮罩区、豁免区
// 与结构行——否则一个 bullet 列表就能把密度顶爆。纯函数，浏览器端可打包消费。

const MAX_SAMPLES = 8;

/** 单个 pattern 命中记录；lineIndex 指向 ctx.lines 下标。 */
type DensityHit = {
    index: number;
    text: string;
    bucket: string;
    core: boolean;
    lineIndex: number;
};

/**
 * 在扫描上下文上执行 density 规则。doc 粒度全文最多一条；paragraph 粒度逐行评估
 * 逐行报。命中锚在首个命中位置。
 */
export function scanDensity(ctx: ScanContext, rules: DensityRuleRecord[]): DensityIssue[] {
    if (rules.length === 0) {
        return [];
    }
    const lineStarts = buildLineStarts(ctx.content);
    const issues: DensityIssue[] = [];

    for (const rule of rules) {
        const view = ctx.layers[rule.scope.layer];
        const window = rule.scope.position ? computePositionWindow(ctx, rule.scope) : null;
        const hits = collectHits(ctx, view, rule, window);

        if ((rule.detector.granularity ?? "doc") === "paragraph") {
            // 逐段（行）评估：分母是该行的可见字数，门槛按行独立判定。
            const byLine = new Map<number, DensityHit[]>();
            for (const hit of hits) {
                const current = byLine.get(hit.lineIndex) ?? [];
                current.push(hit);
                byLine.set(hit.lineIndex, current);
            }
            for (const [lineIndex, lineHits] of byLine) {
                const line = ctx.lines[lineIndex];
                if (!line) {
                    continue;
                }
                const start = Math.max(line.start, window?.[0] ?? line.start);
                const end = Math.min(line.end, window?.[1] ?? line.end);
                const chars = start < end ? visibleCharsInSpan(view, start, end, ctx.maskedRanges) : 0;
                const issue = evaluateThresholds(rule, lineHits, chars, ctx.content, lineStarts);
                if (issue) {
                    issues.push(issue);
                }
            }
            continue;
        }

        const chars = countableVisibleChars(ctx, view, window ?? [0, view.length]);
        const issue = evaluateThresholds(rule, hits, chars, ctx.content, lineStarts);
        if (issue) {
            issues.push(issue);
        }
    }

    return issues;
}

/** 收集规则全部 pattern 的命中，应用遮罩/豁免/结构行/位置窗口过滤。 */
function collectHits(ctx: ScanContext, view: string, rule: DensityRuleRecord, window: MaskedRange | null): DensityHit[] {
    const hits: DensityHit[] = [];
    for (const pattern of rule.detector.patterns) {
        let regex: RegExp;
        try {
            regex = new RegExp(pattern.target, ensureGlobalFlags(pattern.flags));
        } catch (error) {
            throw new Error(`规则 ${rule.id} 的密度 pattern 无效: ${error instanceof Error ? error.message : String(error)}`);
        }
        let match: RegExpExecArray | null;
        while ((match = regex.exec(view)) !== null) {
            const index = match.index;
            const length = match[0].length;
            if (length === 0) {
                regex.lastIndex++;
            }
            if (ctx.maskedRanges.length > 0 && isMasked(index, ctx.maskedRanges)) {
                continue;
            }
            if (ctx.ignoreRanges.length > 0 && overlapsRanges(index, index + length, ctx.ignoreRanges)) {
                continue;
            }
            if (!scopeAllowsFinding(ctx, rule.scope, window, index, index + length)) {
                continue;
            }
            const lineIndex = locateLineIndex(ctx, index);
            if (ctx.lines[lineIndex]?.structural) {
                continue;
            }
            hits.push({
                index,
                text: ctx.content.slice(index, index + length),
                bucket: pattern.bucket ?? "default",
                core: pattern.core === true,
                lineIndex,
            });
        }
    }
    return hits;
}

/** 门槛 AND 判定：全部满足才产出 DensityIssue（锚在首个命中）。 */
function evaluateThresholds(rule: DensityRuleRecord, hits: DensityHit[], visibleChars: number, content: string, lineStarts: number[]): DensityIssue | null {
    const detector = rule.detector;
    if (detector.minChars !== undefined && visibleChars < detector.minChars) {
        return null;
    }
    if (hits.length < detector.minHits) {
        return null;
    }
    const perKilo = visibleChars > 0 ? (hits.length / visibleChars) * 1000 : 0;
    if (detector.perKilo !== undefined && perKilo < detector.perKilo) {
        return null;
    }
    if (detector.coreMinHits !== undefined && hits.filter((hit) => hit.core).length < detector.coreMinHits) {
        return null;
    }
    if (detector.minBuckets !== undefined && new Set(hits.map((hit) => hit.bucket)).size < detector.minBuckets) {
        return null;
    }

    const first = hits.reduce((left, right) => right.index < left.index ? right : left);
    const position = locatePosition(content, lineStarts, first.index);
    return {
        rule,
        line: position.line,
        column: position.column,
        hits: hits.length,
        perKilo: Math.round(perKilo * 100) / 100,
        samples: [...new Set(hits.map((hit) => hit.text))].slice(0, MAX_SAMPLES),
    };
}

/** doc 粒度分母：非结构行、非遮罩区的可见字数总和（按 scope 层视图计）。 */

/** 二分定位偏移所在行下标（ctx.lines 按 start 升序）。 */
function locateLineIndex(ctx: ScanContext, index: number): number {
    let low = 0;
    let high = ctx.lines.length - 1;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const line = ctx.lines[middle]!;
        if (line.start <= index) {
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return Math.max(0, high);
}
