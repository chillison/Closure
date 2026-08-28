export type RuleLevel = "high" | "medium" | "low";

/**
 * 审查受众：决定一条命中默认进入哪个审查出口，独立于严重度 level 与判据类别 detector。
 *
 * 注意这是**审查期**的维度，不能直接当写作期的取舍依据：命中给 human 看表示
 * 「置信度不足，别让 Agent 自动改」，而写作期多提一句约束并不会损坏既有正文，
 * 代价结构完全不同（实测判别力最强的几条规则恰好都在 human 桶）。
 * 写作期的取舍见 guide.ts 的档位定义。
 * - agent：需要 Agent/LLM 读上下文判断，check 默认输出。
 * - human：偏人工或作者风格偏好的检查，默认不喂给 Agent。
 * - none：机械/诊断类规则，默认不进入审查输出。
 */
export type Review = "agent" | "human" | "none";

/**
 * 机械修复能力：描述规则能否被确定性替换，决定 fix 命令是否自动改写。
 * - auto：单一确定替换，由 fix 命令自动修复（默认 dry-run，--write 落盘）。
 * - candidate：有删除/替换候选，但仍需判断上下文。
 * - manual：无机械替换，需要人工或 LLM 改写。
 */
export type Fixability = "auto" | "candidate" | "manual";

/** 配置里按规则/命名空间覆盖时的对象形态；与字符串简写并存，可显式 enable/disable 并调整维度。 */
export type RuleOverrideObject = {
    /** 显式启停；未设置=不改变规则的 enable 状态。 */
    enabled?: boolean;
    level?: RuleLevel;
    review?: Review;
    fixability?: Fixability;
};

export type RuleOverride = "off" | "warn" | "error" | RuleLevel | RuleOverrideObject;

/**
 * 归一化后的覆盖项：字符串简写也展开成这个 patch 形态，是 loader 的唯一消费形态。
 * 字符串语法糖：off→{enabled:false}，warn→{enabled:true,level:medium}，error→{enabled:true,level:high}，
 * high/medium/low→{enabled:true,level:X}。未设置的字段表示「不改变」。
 */
export type NormalizedRuleOverride = {
    /** 未设置=不改变 enable 状态。 */
    enabled?: boolean;
    level?: RuleLevel;
    review?: Review;
    fixability?: Fixability;
};

export type RulesetOverride = "off" | "on";

export type LlmlintOutput = "stylish" | "json";

export type LlmlintConfig = {
    /** 启用的规则包。为空时默认使用 builtin/default。 */
    rulesets?: string[];
    /** 允许加载未来 handler rule 的规则包；v1 仍不执行 handler。 */
    trustedRulesets?: string[];
    /** 按规则包启停。 */
    rulesetOverrides?: Record<string, RulesetOverride>;
    /** 按 namespace 批量关闭或调整级别；支持中文 alias。 */
    namespaces?: Record<string, RuleOverride>;
    /** 按规则 ID 覆盖级别；off 表示禁用该规则。 */
    rules?: Record<string, RuleOverride>;
    /** 项目级豁免词（世界观术语、绰号、章名）。命中区间与豁免词出现区间重叠即丢弃该命中。 */
    ignoreTerms?: string[];
    output?: LlmlintOutput;
};

export type NormalizedLlmlintConfig = {
    rulesets: string[];
    trustedRulesets: string[];
    rulesetOverrides: Record<string, RulesetOverride>;
    namespaces: Record<string, NormalizedRuleOverride>;
    rules: Record<string, NormalizedRuleOverride>;
    ignoreTerms: string[];
    output: LlmlintOutput;
};

export type RulesetManifest = {
    id: string;
    title: string;
    version: string;
    description?: string;
    namespaceAliases?: Record<string, string>;
};

export type LintRuleRecord = DeclarativeRuleRecord | HandlerRuleRecord;

/** 扫描域的文本层。narrative=成对分隔符外的叙述；quoted=成对分隔符内（含分隔符）；all=全文。 */
export type ScanScopeLayer = "narrative" | "quoted" | "all";

