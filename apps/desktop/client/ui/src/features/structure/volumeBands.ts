import type { z } from 'zod';
import type { SceneLine } from '@orison/shared-contracts';
import { outlinePhaseSchema } from '@orison/shared-contracts';
import { MAX_CHAPTER_TRACKS } from './workbenchLayout';

/** Local inference — OutlinePhase isn't exported as a type from shared-contracts
 *  (same pattern as StructurePage's EpisodeOutline inference). */
export type OutlinePhase = z.infer<typeof outlinePhaseSchema>;

/**
 * dogfood R2 批次 B（SP-5 规模化）：卷背景带纯推导。
 *
 * 两条派生（dogfood R2 #80 起分工——章轴卷归属的权威源 = episode.phase_ref）：
 *   - `volumeBandsFromEpisodes`（#80）：章轴卷带——`episode_outlines[].phase_ref`
 *     （→ outline.phases[].id，章→集→卷 1:1 映射）直接定卷。供全部章轴消费方：
 *     VolumeBandStrip（因果骨架第二表头行，显卷名 + 半透明底色）、VolumeBandTint
 *     （因果网格体内的列区间底色 overlay）、ChapterWorkbench 章列卷带行/体色
 *     （08-26 批 3 换轴——列 = 章 index）、页级 minimap 卷刻度。
 *   - `deriveVolumeBands`（SP-5 原场景投币）：cell.lineId → line.phase_ref 逐列
 *     计票。storyTime 等距桶已随 08-26 批 7 换轴退役——现无 UI 消费者，保留给
 *     无集概念（storyTime 轴）的消费方，函数与单测原样（语义见下）。
 *
 * 纯函数（范式判据 ADR-3 ✓）：只做 by-refId 的确定性归属计数与区间闭包/合并，
 * 不判「这卷该含哪些场/这章属哪卷」（那是 story-planner / episode-planner LLM
 * 的语义决策——线/集挂哪个 phase_ref，经人对补丁卡审定）。
 *
 * `deriveVolumeBands` 的归属与冲突取舍（注释写明取舍，单测锁定）：
 *   - **逐 cell 归属**：一个 cell（node × valid lineTag）计 1，归属其 line 的
 *     phase_ref。多线 node 桥接两卷时对两卷各计 1——对称、确定，不偏袒首线。
 *     （另一种取法是只按 primary lineTag 计——那会把桥接场景的单列话语权全部
 *     给首线，故不取。）
 *   - **计票人口（08-27 CR #129 回写注）**：「cell」集合由消费方按各自列轴喂
 *     入——工作台批 3 换轴后以（线 × chip 所在起章）为一票（跨章 span chip 只
 *     在起始章计票，mockup 拍板），因果侧以卡格所在章列计票；多线桥接对称计
 *     票规则不受换轴影响。
 *   - **区间闭包**：phase 的 range = 其归属 cells 的 min/max 列号闭包（列轴从
 *     storyTime 集合推导——LAY 现状）。闭包内的中间列即便没有该卷场景也属于
 *     range（`rangesByPhase` 报告量）；但**逐列着色赢家**由该列实际 cell 计数
 *     决定（见下），闭包不直接染色。
 *   - **同列多卷交叠**：同一 storyTime 列上多线挂不同卷 → 该列归 cell 数最多
 *     的卷；**平票归 outline.phases 里更早的卷**（确定性 tie-break，单测锁定）。
 *   - **未分卷**：该列所有 cell 都落无 phase_ref（或 phase_ref 悬空）的线 →
 *     phaseId=null 的灰带。dangling phase_ref（线指向不存在的 phase）按未分卷
 *     处理——渲染层不捏造卷名。
 *   - **band 合并**：逐列赢家相同且相邻的列合并成一个连续 band；同一卷被别卷
 *     列打断时产生两个 band（同色——色号按 phase 在 outline 里的序号轮换）。
 */

/** 一个连续的卷背景带（逐列赢家相同的相邻列合并）。 */
export type VolumeBand = {
  /** outline phase id；null = 未分卷（灰带） */
  phaseId: string | null;
  /** phase title 原样（outline.phases[].title）；未分卷为空串——组件侧用 i18n 文案补 */
  title: string;
  /** 起始列 index（含）——对应 layout.cols 的下标 */
  fromCol: number;
  /** 结束列 index（含） */
  toCol: number;
};

