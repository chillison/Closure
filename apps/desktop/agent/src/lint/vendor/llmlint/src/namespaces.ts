import type {Fixability, Review} from "./types";

/**
 * 内置中文组名到稳定英文 namespace 的映射。
 */
export const DEFAULT_NAMESPACE_ALIASES: Record<string, string> = {
    "填充短语": "filler",
    "机械过渡": "transition.mechanical",
    "二元对比": "contrast.binary",
    "负向列举": "contrast.negative-listing",
    "喉舌式开头": "opening.mouthpiece",
    "元叙述": "meta",
    "公式化设问": "rhetorical-question",
    "强调拐杖": "emphasis-crutch",
    "商务黑话": "jargon.business",
    "懒惰绝对词": "absolute",
    "抽象空洞": "abstraction.hollow",
    "行动者": "actor.hidden",
    "节奏与评分": "rhythm",
    "形副词系": "modifier",
    "形副词[可选]": "modifier",
    "形副量词": "modifier.measure",
    "删陈词滥调": "cliche",
    "修剪复合句": "sentence.compound",
    "修剪比喻类": "metaphor",
    "人体词汇": "vocabulary.body",
    "人体词汇转换": "vocabulary.body",
    "R18词汇": "vocabulary.r18",
    "学术与解剖词汇": "vocabulary.academic-anatomy",
    "动作与神态": "action-expression",
    "颜色描写": "color-description",
    "破折号": "punctuation.dash",
    "连续符号去重": "punctuation.dedup",
    "正则-高级替换": "regex.advanced",
    "正则-杀“一声”": "sound.once",
    "八股句式/短语删除": "cliche.baguwen",
    "词汇替换[可选]": "vocabulary.optional",
    "处理多类型增殖": "proliferation.mixed",
    "处理多种增殖[选开]": "proliferation.mixed",
    "处理破折号增殖（和角色卡交互有冲突关掉这个开新对话）": "punctuation.dash-proliferation",
    "处理破折号增殖（角色卡交互有问题关掉这个）": "punctuation.dash-proliferation",
    "处理—…增殖[选开]": "punctuation.dash-ellipsis-proliferation",
    "合并较短段落[选开]": "paragraph.merge-short",
    "分割较长段落[选开]": "paragraph.split-long",
    "不是而是": "contrast.binary",
    "三": "numeral.three",
    "合集 3": "collection.deepseek",
    "语气": "tone",
    "像像像": "metaphor.like",
    "嘴角与生理泪水": "cliche.body-reaction",
    "极其替换": "modifier.extreme",
    "极其删除": "modifier.extreme",
    "由于删除": "causal.due-to",
    "生理删除": "modifier.physiological",
    "开场套话": "opening.cliche",
    "渲染性强调": "inflation.significance",
    "价值拔高": "inflation.significance",
    "过渡废话": "transition.summary",
    "无源引用": "attribution.vague",
    "正能量收尾": "cliche.uplift",
    "谄媚": "sycophantic",
    "工程师腔": "jargon.engineer",
    "调试腔": "jargon.engineer",
    "自媒体腔": "jargon.social",
    "翻译腔": "translationese",
    "戏剧化碎句": "structure.fragment",
    "音量反差腔": "cliche.voice-contrast",
    "预告式收尾": "ending.trailer",
    "章尾预告腔": "ending.trailer",
    "解释链": "explanation.chain",
    "动作清单": "rhythm.action-list",
    "监控动作清单": "rhythm.action-list",
    "碎句号": "rhythm.period-stutter",
    "过度精炼": "rhythm.overcompressed",
    "低连接密度": "rhythm.low-connective",
    "公文腔公告": "register.notice",
    "工程词泄漏": "mechanical.stage-leak",
    "微动作复读": "rhythm.micro-action",
};

/** 命名空间级审查策略：curation 的主交付物，决定哪些命名空间默认不喂给 Agent。 */
export type NamespacePolicy = {
    review?: Review;
    fixability?: Fixability;
};

/**
 * 内置命名空间的审查受众与修复能力默认策略。
 *
 * 设计意图：默认 `check --review agent` 只展示真正值得 Agent 处理的 AI 痕迹（填充、机械过渡、
 * 二元对比、喉舌开头、陈词滥调等），把在中文小说里误伤率高、更偏作者
 * 风格偏好的命名空间（破折号、比喻、泛词形副词、段落结构、节奏评分）降到 `human` 桶，把纯
 * 机械去重降到 `none` 桶。未列出的命名空间走 detector/action 推导，默认 `agent`。
 *
 * 这张表是“默认降噪”的真正杠杆，可按项目偏好继续调整，调整这里不需要重生成规则文件。
 */
