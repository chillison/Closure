import {DEFAULT_NAMESPACE_ALIASES} from "./namespaces";
import type {
    ActiveHandlerRuleRecord,
    ActiveRuleRecord,
    DensityRuleRecord,
    LoadedRules,
    NormalizedLlmlintConfig,
    NormalizedRuleOverride,
    RegistrySummary,
    RegexRuleRecord,
    Review,
    RuleDetectorKind,
    RuleLevel,
    RuleRegistryCatalogItem,
    SemanticRuleRecord,
} from "./types";

/**
 * 一条规则的判据类别。
 *
 * handler 规则的算法在代码里、没有 `detector` 字段，所以不能直接读 `detector.type`；
 * 这个函数是「靠什么判据命中」的唯一读法，reporter 的过滤与 guide 的档位选择共用。
 */
export function ruleDetectorKind(rule: ActiveRuleRecord): RuleDetectorKind {
    return "handler" in rule ? "handler" : rule.detector.type;
}

/** 规则在应用配置覆盖过程中的可变状态。 */
type RuleState = {
    enabled: boolean;
    level: RuleLevel;
    review: Review;
    fixability: ActiveRuleRecord["fixability"];
};

/**
 * 从完整规则目录生成当前配置下的 active registry。
 *
 * 这是浏览器与 CLI 共用的纯函数：不读文件系统，只应用 ruleset / namespace / rule 覆盖。
 */
export function materializeRules(options: {
    catalog: RuleRegistryCatalogItem[];
    config: NormalizedLlmlintConfig;
    diagnostics: LoadedRules["diagnostics"];
    namespaceAliases: Record<string, string>;
    loadedRulesets: string[];
}): LoadedRules {
    const activeRules = options.catalog
        .flatMap((item) => applyConfig(item, options.config, options.namespaceAliases));
    const regexRules = activeRules.filter((rule): rule is RegexRuleRecord => "detector" in rule && rule.detector.type === "regex");
    const semanticRules = activeRules.filter((rule): rule is SemanticRuleRecord => "detector" in rule && rule.detector.type === "semantic");
    const densityRules = activeRules.filter((rule): rule is DensityRuleRecord => "detector" in rule && rule.detector.type === "density");
    const handlerRules = activeRules.filter((rule): rule is ActiveHandlerRuleRecord => "handler" in rule);

    return {
        rules: activeRules,
        regexRules,
        semanticRules,
        densityRules,
        handlerRules,
        diagnostics: options.diagnostics,
        summary: summarizeRegistry(options.catalog, activeRules, options.loadedRulesets),
    };
}

function applyConfig(item: RuleRegistryCatalogItem, config: NormalizedLlmlintConfig, aliases: Record<string, string>): ActiveRuleRecord[] {
    const rulesetSetting = config.rulesetOverrides[item.rule.ruleset];
    let state: RuleState = {
        enabled: item.defaultEnabled,
        level: item.rule.level,
        review: item.rule.review,
        fixability: item.rule.fixability,
    };

    if (rulesetSetting === "on") {
        state = {...state, enabled: true};
    }

    // 覆盖优先级：rule id > namespace。后应用者覆盖前者。
    state = applyOverride(state, resolveNamespaceOverride(config.namespaces, item.rule.namespace, aliases));
    state = applyOverride(state, config.rules[item.rule.id]);

    return state.enabled
        ? [{...item.rule, level: state.level, review: state.review, fixability: state.fixability}]
        : [];
}

function resolveNamespaceOverride(overrides: Record<string, NormalizedRuleOverride>, namespace: string, aliases: Record<string, string>): NormalizedRuleOverride | undefined {
    for (const [key, override] of Object.entries(overrides)) {
        if (normalizeNamespace(key, aliases) === namespace) {
            return override;
        }
    }
    return undefined;
}

function normalizeNamespace(namespace: string, aliases: Record<string, string> = DEFAULT_NAMESPACE_ALIASES): string {
    return aliases[namespace] ?? namespace;
}

/** 应用单个归一覆盖 patch：只对显式设置的字段做覆盖，未设置的字段保持原状。 */
function applyOverride(state: RuleState, override: NormalizedRuleOverride | undefined): RuleState {
    if (override === undefined) {
        return state;
    }
    return {
        enabled: override.enabled ?? state.enabled,
        level: override.level ?? state.level,
        review: override.review ?? state.review,
        fixability: override.fixability ?? state.fixability,
    };
}

function summarizeRegistry(items: RuleRegistryCatalogItem[], activeRules: ActiveRuleRecord[], rulesets: string[]): RegistrySummary {
    const activeIds = new Set(activeRules.map((rule) => rule.id));
    const namespaceMap = new Map<string, {namespace: string; totalRules: number; activeRules: number}>();

    for (const item of items) {
        const current = namespaceMap.get(item.rule.namespace) ?? {
            namespace: item.rule.namespace,
            totalRules: 0,
            activeRules: 0,
        };
        current.totalRules++;
        if (activeIds.has(item.rule.id)) {
            current.activeRules++;
        }
        namespaceMap.set(item.rule.namespace, current);
    }

    return {
        rulesets,
        totalRules: items.length,
        activeRules: activeRules.length,
        disabledRules: items.length - activeRules.length,
        namespaces: [...namespaceMap.values()].sort((left, right) => left.namespace.localeCompare(right.namespace)),
    };
}
