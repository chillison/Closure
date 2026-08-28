import { emotionCurveSchema, type EmotionCurve, type EmotionPoint } from '@orison/shared-contracts';

/**
 * dogfood R2 批次 B（SP-4 情绪叠层）→ 08-26 结构页重构 批 2 迁移：
 *
 * 本文件原持有「绝对定位叠层组件 EmotionOverlay」（30px 格常量坐标换算）。批 2
 * 卡化（SceneCard）后行高/卡位自适应，常量坐标对不上卡——**色条迁入卡内**渲染
 * （SceneCard 底部 `.emotion-bar`，mockup `.cell .emo` 同款），叠层组件退役删除。
 * 文件保留情绪数据的两个纯推导函数（消费端 SceneCard；单测 curveOverlays.test）：
 *   - `deriveEmotionTint`：EmotionPoint → 色条视觉三元组（三档色相/不透明度/tooltip）。
 *   - `resolveEmotionCurve`：store unknown 值的 shape-guard 归一。
 *
 * 数据 = creativeFields.emotion_curve（Story 5.1 双轨：语义情绪词一等 + VAD
 * 可选投影）。实际结构（creative-fields.ts emotionCurveSchema）：
 *   - `points[].refId` → SceneNode.id（5.2 projector 约定；粒度由 unit 声明，
 *     unit≠scene 时 refId 指向集/章等其他实体——与场景 id 无交集，按 id 匹配
 *     天然零命中零渲染，**不硬编码 unit 门**）。
 *   - `points[].sceneMood`/`sceneVad`：读者氛围层（语义 + 可选 VAD）。
 *   - `points[].characters[]`：per-character 情绪对（emotion→emotionEnd 语义
 *     转变 + 可选 vad/vadEnd）。空数组合法（氛围-only point）。
 *
 * 着色取舍（注释写明，单测锁定）：
 *   - **VAD 选择**：sceneVad 优先；否则取 characters[] 里带 vad 的条目做 v/a
 *     **算术平均**（戏剧张力核心是角色情绪对立——平均把对立折成中间色，比
 *     「取第一角色」更诚实；确定性强，无隐藏优先级）。
 *   - **色相三档**（克制即可——不连续插值）：valence > +0.15 → 绿（--success）/
 *     < −0.15 → 红（--error）/ 中间 → 琥珀（--warning）。
 *   - **饱和度代理**：arousal −1..1 → 条不透明度 0.4..1.0（token 无法直接调
 *     饱和度，不透明度是等价可感知的代理）。
 *   - **只有语义词无 VAD** → 中性 accent 条（不投影语义词——语义→VAD 查表是
 *     LLM 侧决策，纯代码不捏造数值，schema 注释同款立场）。
 *   - hover title 显原始情绪词（sceneMood + 角色 emotion→emotionEnd，原样）。
 */

/** valence 三档阈值（|v| ≤ 0.15 视为中性——两 token 色之间的缓冲带）。 */
const VALENCE_TIER_THRESHOLD = 0.15;
/** 语义词-only（无 VAD）条的基础不透明度。 */
const SEMANTIC_ONLY_OPACITY = 0.8;
/** arousal(−1) → 条不透明度下限（低唤醒 = 淡条）。 */
const AROUSAL_OPACITY_FLOOR = 0.4;
/** arousal(+1) → 条不透明度上限（高唤醒 = 实条）。 */
const AROUSAL_OPACITY_SPAN = 0.6;

export type EmotionTint = {
  /** 色相三档 + 语义词-only 档（CSS 类后缀） */
  tier: 'pos' | 'neg' | 'mid' | 'semantic';
  /** 条不透明度（arousal 代理；semantic 档固定） */
  opacity: number;
  /** hover tooltip——原始情绪词原样（sceneMood + 角色对） */
  title: string;
};

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Reduce one EmotionPoint to the bar's visual tuple. Pure & deterministic —
 * exported for single tests (tier boundaries / multi-character mean / verbatim
 * title composition all lock here).
 */
export function deriveEmotionTint(point: EmotionPoint): EmotionTint {
  // schema 产物 characters 恒为数组；?? [] 兼容未经 zod 的调用方（纯函数测试
  // 直接构造 point），不逼调用方补 default。
  const characters = point.characters ?? [];
  // title：语义词原样拼接（氛围在前，角色对 `emotion→emotionEnd` 在后）。
  const parts: string[] = [];
  if (point.sceneMood) parts.push(point.sceneMood);
  for (const c of characters) {
    parts.push(c.emotionEnd ? `${c.emotion}→${c.emotionEnd}` : c.emotion);
  }
  const title = parts.join(' · ');

  // VAD 选择：sceneVad 优先；否则 characters 带 vad 条目的算术平均。
  let v: number | null = null;
  let a = 0;
  if (point.sceneVad) {
    v = point.sceneVad.v;
    a = point.sceneVad.a;
  } else {
    const vads = characters.flatMap((c) => (c.vad ? [c.vad] : []));
    if (vads.length > 0) {
      v = mean(vads.map((x) => x.v));
      a = mean(vads.map((x) => x.a));
    }
  }
  if (v === null) {
    return { tier: 'semantic', opacity: SEMANTIC_ONLY_OPACITY, title };
  }
  const tier = v > VALENCE_TIER_THRESHOLD ? 'pos' : v < -VALENCE_TIER_THRESHOLD ? 'neg' : 'mid';
  // CR-13：arousal 先钳到 [-1,1] 再映射（mirror pacingHeatOpacity 的越界裁剪先例）。
  // schema 有界但运行时数据可越界（畸形 patch / 算术平均溢出）——不钳会让透明度
  // 破 0.4 下限或超 1（视觉上等同于越界值被静默截断，不如显式钳制可断言）。
  const arousal = Math.min(1, Math.max(-1, a));
  const opacity = AROUSAL_OPACITY_FLOOR + (AROUSAL_OPACITY_SPAN / 2) * (arousal + 1);
  return { tier, opacity, title };
}

/**
 * Shape-guard + normalise the raw creativeFields.emotion_curve store value
 * (unknown → parsed EmotionCurve | undefined). safeParse：残缺/畸形数据（mid-
 * patch hydration）静默降级为「无叠层」，绝不抛——同 NTP 对 scene_graph 的
 * isSceneGraphLike 防御 seam。
 */
export function resolveEmotionCurve(raw: unknown): EmotionCurve | undefined {
  const parsed = emotionCurveSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}
