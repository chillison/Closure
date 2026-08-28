import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { SceneLine } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import type { CausalCardData } from './workbenchLayout';
import { lineHueIndex } from './linePalette';
import { nominalTimelineRegionWidth, TIMELINE_GEOMETRY } from './timelineGeometry';
import type { VolumeBand } from './volumeBands';

/**
 * dogfood R2 批次 B（SP-5 迷你地图）→ 08-26 批 8（implement 8.7）页级恒驻：
 * 全书压缩条挂 `.structure-page` 直子（chrome 带：zoombar 之后、legend 之前——
 * 带位理由见 StructurePage 落地注），sticky top+left 双轴钉驻——纵横任意滚动
 * 位置都可 seek/拖动（#37 恒可发现）。每场景一枚 3px 色块按所属线着色；卷分段
 * 刻度线 + 半透明 accent 视口框随页滚动联动。
 *
 * #51：卷名小字退役——刻度只画 1px 界线。#41：块分线行（每线一行细带）。
 *
 * ── 08-26 批 7（design §11 定案 4）：列基数换章轴 + 示意精度取舍注记 ──
 * `columnCount` = 共享轨道基数（章轨道数 + 待编排虚拟列，宿主 subgrid 模板同源）；
 * 块定位维持 **index × slot 均匀示意**——章列真实宽度随内容自适应（108..212px 浮动），
 * 轨道内均匀槽位是**有意的精度取舍**：minimap 的价值是相对位置感与可 seek 性，不是
 * 像素级比例尺；「精确比例映射」（实测逐列宽折算轨道 x）列为后续可选增强，本批不
 * 做。内容宽（seek/视口框映射的分母）同理：优先运行时实测（.structure-skeleton 屏
 * 矩形 ÷ zoom——#79：canvas 盒被钳在视口宽，真内容宽由骨架盒溢出承载，见实测
 * effect 处注），jsdom/无 RO 环境回退名义估算（nominalTimelineRegionWidth，纯函数
 * 单测锁定）。
 *
 * 交互：点击/拖动 → 驱动 `.structure-page` scrollLeft。屏↔自然换算**分两帧**（批 8
 * 迁出 zoom 容器后）：滚动量纲（page.scrollLeft/clientWidth ↔ canvas 自然内容宽）
 * 仍 ÷/×zoom（zoom=1 恒等）；轨道本地指针位移不再换算——minimap 是页级 chrome，
 * 自身不在画布 zoom 树内，rect 差值已是自然量纲。确定性纪律不变（jsdom 全 0 →
 * 名义表可精确断言）。
 */

/** 迷你地图轨道宽（列 × 每列槽宽）。纯函数，单测锁定。 */
export function minimapTrackWidth(columnCount: number): number {
  return columnCount * TIMELINE_GEOMETRY.minimapColSlotWidth;
}

/** 轨道高（mirror CSS .timeline-minimap-track 的 26px——#41 分线行的量度基准）。 */
export const MINIMAP_TRACK_HEIGHT = 26;

/**
 * 分线行几何（08-26 批 5 #41）：lane index → 轨道内 {top, height}。
 * 旧实现全块叠同一纵向位（+1px 露头）——6 线 × 30 场景糊成一坨（用户「上面拖动
 * 下面快捷导航完全糊了」）。修法 = 每线一行细带：行高 = floor(26/线数)，块高
 * = clamp(2, 行高-1, 18)（1 线退化为旧 18px 满高形态；2/4/6/12 线各得整数行），
 * top 居中入行。线数超 ~13（行高 < 2px）时块高保底 2px、行间轻微重叠——渐进
 * 降级（泳道位次为主识别，design §9.3 授权按真实数据定）。纯函数，单测锁定。
 */
