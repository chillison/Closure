// ── Story 5.4：节奏喘息纯代码 hotspot（pacingRole vocab 精确匹配计数，design §3.1 / §4.1）──
//
// 5.4 Reader-Audit 情绪维的「节奏喘息」预筛信号（Emotion.pacing-breath 的纯代码 hint）。
// 与 emotion-verify.ts 同层——纯代码机械层（「不理解意义」的 vocab 精确匹配计数）。
//
// 🔑 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md §5.4 段）：
// - pacingRole vocab 是封闭 5 值策展词表（narrative-enums.ts:41-47 PACING_ROLE_VOCAB：
//   铺垫/推进/高潮/喘息/收束）。精确字符串匹配 = 不理解意义（同 storyTime fold 结构查询归 L1 纯代码）。
// - **连续 N 场高强度无松弛**是机械事实（pacingRole 精确匹配计数），归纯代码。
// - unknown / 缺失 pacingRole **不计 intense**（保守免假 WARN——不猜语义，creative-vs-mechanical.md 范式）。
// - 「连续高强度是否真致麻木 / 标了喘息的场是否真写出松弛」= L2 LLM 语义裁判（multi-review-agent.yaml prompt 指示），
//   纯代码 breached=true 只是 hint（同 L1 stylometry hotspot 是软信号）。
//
// 与 5.3 reader_topology 正交：5.3 验**目标轨** emotion_curve.sceneVad 节奏（VAD 形状数学）；
// 5.4 验**实际轨** pacingRole 连续高强度（结构 vocab 计数）+ L2 语义验松弛真缺失。不同数据源不同粒度各验各的。
//
// expected_downstream_consumers:
// - Story 5.4 R2：agent chapter-nodes.ts createReaderAuditNode buildPrompt（消费 selectScenesForEpisode 结果
//   → computePacingBreathHotspot → pacingBreath var → multi-review-agent.yaml {{pacingBreath}}）。
// - 未来：ledger 统计指纹 / dashboard 可视化（节奏风险热点，滞后做）。

/** 节奏喘息预筛信号——单段连续高强度场区间（机械事实，非语义裁判）。 */
export interface IntenseRun {
  /** 起始场 id（连续 intense 段首场）。 */
  startSceneRef: string;
  /** 结束场 id（连续 intense 段末场）。 */
  endSceneRef: string;
  /** 该段连续 intense 场数。 */
  count: number;
}

/** 节奏喘息纯代码 hotspot 产出（喂 L2 multi-review prompt 作 hint）。 */
export interface PacingBreathSignal {
  /** 是否超阈值（连续高强度场数 ≥ BREATH_THRESHOLD → 读者麻木风险机械信号）。 */
  breached: boolean;
  /** 最大连续 intense 场数。 */
  maxConsecutiveIntense: number;
  /** 阈值常量（标 dogfood 后视精度可调，design §8）。 */
  threshold: number;
  /** 所有连续 intense 段（含未超阈值的段，供 L2 参考「哪几段是持续高强度」）。 */
  intenseRuns: IntenseRun[];
  /** 可选 note：降级原因（no-pacing-data / compute-failed）。L2 见 note → 跳过 pacing-breath 不报。 */
  note?: string;
}

/**
 * 本章涉及场结构面的最小消费面——`{ id, pacingRole? }`。
 *
 * 结构上兼容 `SceneStructureDigest`（scene-graph-analytics.ts selectScenesForEpisode 产出）——
 * 那是 `Pick<SceneNode, 'id'|...|'pacingRole'|...>`。调用方传完整 SceneStructureDigest[] 即可（structural typing）。
 * 避免 pacing-breath.ts 依赖完整 SceneNode schema（layering）。
 */
export interface PacingBreathScene {
  id: string;
  pacingRole?: string;
}

// ── 常量（确定性，单测覆盖边界）──

/**
 * 连续高强度场数触发阈值（≥ 此值 → breached=true，design §3.1 / prd AC3 / 5.3 DEFAULT_CONSECUTIVE_RISE_THRESHOLD=3 一致）。
 *
 * 写作经验值（「连续几场无喘息算麻木」）——标可调常量，dogfood 后视精度调（design §8 风险点）。
 */
export const BREATH_THRESHOLD = 3;

