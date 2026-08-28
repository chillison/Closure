import type { CSSProperties } from 'react';
import { TIMELINE_GEOMETRY } from './timelineGeometry';
import { volumeBandColorIndex, type OutlinePhase, type VolumeBand } from './volumeBands';

/**
 * dogfood R2 批次 B（SP-5）：卷背景带的两个渲染面，章轴卷带自 dogfood R2 #80 起
 * 由 `volumeBandsFromEpisodes` 的同一份 bands 驱动（单源——两处视觉永不漂移）：
 *
 *   - `VolumeBandStrip`：第二表头行（正常流，渲染在因果网格正上方）。**批 7 起
 *     是 subgrid 接轨件**（`.volume-band-strip` 类声明 grid-template-columns:
 *     subgrid + grid-column: 1/-1，structure.css）——列宽与两区内网格同解一次，
 *     章列自适应下依旧对列（批 6 #54-P1 的「独立 strip 各自为政」坑在共享轨道
 *     架构下由 subgrid 根治）。故组件不再收 template 字符串 / 宽度 props。
 *   - `VolumeBandTint`：网格体内的列区间底色（绝对定位 overlay，照 EdgeLayer
 *     先例挂在 position:relative 的 .narrative-timeline-grid 里）——几百列滚动
 *     时的空间锚。批 7：分段 x 改 **colOffsets 查表**（章列自适应后等距常量乘法
 *     不存在了；jsdom 回退名义表确定性不变）。
 *
 * 两组件都只渲染数据（落地公理）：bands 为空（无 outline / 无 phase_ref）时
 * Strip 渲染空的 22px 行（高度恒占——工作台卷带行同源镜像）、Tint 渲染 null。
 *
 * Paradigm guard：只把 by-refId 的确定性归属结果画上屏；「这章属哪卷」的语义
 * 决策在 episode-planner/作者（episode 挂 phase_ref，经人对补丁卡审定），本模块
 * 零语义判断。
 */

type BandVisualProps = {
  bands: VolumeBand[];
  phases: OutlinePhase[];
};

/**
 * 色号修饰类（v0/v1/v2 轮换或 unassigned 灰）——strip 格、体色分段与工作台
 * （08-26 批 3）章列卷带行三方共用单源。
 */
export function bandColorClass(band: VolumeBand, phases: OutlinePhase[]): string {
  const colorIdx = volumeBandColorIndex(band, phases);
  return colorIdx >= 0 ? `volume-band--v${colorIdx}` : 'volume-band--unassigned';
}

/** band 显示名（未分卷 → i18n 文案由调用方传入）。同上导出共用。 */
export function bandTitle(band: VolumeBand, unassignedText: string): string {
  return band.phaseId === null ? unassignedText : band.title;
}

type VolumeBandStripProps = BandVisualProps & {
  /** i18n：未分卷文案（zh「未分卷」/ en）——由 NTP 传入，组件不读 store。 */
  unassignedText: string;
  /** i18n：左上角小标签（「卷」） */
  cornerLabel: string;
};

/**
 * 第二表头行。列轨道经 CSS 类向宿主 `.structure-canvas` subgrid 接轨（批 7 共享
 * 轨道架构）——组件自身只管 band 格跨列。高度 22px **最小高**（mirror
 * TIMELINE_GEOMETRY.volumeBandHeight——08-26 批 5 #42：卷名 2 行 wrap 时 band 随
 * 内容长高，不再恒高压扁）。
 */
export function VolumeBandStrip({ bands, phases, unassignedText, cornerLabel }: VolumeBandStripProps) {
  const style: CSSProperties = {
    minHeight: TIMELINE_GEOMETRY.volumeBandHeight,
  };
  return (
    <div className="volume-band-strip" style={style} data-volume-band-strip>
      <div className="volume-band-corner" style={{ gridColumn: 1, gridRow: 1 }}>
        {cornerLabel}
      </div>
      {bands.map((band) => (
        <div
          key={`${band.phaseId ?? 'unassigned'}-${band.fromCol}`}
          className={`volume-band ${bandColorClass(band, phases)}`}
          style={{ gridColumn: `${band.fromCol + 2} / span ${band.toCol - band.fromCol + 1}`, gridRow: 1 }}
          data-band-phase={band.phaseId ?? 'unassigned'}
          title={bandTitle(band, unassignedText)}
        >
          <span className="volume-band-title">{bandTitle(band, unassignedText)}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 网格体列区间底色（绝对定位 overlay，inset 0 罩整个 grid；分段从表头行下缘
 * (top: headerHeight) 拉到网格底 (bottom: 0)——顶底双锚随行数自适应）。分段 x 用
 * colOffsets 查表换算（laneLabelWidth 基准 + 段起缘/宽度查表，与 EdgeLayer 同坐
 * 标系）。pointer-events:none 保证 SceneCard 拖拽/点击不被拦截；透明度在 CSS
 * （.volume-band--v* 约 0.06），叠在卡上只余一层卷色薄纱。
 *
 * CR 组1 edge-3：band 区间落在实测列宽表之外（fromCol/toCol+1 无解析——过渡帧 /
 * 突缩）的分段**整段跳过**——曾用 `?? 0` 静默把错锚零宽帘画在 lane 左缘。批 7
 * subgrid 锁步后本组件仍是因果侧活代码路径（NarrativeTimelinePanel 唯一挂载；
 * 工作台侧卷带走 CSS gridColumn 定位不经此处——grep 2026-08-27 复核），守卫照修。
 */
export function VolumeBandTint({
  bands,
  phases,
  colOffsets,
}: BandVisualProps & { colOffsets: readonly number[] }) {
  if (bands.length === 0) return null;
  const { laneLabelWidth, headerHeight } = TIMELINE_GEOMETRY;
  return (
    <div className="volume-band-tint" aria-hidden="true">
      {bands.map((band) => {
        // 边缘缺解析 → 该卷该帧不画（换表后的下一帧自然恢复）；宽度非正同样跳过。
        const from = colOffsets[band.fromCol];
        const to = colOffsets[band.toCol + 1];
        if (from === undefined || to === undefined) return null;
        const width = to - from;
        if (!(width > 0)) return null;
        return (
          <div
            key={`tint-${band.phaseId ?? 'unassigned'}-${band.fromCol}`}
            className={`volume-band-tint-segment ${bandColorClass(band, phases)}`}
            style={{
              left: laneLabelWidth + from,
              width,
              top: headerHeight,
              bottom: 0,
            }}
          />
        );
      })}
    </div>
  );
}