export function minimapLaneRow(
  laneIndex: number,
  laneCount: number
): { top: number; height: number } {
  const lanes = Math.max(1, laneCount);
  const row = Math.floor(MINIMAP_TRACK_HEIGHT / lanes);
  const height = Math.min(18, Math.max(2, row - 1));
  const centered = laneIndex * row + Math.floor(Math.max(0, row - height) / 2);
  const top = Math.min(Math.max(0, MINIMAP_TRACK_HEIGHT - height), Math.max(0, centered));
  return { top, height };
}

/**
 * 当前视口（page scrollLeft/clientWidth）映射到迷你地图轨道上的框。
 * 时间线区域在页内容 x ∈ [0, timelineContentWidth]（因果骨架是页内容首子元素
 * ——名义表/运行时实测同源），可视窗与之求交后线性映射到轨道。
 * jsdom（clientWidth=0）→ width 0（框隐匿不误导）。纯函数，单测锁定。
 *
 * CR-17：轨道只代表时间线区域（块/刻度/seek 全按列换算），视口框因此取「可视窗 ∩
 * 时间线区域」的交集映射。滚过时间线右端（工作台更宽时）交集为空——旧行为把框钉死在轨道
 * 右缘且宽 0（零宽细线读作「坏了」）。钳制兜底：只要有真实视口宽，框保底一个
 * 列槽宽（minimapColSlotWidth）且整体钳回轨道内——语义是「已越过时间线右端」，
 * 正常范围内（交集非空）的精确映射不受影响。
 */
export function minimapViewportBox(
  scrollLeft: number,
  viewportWidth: number,
  timelineContentWidth: number,
  trackWidth: number
): { left: number; width: number } {
  const W = Math.max(1, timelineContentWidth);
  const clampedLeft = Math.min(Math.max(scrollLeft, 0), W);
  const clampedRight = Math.min(Math.max(scrollLeft + viewportWidth, 0), W);
  let left = (clampedLeft / W) * trackWidth;
  let width = Math.max(0, (clampedRight / W) * trackWidth - left);
  if (viewportWidth > 0 && width === 0 && trackWidth > 0) {
    // CR-17 钳制：交集为空（滚过时间线区）→ 保底一个列槽宽，left 钳回轨道内。
    width = Math.min(TIMELINE_GEOMETRY.minimapColSlotWidth, trackWidth);
    left = Math.min(left, trackWidth - width);
  }
  return { left, width };
}

/**
 * 指针 x（轨道内像素）→ 目标 page.scrollLeft（把该轨道位置呈现到视口中央）。
 * 分数越界裁剪 [0,1]；负目标（点轨道最左且视口已居中余量）夹回 0。纯函数。
 * 注：不向 page.scrollWidth 夹上界——jsdom 两个量都是 0 会把目标误夹成 0，
 * 浏览器对越界 scrollLeft 赋值自身会钳制，无须双重夹。
 */
export function scrollLeftForMinimapX(
  x: number,
  trackWidth: number,
  timelineContentWidth: number,
  viewportWidth: number
): number {
  const frac = Math.min(Math.max(x / Math.max(1, trackWidth), 0), 1);
  return Math.max(0, Math.round(frac * timelineContentWidth - viewportWidth / 2));
}

type TimelineMinimapProps = {
  /** causal 骨架的 layout 卡（块位置 = 所属章轨道；多线场景多块；待编排 = 末槽） */
  cells: CausalCardData[];
  /** scene_graph.lines（线名进块 tooltip） */
  lines: SceneLine[];
  /** 泳道序（NTP 传 layout.rows 的 lineId 序——#41 分线行的行号单源，与两侧泳道同序） */
  laneOrder: string[];
  /** 卷带 bands（章轴 = volumeBandsFromEpisodes 集映射产出，dogfood R2 #80；
   *  卷刻度线——#51 起只画 1px 刻度，不印卷名文字） */
  bands: VolumeBand[];
  /**
   * 共享轨道基数（08-26 批 7）：= chapterTrackCount + 1（待编排虚拟列）。
   * index×slot 均匀示意——示意精度取舍注记见文件头（design §11 定案 4）。
   */
  columnCount: number;
  colIndex: Map<number, number>;
  /** i18n：aria-label */
  ariaLabel: string;
  /** i18n：轨道悬停 tooltip（R4/AC6 可发现性）。 */
  seekHint: string;
  /**
   * i18n：容器 title（T20 发现批9——可见 chrome 小卡形态的可发现性半边）。
   * 悬停在轨道上显示 seekHint（轨道占卡面绝大部分）；本 title 覆盖卡缘/内衬区
   * ——「这块卡片是什么」的即时答案（「小地图」）。
   */
  containerTitle: string;
};

