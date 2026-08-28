import { Fragment } from 'react';
import type { SceneGraphIssue } from '@orison/shared-contracts';
import type { PixelPoint } from './timelineGeometry';
import { summarizeIssues } from './ValidationOverlay';
import { resolveAssocPaint } from './AssocLayer';
import { LINE_PALETTE_SIZE } from './linePalette';

/**
 * Story 1.5 Phase D (design §1.1 / D3 / §2.1): SVG overlay drawing the
 * scene-graph edges as curves over the timeline grid.
 *
 * 08-26 结构页重构 批 2（implement 2.2 / design §3.3 §4）：
 *   - **沉底**：z 序降到格下（格/泳道/列头 z 提升，见 structure.css）——弧线不再
 *     穿文字，线视觉止于卡缘（#32「断连观感」随沉底同时消失）。
 *   - **线色**：线内边走**线身份色**（lane-hue--c{n}，from 端所在线——跨线边用
 *     起点线的色相约定，确定性可测）。CAUSAL/SUSPENSE 的 accent/warning 语义色
 *     退役（design §4「语义色只留语义」）；边类型载体改**虚线**（SUSPENSE
 *     dasharray 保留，CAUSAL 实线）。
 *   - **y 查表**：端点 y 由调用方传实测 rowOffsets 查表解析（design §3.2-3.3，
 *     resolveEndpointPixel 签名带 rowOffsets）；本层只画 path。
 *   - T19（发现批9·因果方向可读）：CAUSAL 实线族终点加箭头（buildEdgeArrowhead
 *     手绘三角——判读者「谁导致谁」诉求的真正归属面）；SUSPENSE 虚线族不加
 *     （悬念未揭示，方向语义弱）。#75 渐变边与箭头共用同一枚 def（id 单射不破）。
 *
 * Edges are NOT interactive (pointer-events: none) — interaction with
 * scenes (drill / anchor toggle / drag) lands on SceneCard, not on edges.
 * This is a read-only presentation layer.
 *
 * Path shape: a horizontal cubic Bézier between the two resolved points —
 * control points pulled along the x-axis so parallel lanes get a gentle S-curve
 * rather than a rigid diagonal. Self-loops (from === to, e.g. a SUSPENSE hold
 * on one scene) render as a small arc above the point so they're visible
 * instead of collapsing to nothing.
 *
 * Phase D-overlay: when `edgeIssues` carries flags for a rendered edge (e.g.
 * `dangling-edge-endpoint` — though that usually drops the edge from the
 * resolved set), a small severity circle is drawn at the path midpoint reusing
 * `summarizeIssues` so the SVG badge stays in sync with the HTML badge
 * semantics (worst severity colour + total count + verbatim tooltip).
 */
export type ResolvedEdge = {
  edgeId: string;
  type: 'CAUSAL' | 'SUSPENSE';
  from: PixelPoint;
  to: PixelPoint;
  /** from 端所在线的 id——线内边上线色（hueIndex 同源派生）+ 线聚焦悬停面
   *  （08-26 批 4：path 带 data-line-id，lineHover.applyLineHover 据此降透明）。 */
  lineId: string;
  /** from 端所在线的色板下标（linePalette.lineHueIndex）——线内边上线色。 */
  hueIndex: number;
  /** to 端目标线的色板下标（#75/W3 收口）：异线边供渐变轴终端；缺省回退
   * from hue（纯色，向后兼容旧构造点）。 */
  toHueIndex?: number;
};

type EdgeLayerProps = {
  edges: ResolvedEdge[];
  width: number;
  height: number;
  /**
   * Issues keyed by edgeId (from `validateSceneGraph` via `indexIssuesByTarget`).
   * Undefined when the validation overlay is toggled off — no badges render.
   * Note: edges whose endpoints don't resolve (dangling) are dropped from
   * `edges` before reaching here, so their badges can't be positioned and won't
   * show on the SVG; the underlying issue still fires (just not visually anchored).
   */
  edgeIssues?: Map<string, SceneGraphIssue[]>;
};

