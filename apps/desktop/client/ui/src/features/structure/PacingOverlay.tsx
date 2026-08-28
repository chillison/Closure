import { useMemo } from 'react';
import { pacingCurveSchema, type PacingCurve } from '@orison/shared-contracts';
import type { CausalCardData } from './workbenchLayout';
import { overlayCardBox, type StackBandTable } from './timelineGeometry';

/**
 * dogfood R2 批次 B（SP-4 节奏叠层）→ 08-26 批 5（R5 拍板）载体改**格顶 3px 细条**。
 *
 * 整格暖色铺底被判「突兀」（mockup 整格橙底被用户误读为 UI 缺陷，08-26 拍板）：
 * 细条只占卡顶缘。强度映射随之重标——旧整格载体的映射 0.06..0.25 是按「半透明罩
 * 覆大面积」定的；换到 3px 窄条后同强度在视觉上不可辨，故按新载体重新定标为
 * 0.4..1.0。这不是按某个倍率换算出来的数字，而是窄条感知度的独立取值区间
 * （横截面 3px：低于 ~0.35 的不透明度和背景几乎融合）；载体几何（~100×3 vs
 * 旧 ~104×48 内域，面积比 ~20×）只是说明两个区间不可互换的背景事实。
 *
 * 定位（CR 组1 #119 / 裁决 1A）：top/left/width 经 `overlayCardBox` 取盒；实测纵带
 * （measuredBands）有效时 top/height **贴真实卡缘**——不再假设卡在行内均分；
 * jsdom / 首帧回退同一双查表公式（行为与批 7 一致）。height 固定 3px（CSS
 * .pacing-heat 单源），宽度经 Math.max(0, …) 钳守卫（CR edge-2：colOffsets 缺项/
 * 列宽不足 2×padding 时曾把负值直接喂 inline style）。
 *
 * ⚠️ 层序取舍注记（CR 组1 附2，诚实记录不改行为的理由）：本层按 DOM 序画在卡之上，
 * 不透明度逼近 1 的高强度细条会盖住卡顶缘约 3px 的边框/选中外环段。备选方案各有
 * 更大代价——沉到卡下则被卡片不透明底色完全遮蔽（功能消失）；压低 opacity 上限则
 * 篡改 intensity→强度的数据映射语义；混合模式需真机目检背书。当前按「薄载体 +
 * 信息轨属性」接受顶缘遮挡，待真机目检再议。
 *
 * 数据粒度（详设 SP-4 明示的「不硬编码」降级路径）：
 * pacing_curve.unit ∈ act/episode/chapter/scene——points.refId 指向**该粒度实体**
 * 的 id。仅当 refId 与场景 node id 有交集（unit=scene，5.2 projector 约定 refId
 * → SceneNode.id）才存在卡级渲染；指向集/章等粒度时 id 与场景 id 无交集 →
 * 按 id 匹配天然零命中 → **本层静默不渲染**（工具栏开关照常接线，数据粒度恢复
 * scene 时自动亮）。渲染层不硬编码 unit 枚举门——id 匹配是唯一确定性连接键，
 * 也容忍「unit 声明错但 refId 实际指向场景」的畸形数据如实渲染。
 *
 * pointer-events:none——细条罩卡顶，必须放行点击/拖拽。
 */

/** 格顶细条高（CSS .pacing-heat height 镜像——R5 载体）。模块内常量：
 * grep 复核无外部消费者（附1 投机性导出回收）。 */
const PACING_STRIP_HEIGHT = 3;

/** intensity 0..10 → 细条不透明度区间（窄条载体的独立感知区间，见文件头说明）。 */
const HEAT_OPACITY_MIN = 0.4;
const HEAT_OPACITY_MAX = 1;
const INTENSITY_MAX = 10;

/** intensity(0..10) → heat 不透明度。越界裁剪（schema 有界，运行时防御）。纯函数，单测锁定。 */
export function pacingHeatOpacity(intensity: number): number {
  const clamped = Math.min(INTENSITY_MAX, Math.max(0, intensity));
  return HEAT_OPACITY_MIN + (clamped / INTENSITY_MAX) * (HEAT_OPACITY_MAX - HEAT_OPACITY_MIN);
}

/**
 * Shape-guard the raw creativeFields.pacing_curve store value (unknown → parsed
 * PacingCurve | undefined). safeParse 静默降级——同 resolveEmotionCurve seam。
 */
export function resolvePacingCurve(raw: unknown): PacingCurve | undefined {
  const parsed = pacingCurveSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

type PacingOverlayProps = {
  cells: CausalCardData[];
  rowIndex: Map<string, number>;
  colIndex: Map<number, number>;
  stackSizeAt: (lineId: string, colValue: number) => number;
  /** 实测行高累计查表（NTP 传；jsdom 回退等高 rowHeight 常量——两侧同一等高公式）。 */
  rowOffsets: readonly number[];
  /** 实测列宽累计查表（批 7：章列自适应——jsdom 回退名义表，nominalChapterWidths）。 */
  colOffsets: readonly number[];
  /** nodeId → intensity（NTP memo 造；toggle off 时传 undefined → 整层不渲染） */
  intensityByNode?: Map<string, number>;
  /**
   * CR 组1 #119（裁决 1A）：cell-stack 实测纵带表（NTP 布局期收集）。有效时热度条
   * 贴真实卡顶缘；jsdom / 未就绪回退双查表公式（既有锁测试口径不变）。
   */
  measuredBands?: StackBandTable;
};

export function PacingOverlay({ cells, rowIndex, colIndex, stackSizeAt, rowOffsets, colOffsets, intensityByNode, measuredBands }: PacingOverlayProps) {
  const heats = useMemo(() => {
    if (!intensityByNode || intensityByNode.size === 0) return [];
    const out = [];
    for (const cell of cells) {
      const intensity = intensityByNode.get(cell.nodeId);
      const rIdx = rowIndex.get(cell.lineId);
      const cIdx = colIndex.get(cell.colValue);
      if (intensity === undefined || rIdx === undefined || cIdx === undefined) continue;
      const box = overlayCardBox(
        {
          rowIndex: rIdx,
          colIndex: cIdx,
          stackSize: stackSizeAt(cell.lineId, cell.colValue),
          subIndex: cell.subIndex,
          // 实测模式桶键上下文（#119）——cells 自带归属信息，顺路传入即得真卡缘。
          lineId: cell.lineId,
          colValue: cell.colValue,
        },
        rowOffsets,
        colOffsets,
        measuredBands
      );
      out.push({
        key: `${cell.nodeId}|${cell.lineId}|${cell.subIndex}`,
        nodeId: cell.nodeId,
        opacity: pacingHeatOpacity(intensity),
        // 批 5（R5）：格顶细条——只取卡盒 top/left/width，height 固定 3px。
        // CR edge-2：负宽守卫（双保险——overlayCardBox 已钳，此处不再信任上游）。
        left: box.left,
        top: box.top,
        width: Math.max(0, box.width),
      });
    }
    return out;
  }, [cells, intensityByNode, rowIndex, colIndex, stackSizeAt, rowOffsets, colOffsets, measuredBands]);

  if (heats.length === 0) return null;
  return (
    <div className="pacing-overlay" aria-hidden="true">
      {heats.map((heat) => (
        <span
          key={heat.key}
          className="pacing-heat"
          style={{ left: heat.left, top: heat.top, width: heat.width, height: PACING_STRIP_HEIGHT, opacity: heat.opacity }}
          data-heat-node={heat.nodeId}
        />
      ))}
    </div>
  );
}