/**
 * 扫描域：规则在哪一层文本、哪个位置窗口上生效。磁盘规则可省略，loader 归一为 all。
 * 不变量：fixability 为 auto/candidate 的规则必须是全文全域（loader 强制降级）——
 * narrative/quoted 视图是等长派生文本，机械修复在派生视图上会写坏原文。
 */
export type ScanScope = {
    /** 文本层；缺省 = all。 */
    layer?: ScanScopeLayer;
    /** 位置窗口：只在当前 layer 的文首/文末 chars 个可见字符内生效。缺省 = 不限位置。 */
    position?: {kind: "opening" | "ending"; chars: number};
};

/** loader 解析后的扫描域。Active 规则与公开输出始终显式携带 layer。 */
export type ResolvedScanScope = {
    layer: ScanScopeLayer;
    position?: {kind: "opening" | "ending"; chars: number};
};

export type BaseLintRuleRecord = {
    id: string;
    namespace: string;
    /** 规则包来源由 loader 写入，规则文件中可省略。 */
    ruleset?: string;
    title: string;
    level: RuleLevel;
    /** 审查受众；缺省时由命名空间策略表或 detector/action 推导。 */
    review?: Review;
    /** 修复能力；缺省时由命名空间策略表或 detector/action 推导。 */
    fixability?: Fixability;
    enabled?: boolean;
    note?: string;
    /**
     * 判定示例。**必须同时能表达命中例与对照例**——只给反例会让消费方（尤其是写作期
     * 提示词）把「形近但可接受」的写法也一并规避掉，写出过度躲闪的干瘪文本。
     *
     * 早期形态是 `{bad, good?}`，`good` 被同时用作「改写后的版本」和「保留」这种裁决词，
     * 同一字段两种含义，消费方无法可靠区分正反例；`hit` 把这件事显式化。
     */
    examples?: Array<{
        /** 示例正文片段。 */
        text: string;
        /** 该片段是否命中本规则。false = 形近但不该报的对照例。 */
        hit: boolean;
        /** 命中例的建议改法；对照例（hit=false）留空。 */
        fix?: string;
        /** 为什么命中或为什么不命中。 */
        reason?: string;
    }>;
    source?: {
        version?: string;
        canonicalKey?: string;
        importedFrom?: string;
    };
    /** 扫描域；缺省 = 全文全域（向后兼容既有规则）。 */
    scope?: ScanScope;
};

export type RegexDetector = {
    type: "regex";
    targets: string[];
    flags?: string;
};

/**
 * 语义型 detector：命中判据是语义的，没有可稳定定位的词法、统计或算法特征，
 * 只能由读得懂上下文的判断者（人或模型）逐段读出来。
 *
 * 命名刻意描述「判据的性质」而不是「谁来执行」——四种 detector 是
 * 词法（regex）/ 统计（density）/ 算法（handler）/ 语义（semantic）四类判据。
 * 早期叫 `llm` 是按执行者命名，既和 `review:"agent"`（给谁看）撞语义，
 * 也和「全部规则在写作期都由模型消费」这个事实冲突。
 *
 * `prompt` 是审查期的判定流程（「判断文本是否…」），只在 `rules` 命令里输出；
 * 写作期摘要取 `action.message` 与 `examples[].bad`，见 references/rule-model.md。
 */
export type SemanticDetector = {
    type: "semantic";
    prompt: string;
};

/**
 * 密度型 detector：逐处正则报不了「套词 12 处/千字才是模板腔」这类分布指纹。
 * 所有门槛 AND 语义（全部满足才报）；计数与分母跳过遮罩区、豁免区与结构行。
 * fixability 恒为 manual（分布问题没有机械修复），loader 强制校验。
 */