/**
 * Build an SVG path `d` for a smooth horizontal curve between two points.
 * Pure — exported for potential unit cover if edge shape grows more complex.
 */
export function buildEdgePath(from: PixelPoint, to: PixelPoint): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  // Self-loop (same cell or within 1px): small arc above the point.
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    const r = 8;
    return `M ${from.x - r} ${from.y} A ${r} ${r} 0 1 1 ${from.x + r} ${from.y}`;
  }
  // Cubic Bézier with horizontal control vectors — gentle S-curve across lanes.
  const ctrlOffset = Math.max(Math.abs(dx) / 2, 24);
  const c1x = from.x + ctrlOffset;
  const c2x = to.x - ctrlOffset;
  return `M ${from.x} ${from.y} C ${c1x} ${from.y}, ${c2x} ${to.y}, ${to.x} ${to.y}`;
}

/** Self-loop 判定（与 buildEdgePath 同一阈值）：from≈to 的边走弧形分支。 */
function isSelfLoop(from: PixelPoint, to: PixelPoint): boolean {
  return Math.abs(to.x - from.x) < 1 && Math.abs(to.y - from.y) < 1;
}

/**
 * T19（发现批9·判读者「谁导致谁」诉求）：因果边（CAUSAL 实线族）终点的箭头三角
 * ——**手绘 path 形态而非 SVG marker**：marker 内容不继承引用路径的 CSS 自定义
 * 属性（lane-hue 的 --structure-line-color 会断，渐变 url 也不可达）。方向贴
 * buildEdgePath 的到达切线：末控制点 c2x = to.x − ctrlOffset 恒在 to 左侧 →
 * 到达切线恒 +x 水平，箭头恒指 +x、尖点恰落 to 端点。SUSPENSE 虚线族不加（悬念
 * 未揭示，方向语义弱）；自环略过（弧形到达切线非 +x，箭头方向失义）。纯函数，
 * 导出供测试。
 */
export function buildEdgeArrowhead(to: PixelPoint): string {
  const len = 8;
  const half = 3.5;
  return `M ${to.x - len} ${to.y - half} L ${to.x} ${to.y} L ${to.x - len} ${to.y + half} Z`;
}

/**
 * toHueIndex 的消费前校验（edge V-9，08-27 三轮 CR）：ResolvedEdge.toHueIndex 是
 * 跨包契约上的自由 number——越界/小数/负值会产出 `lane-hue--c{n}` 不存在的 stop
 * 类（该端黑掉）。非法回退 from hue（纯色，与缺省路径同一向后兼容形态）。
 * hueIndex 本体恒由 linePalette.lineHueIndex 单源供给（已带 [0,SIZE) 归一护栏），
 * 无须重复校验。纯函数。
 */
function resolveToHue(edge: ResolvedEdge): number {
  const t = edge.toHueIndex;
  return t !== undefined && Number.isInteger(t) && t >= 0 && t < LINE_PALETTE_SIZE ? t : edge.hueIndex;
}