export const DEFAULT_NAMESPACE_POLICY: Record<string, NamespacePolicy> = {
    // 纯机械：省略号/破折号尾部清理。重复感叹/问号由规则级补丁降级为人工提示。
    "punctuation.dedup": {review: "none", fixability: "auto"},

    // 标点风格：破折号及其增殖在中文小说里高度依赖作者偏好，默认交人工
    "punctuation.dash": {review: "human", fixability: "manual"},
    "punctuation.dash-proliferation": {review: "human", fixability: "manual"},
    "punctuation.dash-ellipsis-proliferation": {review: "human", fixability: "manual"},
    "proliferation.mixed": {review: "human", fixability: "manual"},

    // 比喻：regex 难以判断是否原创妙喻，误伤率高，默认交人工
    "metaphor": {review: "human", fixability: "manual"},
    "metaphor.like": {review: "human", fixability: "manual"},

    // 泛词 / 形副词系：替换候选多但语境敏感，默认交人工
    "modifier": {review: "human", fixability: "manual"},
    "modifier.measure": {review: "human", fixability: "manual"},
    "modifier.extreme": {review: "human", fixability: "manual"},
    "modifier.physiological": {review: "human", fixability: "manual"},
    "absolute": {review: "human", fixability: "manual"},
    "abstraction.hollow": {review: "human", fixability: "manual"},

    // 题材 / 词表偏好：商业、人体、R18、解剖、颜色和“一声”替换都高度依赖项目文风。
    // 这些规则可提示作者复核，但不应在默认 Agent 视图里和 blocking 结构规则同权重出现。
    "jargon.business": {review: "human", fixability: "manual"},
    "vocabulary.body": {review: "human", fixability: "manual"},
    "vocabulary.r18": {review: "human", fixability: "manual"},
    "vocabulary.academic-anatomy": {review: "human", fixability: "manual"},
    "color-description": {review: "human", fixability: "manual"},
    "sound.once": {review: "human", fixability: "manual"},
    "regex.advanced": {review: "human", fixability: "manual"},

    // 结构与评分：段落切分、节奏评分属于宏观风格，不适合逐条喂 Agent
    "paragraph.merge-short": {review: "human", fixability: "manual"},
    "paragraph.split-long": {review: "human", fixability: "manual"},
    "rhythm": {review: "human", fixability: "manual"},
    "numeral.three": {review: "human", fixability: "manual"},

    // 工程师腔 / 自媒体腔：技术语境与网络用语都可能合理，误杀率高，默认交人工
    "jargon.engineer": {review: "human", fixability: "manual"},
    "jargon.social": {review: "human", fixability: "manual"},
    // 翻译腔：介词框架常合理，戏剧化碎句可能是刻意节奏，默认交人工
    "translationese": {review: "human", fixability: "manual"},
    "structure.fragment": {review: "human", fixability: "manual"},

    // 机械痕迹：零宽字符是确定性清理，安全自动修复；同形字需确认是否有意外文，默认交人工。
    // 占位符 / chatbot 泄漏走 derive=agent 默认展示（成稿里出现即明显错误）。
    "mechanical.zero-width": {review: "none", fixability: "auto"},
    "mechanical.homoglyph": {review: "human", fixability: "manual"},

    // story-deslop 校准导入：blocking 规则默认交 Agent；高误杀宏观分布默认交人工。
    "cliche.voice-contrast": {review: "agent", fixability: "manual"},
    "ending.trailer": {review: "agent", fixability: "manual"},
    "explanation.chain": {review: "agent", fixability: "manual"},
    "rhythm.action-list": {review: "human", fixability: "manual"},
    "rhythm.period-stutter": {review: "agent", fixability: "manual"},
    "rhythm.micro-action": {review: "agent", fixability: "manual"},
    "rhythm.overcompressed": {review: "human", fixability: "manual"},
    "rhythm.low-connective": {review: "human", fixability: "manual"},
    "register.notice": {review: "agent", fixability: "manual"},
    "mechanical.stage-leak": {review: "agent", fixability: "manual"},
};

/**
 * 当前创作语料报告确认的 strong 规则级路由覆盖。
 * 这些规则所在 namespace 默认偏人工，但规则本身有稳定区分力，应交 Agent 结合上下文判断。
 * 旧版曾把 absolute-claim / optional-mood 提权；当前正式 report 已降为 weak，回到 modifier human 桶。
 */
export const DEFAULT_RULE_POLICY: Record<string, NamespacePolicy> = {
    "cn.modifier.measure.subject-measure-word": {review: "agent"},
    "cn.proliferation.mixed.repeated-de-pairs": {review: "agent"},
};
