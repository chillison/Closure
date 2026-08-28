import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { z } from 'zod';
import type { SceneGraph } from '@orison/shared-contracts';
import { episodeOutlineSchema, outlineV2Schema } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import {
  fitCanvasZoom,
  stepCanvasZoom,
  zoomFromWheel,
} from '../../shared/store/structureSlice';
import { TimelineEmptyState } from './TimelineEmptyState';
import { NarrativeTimelinePanel } from './NarrativeTimelinePanel';
import { StructureLegend } from './StructureLegend';
import { SceneEditPopover } from './SceneEditPopover';
import { ChapterWorkbench } from './ChapterWorkbench';
import { AssocLayer } from './AssocLayer';
import { applyLineHover, resolveHoverLine } from './lineHover';
import { isSceneGraphLike } from './layout';
import {
  deriveWorkbenchLayout,
  episodeTrackCountOf,
  PENDING_COLUMN_SENTINEL,
} from './workbenchLayout';
import { volumeBandsFromEpisodes, type OutlinePhase } from './volumeBands';
import { TimelineMinimap } from './TimelineMinimap';
import { sharedColumnTracks, sharedTrackCount } from './timelineGeometry';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

/** D2 新增高亮 TTL（详设三节：绿框脉冲 3s 后清）。 */
const HIGHLIGHT_TTL_MS = 3000;

/**
 * 08-26 结构页重构 批 3（implement 3.4 / design §1.1 / prd R1）：单列纵向堆叠——
 *   [ 因果骨架（章轴，格卡化） ]            ← 批 7 换轴（§11：storyTime 等距桶退役）
 *   ← 46px gap（批 4 AssocLayer 因果↔工作台关联线的居住区）
 *   [ 章节规划工作台（融合网格：行=线 / 列=章 / chip=场景片按阅读序） ]
 * 两区由批 7 的共享宿主轨道锁步（本文件 inline 模板单源）。
 *
 * 退役（删不留档）：阅读骨架独立视图 + PackingLinkLayer（#39 跨窗长斜线连根消失
 * ——「阅读顺序 ↔ 章节打包」语义由工作台 chip 承接）+ `.structure-content--horizontal`
 * flex 行布局。旧 AssociationLayer（常量几何 + reading 网格锚定）随批 4 退役删除，
 * 由 AssocLayer 重建（因果卡 ↔ 工作 chip 关联线：规则显隐 + DOM 实测端点，design
 * §6.1）。layout.ts 的 readPosition 派生保留（工作台 chip 阅读序号仍由它算）。
 *
 * Story 1.5 遗产注：双骨架等宽 padding（columnSlotCount）随阅读骨架退役——因果
 * 网格按自身列数渲染。The timeline is *derived* from scene_graph — never
 * hand-filled; the empty state is the only non-data view (落地公理).
 *
 * 08-26 批 4（R3/R1 线聚焦）：SceneEditPopover（fixed 指针旁浮层 + 页内拖动，
 * SceneDetailDrawer sticky 锚机制退役）/ AssocLayer / 线级悬停聚焦（悬停线元素 →
 * 其余降透明 25% + 该线关联线补齐，移开回落）+ agent 落盘新增节点高亮
 * （pendingStructureHighlight stash 消费 → highlightNodeIds TTL 3s）。
 *
 * ── 08-26 批 7（design §11「同构锁步」定案 2）：共享轨道宿主 ──
 * `.structure-canvas` 升 display:grid 宿主：inline gridTemplateColumns =
 * sharedColumnTracks(episodeTrackCountOf(episodes)) 单源产出一次；因果/工作台两个
 * 内网格各 `grid-template-columns: subgrid; grid-column: 1/-1` 接轨——纵向参考线
 * 在两区连续对齐，AssocLayer 关联线趋竖直。zoom 施加宿主不变；canvas 级
 * mouseover 委托（lineHover）不变。
 */
