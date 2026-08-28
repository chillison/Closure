import {ensureGlobalFlags} from "./scanner";
import type {Fixability, Issue, MaskedRange, RegexRuleRecord} from "./types";

// 机械修复（fixability:auto）的纯字符串逻辑。CLI 的 `fix` 命令与 web 检测页共用同一份，
// 避免两处重实现导致漂移。不读文件系统、无副作用。

/** 在非遮罩区段内应用 auto 规则替换；遮罩区段（代码块/frontmatter）原样保留。 */
export function applyAutoFix(content: string, autoRules: RegexRuleRecord[], maskedRanges: MaskedRange[]): string {
    if (maskedRanges.length === 0) {
        return applyRulesToText(content, autoRules);
    }
    let result = "";
    let cursor = 0;
    for (const [start, end] of maskedRanges) {
        if (start > cursor) {
            result += applyRulesToText(content.slice(cursor, start), autoRules);
        }
        result += content.slice(start, end);
        cursor = end;
    }
    if (cursor < content.length) {
        result += applyRulesToText(content.slice(cursor), autoRules);
    }
    return result;
}

export type AutoFixChange = {
    from: number;
    to: number;
    deleted: string;
    inserted: string;
    ruleId: string;
    title: string;
};

export type AutoFixResult = {
    fixed: string;
    changes: AutoFixChange[];
};

/** 在非遮罩区段内应用 auto 规则替换，同时返回可用于 UI diff 标注的最终文本区间。 */
export function applyAutoFixWithChanges(content: string, autoRules: RegexRuleRecord[], maskedRanges: MaskedRange[]): AutoFixResult {
    if (maskedRanges.length === 0) {
        return applyRulesToTextWithChanges(content, autoRules, 0);
    }

    let fixed = "";
    let cursor = 0;
    const changes: AutoFixChange[] = [];
    for (const [start, end] of maskedRanges) {
        if (start > cursor) {
            const segment = applyRulesToTextWithChanges(content.slice(cursor, start), autoRules, fixed.length);
            fixed += segment.fixed;
            changes.push(...segment.changes);
        }
        fixed += content.slice(start, end);
        cursor = end;
    }
    if (cursor < content.length) {
        const segment = applyRulesToTextWithChanges(content.slice(cursor), autoRules, fixed.length);
        fixed += segment.fixed;
        changes.push(...segment.changes);
    }
    return {fixed, changes};
}

/** 顺序应用各 auto 规则的确定性替换；原生 String.replace 支持 $1 反向引用与 lookbehind。 */
export function applyRulesToText(text: string, rules: RegexRuleRecord[]): string {
    let result = text;
    for (const rule of rules) {
        if (rule.action.type !== "replace") {
            continue;
        }
        const replacement = rule.action.replacements[0] ?? "";
        for (const target of rule.detector.targets) {
            result = result.replace(new RegExp(target, ensureGlobalFlags(rule.detector.flags)), replacement);
        }
    }
    return result;
}

type LocalEdit = {
    from: number;
    to: number;
    finalFrom: number;
    finalTo: number;
    insertedLength: number;
    deleted: string;
    inserted: string;
    ruleId: string;
    title: string;
};

function applyRulesToTextWithChanges(text: string, rules: RegexRuleRecord[], baseOffset: number): AutoFixResult {
    let fixed = text;
    let changes: AutoFixChange[] = [];
    for (const rule of rules) {
        if (rule.action.type !== "replace") {
            continue;
        }
        const replacementTemplate = rule.action.replacements[0] ?? "";
        for (const target of rule.detector.targets) {
            const regex = new RegExp(target, ensureGlobalFlags(rule.detector.flags));
            const edits: LocalEdit[] = [];
            let next = "";
            let cursor = 0;
            let match: RegExpExecArray | null;
            while ((match = regex.exec(fixed)) !== null) {
                const deleted = match[0];
                if (deleted.length === 0) {
                    regex.lastIndex++;
                }
                const inserted = expandReplacementTemplate(replacementTemplate, match, fixed);
                next += fixed.slice(cursor, match.index);
                const finalFrom = next.length;
                next += inserted;
                if (deleted !== inserted) {
                    edits.push({
                        from: match.index,
                        to: match.index + deleted.length,
                        finalFrom,
                        finalTo: finalFrom + inserted.length,
                        insertedLength: inserted.length,
                        deleted,
                        inserted,
                        ruleId: rule.id,
                        title: rule.title,
                    });
                }
                cursor = match.index + deleted.length;
            }
            if (cursor === 0 && edits.length === 0) {
                continue;
            }
            next += fixed.slice(cursor);
            if (edits.length > 0) {
                changes = transformAutoFixChanges(changes, edits);
                changes.push(...edits.map((edit) => ({
                    from: edit.finalFrom,
                    to: edit.finalTo,
                    deleted: edit.deleted,
                    inserted: edit.inserted,
                    ruleId: edit.ruleId,
                    title: edit.title,
                })));
            }
            fixed = next;
        }
    }
    return {
        fixed,
        changes: changes.map((change) => ({
            ...change,
            from: baseOffset + change.from,
            to: baseOffset + change.to,
        })),
    };
}

