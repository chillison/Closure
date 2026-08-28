// Narrative enum vocab seeds — 叙事枚举策展词表 + prompt 指引格式化。
// Story 1.9（epics.md Story 1-9 / FR-532）：给 scene_graph 加三个语义型结构角色字段——
// 场级 outcomeType（结果）/ pacingRole（张弛角色）+ 线级 mice_type（MICE 叙事单元 + 收束契约）。
// 三字段在 creative-fields.ts 落 schema 为 z.string().optional()（自由值），本文件提供策展词表
// 作 story-planner 生成时的先验注入（经 contextBuilder.formatNarrativeEnumGuide），让 LLM 产出
// 更贴合文学词表的结构角色分类，但不锁死（词表外的精确值仍合法）。
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md)：三字段是语义型枚举（场/线的
// 结构角色分类 = 叙事判断），穷举归 LLM。封闭 enum（z.enum）让纯代码按词库命中 pass/fail 判叙事
// 分类 = 假信心门（ADR-3），且写作思维原理 :474 反对过度解构（封闭枚举反限思路）。故：
// - schema 收任意 string（D1，自由值）；
// - 词表是确定性数据（类比 PATTERN_SEEDS），formatNarrativeEnumGuide 是纯字符串格式化（类比
//   formatPatternGuide），零 LLM、零主观阈值；
// - 词表是「先验提示非门禁」（§3.10），LLM 可超出词表自造更精确值。
//
// 区别于机械型枚举（sceneNodeRole / lineTopologyRole / sceneEdgeType）：那些是纯代码 dispatch
// （LINE_VALIDATION_PROFILE 路由 / DAG 校验）必须 closed；本文件三字段是语义型 LLM 消费 → 开放。
//
// 内容来源：写作思维原理策展（非 NeuroBook 菜单照搬）。中文优先；mice 注解保留英文原名（Milieu/
// Idea/Character/Event）溯源性 + 收束条件（其核心价值——线怎样才算「收束」）。
//
// expected_downstream_consumers:
// - Story 4.1 brief 10 段：pacingRole → §4 节奏/牵引；outcomeType/mice_type → §6 关键剧情点。
// - Story 4/10 retrieval：按结构角色召回（语义匹配词表 + 自由值）。
// - Epic 6 / 创作完整性：mice_type 收束检查（该线收了没）。
// - Epic 3 工作台 UI：输入框 + 词表补全 chips（非下拉单选）。

// ── 场·结果类型（SceneNode.outcomeType）──
// 本场结果（主角主动尝试的得/失/逆转/无对抗）。6 项中文策展（覆盖典型场结果光谱）。
export const OUTCOME_TYPE_VOCAB = [
  { value: '达成', gloss: '得到欲望目标，爽点/满足感' },
  { value: '惨胜', gloss: '得到，但付代价或埋下新隐患' },
  { value: '受挫', gloss: '没得到，情绪下行（压抑/落差/绝望）' },
  { value: '反转', gloss: '突破读者预期，局面逆转' },
  { value: '无冲突', gloss: '非对抗场（铺垫/日常/信息场），无主动尝试结果' },
  { value: '被动', gloss: '主角被动承受，未主动尝试' },
] as const;

// ── 场·张弛角色（SceneNode.pacingRole）──
// 本场在节奏曲线中的张弛角色（蓄/推/峰/缓/收）。5 项中文策展。
export const PACING_ROLE_VOCAB = [
  { value: '铺垫', gloss: '建场、埋线、蓄势' },
  { value: '推进', gloss: '矛盾递进、节奏加快' },
  { value: '高潮', gloss: '冲突顶点、情绪最高' },
  { value: '喘息', gloss: '支线/日常放缓节奏、调节张力' },
  { value: '收束', gloss: '结局反馈、满足情绪、承上启下' },
] as const;

// ── 线·叙事单元（SceneLine.mice_type）──
// MICE 叙事单元类型 + 收束契约（线怎样才算「收束」）。4 项中文策展，注解含英文原名 + 收束条件。
// 来源：Card/SF 编叙事单元理论（Milieu/Idea/Character/Event）。线级（场属于线，场非叙事单元）。
export const MICE_TYPE_VOCAB = [
  { value: '世界', gloss: 'Milieu；游历一个世界/环境，收束=离开或回归那个世界' },
  { value: '观念', gloss: 'Idea；一个悬而未决的观念或谜，收束=真相揭晓/论点落定' },
  { value: '角色', gloss: 'Character；一个人的转变，收束=自我认知达成/身份转化' },
  { value: '事件', gloss: 'Event；一次打破秩序的事件，收束=新平衡成立' },
] as const;

// ── formatNarrativeEnumGuide（纯函数，design §3.2 / Step C3）──
// 把三词表格式化成 prompt 注入文本。story-planner prompt 经 contextBuilder 拼进 context
// （mustache `{{narrativeEnumGuide}}`）。恒在（静态词表，零 projectDocument 依赖，零 LLM）——
// 区别于 patternGuide 读 creative_brief.structure_pattern 派生：narrative enum 词表是通用先验，
// 所有 creative run 都带（非 story-planner 的 agent 不引用 = 无害，同 patternGuide）。
// 确定性字符串格式化，零 LLM、零主观阈值。
export function formatNarrativeEnumGuide(): string {
  const formatEntries = (vocab: ReadonlyArray<{ value: string; gloss: string }>): string =>
    vocab.map((entry) => `${entry.value}：${entry.gloss}`).join('\n');

  return [
    '【叙事枚举词表（先验，可超出——按词表值起步，也可自造更精确的值）】',
    '',
    '【场·结果类型 outcomeType】本场主角主动尝试的得/失/逆转：',
    formatEntries(OUTCOME_TYPE_VOCAB),
    '',
    '【场·张弛角色 pacingRole】本场在节奏曲线中的张弛角色：',
    formatEntries(PACING_ROLE_VOCAB),
    '',
    '【线·叙事单元 mice_type】该线的叙事单元类型 + 怎样才算收束：',
    formatEntries(MICE_TYPE_VOCAB),
  ].join('\n');
}