export type DensityDetector = {
    type: "density";
    /** 计数模式组；总命中 = 各 pattern 命中之和。 */
    patterns: Array<{
        target: string;
        flags?: string;
        /** 统计桶名，缺省 "default"；供 minBuckets 多样性门槛。 */
        bucket?: string;
        /** 核心桶命中（coreMinHits 统计口径），缺省 false。 */
        core?: boolean;
    }>;
    /** 绝对次数门槛：总命中低于此数不报。 */
    minHits: number;
    /** 密度门槛：每千可见字命中数（按 scope 层可见字数计），缺省不设。 */
    perKilo?: number;
    /** 核心命中数门槛，缺省不设。 */
    coreMinHits?: number;
    /** 至少命中的不同桶数，缺省不设。 */
    minBuckets?: number;
    /** 参与评估的最小可见字数：文本太短不评密度，缺省不设。 */
    minChars?: number;
    /** 统计粒度：doc=全文一条（缺省）；paragraph=逐段（行）评估、逐段报。 */
    granularity?: "doc" | "paragraph";
};

export type DeclarativeRuleRecord = BaseLintRuleRecord & {
    detector: RegexDetector | SemanticDetector | DensityDetector;
    action:
        | {type: "replace"; replacements: string[]}
        | {type: "suggest"; message: string};
};

/**
 * handler rule：算法体编译进 skill 包的具名 handler（声明式模型表达不了的状态机/
 * 统计逻辑）。规则 JSON 仍是数据（level/review/scope/文案），只有算法在代码里；
 * 第三方规则包引用未注册的 handler 名会得到诊断并被跳过，天然拒绝外部代码。
 */
export type HandlerRuleRecord = BaseLintRuleRecord & {
    handler: {
        type: "builtin";
        /** 编译进 skill 包的 handler 注册表键名（skill/src/handler-rules）。 */
        name: string;
    };
    /** 命中呈现文案；handler 无机械修复，action 恒为 suggest。 */
    action: {type: "suggest"; message: string};
};

/** handler 契约：纯函数，输入按规则 scope 解析后的上下文，输出原文命中区间。 */
export type RuleHandler = (ctx: HandlerScanContext) => HandlerFinding[];

export type HandlerFinding = {
    index: number;
    length: number;
    /** 覆盖规则默认文案的动态补充说明（如具体计数）；呈现为 Issue.detail。 */
    message?: string;
};

/** loader 解析后的声明式规则：review / fixability 一定有值。 */
export type ActiveDeclarativeRuleRecord = Omit<DeclarativeRuleRecord, "scope"> & {
    ruleset: string;
    review: Review;
    fixability: Fixability;
    scope: ResolvedScanScope;
};

/** loader 解析后的 handler 规则；fixability 恒为 manual。 */
export type ActiveHandlerRuleRecord = Omit<HandlerRuleRecord, "scope"> & {
    ruleset: string;
    review: Review;
    fixability: Fixability;
    scope: ResolvedScanScope;
};

export type ActiveRuleRecord = ActiveDeclarativeRuleRecord | ActiveHandlerRuleRecord;

export type RegexRuleRecord = ActiveDeclarativeRuleRecord & {
    detector: RegexDetector;
};

export type SemanticRuleRecord = ActiveDeclarativeRuleRecord & {
    detector: SemanticDetector;
};

export type DensityRuleRecord = ActiveDeclarativeRuleRecord & {
    detector: DensityDetector;
};

export type RegistryDiagnostic = {
    level: "info" | "warning" | "error";
    code: string;
    message: string;
    ruleset?: string;
    ruleId?: string;
    namespace?: string;
    previousRuleset?: string;
    nextRuleset?: string;
};

export type RegistrySummary = {
    rulesets: string[];
    totalRules: number;
    activeRules: number;
    disabledRules: number;
    namespaces: Array<{
        namespace: string;
        totalRules: number;
        activeRules: number;
    }>;
};

export type LoadedRules = {
    rules: ActiveRuleRecord[];
    regexRules: RegexRuleRecord[];
    semanticRules: SemanticRuleRecord[];
    densityRules: DensityRuleRecord[];
    handlerRules: ActiveHandlerRuleRecord[];
    diagnostics: RegistryDiagnostic[];
    summary: RegistrySummary;
};

/**
 * 规则目录条目：保留默认启停状态，供浏览器端按用户覆盖重新生成 active registry。
 */
export type RuleRegistryCatalogItem = {
    rule: ActiveRuleRecord;
    defaultEnabled: boolean;
};