/** 高强度 pacingRole 集（连续出现致读者麻木风险，design §3.1）。封闭词表精确匹配（不解意义）。 */
const INTENSE_ROLES: ReadonlySet<string> = new Set(['推进', '高潮']);

/**
 * 计算本章场景序列的节奏喘息 hotspot（连续高强度无松弛的机械信号，design §3.1）。纯函数。
 *
 * 算法：
 * - per-scene intense 判定：`pacingRole ∈ {推进,高潮}` = true；其他（含 unknown/缺）= false。
 * - 数连续 intense 场：遇非 intense 场（relief/unknown/缺）断开，累计 maxConsecutiveIntense + intenseRuns[]。
 * - `breached = maxConsecutiveIntense >= BREATH_THRESHOLD`。
 *
 * **unknown/缺 pacingRole 不计 intense（保守）**——不猜语义（ADR-3 范式），既不救（不计 relief 中断
 * 已累积的 intense 段判 max），也不加火（不计 intense）。对已 breach 的段无影响（段内 intense 场已计）；
 * unknown 在段间出现会断开连续计数（与 relief 同效——非 intense 即断）。
 *
 * graceful：scenes 空 / 全无 pacingRole → `{ breached:false, ..., note:'no-pacing-data' }`。
 *
 * 🔑 **统计事实非语义裁判**（正交于 L2 喘息语义）：纯代码只报「连续高强度」机械事实，
 * 是否真致麻木 / 喘息场是否真写出松弛 = L2 语义（multi-review-agent.yaml prompt 指示）。
 * breached=true 是 hint（同 L1 hotspot 是软信号），L2 综合 prose 语义判是否真问题。
 *
 * @param scenes 本章场序列（每场至少有 id + 可选 pacingRole）。调用方传 selectScenesForEpisode 结果。
 * @returns      PacingBreathSignal（pacingBreath var 序列化注入 Reader-Audit prompt）。
 */
export function computePacingBreathHotspot(scenes: readonly PacingBreathScene[]): PacingBreathSignal {
  // graceful：scenes 空 → 无 pacing 数据。
  if (!scenes || scenes.length === 0) {
    return {
      breached: false,
      maxConsecutiveIntense: 0,
      threshold: BREATH_THRESHOLD,
      intenseRuns: [],
      note: 'no-pacing-data',
    };
  }

  // graceful：全场无 pacingRole（全 undefined/空串）→ 无 pacing 数据。
  const hasAnyPacingRole = scenes.some(
    (s) => typeof s.pacingRole === 'string' && s.pacingRole.length > 0,
  );
  if (!hasAnyPacingRole) {
    return {
      breached: false,
      maxConsecutiveIntense: 0,
      threshold: BREATH_THRESHOLD,
      intenseRuns: [],
      note: 'no-pacing-data',
    };
  }

  const intenseRuns: IntenseRun[] = [];
  let maxConsecutiveIntense = 0;
  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  let currentCount = 0;

  for (const scene of scenes) {
    const isIntense =
      typeof scene.pacingRole === 'string' && INTENSE_ROLES.has(scene.pacingRole);
    if (isIntense) {
      // 累积连续 intense 段。
      if (currentStart === null) {
        currentStart = scene.id;
      }
      currentEnd = scene.id;
      currentCount += 1;
      if (currentCount > maxConsecutiveIntense) {
        maxConsecutiveIntense = currentCount;
      }
    } else {
      // 非 intense（relief/unknown/缺）→ 断开当前段，flush 已累积段。
      if (currentStart !== null && currentEnd !== null) {
        intenseRuns.push({ startSceneRef: currentStart, endSceneRef: currentEnd, count: currentCount });
      }
      currentStart = null;
      currentEnd = null;
      currentCount = 0;
    }
  }
  // flush 末段（序列以 intense 收尾时）。
  if (currentStart !== null && currentEnd !== null) {
    intenseRuns.push({ startSceneRef: currentStart, endSceneRef: currentEnd, count: currentCount });
  }

  const breached = maxConsecutiveIntense >= BREATH_THRESHOLD;
  return {
    breached,
    maxConsecutiveIntense,
    threshold: BREATH_THRESHOLD,
    intenseRuns,
  };
}