export type VolumeBandDerivation = {
  /** 连续 band 序列（列序，覆盖所有列） */
  bands: VolumeBand[];
  /** phase id → min/max storyTime 列闭包（不论逐列输赢——报告量，不含 null） */
  rangesByPhase: Map<string, { fromCol: number; toCol: number }>;
};

/**
 * Derive the volume bands. Pure & deterministic: same inputs → same output,
 * inputs never mutated.
 *
 * 08-26 批 3（design §2「卷带换轴」）：cells 参数放宽为结构最小面
 * `{ lineId, colValue }[]`——列轴从 storyTime 换成章列号时，工作台喂入
 * `{ lineId, colValue: chip.colStart }` 伪 cell 即可复用全部归属/平票/合并逻辑
 * （TimelineCell 结构兼容本签名，因果侧调用不变）。
 *
 * @param cells  per-scene membership（lineId + the column value it lands on）.
 * @param lines  scene_graph.lines（phase_ref 来源；dangling → 未分卷）。
 * @param phases outline.phases（卷名 + tie-break 序）。
 * @param cols   列值序列（升序——因果侧 storyTime、工作台侧章 index 的稠密区间）。
 */
export function deriveVolumeBands(
  cells: ReadonlyArray<{ lineId: string; colValue: number }>,
  lines: SceneLine[],
  phases: OutlinePhase[],
  cols: number[]
): VolumeBandDerivation {
  // line → phase id（无 phase_ref 或悬空 → null = 未分卷）。
  const knownPhaseIds = new Set(phases.map((p) => p.id));
  const linePhase = new Map<string, string | null>();
  for (const line of lines) {
    const ref = line.phase_ref;
    linePhase.set(line.id, ref && knownPhaseIds.has(ref) ? ref : null);
  }
  // tie-break 序 + 卷名。
  const phaseOrder = new Map(phases.map((p, i) => [p.id, i] as const));
  const phaseTitle = new Map(phases.map((p) => [p.id, p.title] as const));
  const colIndexOf = new Map(cols.map((c, i) => [c, i] as const));

  // ── 逐列逐卷计数 + 各卷区间闭包 ──
  const NO_WINNER = Symbol('none');
  const countsPerCol: Array<Map<string | null, number>> = cols.map(() => new Map());
  const extremes = new Map<string, { min: number; max: number }>();
  for (const cell of cells) {
    const colIdx = colIndexOf.get(cell.colValue);
    if (colIdx === undefined) continue; // 防御：cell 落在 cols 之外（不应发生——同源推导）
    const phaseId = linePhase.get(cell.lineId);
    if (phaseId !== undefined) {
      const counts = countsPerCol[colIdx];
      counts.set(phaseId, (counts.get(phaseId) ?? 0) + 1);
    }
    if (phaseId) {
      const ex = extremes.get(phaseId);
      if (ex) {
        if (colIdx < ex.min) ex.min = colIdx;
        if (colIdx > ex.max) ex.max = colIdx;
      } else {
        extremes.set(phaseId, { min: colIdx, max: colIdx });
      }
    }
  }

  // ── 逐列赢家：cell 数最多；平票归 outline 更早的卷；零归属列 = 未分卷（null）──
  const winnerPerCol: Array<string | null> = countsPerCol.map((counts) => {
    let best: string | null = null;
    let bestCount = 0;
    // 迭代 phases 声明序而非 Map 插入序——声明序本身就是 tie-break（> 比较先到先赢）。
    for (const phase of phases) {
      const n = counts.get(phase.id) ?? 0;
      if (n > bestCount) {
        best = phase.id;
        bestCount = n;
      }
    }
    return best; // bestCount === 0（零归属列）→ null = 未分卷
  });

  // ── 相邻同赢家列合并成 band ──
  const bands: VolumeBand[] = [];
  let current: VolumeBand | null = null;
  winnerPerCol.forEach((winner, colIdx) => {
    if (current && current.phaseId === winner && colIdx === current.toCol + 1) {
      current.toCol = colIdx;
      return;
    }
    current = {
      phaseId: winner,
      title: winner ? phaseTitle.get(winner) ?? '' : '',
      fromCol: colIdx,
      toCol: colIdx,
    };
    bands.push(current);
  });

  const rangesByPhase = new Map<string, { fromCol: number; toCol: number }>();
  for (const [phaseId, ex] of extremes) {
    rangesByPhase.set(phaseId, { fromCol: ex.min, toCol: ex.max });
  }
  return { bands, rangesByPhase };
}

