// check 报告的紧凑投影。与 fix.ts / rule-registry.ts 同一取舍：纯函数、无终端依赖，
// 供 CLI（skill/src/reporter.ts）与 web（「复制 JSON」）共用同一份实现，保证两侧输出同构。
// 刻意不放在 reporter.ts 里：那里依赖 picocolors 做终端着色，浏览器 bundle 不该带它。
import type {ActiveRuleRecord, CompactDensityIssue, CompactIssue, CompactRuleEntry, DensityIssue, Issue} from "./types";

/**
 * 紧凑报告里 `context.before` / `context.after` 各保留的最大码点数。
 *
 * scanner 给的前后文是**整行**；中文长段落一行常有 150+ 字，逐处命中带整行是紧凑化前 JSON 体积的最大来源
 * （UTF-8 下中文 3 字节/字）。24 字足够判断命中所在分句承担什么功能；要完整段落应直接读原文，
 * 或用 `check --rule-detail`。
 */
export const COMPACT_CONTEXT_CHARS = 24;

/** 单条规则的紧凑投影：保留 resolved scope，丢掉 detector / source / examples / ruleset。 */
function compactRuleEntry(rule: ActiveRuleRecord): CompactRuleEntry {
    return {
        namespace: rule.namespace,
        title: rule.title,
        level: rule.level,
        review: rule.review,
        fixability: rule.fixability,
        scope: rule.scope,
        action: rule.action,
        ...(rule.note ? {note: rule.note} : {}),
    };
}

/** 按码点裁剪前后文；被裁掉时在裁剪侧补省略号，让消费者知道这里不是行首 / 行尾。 */
function trimContextSide(text: string, side: "before" | "after"): string {
    const characters = Array.from(text);
    if (characters.length <= COMPACT_CONTEXT_CHARS) {
        return text;
    }
    return side === "before"
        ? `…${characters.slice(-COMPACT_CONTEXT_CHARS).join("")}`
        : `${characters.slice(0, COMPACT_CONTEXT_CHARS).join("")}…`;
}

/**
 * 把命中投影为紧凑形态：规则元数据按 id 收进 `rules` 字典，逐处命中只留 `ruleId` + 位置 + 文本证据。
 *
 * 多文件场景可对每个文件各调一次，再用 `mergeCompactRules` 合并字典。
 *
 * @param issues 逐处命中（regex ∪ handler）。
 * @param densityIssues 密度指纹；缺省表示未跑 density 扫描，返回值同样省略该字段。
 */
export function projectCheckIssues(issues: Issue[], densityIssues?: DensityIssue[]): {
    rules: Record<string, CompactRuleEntry>;
    issues: CompactIssue[];
    densityIssues?: CompactDensityIssue[];
} {
    const rules: Record<string, CompactRuleEntry> = {};
    const collect = (rule: ActiveRuleRecord): string => {
        if (!rules[rule.id]) {
            rules[rule.id] = compactRuleEntry(rule);
        }
        return rule.id;
    };

    const compactIssues: CompactIssue[] = issues.map((issue) => ({
        ruleId: collect(issue.rule),
        line: issue.line,
        column: issue.column,
        endLine: issue.endLine,
        endColumn: issue.endColumn,
        match: issue.match,
        ...(issue.detail ? {detail: issue.detail} : {}),
        context: {
            before: trimContextSide(issue.context.before, "before"),
            current: issue.context.current,
            after: trimContextSide(issue.context.after, "after"),
        },
    }));

    if (!densityIssues) {
        return {rules, issues: compactIssues};
    }
    return {
        rules,
        issues: compactIssues,
        densityIssues: densityIssues.map((issue) => ({
            ruleId: collect(issue.rule),
            line: issue.line,
            column: issue.column,
            hits: issue.hits,
            perKilo: issue.perKilo,
            samples: issue.samples,
        })),
    };
}

/** 合并多个文件的规则字典。同一 rule id 在各文件里指向同一条规则，先到先留即可。 */
export function mergeCompactRules(dictionaries: Array<Record<string, CompactRuleEntry>>): Record<string, CompactRuleEntry> {
    const merged: Record<string, CompactRuleEntry> = {};
    for (const dictionary of dictionaries) {
        for (const [ruleId, entry] of Object.entries(dictionary)) {
            merged[ruleId] ??= entry;
        }
    }
    return merged;
}
