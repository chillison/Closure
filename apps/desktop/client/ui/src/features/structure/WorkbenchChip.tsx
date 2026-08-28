import { useEffect, useRef, useState } from 'react';
import type { DragEvent, PointerEvent } from 'react';
import type { SceneGraphIssue } from '@orison/shared-contracts';
import type { PendingChipData, WorkbenchChipData } from './workbenchLayout';
import { WORKBENCH_GEOMETRY } from './workbenchLayout';
import {
  clearNodeHover,
  clearNodePreview,
  publishNodePreview,
  setNodeHover,
  useNodeHoverLit,
  useNodePreview,
} from './nodeSharedState';
import { lineHueIndex } from './linePalette';
import { ValidationBadges } from './ValidationOverlay';

/**
 * 08-26 结构页重构 批 3（implement 3.1 / design §5 / prd R1 R2）+ 08-27 R6 方案 D：
 * 工作台场景片 chip。状态视觉语法（design §5「一轴一维」）：
 *   - 线身份 → 色相：`lane-hue--c{n}` 局部变量（chip 边框 + 淡底 / 圆号底色同源）。
 *   - 阅读序 → 圆号（readIndex+1，线色底白字）；**倒叙 → 钢蓝圆号**（accent——
 *     阅读序与故事时序错位，序号跳变一眼可辨）。
 *   - 跨章 span → 宽卡物理形态本身即表达（T10 起「续至第 N 章」徽记退役——
 *     形态已承载语义，不再文字复述跨度）。
 *   - 选中 → 外环 outline（与 SceneCard 同款同公式：线色深化 12%、2px、offset 2px
 *     ——selectedNodeId 单源，因果卡与工作台 chip 同场景同显）。
 *   - 待编排 → 灰态（pending 类；dangling 场景，补挂章节后进章列）。
 *
 * 编辑手势（R6 §6.3 冻结案）：
 *   - **卡体拖拽 = 移动语义**（HTML5 DnD 管线；落点路由在槽位容器面——本组件零
 *     drop handler，杜绝冒泡双写与宽卡截胡）。dragstart 起手时若正在 resize 则
 *     preventDefault 抑制（热区起手误入 DnD 的双保险）。
 *   - **缘部把手 = 区间 resize**（pointer events）：左右 ~6px 热区，hover 显形是
 *     CSS 面（V 清单 `.workbench-chip-handle`）；move 只产预览态（类名 + data 属性
 *     + T15 实时变宽 inline 盒，零写盘），pointerup 一次 dispatch
 *     onResizeSpanRange——一次手势一次写。
 *     T15（发现批7·实时变宽）：手势期卡体**脱流抬升**（`--resizing` 类 absolute）
 *     + 实测列盒驱动 inline 宽——拖到第 2 格即占 2 格、第 3 格即占 3 格（用户
 *     拍板 UX 升级，虚线轮廓降为叠加提示形）。
 *     把手**恒渲染**（T11，「发现批5」：贴边界卡把手消失造成「有的只能左拉」的
 *     困惑——不可用不再是吞把手，而是 disabled 置灰 + title 说明；单章左缘/末章
 *     单章右缘为完全不可拉，宽卡贴边（起点=首章/终点=末章）为部分可用——收边
 *     仍可，只挂 title 不置灰）。
 *     手势健壮性（CR3 G 域 patch 批）：
 *     - gestureRef 持 pointerId——move/up/cancel 只认配对指针，第二指针（多点触控
 *       双把手）不覆盖不混写（G-F6）；
 *     - 预览解析列须在已建章集内（builtColumnSet，gap 轨 = 解析失败同处——保持
 *       上一预览，预览永不承诺未建章，G-F3）；
 *     - 吞点击旗标只武装到宏任务边界（无 click 跟随的路径由 setTimeout(0) 兜底
 *       disarm，不悬空误吞下一次真实点击，G-F7）；
 *     - beginResize 挂 window 级 up/cancel 兜底收手——capture 失败 / 窗外抬手时
 *       把手自身 handler 收不到事件，陈旧 gestureRef 会经 dragStartGuard 永久
 *       卡死卡体拖拽（edge）；up 端等值也照发提交（chip 侧 props 可能陈旧，真
 *       no-op 归模型层引用级短路，edge）。
 *     - T14（发现批6·真机红「拖拽准入全死」）中断面补全：up/cancel 之外，
 *       **window blur**（Alt+Tab 持键切走、他处松开——本窗口永远收不到 up）与
 *       **他位落指**（鼠标单指针下新 pointerdown ⇒ 本手势的 up 已丢；native 拖拽
 *       起手必经 pointerdown，此缝先行收手否则被卡手势吞掉整次拖拽尝试）同为
 *       cancel 信号；endResize 改「状态先清后判」——pending 中途翻转不再把
 *       gestureRef 整个卡死。
 *   - T16a→T18→T23（发现批8→9→10·宽卡物理形态三轮）：v1 全宽实心卡（双段判读
 *     定罪——六卡文字挤一条无边框长条）→ v2 内容宽实体卡 + 半透明延伸带（仍不
 *     符用户预期）→ **T23 终案（用户三段拍板）**：跨 N 章的卡 = 一张真正的横长
 *     方形横跨覆盖列。线行内 chip 全部绝对定位消费装填坐标（workbenchPacking
 *     阅读序 first-fit 天际线：同线永不重叠、撞则下放、行高随轨道增长）；文字
 *     完全显示=硬约束（估算帧不钉 inline height 内容自撑，实测帧钉装填高收敛）。
 *     v2 延伸带（span-band）随本形态退役删除。
 *   - T16b（发现批8·位移式平移）：onDragEnd 收尾缝——hook 侧抓起列记录的清场
 *     兜底（HTML5 拖拽对 drop 与一切取消路径恒发 dragend）。
 *   - 点击选中（共享抽屉）。悬停 title = 标题 · 阅读序（人话措辞）。
 *     pending 判别位 = chip.pending。
 *
 * T26（发现批10·多线实例三合一）：
 *   - ① resize 预览**跨实例传播**：同 nodeId 每线一枚 chip 实例（多线投影）——
 *     手势拥有者照旧（gestureRef/pointer 配对/提交都在被拖实例本地），但预览值
 *     发布到按 nodeId 键的轻量 mini-store（nodeSharedState，**不进 app store**
 *     ——指针频率路径零全局广播）；兄弟实例订阅共享值照画同款实时值盒
 *     （activePreview：类/data 属性/inline 盒全走它，兄弟无手势状态也照画——吃
 *     的是共享值；像素盒由各实例用各自注入的列盒 resolver 换算，几何随视图走）。
 *     抬手/取消清共享键与 gestureRef 生命周期同拍（T14 中断面纪律不变）。
 *     用户定谳事实记档：**提交时全实例同步 ✓（updateField 单写通道）——缺陷只在
 *     手势期预览不同步**（旧实现 T15 预览是本地 state，兄弟实例不知情）。
 *   - ② 多线静态标记（圆号双环 .workbench-chip-ord--multiline + data-multiline，
 *     数据 = chip.multiline〔workbenchLayout 单源：valid lineTags >1〕）+ 悬停
 *     任一实例全 nodeId 兄弟柔光（.workbench-chip--sibling-lit，nodeId 级订阅）。
 *   - 悬停键 (nodeId, lineId) 对发布到同一 store（T25 弧逐实例锚定的身份源）。
 *
 * （历史注记：«± 新增/减少章节»按钮族整体退役——低频高破坏面的 span 编辑被边缘
 *   直拖取代；「续至第 N 章」徽记先退化为纯信息展示、后随 T10 整体退役。）
 *
 * Paradigm guard：组件只反映数据 + 上报作者手势到 hook（确定性字段写入）；无语义判断。
 */