export function TimelineMinimap({
  cells,
  lines,
  laneOrder,
  bands,
  columnCount,
  colIndex,
  ariaLabel,
  seekHint,
  containerTitle,
}: TimelineMinimapProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [viewportBox, setViewportBox] = useState({ left: 0, width: 0 });

  // 08-26 批 1（AC5）：canvas zoom——IO 边界的屏↔自然换算因子（zoom=1 恒等）。
  const canvasZoom = useAppStore((s) => s.canvasZoom);

  // 批 7：内容宽运行时实测（RO 跟随布局变化。jsdom 无 RO → measured 保持 0 →
  // 名义表兜底，断言确定性保持）。批 8（8.7）迁出 zoom 容器后不再是 canvas 后代
  // ——测量目标改经页级兄弟查找（closest 只向上找，够不着同级；页是组件直挂点的
  // 唯一稳定锚）。
  //
  // ── #79（2026-08-28 CDP 定谳）：测量元素 = `.structure-skeleton`，非 canvas 盒 ──
  // canvas 盒自 #7/#55 起 `min-width:100%` + 容器宽把它钳在视口宽（真机 160 章：
  // canvas rect 1,469 = 视口宽，skeleton rect 17,660 = 真内容宽），max-content 轨道
  // 的溢出由子元素 skeleton 承载——量盒子拿到视口宽 → seek/拖拽的分母错 12 倍、只
  // 达首屏（75% 点击 → scrollLeft 367 应 12,153；30 章规模误差小未察觉，160 章全
  // 失效）。同坑在 StructurePage fitWidth 08-27 已实测修复在案（fitWidth 注：改量
  // page.scrollWidth）——本处换量内容载具对齐同一课。骨架盒与 canvas 同在 zoom 树
  // 内 → rect÷zoom 公式不变；DOM 序首个命中 = causal 骨架（minimap 所代表的时间线
  // 区域本身；两个 skeleton 同跨共享轨道等宽，取哪个同值）。查不到 skeleton（结构
  // 演进/隔离测试）→ 与旧查不到 canvas 同款 no-op 语义。AssocLayer 不在本修范围：
  // 它量 canvas rect 只取**原点**做端点 delta 换算（盒宽钳制不动 left/top），SVG
  // 宽值消费另有 overflow:visible 兜底不裁剪。
  //
  // ── 尺寸量纲口径（BMad CR 组2a/组4 ★：同值同义钉准）──
  // 自然内容宽 = `getBoundingClientRect().width ÷ zoom`。rect 已含 zoom 缩放（屏
  // px），除回 zoom 得 SVG user unit / 自然布局 px——量纲与 AssocLayer 端点换算
  // （同一 ÷zoom 公式）同义；测量元素按各面语义选（本组件 = 内容载具 skeleton，
  // AssocLayer = 宿主盒原点），不再共享同一 rect。不用 scrollWidth÷zoom 作第二套
  // 基准：scrollWidth 是不含 padding/border 的整数本位量纲，元素自带 zoom 时它与
  // 「rect÷zoom」既不同值也不同义（曾经两口径并插——minimap 拿 scrollWidth、关联
  // 线拿 rect，画布一经缩放即互相漂移）。锁定：÷zoom 公式改动必须连 AssocLayer
  // 的端点/尺寸换算一起改（#79 只换测量元素、不动公式——正是此边界）。
  useEffect(() => {
    const skeleton = rootRef.current
      ?.closest<HTMLElement>('.structure-page')
      ?.querySelector<HTMLElement>('.structure-skeleton');
    if (!skeleton || typeof ResizeObserver === 'undefined') return;
    let cancelled = false;
    const zoomSafe = canvasZoom > 0 && Number.isFinite(canvasZoom) ? canvasZoom : Number.EPSILON;
    const ro = new ResizeObserver(() => {
      if (cancelled) return;
      const w = skeleton.getBoundingClientRect().width / zoomSafe;
      setMeasuredRegionWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    });
    ro.observe(skeleton);
    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [canvasZoom]);

  const trackWidth = minimapTrackWidth(columnCount);
  // 时间线区域在页内容里的宽度：优先运行时实测（.structure-skeleton 屏矩形 ÷ zoom
  // ——#79 根修：量内容载具不量被钳的 canvas 盒，量纲口径见上方实测 effect 处注），
  // 无 RO/jsdom 回退名义估算（纯函数单源）。
  // 名义参数 = 章轨道数 = columnCount - 1（共享轨道基数减待编排列）。
  const nominalRegionWidth = nominalTimelineRegionWidth(Math.max(0, columnCount - 1));
  const [measuredRegionWidth, setMeasuredRegionWidth] = useState(0);
  const contentWidth = measuredRegionWidth > 0 ? measuredRegionWidth : nominalRegionWidth;

  const lineNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lines) m.set(l.id, l.name);
    return m;
  }, [lines]);

  // #41 分线行：lane 序号查表（laneOrder = NTP 泳道序，与因果骨架泳道/工作台行
  // 同序——块行位置与页面泳道位置上下对读）。laneOrder 缺该线（防御：数据竞态
  // 过渡帧）→ 块落第 0 行不崩。
  const laneIndexByLine = useMemo(() => {
    const m = new Map<string, number>();
    laneOrder.forEach((id, i) => m.set(id, i));
    return m;
  }, [laneOrder]);

  const blocks = useMemo(() => {
    const { minimapColSlotWidth } = TIMELINE_GEOMETRY;
    return cells.flatMap((cell) => {
      const cIdx = colIndex.get(cell.colValue);
      if (cIdx === undefined) return [];
      // 分线行几何（#41）：每线一行细带；同线同列碰撞堆保留 +1px 露头（行内叠放
      // 压缩读法——旧跨线叠罗汉已由分行消解）。
      const laneIdx = laneIndexByLine.get(cell.lineId) ?? 0;
      const { top, height } = minimapLaneRow(laneIdx, laneOrder.length);
      return [{
        key: `${cell.nodeId}|${cell.lineId}|${cell.subIndex}`,
        nodeId: cell.nodeId,
        colorIndex: lineHueIndex(cell.lineId),
        top,
        height,
        left: cIdx * minimapColSlotWidth + (cell.subIndex > 0 ? 1 : 0),
        title: `${lineNameById.get(cell.lineId) ?? cell.lineId} · ${cell.nodeId}`,
      }];
    });
  }, [cells, colIndex, lineNameById, laneIndexByLine, laneOrder.length]);

  // 视口框随页滚动联动：监听 .structure-page scroll（dispatch 指定）；挂载时
  // 先读一次初始位。屏 px（scrollLeft/clientWidth）÷zoom 归一到自然量纲再进纯
  // 函数（视口框的 left/width 落在被缩放的轨道里，自然 px 视觉上随轨道同比——
  // 映射自洽）。zoom 变化也触发重算（dep）。隔离面板测试（无 .structure-page
  // 祖先）下 closest 返回 null → 静默不接线，块/刻度照常渲染。
  useEffect(() => {
    const page = rootRef.current?.closest<HTMLElement>('.structure-page') ?? null;
    if (!page) return;
    const update = () => {
      setViewportBox(
        minimapViewportBox(
          page.scrollLeft / canvasZoom,
          page.clientWidth / canvasZoom,
          contentWidth,
          trackWidth
        )
      );
    };
    update();
    page.addEventListener('scroll', update, { passive: true });
    return () => page.removeEventListener('scroll', update);
  }, [contentWidth, trackWidth, canvasZoom]);

  /** 轨道 x → page.scrollLeft（点击与拖动共用一条换算路径；两端各做一次屏↔自然换算）。 */
  const seek = (clientX: number) => {
    const page = rootRef.current?.closest<HTMLElement>('.structure-page');
    const track = trackRef.current;
    if (!page || !track) return;
    // 防御：个别引擎/测试环境的 pointer 事件不带坐标（clientX undefined）——
    // Number.isFinite 拦截，按轨道最左处理，绝不把 NaN 写进 scrollLeft。
    if (!Number.isFinite(clientX)) clientX = 0;
    const rect = track.getBoundingClientRect(); // jsdom 全 0 → x = clientX（测试可预期）
    // 批 8（8.7）后轨道是页级 chrome、不在 .structure-canvas 的 zoom 树内——rect
    // 差值已是自然量纲，不做 ÷zoom（滚动面两端仍换算，见文件头注的分两帧说明）。
    const xNatural = clientX - rect.left;
    const targetNatural = scrollLeftForMinimapX(
      xNatural,
      trackWidth,
      contentWidth,
      page.clientWidth / canvasZoom
    );
    page.scrollLeft = Math.round(targetNatural * canvasZoom);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    // 指针捕获让拖动越出轨道仍持续跟踪；jsdom/旧引擎无实现时静默跳过（拖不出
    // 轨道场景仍正常——move 事件仍派发在轨道上）。
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not implemented in this environment */
    }
    seek(e.clientX);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seek(e.clientX);
  };
  const endDrag = () => {
    draggingRef.current = false;
  };

  // CR-21：window 级 pointerup/pointercancel 兜底。setPointerCapture 失败/未实现时，
  // 轨道外的松手事件不会派发到轨道 → 轨道自身的 onPointerUp 收不到 → draggingRef
  // 卡 true，后续纯 hover 的 pointermove 持续劫持滚动。常挂 window（非拖拽期为
  // no-op），随组件卸载拆除；轨道内松手会冒泡到 window，与轨道自身 endDrag 幂等。
  useEffect(() => {
    const stop = () => {
      draggingRef.current = false;
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
  }, []);

  return (
    // T20（发现批9）：容器携带 title + CSS 四边框/圆角/实底小卡形态——「来历不明的
    // 无框浅色条」判读的消解（容器 chrome 见 structure.css .timeline-minimap 段注）。
    <div className="timeline-minimap" ref={rootRef} title={containerTitle}>
      <div
        className="timeline-minimap-track"
        ref={trackRef}
        style={{ width: trackWidth }}
        role="navigation"
        aria-label={ariaLabel}
        title={seekHint}
        data-minimap-track
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {bands.map((band) => (
          <span
            key={`vol-${band.phaseId ?? 'unassigned'}-${band.fromCol}`}
            className="minimap-volume-mark"
            style={{ left: band.fromCol * TIMELINE_GEOMETRY.minimapColSlotWidth }}
            aria-hidden="true"
          />
        ))}
        {blocks.map((block) => (
          <span
            key={block.key}
            className={`minimap-block minimap-block--c${block.colorIndex}`}
            style={{ left: block.left, top: block.top, height: block.height }}
            data-mm-node={block.nodeId}
            title={block.title}
          />
        ))}
        <span
          className="minimap-viewport"
          style={{ left: viewportBox.left, width: viewportBox.width }}
          data-minimap-viewport
        />
      </div>
    </div>
  );
}