export function EdgeLayer({ edges, width, height, edgeIssues }: EdgeLayerProps) {
  return (
    <svg
      className="narrative-edge-layer"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      {/* #75/W3：异线因果边的两端渐变 defs（userSpaceOnUse，轴=两端实测锚点；
          stop 挂 .assoc-stop 复用单一 token 挂法）。同线边恒实色分支、零 def。
          id = owner 域 'edge' + 单射转义 + 渲染序（AssocLayer.assocGradientId 三层
          防撞——nodeId="edge-*" 与本层种子不再跨层撞名）。 */}
      <defs>
        {edges.flatMap((edge, i) => {
          const paint = resolveAssocPaint(edge.hueIndex, resolveToHue(edge), 'edge', edge.edgeId, i);
          if (paint.mode !== 'gradient') return [];
          return [
            <linearGradient
              key={paint.gradientId}
              id={paint.gradientId}
              gradientUnits="userSpaceOnUse"
              x1={edge.from.x}
              y1={edge.from.y}
              x2={edge.to.x}
              y2={edge.to.y}
            >
              <stop offset="0" className={`lane-hue--c${paint.fromHue} assoc-stop`} />
              <stop offset="1" className={`lane-hue--c${paint.toHue} assoc-stop`} />
            </linearGradient>,
          ];
        })}
      </defs>
      {edges.map((edge, i) => {
        const paint = resolveAssocPaint(edge.hueIndex, resolveToHue(edge), 'edge', edge.edgeId, i);
        return (
          <Fragment key={edge.edgeId}>
            <path
              className={`narrative-edge narrative-edge--${edge.type.toLowerCase()} lane-hue--c${edge.hueIndex}`}
              style={paint.mode === 'gradient' ? { stroke: `url(#${paint.gradientId})` } : undefined}
              d={buildEdgePath(edge.from, edge.to)}
              data-edge-id={edge.edgeId}
              data-edge-type={edge.type}
              data-line-id={edge.lineId}
              fill="none"
            />
            {/* T19（发现批9·因果方向可读）：CAUSAL 实线族终点箭头（「谁导致谁」的
                归属面）。fill 走 .narrative-edge-arrowhead 的线色 token（元素自带
                lane-hue 类）；异线渐变边内联 fill=url(#id)——与线共用同一枚
                userSpaceOnUse def（id 单射纪律不破：箭头不产第二 def），渐变在
                箭头坐标处即取终端色。SUSPENSE 虚线族/自环不加（见
                buildEdgeArrowhead 注）。身份挂 data-arrow-edge-id（非 data-edge-id
                ——后者是「每渲染边恰一 path」的既有 DOM 契约锚，下游测试/校验
                overlay 以它计数，装饰路径不得混入）。 */}
            {edge.type === 'CAUSAL' && !isSelfLoop(edge.from, edge.to) && (
              <path
                className={`narrative-edge-arrowhead lane-hue--c${edge.hueIndex}`}
                style={paint.mode === 'gradient' ? { fill: `url(#${paint.gradientId})` } : undefined}
                d={buildEdgeArrowhead(edge.to)}
                data-arrow-edge-id={edge.edgeId}
              />
            )}
          </Fragment>
        );
      })}
      {edges.map((edge) => {
        const issues = edgeIssues?.get(edge.edgeId);
        if (!issues || issues.length === 0) return null;
        return (
          <EdgeBadge
            key={`badge-${edge.edgeId}`}
            point={edgeMidpoint(edge.from, edge.to)}
            issues={issues}
            edgeId={edge.edgeId}
          />
        );
      })}
    </svg>
  );
}

/**
 * Midpoint of an edge's resolved endpoints — used as the badge anchor. The
 * badge sits at the visual centre of the curve, close enough to the Bézier's
 * t=0.5 point that it reads as "this edge is flagged" without precise curve
 * maths (a few px of drift is invisible at badge scale).
 */
function edgeMidpoint(from: PixelPoint, to: PixelPoint): PixelPoint {
  return { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
}

type EdgeBadgeProps = {
  point: PixelPoint;
  issues: SceneGraphIssue[];
  edgeId: string;
};

/**
 * SVG severity badge for a flagged edge: a small circle filled with the
 * worst-severity colour + the total issue count as text. Reuses
 * `summarizeIssues` so colour/count/tooltip match the HTML `ValidationBadges`.
 * `<title>` child provides the native hover tooltip (verbatim issue messages).
 *
 * CR-005: radius 9 (was 7) so a two-digit count (≥10 issues on one edge) fits
 * inside the circle — the 9px font's "99" is ~12px wide, comfortably inside the
 * 18px diameter. Simpler than capping at "9+" and the geometric growth reads
 * cleanly at badge scale.
 */
function EdgeBadge({ point, issues, edgeId }: EdgeBadgeProps) {
  const { worst, count, title } = summarizeIssues(issues);
  if (!worst) return null;
  return (
    <g
      className={`narrative-edge-badge narrative-edge-badge--${worst}`}
      data-edge-badge-id={edgeId}
      data-validation-severity={worst}
    >
      {title && <title>{title}</title>}
      <circle cx={point.x} cy={point.y} r={9} />
      <text x={point.x} y={point.y}>{count}</text>
    </g>
  );
}