function transformAutoFixChanges(changes: AutoFixChange[], edits: LocalEdit[]): AutoFixChange[] {
    return changes.flatMap((change) => {
        const localChange = {
            ...change,
            from: change.from,
            to: change.to,
        };
        if (edits.some((edit) => localChange.from < edit.to && localChange.to > edit.from)) {
            return [];
        }
        return [{
            ...change,
            from: transformPosition(change.from, edits),
            to: transformPosition(change.to, edits),
        }];
    });
}

function transformPosition(position: number, edits: LocalEdit[]): number {
    let delta = 0;
    for (const edit of edits) {
        if (position <= edit.from) {
            return position + delta;
        }
        if (position >= edit.to) {
            delta += edit.insertedLength - (edit.to - edit.from);
            continue;
        }
        return edit.finalTo;
    }
    return position + delta;
}

export type SingleIssueReplacement = {
    replacement: string;
    fixed: string;
};

export type SingleIssueReplacementOptions = {
    /** 默认只允许 auto；Web 修复模式可显式允许 candidate，由用户逐条确认后应用。 */
    allowedFixabilities?: Fixability[];
};

/**
 * 在全文上下文里只替换某一个 scanner 命中。
 * 不能只对 issue.match 做 replace：lookbehind、捕获组和前后文相关规则都需要原文上下文。
 */
export function applySingleIssueReplacement(content: string, issue: Issue, startOffset: number, options: SingleIssueReplacementOptions = {}): SingleIssueReplacement | null {
    const rule = issue.rule;
    const allowedFixabilities = options.allowedFixabilities ?? ["auto"];
    // handler 命中（无 regex detector）没有可复放的机械替换，直接拒绝。
    if (!("detector" in rule) || rule.detector.type !== "regex") {
        return null;
    }
    if (!allowedFixabilities.includes(rule.fixability) || rule.action.type !== "replace") {
        return null;
    }

    let regex: RegExp;
    try {
        regex = new RegExp(issue.target, ensureGlobalFlags(rule.detector.flags));
    } catch {
        return null;
    }

    regex.lastIndex = startOffset;
    const match = regex.exec(content);
    if (!match || match.index !== startOffset || match[0] !== issue.match) {
        return null;
    }

    const replacement = expandReplacementTemplate(rule.action.replacements[0] ?? "", match, content);
    return {
        replacement,
        fixed: `${content.slice(0, startOffset)}${replacement}${content.slice(startOffset + match[0].length)}`,
    };
}

/** 展开 JS String.replace 支持的常用 `$` 替换模板。 */
function expandReplacementTemplate(template: string, match: RegExpExecArray, content: string): string {
    return template.replace(/\$(\$|&|`|'|<[^>]+>|\d{1,2})/g, (token: string, key: string) => {
        if (key === "$") {
            return "$";
        }
        if (key === "&") {
            return match[0];
        }
        if (key === "`") {
            return content.slice(0, match.index);
        }
        if (key === "'") {
            return content.slice(match.index + match[0].length);
        }
        if (key.startsWith("<") && key.endsWith(">")) {
            return match.groups?.[key.slice(1, -1)] ?? "";
        }
        if (!/^\d{1,2}$/.test(key)) {
            return token;
        }
        const twoDigitIndex = Number(key);
        if (key.length === 2 && match[twoDigitIndex] === undefined) {
            const oneDigitIndex = Number(key.slice(0, 1));
            const suffix = key.slice(1);
            return oneDigitIndex > 0 && match[oneDigitIndex] !== undefined
                ? `${match[oneDigitIndex]}${suffix}`
                : token;
        }
        if (twoDigitIndex <= 0) {
            return token;
        }
        return match[twoDigitIndex] ?? "";
    });
}
