// Craft-type taxonomy vocabulary - 网文 craft 参考库 8 类策展词表。
// Story 2.1（epics.md Story 2-1 / FR-344）：全局 craft KB 的 craft_type 分类词表，
// 作 query_craft 工具描述 / UI 补全 / 查询建议的先验注入（非封闭枚举）。
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md)：craft_type 是
// 结构型分类标签（检索过滤域），但穷举归 LLM/用户（写作分类判断 = 语义）。
// 封闭 enum（z.enum）让纯代码按词库命中 pass/fail 判 craft 分类 = 假信心门
// （ADR-3），且写作思维原理 :474 反对过度解构（封闭枚举反限思路）。故：
// - schema 收任意 string（closureCraftQuerySchema.craft_type: z.string().optional()）；
// - 词表是确定性数据（类比 PATTERN_SEEDS / narrative-enums），零 LLM、零主观阈值；
// - 词表是「先验提示非门禁」，用户 frontmatter 直接写新 craft_type 即自建新类，
//   零 migration（mirror Story 1.9 narrative-enums 非封闭枚举惯例）。
//
// 8 类 + uncategorized 兜底（child5 design §1.2 + Story 2.1 增第 8 类「角色设计OC」）：
// 爽点 / 金手指 / 题材playbook / 桥段 / 节奏 / 力量体系 / 6 结构 pattern / 角色设计(OC)。
// `character` craft 类与 Epic 9 角色欲望 methodology skill 互补（参考材料 vs 提问机，不重复）。
//
// 内容来源：child5 `07-23-genre-craft-seed` design §1.2 划定。种子内容策展 defer 后续 story
// （用户 after-all-epics 另开 story 策展作项目初始自带；2.1 交付空库 + taxonomy + bundled 机制）。
//
// expected_downstream_consumers:
// - Story 2.2 设定助手：query_craft 查 craft 深化设定（L2.1）。
// - Story 2.5 GenreContract：craft_type='playbook' 子结构含题材标签（接 GenreContract）。
// - Epic 4 Writer/Director/Reader-Audit 运行时查 craft。
// - Epic 3 工作台 UI：输入框 + 词表补全 chips（非下拉单选）。
// - Epic 10 拆书 craft 写入（10.2 -> 9.7 -> 2.1，frontmatter source 标 provenance）。

// ── craft_type 8 类 + 兜底（open string 词表先验非封闭枚举）──
// value = frontmatter craft_type 值（拼音 slug，稳定可过滤）；gloss = 中文注解。
export const CRAFT_TYPE_VOCAB = [
  { value: 'shuangdian', gloss: '爽点：3 层满足感机制（即时/累积/终极），先抑后扬等情绪回报模式' },
  { value: 'jinzhishao', gloss: '金手指：主角核心外挂/特权体系（7 类 8 字段：来源/限制/代价/成长等）' },
  { value: 'playbook', gloss: '题材 playbook：题材套路手册（7 组题材 + jwynia 11 元素 + 8 病态规避）' },
  { value: 'qiaoduan', gloss: '桥段：可复用情节单元（Polti 36 + YY 103 + narrative_function 8 + Swain 6 拍）' },
  { value: 'jiezou', gloss: '节奏：章节节奏范式（黄金 300 字 + FORMULA_MAP + 6 钩子）' },
  { value: 'liliang', gloss: '力量体系：4 范式（修炼/科技/血脉/契约等力量进阶模型）' },
  { value: 'pattern', gloss: '6 结构 pattern：6 种叙事结构 pattern 的 craft 内容（与 scene_graph 结构种子互补）' },
  { value: 'character', gloss: '角色设计(OC)：人设 craft（原型/弧模式/声线/欲望向量/成长轨迹/OOC 规避）' },
  { value: 'uncategorized', gloss: '兜底：无法归入上述 8 类的 craft 文档' },
] as const;

/**
 * 把 craft_type 词表格式化成 prompt 注入文本（纯函数，mirror
 * narrative-enums.formatNarrativeEnumGuide）。query_craft 工具描述 + 未来 UI 补全
 * 消费。确定性字符串格式化，零 LLM、零主观阈值。词表是先验提示非门禁--用户可
 * 在 frontmatter 写词表外的 craft_type 自建新类（schema 收任意 string）。
 */
export function formatCraftTypeVocab(): string {
  const entries = CRAFT_TYPE_VOCAB.map((e) => `${e.value}：${e.gloss}`).join('\n');
  return [
    '【craft_type 词表（先验，可超出--按词表值起步，也可自造更精确的值）】',
    entries,
  ].join('\n');
}