/** Markdown 遮罩区间：半开 `[start, end)`，字符索引空间与 scanner 的 `match.index` 一致。 */
export type MaskedRange = [number, number];

/** 带结构标记的行切分条目。offsets 与原文一致（end 含换行符，指向下一行起点）。 */
export type ScanLine = {
    start: number;
    end: number;
    /** 行文本（不含换行符与行尾 \r）。 */
    text: string;
    /** markdown 结构行（标题/列表/引用/表格/分隔线）或章节标题行；density/handler 统计默认跳过。 */
    structural: boolean;
};

/**
 * 扫描上下文：一次算好遮罩、引号分域与派生视图，供 regex / density / handler 三种 detector 共享。
 * 由 `prepareScanContext` 构建；纯数据，浏览器端可用。
 */
export type ScanContext = {
    content: string;
    /**
     * 三层等长视图：all 即原文引用（无拷贝）；narrative = 成对引号段（含引号）替换为等长 `。`；
     * quoted = 补集同法。换行符在所有视图中原样保留，`match.index` 与原文偏移一致。
     * narrative 规则作者须知：引号段呈现为 `。` 串，规则模式不得依赖「数句号」类判断。
     */
    layers: {all: string; narrative: string; quoted: string};
    /** markdown 结构遮罩（代码块/frontmatter/链接等）；命中起点落入即跳过。 */
    maskedRanges: MaskedRange[];
    /** 词级白名单区间；命中区间与之重叠即丢弃。 */
    ignoreRanges: MaskedRange[];
    /** 成对引号区间（含引号本身），行内配对；诊断/报告可复用。 */
    quotedRanges: MaskedRange[];
    /** 行切分结果；density(paragraph) 与 handler 复用，免逐个重算。 */
    lines: ScanLine[];
};

/** handler 的逐行紧凑投影。text 只含当前 layer 字符，map 可回到原文偏移。 */
export type HandlerLineProjection = {
    text: string;
    map: number[];
};

/**
 * 单条 handler 的执行上下文。view 与原文等长；projection 供统计/状态机跳过非当前层字符，
 * allowsFinding 与 positionWindow 供 handler 和执行器统一守住 scope。
 */
export type HandlerScanContext = ScanContext & {
    scope: ResolvedScanScope;
    view: string;
    positionWindow: MaskedRange | null;
    /** position 检查起点，layer 检查完整 [start,end)；执行器会用它做第二次防御。 */
    allowsFinding: (start: number, end: number) => boolean;
    /** 从 start 生成不跨行、不跨 layer/Markdown 遮罩的连续短锚点。 */
    shortAnchor: (start: number, maxCodePoints?: number) => MaskedRange | null;
    projectLine: (line: ScanLine) => HandlerLineProjection;
    layerRangesOfLine: (line: ScanLine) => MaskedRange[];
};

export interface Issue {
    /** 命中来源规则：regex 逐处命中或 handler 命中（density 走 DensityIssue）。 */
    rule: RegexRuleRecord | ActiveHandlerRuleRecord;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    match: string;
    /** regex 命中 = 命中的 target 模式；handler 命中 = handler 注册表键名。 */
    target: string;
    /** handler 输出的动态补充说明（如具体计数）；regex 命中无此字段。 */
    detail?: string;
    context: {
        before: string;
        current: string;
        after: string;
    };
}

/** density 规则命中：全文（doc）/每段（paragraph）最多一条，锚在首个命中位置。 */
export type DensityIssue = {
    rule: DensityRuleRecord;
    line: number;
    column: number;
    /** 总命中次数。 */
    hits: number;
    /** 每千可见字命中数（分母跳过遮罩/豁免/结构行）。 */
    perKilo: number;
    /** 去重样本（≤8 条），供 Agent/人快速识别命中形态。 */
    samples: string[];
};