type WorkbenchChipProps = {
  chip: WorkbenchChipData | PendingChipData;
  nodeIssues?: SceneGraphIssue[];
  /** click → select（共享抽屉，与因果骨架 SceneCard 同一 selectedNodeId）。 */
  onSceneClick?: (nodeId: string) => void;
  selectedNodeId?: string | null;
  /** within-chapter positional drag（drop routing lives on the slot surface）. */
  onSceneDragStart?: (nodeId: string) => (e: DragEvent) => void;
  /**
   * T16b（发现批8）：卡体拖拽收尾缝（dragend）。HTML5 拖拽对 drop 与一切取消
   * 路径（Esc / 窗外释放）恒发 dragend——hook 侧抓起列记录在此兜底清场。
   */
  onSceneDragEnd?: () => void;
  /**
   * R6 方案 D：缘部直拖的提交缝（pointerup 一次调用 = applyResizeSpanRange 一条
   * op）。缺省时完全不渲染把手（孤立测试/无写通道形态）。
   */
  onResizeSpanRange?: (nodeId: string, newStartCol: number, newEndCol: number) => void;
  /**
   * 指针 clientX → 目标列 index 的解析器（视图层注入：实测列头表 → null 拒收；
   * §6.3 T1 梯）。解析失败时预览保持上一值，永不误提交非法列（提交层二次校验）。
   */
  resolveColumnAt?: (clientX: number) => number | null;
  /**
   * T15（发现批7·实时变宽）：列 index → 画布自然单位盒 {left,right} 的实测解析器
   * （父层注入，与 resolveColumnAt 同一 rect 表单源；屏系 rect ÷canvasZoom 归一，
   * 原点任意——消费侧只用差值）。resize 手势期把预览区间 [start..end] 换算成像素
   * 盒驱动卡体实时变宽（拖到第 2 格即占 2 格宽）；不可用（jsdom 零 rect / 未布局 /
   * 列不在表内）→ null，预览退回纯虚线轮廓形态（旧观感零断裂）。
   */
  resolveColumnBox?: (col: number) => { left: number; right: number } | null;
  /**
   * T23（发现批10·宽卡天际线装填）：装填盒——由 ChapterWorkbench 的线行装填纯
   * 函数产出（workbenchPacking.packLaneChips，阅读序 first-fit 天际线）。在场 =
   * chip 以绝对定位消费装填坐标（left/top + width 跨列盒宽 + maxWidth none；
   * height 仅实测校正帧由父层带上——估算首帧不钉高，卡高随文字内容自然生长，
   * 「文字完全显示」由内容自撑托底，天际线防估偏差的实测重排在父层
   * useLayoutEffect 一次落定）。缺省 = 非装填形态（待编排堆内灰片 / 孤立测试）：
   * in-flow 内容宽 + 212 上界（既有行为）。
   */
  box?: { left: number; top: number; width: number; height?: number };
  /** 已建章域下界（预览钳制；提交层 applyResizeSpanRange 仍兜底校验）。 */
  builtMinCol?: number;
  /** 已建章域上界（同上）。 */
  builtMaxCol?: number;
  /**
   * 已建章 index 集（episodeIndexSet 口径；CR3 G-F3 gap 门槛）：resize 预览的解析列
   * 不在集内（gap 轨）→ 与解析失败同处——保持上一预览，预览永不承诺未建章（抬手
   * 即所见即所写）。缺省 = 视 [builtMinCol..builtMaxCol] 为稠密已建域（孤立测试 /
   * 未接线形态兼容；提交层 applyResizeSpanRange 整区间守卫仍自校验兜底）。
   */
  builtColumnSet?: ReadonlySet<number>;
  /** 该 chip 的下一章是否真实存在（episodeIndexSet.has(colEnd+1)，父层计算传入）。 */
  canExtendRight?: boolean;
  /**
   * T11：把手边界态的悬停说明文案（i18n `structure.workbench.handle*` 三键，父层
   * 经 t() 解析后传入；缺省 = 边界态无 title——孤立测试/无文案形态）。
   */
  handleHint?: {
    /** 右把手完全不可拉（单章卡右缘=最后已建章——既不能扩也不能缩）。 */
    rightAtEnd?: string;
    /** 左把手完全不可拉（单章卡左缘不参与——首章稳定原则）。 */
    leftSingle?: string;
    /** 宽卡贴左缘（起点已是首章——向左扩不可、收起点仍可；仅说明不置灰）。 */
    leftAtFirst?: string;
  };
};