export function StructurePage() {
  // CR-001: shape-guard the store cast — a partial/malformed scene_graph (e.g.
  // `.nodes` undefined under mid-patch hydration) coerces to undefined so the
  // downstream `hasGraph` check + layout derivations never crash on a
  // `.nodes.length` / `.lines` access. Mirrors OutlineEditor `?? []` defense.
  const rawSceneGraph = useAppStore(
    useShallow((s) => s.creativeFields.scene_graph as SceneGraph | undefined)
  );
  const sceneGraph = isSceneGraphLike(rawSceneGraph) ? rawSceneGraph : undefined;
  // 批 7：宿主共享模板的章轨道基数——raw episode 数据直调单源函数（与两区派生同一
  // 口径，防第三条算max 的路径漂移）。
  const rawEpisodes = useAppStore(
    (s) => s.creativeFields.episode_outlines
  ) as EpisodeOutline[] | undefined;
  // 批 8（8.7）：页级 minimap 的卷刻度数据源（同 NTP 卷带的 unknown 原样取引用，
  // memo 内 safeParse 归一）。
  const rawOutline = useAppStore((s) => s.creativeFields.outline);
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const { t } = useI18n(resolvedLocale);

  // ⚠️ 先于全部 effect 计算（BMad CR 组3a 绑定死区修复的依赖面）：无图首挂载时
  // 本组件在下方提前 return TimelineEmptyState（页/canvas 容器都不存在），wheel/
  // hover 委托若按旧实现一次性挂 [] deps，图后到永不再绑。hasGraph 翻转进两处
  // 委托 effect 的依赖做条件重绑。
  const hasGraph = !!sceneGraph
    && (sceneGraph.nodes.length > 0 || sceneGraph.lines.length > 0);

  // D2：agent 落盘高亮——消费 applySelectedPatches 存下的待消费新增集。
  const setHighlightNodeIds = useAppStore((s) => s.setHighlightNodeIds);
  const highlightNodeIds = useAppStore((s) => s.highlightNodeIds);
  const pendingStructureHighlight = useAppStore((s) => s.pendingStructureHighlight);
  const consumePendingStructureHighlight = useAppStore((s) => s.consumePendingStructureHighlight);

  // ── 08-26 结构页重构 批 1（R4）：画布缩放 + 横向导航 ──
  const canvasZoom = useAppStore((s) => s.canvasZoom);
  const setCanvasZoom = useAppStore((s) => s.setCanvasZoom);
  const resetCanvasZoom = useAppStore((s) => s.resetCanvasZoom);
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // wheel 拦截（#36/#37）：ctrl → 画布 zoom、shift → 横向滚动（deltaY 转 scrollLeft）。
  // 原生 addEventListener + passive:false——React onWheel 挂在 root 上是 passive 监听，
  // preventDefault 不生效（ctrl+滚轮会落成浏览器整页缩放）。读值走
  // useAppStore.getState()（免闭包 stale；effect 只随稳定 action 重挂）。
  // deltaMode 1（DOM_DELTA_LINE，Firefox 鼠标滚轮）按每行 ≈16px 归一到像素量纲
  // ——shift 横滚分支与 ctrl 缩放分支同款归一（BMad CR 组3a：两分支曾一归一、一裸
  // delta，行模式下行进 3px/tick 的横滚几乎不可感）。
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        setCanvasZoom(zoomFromWheel(useAppStore.getState().canvasZoom, unit));
      } else if (e.shiftKey && e.deltaY !== 0) {
        e.preventDefault();
        page.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      }
    };
    page.addEventListener('wheel', onWheel, { passive: false });
    return () => page.removeEventListener('wheel', onWheel);
    // hasGraph 条件重绑：无图首挂载页容器不存在 → 图后到必须补绑（绑定死区修复）。
  }, [setCanvasZoom, hasGraph]);

  // ── 08-26 批 4（implement 4.4 / design §6.4）：线级悬停聚焦 ──
  // 页级 mouseover 委托（BMad CR 组2a/3a：委托根从 .structure-canvas 升
  // .structure-page——zoombar/minimap/legend 批 8 起已页级化，指针移入这些 chrome
  // 时旧根收不到 mouseover，降透明/关联线揭示滞留；chrome 无 data-line-*，resolve
  // 得 null = 回落）。closest('[data-line-id],[data-lane-id]') 命线 → applyLineHover
  // 切类；两条清态出口：
  //   ① relatedTarget 在委托根外（指针跨出窗口边界的 mouseover 链）→ 立即清；
  //   ② mouseleave 整页 → 清。
  // hover 态不走 React state/store——高频瞬态零重渲染（行为单源 = mockup v1.6；
  // 类切换纯函数在 lineHover.ts）。hasGraph 条件重绑同 wheel（绑定死区）。
  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    let hovered: string | null = null;
    const applyNext = (next: string | null) => {
      if (next === hovered) return;
      hovered = next;
      applyLineHover(page, next);
    };
    const onOver = (e: MouseEvent) => {
      // 逃逸出口：relatedTarget 在委托根**之外**（指针跨入窗口外的浮层/DevTools 等）
      // → 立即回落。relatedTarget 缺失（入场事件 / 合成事件）不判逃逸——root 的
      // mouseleave 出口兜底真离场。
      const related = e.relatedTarget;
      if (related instanceof Node && !page.contains(related)) {
        applyNext(null);
        return;
      }
      applyNext(resolveHoverLine(e.target));
    };
    const onLeave = () => {
      applyNext(null);
    };
    page.addEventListener('mouseover', onOver);
    page.addEventListener('mouseleave', onLeave);
    return () => {
      page.removeEventListener('mouseover', onOver);
      page.removeEventListener('mouseleave', onLeave);
      applyLineHover(page, null); // 卸载/重绑清聚焦残留
    };
  }, [hasGraph]);

  // 适宽：fit = viewport / content。内容宽必须取滚动几何 page.scrollWidth（zoom 后
  // 布局值 = 屏坐标语义）——.structure-canvas 盒自身 width:auto 填满视口，固定轨道
  // 以可见溢出探出盒外，getBoundingClientRect 量到的是视口宽而非内容宽（08-27 真机
  // 实测 1708.67 → fit≈1.0002 no-op）。jsdom 双 0 → no-op 契约不变。
  // useCallback（#78）：挂载自动适宽 effect 以它为 dep——store action 恒稳定引用，
  // effect 不因 fitWidth 逐渲染重建而重挂。
  const fitWidth = useCallback(() => {
    const page = pageRef.current;
    if (!page) return;
    setCanvasZoom(
      fitCanvasZoom(
        useAppStore.getState().canvasZoom,
        page.clientWidth,
        page.scrollWidth
      )
    );
  }, [setCanvasZoom]);

  // ── #78（2026-08-28 拍板修订）：不做挂载自动适宽，默认 100% 进页 ──
  // 曾实现挂载自动适宽（恰一次），用户真机试用后否决：160 章规模 fit≈8% 全览
  // 「实际上啥也看不清」，进去默认 100% 即可；全览是用户主动意图，按「适宽」钮
  // 手动触发（zoom 地板已放通至 0.05——structureSlice CANVAS_ZOOM_MIN——手动适
  // 宽可真正到达全宽天际线）。日常导航主干 = #79 修复后的 minimap 拖拽/点击 +
  // ctrl+滚轮缩放。另注：曾用 double-rAF 一次性测量，真机实测挂载时数据常仍在
  // 异步水合（creativeFields 空 → 不溢出 → 一次性锁死 no-op）——自动方案本身还
  // 带此竞态，撤销一并消除。批9 卷级折叠再设计真实规模阅读 UX。

  // ── 08-26 批 7（design §11 定案 2）：共享轨道宿主模板 ──
  // .structure-canvas 升 display:grid；gridTemplateColumns 由单源纯函数产出一次
  // 注入 inline——两个内网格（因果/工作台）各 subgrid 接轨，逐列宽度由浏览器在
  // 同一条轨道上解一次，纵向参考线全高连续（「同 template 字符串喂两个独立 grid」
  // 不成立：max-content 按各自内容解析，必须 subgrid）。zero episode → 两区同步
  // 退化「仅待编排列」（§11 定案 5）。
  const chapterTrackCount = useMemo(() => episodeTrackCountOf(rawEpisodes), [rawEpisodes]);
  const sharedTemplate = useMemo(() => sharedColumnTracks(chapterTrackCount), [chapterTrackCount]);
  const trackTotal = useMemo(() => sharedTrackCount(chapterTrackCount), [chapterTrackCount]);

  // ── 批 8（8.7）：页级恒驻 minimap 的数据面——与两区同一派生单源 ──
  // 块/泳道序/哨兵列映射全走 deriveWorkbenchLayout 一份输出（原面板内挂载
  // 时代的等价口径迁移，非第二条派生链）。pageLayout 恒非 null（hasGraph 守卫后），
  // 空守卫仅满足 TS（空态分支提前 return 不达此处）。卷刻度 dogfood R2 #80 起走
  // 集映射（episode.phase_ref 直接定卷，与两区卷带同一映射——见下）。
  const pageLayout = useMemo(
    () => (sceneGraph ? deriveWorkbenchLayout(sceneGraph, rawEpisodes) : null),
    [sceneGraph, rawEpisodes]
  );
  const pageOutlinePhases = useMemo<OutlinePhase[]>(() => {
    const parsed = outlineV2Schema.safeParse(rawOutline);
    return parsed.success ? parsed.data.phases : [];
  }, [rawOutline]);
  const minimapColIndex = useMemo(() => {
    const m = new Map<number, number>();
    for (let c = 0; c < chapterTrackCount; c++) m.set(c, c);
    m.set(PENDING_COLUMN_SENTINEL, chapterTrackCount);
    return m;
  }, [chapterTrackCount]);
  // ── dogfood R2 #80：minimap 卷刻度切集映射（章轴权威源 = episode.phase_ref——
  // 与因果/工作台两区卷带同源，不再有第二种口径；旧伪 cell 投币在稀疏场景工程里
  // 产出灰带交错的假「未分卷」）。无 phases → 零刻度。 ──
  const minimapBands = useMemo(
    () => (pageOutlinePhases.length === 0 ? [] : volumeBandsFromEpisodes(rawEpisodes ?? [], pageOutlinePhases)),
    [rawEpisodes, pageOutlinePhases]
  );

  // ── D2 agent 落盘新增节点高亮（详设三节；CR-4/CR-25 重构后的两段式）──
  // 段一（CR-25）：触发点在 creativeFieldsSlice.applySelectedPatches——本页挂载或
  // stash 更新时消费（consume 原子取走并清空，StrictMode 双跑天然幂等）并写入
  // highlightNodeIds（SceneCard ✦ 脉冲角标）。source='user' 的 updateField 手势
  // 不经 apply 通道，天然不进高亮（作者自己知道刚建了什么）。
  useEffect(() => {
    if (pendingStructureHighlight.length === 0) return;
    const ids = consumePendingStructureHighlight();
    if (ids.length > 0) setHighlightNodeIds(ids);
  }, [pendingStructureHighlight, consumePendingStructureHighlight, setHighlightNodeIds]);

  // 段二（CR-4）：TTL 定时器生命周期只跟 highlightNodeIds 本身走（图编辑不打断
  // 倒计时——3s 窗口内用户一编辑不重臂也不清）。
  useEffect(() => {
    if (highlightNodeIds.length === 0) return undefined;
    const timer = setTimeout(() => setHighlightNodeIds([]), HIGHLIGHT_TTL_MS);
    return () => clearTimeout(timer);
  }, [highlightNodeIds, setHighlightNodeIds]);

  // 卸载清高亮（切页残留的脉冲态不跨页存活）。
  useEffect(() => () => {
    setHighlightNodeIds([]);
  }, [setHighlightNodeIds]);

  if (!hasGraph || !sceneGraph) {
    return <TimelineEmptyState />;
  }

  return (
    <div className="structure-page" data-page="structure" ref={pageRef}>
      {/* 08-26 批 1（R4）：画布缩放组——页级、canvas 外（design §3.4：工具栏不受
          缩放）。sticky left：页横向滚动时钉在视口左缘（批 8.7 起 minimap 与图例
          同为页级钉驻成员，本行是先例）。
          ％ 钮显示当前倍率，点击复位 100%（R4「双击/按钮复位」的按钮路径）。 */}
      <div className="structure-zoombar" role="group" aria-label={t('structure.zoom.group')}>
        <button
          type="button"
          className="structure-zoombar-btn"
          data-zoom-action="out"
          aria-label={t('structure.zoom.out')}
          title={t('structure.zoom.out')}
          onClick={() => setCanvasZoom(stepCanvasZoom(useAppStore.getState().canvasZoom, -1))}
        >
          −
        </button>
        <button
          type="button"
          className="structure-zoombar-btn structure-zoombar-pct"
          data-zoom-action="reset"
          aria-label={t('structure.zoom.reset')}
          title={t('structure.zoom.reset')}
          onClick={resetCanvasZoom}
        >
          {Math.round(canvasZoom * 100)}%
        </button>
        <button
          type="button"
          className="structure-zoombar-btn"
          data-zoom-action="in"
          aria-label={t('structure.zoom.in')}
          title={t('structure.zoom.in')}
          onClick={() => setCanvasZoom(stepCanvasZoom(useAppStore.getState().canvasZoom, 1))}
        >
          ＋
        </button>
        <button
          type="button"
          className="structure-zoombar-btn structure-zoombar-fit"
          data-zoom-action="fit"
          title={t('structure.zoom.fitTitle')}
          onClick={fitWidth}
        >
          {t('structure.zoom.fit')}
        </button>
      </div>

      {/* 08-26 批 8（implement 8.7）：全书迷你地图升格**页级 chrome 带**（原挂因果
          骨架区内的占位行回收）。带位 = zoombar 与图例之间：①minimap 是导航件，与
          缩放控制同层阅读（都是「看多宽/在哪」的横轴控制）；②sticky top 只需对齐
          恒高 zoombar（32px）——排在 legend 之后则 top 值要吃 legend 的可变展开高，
          固定值必重叠/漏缝。sticky **top+left 双轴**钉驻：纵横任意滚动位置都可
          seek/拖动（#37 恒可发现）；在 zoom 容器外（design §3.4 chrome 边界），
          组件内部滚动量纲仍 ÷zoom/×zoom 换算，轨道本地指针位移已是自然量纲不再
          换算（批 8 迁出后的分帧约定——TimelineMinimap 文件头注）。 */}
      <TimelineMinimap
        cells={
          pageLayout
            ? [...pageLayout.causalSlots.values()]
                .flat()
                .concat([...pageLayout.causalPending.values()].flat())
            : []
        }
        lines={sceneGraph.lines}
        laneOrder={pageLayout ? pageLayout.rows.map((r) => r.lineId) : []}
        bands={minimapBands}
        columnCount={trackTotal}
        colIndex={minimapColIndex}
        ariaLabel={t('structure.minimap.label')}
        seekHint={t('structure.minimap.seekHint')}
        containerTitle={t('structure.minimap.title')}
      />

      {/* 08-26 批 2（implement 2.3 / prd R2）：图例常驻工具栏（缩放组）之下、
          canvas 之外（chrome 不随画布缩放）。完备是验收线——所有视觉记号必须
          在图例，structureLegend.test 断言锁定。 */}
      <StructureLegend lines={sceneGraph.lines} />

      {/* 08-26 批 1/3/7（R4 + design §1.1 §11）：zoom 作用容器 = 双视图共同父，
          且批 7 起**共享轨道宿主**（display:grid）——因果骨架在上、46px gap、工作台
          在下；格/连线/叠层同容器同比 → 几何不破（AC5；批 8.7 起 minimap 移出
          zoom 容器升页级 chrome，其换算在组件内部自洽）；inline
          gridTemplateColumns = sharedColumnTracks 单源，两个内网格 subgrid 接轨。
          data-shared-track-count 供单源测试对拍（= episodeTrackCountOf+1）。 */}
      <div
        className="structure-canvas"
        data-structure-canvas
        ref={canvasRef}
        style={{
          zoom: canvasZoom,
          display: 'grid',
          gridTemplateColumns: sharedTemplate,
        }}
        data-shared-track-count={trackTotal}
      >
        <section className="structure-skeleton" data-skeleton="causal">
          <h3 className="structure-skeleton-title">{t('structure.skeleton.causal')}</h3>
          <NarrativeTimelinePanel />
        </section>

        {/* 双视图间保留带（design §1.1 定 46px）——AssocLayer（因果↔工作台关联线：
            对齐=短竖线 / 错位=短斜线承载倒叙信号）的居住区。 */}
        <div className="structure-skeleton-gap" data-skeleton-gap aria-hidden="true" />

        <section className="structure-skeleton" data-skeleton="workbench">
          <ChapterWorkbench />
        </section>

        {/* 08-26 批 4（implement 4.2）：关联线层——因果卡 ↔ 工作 chip 的短连线，
            规则显隐（anomaly+selected 常驻 / minor 悬停揭示）+ DOM 实测端点（zoom
            天然兼容）。canvas 内（zoom 同比，AC5）；pointer-events:none；svg 经
            closest 自定位宿主。 */}
        <AssocLayer />
      </div>

      {/* 08-26 批 4（implement 4.1 / prd R3）：场景编辑浮层——canvas **外**（fixed
          定位不受画布 zoom 缩放，design §3.4），点击卡/chip 于指针 +14px 展开 +
          标题栏拖动钳位结构页内。单例；selectedNodeId 驱动开/移位/重载。Renders
          null until a scene is picked.
          T1 常驻契约（2026-08-27 C1 遍历首开锚丢失）：挂载表达式**无条件**——锚记录
          监听器（document capture click）随组件存活，关闭态（面板按 node 条件渲染
          null、hooks 全在早退前）照常记锚，「首开也走 L1 点击锚」依赖此形态；改成
          条件挂载 = 首开恒落 L3 默认位（SceneEditPopover T1 用例锁死）。 */}
      <SceneEditPopover />
    </div>
  );
}