/**
 * dogfood R2 #80：章轴卷带——episode.phase_ref 直接定卷（集映射）。
 *
 * 章轴卷归属的权威源 = `episode_outlines[].phase_ref`（LLM 经 episode_outlines_update
 * 写入、人对补丁卡审定；章→集→卷 1:1 确定性映射就在数据里）。场景投币
 * （deriveVolumeBands）是集纲 phase 覆盖普遍缺失时代的代理方案：真实工程 38 场撒
 * 160 章，~120 无场景章零票全落「未分卷」灰带与卷色交错（#80 症状），而 episode
 * 自带 phase_ref 160/160 有效。投币推导保留给无集概念的 storyTime 轴消费方（现无
 * UI 消费者——见模块头）。
 *
 * 语义：episode.index 升序逐章定卷（phase_ref 悬空/缺失 → null 未分卷灰带）→
 * 相邻同卷合并成带；fromCol/toCol = 章列 index（与消费方稠密轨道域同轴）。
 * 同 index 重复以后枚胜（mirror deriveWorkbenchLayout 的 episodeByIndex 覆盖写
 * 约定）；界外 index（#125 封顶域外，渲染轨道不存在）整枚跳过。
 * 纯函数（ADR-3 ✓）：by-refId 查表 + 区间合并，零语义判断。
 *
 * @param episodes episode_outlines（结构最小面——EpisodeOutline 结构兼容直传）。
 * @param phases   outline.phases（卷名 + 色号序）。
 */
export function volumeBandsFromEpisodes(
  episodes: ReadonlyArray<{ index: number; phase_ref?: string | null }>,
  phases: OutlinePhase[]
): VolumeBand[] {
  // CR-001 口径：store 原样引用可能未过 safeParse——非数组防御性归零。
  if (!Array.isArray(episodes)) return [];
  const knownPhaseIds = new Set(phases.map((p) => p.id));
  const phaseTitle = new Map(phases.map((p) => [p.id, p.title] as const));

  // 章 → 卷（悬空/缺失 → null；元素级防御：注水/手改数据可产 null 元素——坏元素跳过）。
  const volumeByChapter = new Map<number, string | null>();
  for (const ep of episodes) {
    const idx = ep?.index;
    // #125 同界：界外章的渲染轨道不存在（宿主模板同界钳制）——引用它的 band 会
    // 掉出网格，整枚跳过（与 deriveWorkbenchLayout 截断同口径）。
    if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= MAX_CHAPTER_TRACKS) {
      continue;
    }
    const ref = ep.phase_ref;
    volumeByChapter.set(idx, ref && knownPhaseIds.has(ref) ? ref : null);
  }
  if (volumeByChapter.size === 0) return [];

  // 稠密轨道域 [0..maxIndex] 逐列定卷（无 episode 的 gap 轨 → null 灰带——与投币
  // 路径 denseCols 口径一致）→ 相邻同卷合并成带。
  let maxIndex = -1;
  for (const idx of volumeByChapter.keys()) if (idx > maxIndex) maxIndex = idx;
  const bands: VolumeBand[] = [];
  let current: VolumeBand | null = null;
  for (let col = 0; col <= maxIndex; col++) {
    const winner = volumeByChapter.get(col) ?? null;
    if (current && current.phaseId === winner && col === current.toCol + 1) {
      current.toCol = col;
      continue;
    }
    current = {
      phaseId: winner,
      title: winner ? phaseTitle.get(winner) ?? '' : '',
      fromCol: col,
      toCol: col,
    };
    bands.push(current);
  }
  return bands;
}

/**
 * Volume band colour rotation index (0/1/2 → structure.css .volume-band--v0/1/2).
 * Derived from the phase's position in outline.phases so a volume keeps its hue
 * even when its columns split into multiple bands. Unassigned → -1 (grey class).
 */
export function volumeBandColorIndex(band: VolumeBand, phases: OutlinePhase[]): number {
  if (band.phaseId === null) return -1;
  const idx = phases.findIndex((p) => p.id === band.phaseId);
  return idx < 0 ? -1 : idx % 3;
}
