// ── 章序单源（dogfood R2 #107 / R1.1）：chapters/*.md 磁盘派生排序规则 ──
//
// 规则权威原长在 ui `chapterDiskDerivation.ts` 的 sortDiskChapters（私有函数）——#107 链侧自动建章
// 需要「建文件后新章会落在哪个 sort_order 位」的事前判定，若在 agent/shell 入口层重写一份排序
// 逻辑，守卫与 renderer 实际派生一旦漂移 = 自动建出错位章（写错章是 accept 链最高风险事故，
// CR-4.1-06 同族）。本文件把该排序逻辑提为跨包纯函数单源：
//
// - ui `chapterDiskDerivation` 改 import `sortChapterOrderingEntries`（零行为变化——ui 既有派生
//   测试原样全绿 = 提取正确性的证明）。
// - agent write-chapter no-chapter 消费点 + shell closureChainIpc（波3-B/C）用
//   `wouldChapterLandAtOrder` 做落位守卫（R1.1d），用 chapter-integration 的
//   `countChaptersAtSortOrder` 区分 0 命中 vs 多命中。
//
// 排序契约（mirror 提取前 sortDiskChapters 逐字，含已知边界）：
// 1. 派生 `sort_order` 是**排序后位置**非 order 原值——order 0,2,5 三文件派生后 sort_order 为
//    0,1,2（顺序密集 0..k 连续时位置===order；有洞时压缩错位——这正是 R1.1d 守卫存在的原因）。
// 2. `hasExplicitOrder` 是全局开关：**任一**文件带显式 order → 全体按 explicitOrder 排，缺 order
//    者排最后（MAX_SAFE_INTEGER）；全无 order → 纯文件名自然序。
// 3. 同分决胜（同 order / 全无 order 场景）按文件名 `Intl.Collator(undefined, {numeric:true,
//    sensitivity:'base'})`（locale 取运行时缺省——与提取前行为一致，此处不收紧）。
//
// 纯函数（无 fs / db / LLM / Date）→ plain vitest 单测；renderer 安全（无 Node API，可进 barrel）。
//
// expected_downstream_consumers:
// - ui chapterDiskDerivation（本批改 import，行为零变化）。
// - agent write-chapter no-chapter 消费点 + shell closureChainIpc persistChapterAcceptIfNeeded
//   前置（波3-B/C：no-chapter + countChaptersAtSortOrder===0 + wouldChapterLandAtOrder 通过 →
//   自动建章；守卫不过 → 维持现状告警不建）。

/** 章序排序输入的轻量章描述（ui DiskChapter 满足；结构 typing 避免跨包拉 UI store 类型）。 */
export interface ChapterOrderingEntry {
  /** 章 id（文件名去 .md；身份标识，不参与排序）。 */
  id: string;
  /** 磁盘文件名（含扩展名；同分决胜的 collator 键——与提取前一致比全名，不去扩展名）。 */
  fileName: string;
  /** frontmatter `order:` 显式序；无 frontmatter / 无合法 order 行 = null（派生排序按「缺序」处理）。 */
  explicitOrder: number | null;
}

/**
 * chapters/*.md 磁盘派生排序（#107 单源；原 ui sortDiskChapters 逐字提取）。
 *
 * 规则见文件头契约 1-3。**返回新数组**（入参顺序不变），元素为原引用（generic 保调用方类型）。
 *
 * @param entries 章的轻量描述集（ui 派生传 DiskChapter；agent/shell 守卫传模拟盘态）
 * @returns 排序后数组——**位置下标即派生 sort_order**（mergeDiskAndStoredChapters `sortOrder:index` 语义）
 */
export function sortChapterOrderingEntries<T extends ChapterOrderingEntry>(
  entries: ReadonlyArray<T>,
): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const hasExplicitOrder = entries.some((entry) => entry.explicitOrder !== null);
  return [...entries].sort((a, b) => {
    if (hasExplicitOrder) {
      const orderA = a.explicitOrder ?? Number.MAX_SAFE_INTEGER;
      const orderB = b.explicitOrder ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) return orderA - orderB;
    }
    return collator.compare(a.fileName, b.fileName);
  });
}

/**
 * 模拟「现有章集 + 新章」一起过派生排序后，新章落位的位置下标（= 注册后的派生 sort_order）。
 *
 * newEntry 若与 existingEntries 中某元素同引用（调用方复用对象的重跑形态），按**覆盖语义**只算
 * 一次（等价 chapter_write 同 stem 覆盖，不双计）。注意仅去引用重复——同 fileName 的**不同对象**
 * 不去重（真实盘上文件名唯一，构造出重复文件名是调用方输入错误，模拟如实反映）。
 */
export function landingIndexOfChapter(
  existingEntries: ReadonlyArray<ChapterOrderingEntry>,
  newEntry: ChapterOrderingEntry,
): number {
  const merged = existingEntries.filter((entry) => entry !== newEntry);
  merged.push(newEntry);
  return sortChapterOrderingEntries(merged).indexOf(newEntry);
}

/**
 * R1.1d 落位守卫（#107 多章防错位）：模拟加入 newEntry 后按派生排序，其位置下标是否 === targetIndex。
 *
 * targetIndex = episode.index（episode→chapter 映射要求新章注册后 sort_order===episode.index，
 * `resolveChapterIdForEpisode` 才能在后续 accept 中命中）。**order 有洞 / 混排（部分文件无
 * frontmatter）时 order:N 不保证落位 N**（位置是排序后下标非 order 原值）——本谓词判不过的
 * 场景入口层不得自动建章（维持现状告警，指引手建），防产错位章。
 *
 * 首章（existingEntries 为空 + order 0）必然落位 0——守卫零成本放行。
 *
 * @param existingEntries 现有章集的轻量描述（模拟建文件前的盘态 / novel.chapters 等价投影）
 * @param newEntry        拟建新章（fileName + frontmatter order 即将写入的形态）
 * @param targetIndex     期望落位（episode.index，0-based）
 */
export function wouldChapterLandAtOrder(
  existingEntries: ReadonlyArray<ChapterOrderingEntry>,
  newEntry: ChapterOrderingEntry,
  targetIndex: number,
): boolean {
  return landingIndexOfChapter(existingEntries, newEntry) === targetIndex;
}