/**
 * resize 手势的进行中状态（ref 权威源 + state 渲染镜像）。pointerId 用于多点触控
 * 配对（CR3 G-F6）：undefined = jsdom 合成 MouseEvent / 无指针 id 环境——通配。
 */
/**
 * T15 预览盒（画布自然单位 px）——渲染跨度 = 预览区间的实测列盒：marginLeft =
 * 起始列对归属列（colStart）的左缘平移差（`left:auto` 静态位锚定下槽 padding 在
 * 差值中自消，正负皆可）；width = [start.left..end.right] 跨列盒宽（含中间列
 * gap——「占 2 格」的视觉即覆盖格间空隙）。
 */
type ResizePreviewBox = { marginLeft: number; width: number };

/** 手势预览形（ref 权威源与 state 渲染镜像共用；box=null = 几何不可用回退形态）。 */
type ResizePreview = { start: number; end: number; box: ResizePreviewBox | null };

type ResizeGesture = {
  pointerId: number | undefined;
  edge: 'left' | 'right';
  preview: ResizePreview | null;
};

export function WorkbenchChip({
  chip,
  nodeIssues,
  onSceneClick,
  selectedNodeId,
  onSceneDragStart,
  onSceneDragEnd,
  onResizeSpanRange,
  resolveColumnAt,
  resolveColumnBox,
  box,
  builtMinCol = 0,
  builtMaxCol = Number.MAX_SAFE_INTEGER,
  builtColumnSet,
  canExtendRight = false,
  handleHint,
}: WorkbenchChipProps) {
  // 显式判别位（CR 组 3a）：`'colStart' in chip` 鸭子探测退役——判别在类型单源。
  const pending = chip.pending;
  const spansChapters = !pending && chip.colEnd > chip.colStart;
  const selected = selectedNodeId != null && selectedNodeId === chip.nodeId;
  const clickable = !!onSceneClick;

  // ── T26：同 nodeId 跨线实例的共享态（nodeSharedState mini-store，nodeId 级订阅）──
  // 兄弟实例发布中的 resize 预览区间（null = 无进行中手势）；本实例手势期本地
  // preview 更新鲜，渲染合并时本地优先。
  const sharedPreview = useNodePreview(chip.nodeId);
  // 悬停任一同 nodeId 实例 → 全实例（含悬停者自身——视觉退让归 CSS :not(:hover)）。
  const siblingLit = useNodeHoverLit(chip.nodeId);

  // ── 缘部直拖手势（R6 方案 D；预览=ref/state 双轨，up 端从 ref 读权威值）──
  const gestureRef = useRef<ResizeGesture | null>(null);
  const [preview, setPreview] = useState<ResizePreview | null>(null);
  // 刚完成过 resize 的吞点击旗标：pointerup 后紧跟的合成 click 不应顺带选中抽屉。
  const swallowedClickRef = useRef(false);
  // window 级兜底收手监听的拆卸器（endResize / 卸载时收——见 installGestureFallback）。
  const clearGestureFallbackRef = useRef<(() => void) | null>(null);

  // T23 注：T18 的首帧 bump（bumpSpanGeom）已删——静止态几何（left/top/width/
  // height）的测量收敛由父层 ChapterWorkbench 的 settle useLayoutEffect 统一承担
  // （实测各 chip 内容高后带 measuredHeight 重排一次，先于 paint 零闪烁）；chip
  // 自身不再持有几何状态。

  // 把手激活判定（手势语义不变）：多章卡两缘皆活；单章卡只有右缘（首章稳定原则
  // ——presentationOrder 锚首章，移动由卡体独家负责），且须有下一章可扩。
  const canLeft = !pending && spansChapters;
  const canRight = !pending && (spansChapters || canExtendRight);
  const gestureLive = !!onResizeSpanRange && !pending;

  // T11（发现批5）：把手**恒渲染**——完全不可拉（canLeft/canRight 假）不再吞把手，
  // 置灰 + title 说明；宽卡贴边为**部分可用**（收边仍可——[0..2] 左缘收起点 /
  // 右缘收终点都是合法编辑），只挂 title 不置灰。title 缺省（无 handleHint）=
  // 边界态零说明（孤立测试形态）。
  const leftDisabled = !canLeft;
  const rightDisabled = !canRight;
  const leftTitle =
    !handleHint
      ? undefined
      : leftDisabled
        ? handleHint.leftSingle
        : !pending && chip.colStart <= builtMinCol
          ? handleHint.leftAtFirst
          : undefined;
  const rightTitle =
    !handleHint
      ? undefined
      : rightDisabled
        ? handleHint.rightAtEnd
        : spansChapters && chip.colEnd >= builtMaxCol
          ? handleHint.rightAtEnd
          : undefined;

  const endResize = (commit: boolean) => (e?: { pointerId?: number }) => {
    const st = gestureRef.current;
    if (!st) return;
    // 他指 up/cancel（G-F6 配对纪律）：本手势等配对指针收手，不误吞。
    if (
      e
      && typeof e.pointerId === 'number'
      && typeof st.pointerId === 'number'
      && e.pointerId !== st.pointerId
    ) {
      return;
    }
    // T14（发现批6）：**状态先清后判**。旧形 `if (!st || pending) return` 把「手势
    // 进行中 pending 翻转」的收手路径整个吞掉——gestureRef 永久悬空，该卡的
    // dragStartGuard 从此对每次拖拽起手 preventDefault（「部分卡能动部分不能」
    // 的单卡死亡形态），window 兜底监听也同步悬空。pending 中途翻转 = 章语义消失，
    // 正确语义是「收手不提交」，不是「拒绝收手」。
    gestureRef.current = null;
    const clearFallback = clearGestureFallbackRef.current;
    clearGestureFallbackRef.current = null;
    clearFallback?.(); // 正常路径先于 window 冒泡末站自清（零双触发）
    setPreview(null);
    // T26 ①：清共享预览键（兄弟实例随订阅回落）——与 gestureRef 生命周期同拍，
    // 上方「状态先清后判」早退路径（pending 翻转/零预览）同样走到这里。
    clearNodePreview(chip.nodeId);
    const p = st.preview;
    if (!p || pending) return; // 零预览 / pending 翻转——收手即可，无提交面
    // 吞旗标只武装到宏任务边界（G-F7）：真实尾随 click 与 pointerup 同一输入序列、
    // 先于定时器到达；pointercancel / 窗外 up 等无 click 跟随的路径由定时器兜底
    // disarm——不再悬空误吞下一次真实点击（「点了没反应」死区观感族）。
    swallowedClickRef.current = true;
    setTimeout(() => {
      swallowedClickRef.current = false;
    }, 0);
    if (commit && onResizeSpanRange) {
      // 等值也照发（CR3 edge）：手势中图可能被其他写者改写，chip 侧 colStart/colEnd
      // props 已陈旧——本地等值比较会静默跳过真变更。真无变更由模型层引用级 no-op
      // 兜底（零 updateField / 零落盘），「一次手势一次写」语义不变。
      onResizeSpanRange(chip.nodeId, p.start, p.end);
    }
  };

  const installGestureFallback = (pointerId: number | undefined) => {
    // capture 失败 / 窗外抬手兜底（CR3 edge）：up/cancel 不落把手元素时 React 处理
    // 器收不到事件，陈旧 gestureRef 会经 dragStartGuard preventDefault 永久阻塞卡体
    // 拖拽。window 级监听在冒泡末站收手（cancel 语义——capture 失败路径下指针落点
    // 不可信，不提交）；正常路径把手自己的 handler 先到（React 根在 window 之下）
    // 并自清本对监听。
    //
    // T14（发现批6）中断面补全：up/cancel 之外还有两类「收尾事件永不到达」的路径
    // 会让 gestureRef 悬空到下一次完整点击（而 HTML5 拖拽起手会**抑制后续 pointer
    // 事件**——被卡手势直接吞掉整次拖拽尝试，且失败本身不再产生可自愈的 up）：
    //   - window blur：Alt+Tab 持键切走、在他处松开——本窗口永远收不到 up；
    //   - 他位落指：鼠标单指针下「别处已有新 pointerdown」⇔ 本手势的 up 已丢。
    //     （native 拖拽起手必经 pointerdown——此缝先行收手，被卡手势不再吞噬
    //     拖拽尝试。把手上的落指除外：那是 resize 意图（含 G-F6 双把手多点触控），
    //     不当作陈旧信号。）
    const onEnd = (ev: Event) => {
      const pid = (ev as { pointerId?: number }).pointerId;
      if (typeof pid === 'number' && typeof pointerId === 'number' && pid !== pointerId) {
        return;
      }
      endResize(false)(ev as { pointerId?: number });
    };
    const onBlur = () => endResize(false)();
    // 起手 pointerdown 的 window 冒泡末站尚未越过前不自取消（同步挂监听会接住
    // 本手势自己的起手事件——微任务边界后放行；手势若在此之前已收手则监听已被拆）。
    let selfDown = true;
    queueMicrotask(() => {
      selfDown = false;
    });
    const onForeignDown = (ev: Event) => {
      if (selfDown) return; // 本手势自己的起手事件（同一次派发冒泡到 window）
      const target = ev.target;
      if (target instanceof Element && target.closest('.workbench-chip-handle')) {
        return; // 把手落指 = resize 意图（G-F6 双把手同席）——不作陈旧信号
      }
      endResize(false)();
    };
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointerdown', onForeignDown);
    clearGestureFallbackRef.current?.(); // 防御性（begin 已挡并发第二指针）
    clearGestureFallbackRef.current = () => {
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerdown', onForeignDown);
    };
  };

  // 卸载兜底：手势进行中卸载时拆掉 window 监听（ref 状态随组件死亡，不补收手）。
  // T26 追加：手势拥有者中途卸载（图被改写等）——共享预览键若不随葬，兄弟实例会
  // 永久卡在预览态（gestureRef 非空 = 本实例是发布者）；悬停键按本实例身份条件清
  // （悬停中卸载的等价缝）。
  useEffect(
    () => () => {
      clearGestureFallbackRef.current?.();
      if (gestureRef.current) clearNodePreview(chip.nodeId);
      clearNodeHover({ nodeId: chip.nodeId, lineId: chip.lineId });
    },
    [chip.nodeId, chip.lineId]
  );

  const beginResize = (edge: 'left' | 'right') => (e: PointerEvent<HTMLSpanElement>) => {
    if (!gestureLive) return;
    if (!(edge === 'left' ? canLeft : canRight)) return;
    if (typeof e.button === 'number' && e.button !== 0) return; // 仅主键起手
    // 多点触控守卫（G-F6）：进行中手势只认配对指针——第二指针按另一把手时「后入
    // 覆盖先入」会让两路 move 以对方 edge 混写同一手势、提交区间不确定。undefined
    // （jsdom 合成 MouseEvent）= 通配不设防。
    const st = gestureRef.current;
    if (
      st
      && typeof e.pointerId === 'number'
      && typeof st.pointerId === 'number'
      && e.pointerId !== st.pointerId
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    // 抑制原生拖拽链：把手起手后指针位移不应转成 HTML5 卡体拖拽。
    // （jsdom 无活动指针——capture 调用会抛 InvalidStateError；逐站防护。）
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      /* 非活动指针（测试/无障碍合成事件）——跳过捕获不影响手势状态机 */
    }
    gestureRef.current = { pointerId: e.pointerId, edge, preview: null };
    installGestureFallback(e.pointerId);
  };

  // T15 实时变宽的盒解析：预览区间 → 像素盒（null = 几何不可用，纯虚线轮廓回退）。
  // T23 起静止态宽度由父层装填盒（box）承载——本函数只服务手势期预览；锚定口径：
  // margin-left 相对「静态位」（= 归属槽内容盒原点）平移，槽间 padding 同值在差值
  // 中自消，故只需列盒差、无需读槽 padding。box.left 恒 0（chip 恒渲染于归属章槽）
  // ——预览的 margin-left 直接叠加在 left 之上，与 T15 前静态位锚定语义等价。
  const resolveSpanBox = (start: number, end: number): ResizePreviewBox | null => {
    if (!resolveColumnBox || chip.pending) return null; // pending 无章列——判别位收窄
    const startBox = resolveColumnBox(start);
    const endBox = resolveColumnBox(end);
    const homeBox = resolveColumnBox(chip.colStart);
    if (!startBox || !endBox || !homeBox) return null;
    return {
      marginLeft: startBox.left - homeBox.left,
      width: endBox.right - startBox.left,
    };
  };

  const moveResize = () => (e: PointerEvent<HTMLSpanElement>) => {
    const st = gestureRef.current;
    if (!st || pending) return;
    if (
      typeof e.pointerId === 'number'
      && typeof st.pointerId === 'number'
      && e.pointerId !== st.pointerId
    ) {
      return; // 他指 move（G-F6）——不混写本手势预览
    }
    const rawCol = resolveColumnAt?.(e.clientX) ?? null;
    if (rawCol === null || !Number.isFinite(rawCol)) return; // 解析失败——保持上一预览
    const clamped = Math.max(builtMinCol, Math.min(builtMaxCol, Math.floor(rawCol)));
    // gap 轨门槛（G-F3）：钳制域只保证端点在 [min..max]，不保证已建——解析列不在
    // 已建集时与解析失败同处（保持上一预览 = 钉在最近已建列），预览永不承诺未建
    // 章，杜绝「全程有预览、抬手零效果零解释」的死手势。
    if (builtColumnSet && !builtColumnSet.has(clamped)) return;
    const start = st.edge === 'left' ? Math.min(clamped, chip.colEnd) : chip.colStart;
    const end = st.edge === 'left' ? chip.colEnd : Math.max(clamped, chip.colStart);
    const next: ResizePreview = { start, end, box: resolveSpanBox(start, end) };
    const prev = st.preview;
    // 盒值也参与刷新判定：同列但几何漂移（手势中页面滚动/缩放使 rect 平移）时
    // 预览盒须跟上，否则变宽卡与列界错位到下次跨列才纠正。
    if (
      !prev
      || prev.start !== next.start
      || prev.end !== next.end
      || prev.box?.marginLeft !== next.box?.marginLeft
      || prev.box?.width !== next.box?.width
    ) {
      st.preview = next;
      setPreview(next);
      // T26 ①：预览值发布到 nodeId 键 mini-store——兄弟实例（他线行的同场景拷贝）
      // 订阅同值照画实时盒（用户定谳：提交同步而预览不同步才是缺陷）。只通知该
      // nodeId 的订阅实例，指针频率路径零全局广播。
      publishNodePreview(chip.nodeId, { start: next.start, end: next.end });
    }
  };

  // ── T26 ① 渲染合并：本实例的活跃预览 = 本地手势预览（拥有者，更新鲜）优先，
  //    否则吃兄弟实例发布的共享区间（数据级列号 → 本实例视图换算像素盒；几何
  //    seam 不可用 → box=null 纯虚线轮廓回退，同 T15 回退形态）。pending 实例
  //    无章语义，不消费共享预览。──
  const activePreview: ResizePreview | null = preview
    ?? (sharedPreview && !pending
      ? {
          start: sharedPreview.start,
          end: sharedPreview.end,
          box: resolveSpanBox(sharedPreview.start, sharedPreview.end),
        }
      : null);

  const dragStartGuard = (e: DragEvent) => {
    if (gestureRef.current) {
      e.preventDefault(); // resize 进行中不允许转入 HTML5 卡体拖拽
      return;
    }
    onSceneDragStart?.(chip.nodeId)(e);
  };

  return (
    <span
      className={[
        'workbench-chip',
        `lane-hue--c${lineHueIndex(chip.lineId)}`,
        pending ? 'workbench-chip--pending' : '',
        // 选择器契约钩子（CR3 auditor V-F7 + T23 修订）：形状/定位规则恒不在此
        // 复活——该类名是纯选择器锚：chapterWorkbench.test / SceneEditPopover.test
        // 以它定位跨章 chip；structure.css `:has()` 常驻解裁剪以它门控（装填宽卡
        // 要伸出槽外）。跨章语义由装填宽盒形态承载（T10 起零文字复述）。勿删类名
        // 输出、勿在此复活形状/定位规则。
        spansChapters ? 'workbench-chip--span' : '',
        // T23 装填形态：定位模式（absolute）归 CSS 本类，坐标值归 inline（见
        // style）——单一权威面。在场 = 父层装填盒已接线。
        box ? 'workbench-chip--packed' : '',
        clickable ? 'workbench-chip--clickable' : '',
        selected ? 'workbench-chip--selected' : '',
        // T26 ②：同 nodeId 兄弟柔光（悬停任一实例全实例点亮——悬停者自身的
        // :hover 样式在 CSS 侧以 :not(:hover) 退让）。
        siblingLit ? 'workbench-chip--sibling-lit' : '',
        // T26 ①：兄弟实例发布的共享预览同样落 resizing 形态（absolute+虚线+
        // 半透明复用 T15/T23 既有形态——吃的是共享值，无手势状态也照画）。
        activePreview ? 'workbench-chip--resizing' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        activePreview?.box
          ? {
              // T15 手势期实时变宽：width/margin-left 吃预览区间的实测列盒；T23 起
              // 装填坐标（left/top/height）静止沿用——手势不动纵向位，高度随装填
              // 高走。212 上界手势期解除——跨列预览必须越过（抬手随预览清除回
              // 装填盒 / 非装填形态的内容宽锚）。
              maxWidth: 'none',
              ...(box
                ? {
                    left: `${box.left}px`,
                    top: `${box.top}px`,
                    ...(box.height !== undefined ? { height: `${box.height}px` } : {}),
                  }
                : {}),
              marginLeft: `${activePreview.box.marginLeft}px`,
              width: `${activePreview.box.width}px`,
            }
          : box
            ? {
                // T23 装填盒：绝对定位坐标（模式归 CSS --packed 类，值归此处
                // inline）+ 跨列盒宽 + maxWidth none。height 仅实测帧由父层带上
                // （估算帧内容自撑——「文字完全显示」托底，实测重排后收敛钉高）。
                left: `${box.left}px`,
                top: `${box.top}px`,
                width: `${box.width}px`,
                maxWidth: 'none',
                ...(box.height !== undefined ? { height: `${box.height}px` } : {}),
              }
            : { maxWidth: WORKBENCH_GEOMETRY.chipMaxWidth }
      }
      data-node-id={chip.nodeId}
      data-line-id={chip.lineId}
      data-role={chip.role}
      data-read-index={chip.readIndex}
      data-pending={pending ? 'true' : 'false'}
      data-reordered={!pending && chip.reordered ? 'true' : 'false'}
      data-selected={selected ? 'true' : 'false'}
      /* T26 ②：多线拷贝静态标记（状态位恒串纪律——单线 false 非缺省）。 */
      data-multiline={chip.multiline ? 'true' : 'false'}
      data-resizing={activePreview ? 'true' : 'false'}
      {...(activePreview ? { 'data-resize-start': String(activePreview.start), 'data-resize-end': String(activePreview.end) } : {})}
      /* T25/T26：悬停键发布（(nodeId, lineId) 对——弧逐实例锚定的身份源 + 兄弟柔光
          的触发源）。React 由 mouseout/mouseover 合成 enter/leave——离场即条件清。 */
      onMouseEnter={() => setNodeHover({ nodeId: chip.nodeId, lineId: chip.lineId })}
      onMouseLeave={() => clearNodeHover({ nodeId: chip.nodeId, lineId: chip.lineId })}
      onClickCapture={(e) => {
        // resize 提交后的尾随 click：不许它顺带打开编辑浮层（swallow once）。
        if (swallowedClickRef.current) {
          e.preventDefault();
          e.stopPropagation();
          swallowedClickRef.current = false;
        }
      }}
      onClick={clickable ? () => onSceneClick(chip.nodeId) : undefined}
      draggable={!!onSceneDragStart}
      onDragStart={onSceneDragStart ? dragStartGuard : undefined}
      onDragEnd={onSceneDragEnd}
      title={`${chip.title ?? chip.nodeId} · ${chip.readIndex + 1}`}
    >
      <span
        className={`workbench-chip-ord${!pending && chip.reordered ? ' workbench-chip-ord--reorder' : ''}${chip.multiline ? ' workbench-chip-ord--multiline' : ''}`}
        aria-hidden="true"
      >
        {chip.readIndex + 1}
      </span>
      <span className="workbench-chip-title">{chip.title ?? chip.nodeId}</span>
      <ValidationBadges issues={nodeIssues} />
      {/* （T18 v2 延伸带 .workbench-chip-span-band 已随 T23 装填宽盒形态退役删除
          ——跨 N 章的卡本体即横跨覆盖列的横长方形，宽度证据无需第二载体。cssLock
          负断言防回魂。） */}
      {/* R6 方案 D 缘部把手（~6px 热区 hover 显形归 CSS；此元素只承载手势）。T11 起
          恒渲染：不可用态 = disabled 类 + data-disabled + title 说明（beginResize 对
          canLeft/canRight 假值早退，disabled 把手零手势零写入）。 */}
      {gestureLive && (
        <span
          className={`workbench-chip-handle workbench-chip-handle--left${leftDisabled ? ' workbench-chip-handle--disabled' : ''}`}
          data-resize-edge="left"
          data-disabled={leftDisabled ? 'true' : 'false'}
          aria-hidden="true"
          title={leftTitle}
          onPointerDown={beginResize('left')}
          onPointerMove={moveResize()}
          onPointerUp={endResize(true)}
          onPointerCancel={endResize(false)}
        />
      )}
      {gestureLive && (
        <span
          className={`workbench-chip-handle workbench-chip-handle--right${rightDisabled ? ' workbench-chip-handle--disabled' : ''}`}
          data-resize-edge="right"
          data-disabled={rightDisabled ? 'true' : 'false'}
          aria-hidden="true"
          title={rightTitle}
          onPointerDown={beginResize('right')}
          onPointerMove={moveResize()}
          onPointerUp={endResize(true)}
          onPointerCancel={endResize(false)}
        />
      )}
    </span>
  );
}