export type CheckSummary = {
    total: number;
    high: number;
    medium: number;
    low: number;
    /**
     * 正文可见字数，与 density `perKilo` 同分母（跳过结构行与遮罩区）。
     *
     * 用途是让修复前后能比篇幅——审稿流程要求删减不超过两成，没有这个数就只能靠外部
     * 工具数字，而 `wc` 数的是全部字符（含标点空白），与规则命中的千字口径对不上。
     *
     * 缺省 = 调用方没有提供原文上下文（例如 web 从已有命中重建报告），此时报告不输出篇幅。
     */
    visibleChars?: number;
};

/**
 * 紧凑报告里的规则元数据：按 rule id 去重提到报告顶层，Agent 做「修 / 留 / 问」判断要用的字段全在这里。
 *
 * 剔除的是规则作者才需要的字段：`detector`（长正则）、`source.canonicalKey`、`examples`、
 * `enabled`、`ruleset`。它们在逐处内联时是 JSON 体积的主要来源，而对单轮审稿判断没有作用。
 * 需要完整形态时用 `check --rule-detail`。
 */
export type CompactRuleEntry = {
    namespace: string;
    title: string;
    level: RuleLevel;
    review: Review;
    fixability: Fixability;
    scope: ResolvedScanScope;
    action: DeclarativeRuleRecord["action"];
    /** 规则整理留下的处理边界说明；缺省 = 该规则没有额外说明。 */
    note?: string;
};

/** 紧凑报告里的单处命中：规则元数据在顶层 `rules[ruleId]`，此处只留位置与文本证据。 */
export type CompactIssue = {
    ruleId: string;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    match: string;
    /** handler 输出的动态补充说明（如具体计数）；regex 命中无此字段。 */
    detail?: string;
    /**
     * 命中前后文。`before`/`after` 已按码点裁到上限，被裁掉时带省略号标记；
     * 完整整行前后文在 `--rule-detail` 形态里。
     */
    context: {
        before: string;
        current: string;
        after: string;
    };
};

/** 紧凑报告里的密度指纹：同样把规则元数据挪到顶层 `rules`。 */
export type CompactDensityIssue = {
    ruleId: string;
    line: number;
    column: number;
    /** 总命中次数。 */
    hits: number;
    /** 每千可见字命中数。 */
    perKilo: number;
    /** 去重样本（≤8 条）。 */
    samples: string[];
};

/** 紧凑报告的 registry 概览：去掉逐 namespace 明细（70 条 × 3 字段），只留总数与规则包列表。 */
export type CompactRegistrySummary = Omit<RegistrySummary, "namespaces">;

/**
 * 单文件 check 的默认 JSON 报告（紧凑形态）。
 * 规则元数据去重到 `rules`，命中只引用 `ruleId`；`--rule-detail` 输出 CheckDetailJsonReport。
 */
export type CheckJsonReport = {
    kind: "check";
    filePath: string;
    configPath: string | null;
    summary: CheckSummary;
    /** CLI 级别 / 审查受众过滤信息；check 默认按 review 过滤，故一定存在。 */
    filter: CheckFilterInfo;
    registry: CompactRegistrySummary;
    diagnostics: RegistryDiagnostic[];
    /** 本次报告涉及的规则元数据，按 rule id 去重。issues/densityIssues 的 ruleId 一定能在这里查到。 */
    rules: Record<string, CompactRuleEntry>;
    issues: CompactIssue[];
    /** density 规则命中；缺省 = 未跑 density 扫描。 */
    densityIssues?: CompactDensityIssue[];
};

/** 单文件 check 的完整 JSON 报告（`--rule-detail`）：命中内联完整规则对象，registry 带逐 namespace 明细。 */
export type CheckDetailJsonReport = {
    kind: "check";
    filePath: string;
    configPath: string | null;
    summary: CheckSummary;
    filter: CheckFilterInfo;
    registry: RegistrySummary;
    diagnostics: RegistryDiagnostic[];
    issues: Issue[];
    densityIssues?: DensityIssue[];
};

/** CLI 级别 / 审查受众过滤信息，check 与 check-multi 共用。 */
export type CheckFilterInfo = {
    review: Review | "all";
    hiddenByReview: number;
    minLevel: RuleLevel;
    hiddenByLevel: number;
};

/**
 * 规则的判据类别。handler 规则没有 `detector` 字段（算法在代码里），
 * 所以这不是 `detector.type` 的别名，而是「这条规则靠什么判据命中」的统一说法。
 */
export type RuleDetectorKind = "regex" | "density" | "handler" | "semantic";

/** rules 命令的 JSON 报告：规则库检视，覆盖全部判据类别而不只是语义规则。 */
export type RulesJsonReport = {
    kind: "rules";
    configPath: string | null;
    registry: RegistrySummary;
    diagnostics: RegistryDiagnostic[];
    /** 应用过滤后的规则；无过滤条件时为全部 active 规则。 */
    rules: ActiveRuleRecord[];
    filter: {
        /** all 表示不按判据过滤。 */
        detector: RuleDetectorKind | "all";
        /** null 表示不按 namespace 过滤。 */
        namespace: string | null;
    };
};

/** 多文件 check 的单文件条目。 */
export type CheckFileEntry = {
    filePath: string;
    summary: CheckSummary;
    issues: Issue[];
    /** density 规则命中；缺省 = 未跑 density 扫描。 */
    densityIssues?: DensityIssue[];
};

/** 多文件紧凑报告的单文件条目；规则元数据在报告顶层共享，逐文件不重复。 */
export type CompactCheckFileEntry = {
    filePath: string;
    summary: CheckSummary;
    issues: CompactIssue[];
    densityIssues?: CompactDensityIssue[];
};

/**
 * 多文件 check 的默认报告（紧凑形态）；registry/diagnostics/filter/rules 为全局，files 为逐文件结果。
 * `rules` 跨全部文件共享，所以多文件场景的去重收益比单文件更大。
 */
export type CheckMultiJsonReport = {
    kind: "check-multi";
    configPath: string | null;
    filter: CheckFilterInfo;
    registry: CompactRegistrySummary;
    diagnostics: RegistryDiagnostic[];
    /** 全部文件涉及的规则元数据，按 rule id 去重。 */
    rules: Record<string, CompactRuleEntry>;
    files: CompactCheckFileEntry[];
    summary: CheckSummary;
};

/** 多文件 check 的完整报告（`--rule-detail`）。 */
export type CheckMultiDetailJsonReport = {
    kind: "check-multi";
    configPath: string | null;
    filter: CheckFilterInfo;
    registry: RegistrySummary;
    diagnostics: RegistryDiagnostic[];
    files: CheckFileEntry[];
    summary: CheckSummary;
};

/** fix 命令的逐规则修复计数。 */
export type FixRuleCount = {
    ruleId: string;
    title: string;
    count: number;
};

/** fix 命令的单文件结果（占位/统计用，不含正文）。 */
export type FixFileEntry = {
    filePath: string;
    changed: boolean;
    /** 该文件在可编辑区域内命中的 auto 规则次数。 */
    occurrences: number;
    ruleCounts: FixRuleCount[];
};

/** fix 命令报告。write=false 为 dry-run（仅预览，不落盘）。 */
export type FixReport = {
    kind: "fix";
    configPath: string | null;
    write: boolean;
    files: FixFileEntry[];
    totalOccurrences: number;
};

/** fix 命令在内存中的完整单文件结果（含正文，供预览与写盘）。 */
export type FixFileResult = {
    filePath: string;
    content: string;
    fixed: string;
    changed: boolean;
    issues: Issue[];
};

export type CuratedRulesetReport = {
    rulesetId: string;
    outputRoot: string;
    sourceFiles: string[];
    originalTargets: number;
    rules: number;
    activeRules: number;
    converted: {
        text: number;
        simple: number;
        regex: number;
    };
    replacementConflicts: number;
};

export type CuratedImportJsonReport = {
    kind: "curated-import";
    sourceRoot: string;
    outputRoot: string;
    sourceFiles: number;
    originalTargets: number;
    uniqueRules: number;
    converted: {
        text: number;
        simple: number;
        regex: number;
    };
    skipped: Array<{
        file: string;
        group: string;
        reason: string;
        target?: string;
    }>;
    rulesets: CuratedRulesetReport[];
};
