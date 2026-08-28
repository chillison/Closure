import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent } from 'react';
import type { z } from 'zod';
import { useShallow } from 'zustand/react/shallow';
import {
  applySceneGraphActions,
  episodeOutlineSchema,
  outlineV2Schema,
  validateSceneGraph,
  OUTCOME_TYPE_VOCAB,
  PACING_ROLE_VOCAB,
  type SceneEdge,
  type SceneGraph,
  type SceneGraphAction,
  type SceneGraphIssue,
  type SceneNodeRole,
} from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { isProjectRunActive } from '../../shared/store/agentSessionSlice';
import { useI18n } from '../../shared/i18n/useI18n';
import { isSceneGraphLike } from './layout';
import {
  buildAddEdgeAction,
  buildRemoveSceneActions,
  clampStoryTime,
  edgesTouchingNode,
} from './sceneGraphEditModel';
import { PENDING_CHAPTER_SENTINEL } from './workbenchLayout';
import { useSceneGraphEdit } from './useSceneGraphEdit';
import { DeleteConfirmDialog } from '../model-settings/DeleteConfirmDialog';

/**
 * 08-26 结构页重构 批 4（implement 4.1 / design §6.2 / prd R3）：场景编辑浮层——
 * SceneDetailDrawer 的指针旁改造（终版拍板：**fixed 定位 + 点击点 +14px 展开 + 视口
 * 钳位/右下缘翻转 + 标题栏拖动钳位结构页内**；「视口左/右定侧 + sticky 锚」过渡方案
 * 与 `.scene-detail-drawer-anchor` 机制退役，#38 定位错乱的解）。
 *
 * 行为规格（mockup v1.7 openDrawerAt/drag 段——浏览器断言过的验收标准）：
 *   - 展开位 = 最近一次点击点 +14px（`placePopover` 纯函数：右缘翻到点击点左侧、
 *     下缘翻到上方、左/上缘钳 margin；无点击锚的程序化打开（右键改名/新建列钮）落
 *     默认位或保持现位——单例不移位）。
 *   - 单例：点新卡/chip → 移位重载内容（selectedNodeId 单源驱动）；✕/Esc/外点关闭
 *     （外点 = 浮层外且非卡/chip 的点击——点卡/chip 走移位重开流）。
 *   - 拖动：标题栏 mousedown 按住拖（标题输入/按钮不触发），`clampDragPosition`
 *     钳位**结构页边界内**（垂直方向至少留住标题栏——拖不丢手柄）。
 *   - 浮层渲染在 `.structure-canvas`（zoom 容器）**外**——zoom 不缩放浮层（design
 *     §3.4「工具栏/浮层不受缩放」）。
 *
 * 08-27 结构页修复第三轮（R2 放置算法整段复审重写，#66 + #72 / E1 取证四路径）：
 *   - 可视域钳位尊重顶部恒驻 chrome 带——bounds.top 抬到 zoombar/minimap 带底缘
 *     （DOM 实测优先，102px 页相对口径兜底），placement 与拖拽共用同一界；
 *   - 打开锚三层回退闭合：L1 事件坐标 → L2 打开方元素 rect（键盘激活等无坐标
 *     形态落激活元素邻域）→ L3 defaultAnchor——(0,0) 落点全路径不可达；
 *   - locate 兜底改「打开方元素自身」优先于全图文档序首个同名子（多线节点双份
 *     元素是常态非异常，异区错锚根修）；合成/信任事件同路径零分支差异；
 *   - 高于可视域 → 顶钉最大化（钳位数学证明见 placePopover 分支④头注）。
 *
 * 08-27 第三轮 CR（P 域 patch 批）：
 *   - 分支②底对齐补下界钳位（锚低于可视域的 portal 扫过点击不再把浮层伸进页底，
 *     edge P-1）+ placePopover 产 maxHeight 高度联动（「顶钉=最大化高度」承谛成立，
 *     blind P-F5）；
 *   - sourceOpener 三联守卫：浮层关闭即清 ref / 兜底链消费前身份校验 / 仅点击命中
 *     卡时写 ref（blind P-F1 + edge P-3/P-4）；
 *   - topChromeFloor 零矩形采信门槛对齐 either-zero（blind P-F2 + auditor P-F3）；
 *   - zone-badge tabIndex 补键盘/触屏可达（edge P-6）；formatEpisodeMembership
 *     守卫扩展至负数/非整数索引（edge P-5 + auditor P-F7）。
 *
 * 08-27 C1 真机遍历 T1（首开锚丢失——AC4 红四入口 x=页左+14 全复现）：挂起锚改
 * 「配对存活」——卡片点击锚（带 nodeId 标记）豁免关闭态清扫 + 消费侧身份校验。
 * 真机交错根因：锚记录（document capture 原生监听，setAnchorTick 独立调度）与
 * 选中提交（React 冒泡分派 → 外部 store）可分属两次 commit——锚记录提交先落时
 * 定位 effect 的 !node 清扫把即将被消费的锚提前毁掉，首开恒落 L3 默认位；jsdom
 * 矩阵全绿是 RTL act() 合并提交的假象（T1 用例以不冒泡原生 click 解耦两半锁死
 * 该交错）。组件常驻挂载契约（监听器随组件存活、面板按 node 条件渲染）由
 * StructurePage 挂载点注释与 T1 用例共同锁定。
 *
 * 内容结构 = SceneDetailDrawer 两区三档原样（机械·直写 / 作者主权·直写 / AI 建议），
 * 写通道不变（useSceneGraphEdit → 同一投影器 → updateField）。自由文本 500ms
 * debounce + 切场景/卸载 flush 照旧（闭浮层不丢 0–500ms 窗口的字）。
 */
type OutlineV2 = z.infer<typeof outlineV2Schema>;
type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

/** 自由文本 debounce（mirror OutlineEditor DEBOUNCE_MS）。 */
const TEXT_DEBOUNCE_MS = 500;

/** 叙事枚举 select 里「自定义…」哨兵值（schema 收任意 string——哨兵不会落库）。 */
const CUSTOM_SENTINEL = '__custom__';

// ── 定位纯函数（导出单测：四缘坐标矩阵全覆盖）──

/** 展开偏移（点击点 +14px——prd R3 拍板）。 */
export const POPOVER_POINTER_OFFSET = 14;
/** 钳位边界缘安全边距（钳位/翻转后的最终落点不贴边）。 */
export const POPOVER_EDGE_MARGIN = 12;
/** 拖动钳位的页缘呼吸边距。 */
export const POPOVER_DRAG_MARGIN = 4;
/** 拖动垂直下限：至少留住标题栏高度（拖不出手柄——mockup -40 同款）。 */
export const POPOVER_DRAG_HEADER_KEEP = 40;

/**
 * 顶部恒驻 chrome 带的**页相对兜底口径**（R2 升级 #72：可视域钳位必须尊重顶部
 * chrome 带）。
 *
 * E1 取证口径注记（CR3 blind P-F3 + auditor P-F5）：E1 原始记录只写了
 * `zoombarBottom=102` 单值，未标注坐标系——按「页相对」（`raw.top + 常量`）消费，
 * 与 E1 会话形态（页顶 ≈ 视口顶，绝对视口 Y 与页相对近似同值）一致；数值为该会话
 * 恒驻带底缘的量级，代表 **zoombar+minimap 恒驻带的总高**（带内堆叠形态），非仅
 * zoombar 单成员。实测路径优先：真机若 minimap 底缘更低（或 chrome 高度演进），
 * DOM 实测恒接管，本值只在实测不可用（jsdom 零矩形 / 未布局 / 隔离渲染兜底路径）
 * 时垫底。
 *
 * 单源注记：恒驻带成员 = `.structure-zoombar`（structure.css 高 32px）+
 * `.timeline-minimap`（批 8.7 升格的页级 chrome 带）——真值优先 DOM 实测
 * （resolvePopoverBounds 内取成员 rect 底边最大者）；接线守卫（选择器在真实页面
 * DOM 中存在且实测分支可达）由 SceneEditPopover.test 的组件级用例锁定——选择器
 * 漂移（CSS/DOM 改名、成员迁出 .structure-page）会使该测试红，而非静默退化回本
 * 兜底值。
 *
 * 家族挂靠（TIMELINE_GEOMETRY 同职）：与 `timelineGeometry.TIMELINE_GEOMETRY`
 * 同为「页面像素常量单源」一族，终局归属是其家族表——本任务授权文件面仅含浮层
 * （G/V 两片并行占用该文件），搬家由收口批次落位；消费侧一律走
 * resolvePopoverBounds，禁止直读本值做几何。
 */
export const POPOVER_TOP_CHROME_BAND_FALLBACK = 102;

export type PopoverSize = { width: number; height: number };
export type PopoverBounds = { left: number; top: number; right: number; bottom: number };

/**
 * 页级恒驻顶部 chrome 选择器族（zoombar + minimap——竖向钉顶成员）。legend 只钉左
 * 且高度随展开可变，不入带。新增钉顶成员须同址登记（成员缺失时兜底常量接管，
 * 漏登记的症状 = 浮层压进该 chrome 条下）。
 */
const TOP_CHROME_SELECTORS = ['.structure-zoombar', '.timeline-minimap'] as const;

/**
 * 钳位界（08-26 批 5 #48）：**`.structure-page` rect**（fixed 坐标系），非整窗
 * 视口——浮层顶部钻到应用顶栏/状态栏下面（用户实测 #48）的解：页面天然在 chrome
 * 之下，与既有 clampDragPosition 同界一致。
 *
 * R2 升级（#72 追加）：返回前把 `top` 抬到「顶部恒驻 chrome 带底缘」——placement
 * 与拖拽共用同一界，浮层顶边永不压进 zoombar/minimap 带（E1 取证：原口径只保页
 * rect，近顶点击必然钻带下）。带底优先 DOM 实测（TOP_CHROME_SELECTORS 成员的
 * rect.bottom 最大值）；实测不可用退单源兜底常量（页相对 102px 口径）。
 *
 * CR 组 3a 边界语义修订（保留）：页元素在场即按其 rect 钳——**零尺寸 rect（真折
 * 叠/过渡态）也是真实界**，钳进小盒只是贴角可见性差，绝不能退视口界绕过 #48（旧
 * 「全 0 当 jsdom 退化」的分支会把折叠态浮层放回整窗、钻 chrome 下）。仅缺页元素
 * （隔离渲染/测试）才退视口界；jsdom 全量视口值可测，测试要确定性界就 mock 页 rect。
 */
export function resolvePopoverBounds(pageEl: HTMLElement | null): PopoverBounds {
  const raw: PopoverBounds = pageEl
    ? (() => {
        const r = pageEl.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      })()
    : {
        left: 0,
        top: 0,
        right: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth,
        bottom: typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerHeight,
      };
  return { ...raw, top: topChromeFloor(pageEl, raw) };
}

/**
 * 顶部恒驻 chrome 地板（绝对视口 Y）。实测优先：遍历选择器族取可用 rect 的最大
 * 底边；成员矩形任一维为零（jsdom / 未布局首帧 / 半塌缩过渡态——height 塌 0 宽
 * 仍在的形态不采信，否则地板落在该成员 top 边）不采信（**either-zero 拒收**，
 * CR3 blind P-F2 + auditor P-F3：与注释引证的 collectStackBands / L2 采信门槛
 * 真正同口径——旧实现 both-zero 才拒是反引同款名号的更宽口径），全部不可用时退
 * POPOVER_TOP_CHROME_BAND_FALLBACK 页相对垫底。
 *
 * 缺页元素 → 原样返回 raw.top（无带信息可测，不凭空抬顶——隔离渲染语义不变）；
 * 兜底防倒挂：地板永不越过页面 bottom（折叠态零尺寸界按原 top 返回）。
 */
function topChromeFloor(pageEl: HTMLElement | null, raw: PopoverBounds): number {
  if (!pageEl || typeof pageEl.querySelectorAll !== 'function') return raw.top;
  let measuredBottom: number | undefined;
  for (const sel of TOP_CHROME_SELECTORS) {
    for (const el of Array.from(pageEl.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) continue; // 任一维零——未布局/半塌缩，不采信
      measuredBottom = Math.max(measuredBottom ?? Number.NEGATIVE_INFINITY, r.bottom);
    }
  }
  const floor = measuredBottom ?? raw.top + POPOVER_TOP_CHROME_BAND_FALLBACK;
  return Math.min(Math.max(raw.top, floor), Math.max(raw.top, raw.bottom));
}

/**
 * 浮层展开位（纯函数）：点击点 +14px 起步；右缘放不下翻到点击点左侧、下缘放不下
 * 翻到点击点上方；左/上缘钳 margin——全部相对 `bounds`（#48：结构页 rect 经
 * resolvePopoverBounds 抬升 chrome 地板后的**可视域**——R2 升级 #72：顶部永不压
 * zoombar/minimap 带；页面底部守护由 bounds.bottom 承担）。界比浮层还小（极端窄
 * 窗/jsdom 零尺寸）→ 钳到界内（max 守卫防倒挂）。返回 fixed 定位坐标（= 视口坐标）。
 *
 * y 轴分支表（公式固化——唯一魔法常量是 POPOVER_POINTER_OFFSET / EDGE_MARGIN，
 * 无散落偏移；「底对齐」口径即 E1 观测的雏形行为升格为显式②支）：
 *   ① 下展放得下        → top = py + OFFSET
 *   ② 下展溢出、上翻放得下 → top = py − OFFSET − height（底缘恒距点击点 −OFFSET）
 *   ③④（else 同解合并，CR3 blind P-F4）近顶点击垂帘展开（③ 箱可容）/ 高于可视域
 *      顶钉最大化（④ 箱不可容）——两支经钳位数学必然坍缩同解 minTop：③条件
 *      h+2M≤boxH ⟺ minTop+h ≤ 底界−M（即③本身产出合法垂帘位）；④的底钉候选
 *      bottom−M−h < minTop ⇒ max 钳回 minTop——原 else-if 谓词对输出零影响，分支
 *      语义保留在本表。顶钉同时是唯一保住标题栏手柄可见的形态（拖不丢手柄不变式
 *      的 placement 侧推论）。
 * 末行双向钳位：`max(minTop,·)` 守卫任何分支（含防御性负坐标点击）不得越过 chrome
 * 地板；`min(·,maxTop)` 守卫分支②的底对齐在**锚点低于可视域**（portal 菜单扫过
 * 点击，py > bounds.bottom）时不得把浮层伸进页底（CR3 edge P-1 回归修复——旧实现
 * 只钳上界）。maxTop 自带 `max(minTop,·)` 防倒挂：浮层高于可视域时 maxTop < minTop，
 * 顶钉形态不变。
 *
 * 高度联动（CR3 blind P-F5）：返回 maxHeight = 自落点顶到 bounds.bottom−MARGIN 的
 * 可用高——「顶钉 = 最大化高度」承谛成立：正常分支 maxHeight ≥ size.height 零影响；
 * 顶钉形态真实收缩（内联 maxHeight 覆盖 CSS max-height 的视口语义——放置域才是
 * 权威界，两者错位正是原缺陷——尾部经 .scene-edit-popover-body 的 overflow-y:auto
 * 可达，不再悬挂页底不可达）。
 */
export function placePopover(
  px: number,
  py: number,
  size: PopoverSize,
  bounds: PopoverBounds
): { left: number; top: number; maxHeight: number } {
  let left = px + POPOVER_POINTER_OFFSET;
  // 右缘翻转：右展开放不下 → 翻到点击点左侧。
  if (left + size.width > bounds.right - POPOVER_EDGE_MARGIN) {
    left = px - size.width - POPOVER_POINTER_OFFSET;
  }
  const minLeft = bounds.left + POPOVER_EDGE_MARGIN;
  const maxLeft = Math.max(minLeft, bounds.right - size.width - POPOVER_EDGE_MARGIN);
  left = Math.min(Math.max(left, minLeft), maxLeft);

  const minTop = bounds.top + POPOVER_EDGE_MARGIN;
  const downEdge = py + POPOVER_POINTER_OFFSET;
  const upEdge = py - POPOVER_POINTER_OFFSET - size.height;
  let top: number;
  if (downEdge + size.height <= bounds.bottom - POPOVER_EDGE_MARGIN) {
    top = downEdge; // ① 下展
  } else if (upEdge >= minTop) {
    top = upEdge; // ② 上翻 · 底对齐点击（E1 口径）
  } else {
    // ③④ 同解合并（分支表见头注）：近顶垂帘 / 高于可视域顶钉——均落 minTop。
    top = minTop;
  }
  const maxTop = Math.max(minTop, bounds.bottom - size.height - POPOVER_EDGE_MARGIN);
  top = Math.min(Math.max(top, minTop), maxTop);
  return {
    left,
    top,
    maxHeight: Math.max(0, bounds.bottom - POPOVER_EDGE_MARGIN - top),
  };
}

/**
 * 拖动钳位（纯函数）：浮层留在结构页边界内（不可拖出页外）；垂直方向允许溢出但
 * 至少保留标题栏高度（把手不丢失）。视口内坐标（page.getBoundingClientRect 同系）。
 */
export function clampDragPosition(
  left: number,
  top: number,
  size: PopoverSize,
  bounds: PopoverBounds
): { left: number; top: number } {
  const minLeft = bounds.left + POPOVER_DRAG_MARGIN;
  const maxLeft = Math.max(minLeft, bounds.right - size.width - POPOVER_DRAG_MARGIN);
  const minTop = bounds.top + POPOVER_DRAG_MARGIN;
  const maxTop = Math.max(minTop, bounds.bottom - POPOVER_DRAG_HEADER_KEEP);
  return {
    left: Math.min(Math.max(left, minLeft), maxLeft),
    top: Math.min(Math.max(top, minTop), maxTop),
  };
}

/** 程序化打开（无点击锚）的默认展开点：钳位界的左上角（#48 起按 bounds 起算——
 * 页界左上角在应用 chrome 之下，R2 升级后 bounds.top 已抬到 chrome 地板——默认位
 * 同样不压带）；placePopover 的 +14 偏移即落入 margin 内侧。三层锚链闭合的 L3
 * 终点：L1 事件坐标 / L2 打开方 rect 均 miss 时由此兜底（不存在无效锚形态）。 */
function defaultAnchor(bounds: PopoverBounds): { x: number; y: number } {
  return { x: bounds.left, y: bounds.top };
}

/** CSS 属性选择器值的转义（CR 组 2a/3a：CSS.escape 的守卫版——nodeId 含引号/
 * 反斜杠会让裸插值 attr 选择器整层 SyntaxError；CSS.escape 不可用的环境退手工
 * 双字符转义）。 */
export function escapeSelector(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 呈现序显示文案（CR 组 5 / 组 1 建模防御，纯函数）：
 *   - 形态缺失或字段非数值 →「-」兜底（渲染路径不直解引用可缺形态——旧实现
 *     `node.presentationOrder.chapter` 对 as-cast 图直接 throw）；
 *   - chapter 是待编排哨兵（999999）→ 译成人话 label「待编排」（哨兵漏到 UI 是
 *     泄内部表示）；
 *   - 正常态 → 「章 / pos」。
 */
export function formatPresentationOrder(
  po: { chapter: number; pos: number } | undefined | null,
  pendingLabel: string
): string {
  if (!po || !Number.isFinite(po.chapter) || !Number.isFinite(po.pos)) return '-';
  if (po.chapter === PENDING_CHAPTER_SENTINEL) return pendingLabel;
  return `${po.chapter} / ${po.pos}`;
}

/**
 * 打开锚三层回退闭合（R2 / #66 (0,0) 根除，纯函数）：
 *   L1 真指针坐标（clientX/Y 非 0,0——物理指针不可能精确落在原点，0,0 即「无坐标
 *      形态」的判别位；合成事件与真实 isTrusted 事件在同一坐标口径上**无分支差异**，
 *      锚链全程只消费 clientX/Y 与 rect 几何）；
 *   L2 打开方元素 rect 中心（键盘激活 Enter/Space、fireEvent 无坐标形态——旧
 *      「(0,0)=键盘」启发式退役为该路径，浮层落在被激活元素邻域而非页角）；
 *   L3 双 miss → 返回 null（调用方落 defaultAnchor 兜底——不存在 (0,0) 落点）。
 *
 * L2 采信门槛镜像 collectStackBands：宽高全零 = 未布局矩形，不采信（jsdom 合成
 * 点击的宿主兜底语义由 L3 接管，保证矩阵可测且确定）。
 */
export function resolveClickAnchor(
  clientX: number,
  clientY: number,
  openerEl: Element | null
): { x: number; y: number } | null {
  if (clientX !== 0 || clientY !== 0) return { x: clientX, y: clientY };
  // 能力探测而非 instanceof——与 resolvePopoverBounds 同款鸭子口径（真实 DOM 恒
  // 通过；测试假体只要能给 rect 就能表达同一语义）。
  const rectFn = openerEl?.getBoundingClientRect;
  if (typeof rectFn === 'function') {
    const r = rectFn.call(openerEl);
    if (r.width > 0 && r.height > 0) {
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
}

/**
 * 「所属集」人读格式化（R12 / #73）：ep-05 字面 → 「第 N 章 · {title}」（N =
 * index+1 人读章号，与工作台列头 `chapterColumn {n: col.index+1}` 同一口径）。
 * 存储原值（episodeId）不动，仅显示层；lookup 缺失 / 畸形索引 → 防级回退原文
 * id（自由数据永不因映射缺席而消失）；有章号无标题 → 无标题专用键。
 *
 * 畸形索引守卫（CR3 edge P-5 + auditor P-F7）：非有限 / 非整数 / 负数全拒——
 * schema（int().nonnegative()）之外的 loose-cast、手改 yaml 形态在此兜住；旧实现
 * 只拒非有限值，index=-1 产「第 0 章」、index=1.5 产「第 2 章」伪标签。
 */
export function formatEpisodeMembership(
  episode: EpisodeOutline | null | undefined,
  fallbackId: string,
  translate: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (!episode) return fallbackId;
  if (
    !Number.isFinite(episode.index)
    || !Number.isInteger(episode.index)
    || episode.index < 0
  ) {
    return fallbackId;
  }
  const n = episode.index + 1;
  const title = typeof episode.title === 'string' ? episode.title.trim() : '';
  return title !== ''
    ? translate('structure.drawer.episodeValue', { n, title })
    : translate('structure.drawer.episodeValueNoTitle', { n });
}

// ── pure helpers (exported for unit testing) ──

/** One resolved act (phase) the selected scene belongs to via its lines. */
export type ResolvedAct = { phaseId: string; title: string };

/**
 * Opportunistic 幕 (act) resolution (design §1.1 / E3.3): walk the scene's lines
 * (via `lineTags`), and for each line that carries a `phase_ref` resolving to a
 * phase in `outline.phases`, collect `{phaseId, title}`. Dedupes by phaseId.
 * Pure; returns `[]` when nothing resolves → the popover hides the act section.
 */
export function resolveSceneActs(
  graph: SceneGraph,
  outline: OutlineV2 | undefined,
  nodeId: string
): ResolvedAct[] {
  if (!outline) return [];
  // CR-001: Array.isArray guards against a malformed outline whose `.phases` is
  // undefined under partial hydration (mirrors OutlineEditor `?? []`).
  const phases = Array.isArray(outline?.phases) ? outline.phases : [];
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return [];
  const lineById = new Map(graph.lines.map((l) => [l.id, l] as const));
  const phaseById = new Map(phases.map((p) => [p.id, p] as const));

  const out: ResolvedAct[] = [];
  const seen = new Set<string>();
  for (const lineTag of node.lineTags) {
    const line = lineById.get(lineTag);
    const phaseRef = line?.phase_ref;
    if (!phaseRef) continue;
    const phase = phaseById.get(phaseRef);
    if (!phase) continue; // dangling phase_ref → skip (validateSceneGraph flags)
    if (seen.has(phase.id)) continue;
    seen.add(phase.id);
    out.push({ phaseId: phase.id, title: phase.title });
  }
  return out;
}

/**
 * Opportunistic beat resolution (design §1.1 / E3.3): if the scene carries an
 * `episodeId` that resolves to an episode in `episode_outlines`, return that
 * episode. Returns null when absent/dangling → the beat section hides.
 * Pure.
 */
export function resolveSceneEpisode(
  episodeOutlines: EpisodeOutline[] | undefined,
  nodeId: string,
  graph: SceneGraph
): EpisodeOutline | null {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node?.episodeId) return null;
  // CR-001: Array.isArray guards against a malformed episode_outlines value.
  if (!Array.isArray(episodeOutlines)) return null;
  return episodeOutlines.find((e) => e.id === node.episodeId) ?? null;
}

// ── the component ──

const ROLE_KEYS: ReadonlyArray<{ value: SceneNodeRole; labelKey: string }> = [
  { value: 'normal', labelKey: 'structure.role.normal' },
  { value: 'core-anchor', labelKey: 'structure.role.coreAnchor' },
  { value: 'secondary-anchor', labelKey: 'structure.role.secondaryAnchor' },
  { value: 'fork-point', labelKey: 'structure.role.forkPoint' },
];

const EDGE_TYPES: ReadonlyArray<SceneEdge['type']> = ['CAUSAL', 'SUSPENSE'];

/**
 * 边类型显示层映射表（R12 / #73：CAUSAL 等字面中文化）。存储原值不动——value /
 * data-edge-type / 写通道仍是 schema 字面值，本表只管显示。
 */
export const EDGE_TYPE_LABEL_KEY: Readonly<Record<SceneEdge['type'], string>> = {
  CAUSAL: 'structure.drawer.edgeTypeCausal',
  SUSPENSE: 'structure.drawer.edgeTypeSuspense',
};

/** 显示层本地化（未知值防御性回退原文——自由数据不因映射表缺席而消失）。 */
export function edgeTypeLabel(
  type: SceneEdge['type'],
  translate: (key: string) => string
): string {
  const key = (EDGE_TYPE_LABEL_KEY as Record<string, string | undefined>)[type];
  return key !== undefined ? translate(key) : String(type);
}

export function SceneEditPopover() {
  const {
    sceneGraph,
    outline,
    episodeOutlines,
    selectedNodeId,
    setSelectedNodeId,
    updateField,
    sendAgentMessage,
    resolvedLocale,
    drawerTitleFocus,
    setDrawerTitleFocus,
    agentRunActive,
    validationOverlayOn,
  } = useShallowSelect();

  const { t } = useI18n(resolvedLocale);
  const { applyActions } = useSceneGraphEdit();

  const popoverRef = useRef<HTMLElement>(null);

  // ── 展开位（R3）：点击锚 + placePopover ──
  // maxHeight 随 placement 产出（CR3 blind P-F5 高度联动：顶钉形态收缩到可视域内
  // 可用高，内联值覆盖 CSS max-height 的视口语义）。拖拽/resize 重钳**不带**该值
  // （undefined → 内联移除，CSS 帽接管）——拖动语义本就允许纵向溢出、只保标题栏
  // 手柄（clampDragPosition），高度钳制只属 placement 的「最大化高度」承诺。
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const [anchorTick, setAnchorTick] = useState(0);
  /**
   * 挂起展开锚（T1 配对存活，2026-08-27 C1 遍历首开锚丢失根修）。
   * `nodeId` = 记锚时点击命中的 `[data-node-id]`（非卡片点击 = null）。锚记录
   * （document capture，`setAnchorTick` 独立调度的 tick 提交）与选中提交（React
   * 冒泡 onClick → 外部 store）在真机可分属两次 commit——卡片锚与其选中**配对
   * 存活**（!node 清扫豁免），消费侧按 node id 身份校验后才生效；非卡片锚照旧
   * 即扫即清（CR 组 3a 程序化打开不吃过路锚的语义不变）。详见定位 effect 头注。
   */
  const pendingAnchorRef = useRef<{ x: number; y: number; nodeId: string | null } | null>(null);
  const placedRef = useRef(false);
  /** 最近一次指针打开的来源区（handleLocate 的作用域——同名卡/chip 两枚的歧义解）。 */
  const sourceRegionRef = useRef<'causal' | 'workbench'>('causal');
  /** 最近一次点击的打开方元素（多区双份常态下「作者正看的那枚」）——locate 区内
   *  miss 的首兜底（异区错锚根修 #66c：全图文档序首个同名子可能正是另一区的副本，
   *  滚去那里 = 跳到作者没在看的位置）。
   *  写入/失效语义（CR3 blind P-F1 + edge P-3/P-4 三联守卫）：
   *   - 仅在点击命中 [data-node-id] 卡/chip 时写入——区外无卡点击（菜单项/列头钮等
   *     中间操作）保留上次值，不抹掉作者正看的锚；
   *   - 浮层关闭即清空（定位 effect 无选中分支）——陈旧存活 opener 不得劫持下一次
   *     程序化打开（agent patch/右键改名）的 locate 兜底链；
   *   - 消费侧（handleLocate）校验 data-node-id 身份相符才可用——「存活但属于他场」
   *     的 opener 不把定位滚去无关场景。 */
  const sourceOpenerRef = useRef<HTMLElement | null>(null);
  /** pos 的镜像（resize 重钳监听读现位——事件闭包里 state 恒旧值）。 */
  const posRef = useRef<{ left: number; top: number; maxHeight?: number } | null>(null);
  useEffect(() => {
    posRef.current = pos;
  }, [pos]);

  /**
   * 浮层输入面的 Escape 只属输入态（CR 组 3a）：标题/摘要/storyTime 编辑中按 Esc
   * 是「取消这轮输入」，不冒泡到 window 监听强拆整层浮层（自定义枚举输入同款先例）。
   */
  const swallowEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') e.stopPropagation();
  };

  // ── SP-1 建场景/右键改名 → 打开浮层并聚焦标题输入框（一次性旗标，消费即清）──
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!drawerTitleFocus || selectedNodeId === null) return;
    setDrawerTitleFocus(false);
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [drawerTitleFocus, selectedNodeId, setDrawerTitleFocus]);

  // Auto-clear selection if the node vanished mid-selection (agent patch removed
  // it, project switched partial hydration, etc. — carried over from 1.5).
  useEffect(() => {
    if (
      selectedNodeId !== null
      && sceneGraph
      && !sceneGraph.nodes.some((n) => n.id === selectedNodeId)
    ) {
      setSelectedNodeId(null);
    }
  }, [selectedNodeId, sceneGraph, setSelectedNodeId]);

  const node = useMemo(
    () => (sceneGraph && selectedNodeId !== null
      ? sceneGraph.nodes.find((n) => n.id === selectedNodeId) ?? null
      : null),
    [sceneGraph, selectedNodeId]
  );

  // ── 定位 effect：选中场景变化 / 新点击锚到达 → 测尺寸 + placePopover ──
  // 非点击换场景（右键改名等程序化路径，无锚）且浮层已开 → 保持现位（单例不移位）；
  // 浮层未开的无锚打开 → 默认位。首帧 pos=null → visibility:hidden（保布局可测
  // offsetWidth），layout effect 落位后同帧可见（无闪烁）。
  // 08-26 批 5（#48）：钳位界 = .structure-page rect（resolvePopoverBounds——
  // 页在应用顶栏之下，浮层顶部不再钻 chrome 下；jsdom 页 rect 全 0 退视口界）。
  // R2 升级（#72）：bounds.top 已抬到顶部恒驻 chrome 带底缘（zoombar/minimap 实测
  // 或 102px 兜底）——placement 与拖拽共用同一可视域，顶边永不压带。
  useLayoutEffect(() => {
    if (!node) {
      placedRef.current = false;
      // CR 组 3a stale-anchor 泄漏修复 + T1 收窄（C1 遍历发现批 2）：外点先把锚写进
      // ref 再判定「非卡外点关闭」，若不清，下一次**程序化打开**（右键改名/列头＋钮，
      // 本应落默认位）会消费这枚过路锚——**非卡片锚**（nodeId=null，空白外点）照旧
      // 清；**卡片锚**（nodeId≠null）清扫豁免——真机实测锚记录与选中提交可分属两次
      // commit（capture 写锚的 tick 提交先落、React 冒泡选中后到），全量清扫会把即将
      // 被消费的锚提前毁掉，首开恒落 L3 默认位（AC4 红四入口形态；jsdom act 合并
      // 提交把该交错埋成只爆真机的回归）。豁免后的陈旧卡片锚由下方消费侧身份校验
      // 兜底（配对失败不生效），不劫持他人开位。
      if (pendingAnchorRef.current?.nodeId == null) pendingAnchorRef.current = null;
      // CR3（blind P-F1）：关闭即清打开方记录——陈旧存活 opener（Esc/✕/外点关闭
      // 后仍挂在 DOM 的他场卡）不得劫持下一次程序化打开（agent patch/右键改名）的
      // locate 兜底链 tier②。
      sourceOpenerRef.current = null;
      setPos(null);
      return;
    }
    const pending = pendingAnchorRef.current;
    // T1 配对身份校验：卡片锚只在「选中了它点击的那枚」时生效——吞点击
    // （WorkbenchChip resize 尾随 click 被 swallow、选中不跟随）等无消费方卡片锚
    // 不劫持他人开位/不移位他场。配对失败**不弃置**（锚记录与选中分属两次 commit
    // 时，本提交先见旧选中——锚留待选中提交侧消费，「点新卡移位重载」在该交错下
    // 仍成立），由后续配对消费 / 新点击覆盖 / 非卡片态清扫收口。
    const anchor = pending !== null && (pending.nodeId === null || pending.nodeId === node.id)
      ? pending
      : null;
    if (!anchor && placedRef.current) return;
    if (anchor) pendingAnchorRef.current = null; // 读即清（仅消费时）
    const el = popoverRef.current;
    const size: PopoverSize = el
      ? { width: el.offsetWidth, height: el.offsetHeight }
      : { width: 0, height: 0 };
    const page = el?.closest('.structure-page');
    const bounds = resolvePopoverBounds(page instanceof HTMLElement ? page : null);
    const a = anchor ?? defaultAnchor(bounds);
    setPos(placePopover(a.x, a.y, size, bounds));
    placedRef.current = true;
    // anchorTick：同场景再点击（锚更新）也重落位（「点别处即移位重开」）。
  }, [node?.id, anchorTick]);

  // ── 拖动（R3）：标题栏按住拖 + 结构页内钳位 ──
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const handleHeaderMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    // 标题输入区/按钮不触发拖动（prd R3 拍板——输入是编辑面不是把手）。
    if ((e.target as HTMLElement).closest('input, button, select, textarea')) return;
    e.preventDefault(); // 防拖动途中文本选择
    if (!pos) return;
    dragRef.current = { dx: e.clientX - pos.left, dy: e.clientY - pos.top };
  };

  useEffect(() => {
    const onMove = (e: globalThis.MouseEvent) => {
      const d = dragRef.current;
      const el = popoverRef.current;
      const page = el?.closest('.structure-page');
      if (!d || !el || !(page instanceof HTMLElement)) return;
      const size: PopoverSize = { width: el.offsetWidth, height: el.offsetHeight };
      // R2 升级：拖拽界与 placement 同源（resolvePopoverBounds——含 chrome 地板），
      // 拖到顶部时标题栏不滑进 zoombar/minimap 带下（拖不丢手柄不变式全路径生效）。
      setPos(
        clampDragPosition(
          e.clientX - d.dx,
          e.clientY - d.dy,
          size,
          resolvePopoverBounds(page instanceof HTMLElement ? page : null)
        )
      );
    };
    const onUp = () => {
      dragRef.current = null;
    };
    // CR 组 3a：mouseup 落在窗外（拖到浏览器外松手）不会再派发 mouseup——document
    // 级监听收不到，dragRef 悬空后光标一动浮层跟着瞬移。逃逸出口：指针离开窗口
    // （mouseleave on documentElement）或窗口失焦即终止本次拖动。
    const resetDrag = onUp;
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.documentElement.addEventListener('mouseleave', resetDrag);
    window.addEventListener('blur', resetDrag);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.documentElement.removeEventListener('mouseleave', resetDrag);
      window.removeEventListener('blur', resetDrag);
    };
  }, []);

  // ── 窗口尺寸变化 → 现位重钳进新界（CR 组 3a）。placePopover 需要展开锚而锚在
  // 首次落位时已消费；被拖动过的面板更不该被拽回原锚——按「已放置面板」语义用
  // clampDragPosition 把现位收进新页界：效果等价于重跑定位的最小不变式（不出页界、
  // 不丢手柄、不跳位）。 ──
  useEffect(() => {
    const onResize = () => {
      const el = popoverRef.current;
      const cur = posRef.current;
      if (!el || !cur || useAppStore.getState().selectedNodeId === null) return;
      const page = el.closest('.structure-page');
      const bounds = resolvePopoverBounds(page instanceof HTMLElement ? page : null);
      setPos(
        clampDragPosition(
          cur.left,
          cur.top,
          { width: el.offsetWidth, height: el.offsetHeight },
          bounds
        )
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── 关闭面（R3）：✕（按钮既有）/ Esc（window keydown，菜单/浮层同款先例）/
  //    外点（capture click：浮层外且非卡/chip——点卡/chip 走移位重开流）。锚点记录
  //    同监听器完成（R2 三层回退闭合）：浮层外的**任何**点击都经 resolveClickAnchor
  //    解析展开锚——真指针落点击点；键盘激活/无坐标合成事件落打开方元素 rect 邻域；
  //    双 miss 不产锚（程序化语义不变），(0,0) 落点在任一路径都不可达。
  //    T1 常驻契约：本监听器随**组件**存活而非浮层面板——关闭态（组件渲染 null 但
  //    挂载不变，全部 hooks 在早退前）锚记录照常工作，「首开也走 L1 点击锚」由此
  //    成立；挂载点必须保持无条件渲染（StructurePage 注释同款契约）。
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (useAppStore.getState().selectedNodeId !== null) setSelectedNodeId(null);
    };
    const onClick = (e: globalThis.MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return; // 浮层内（含确认对话框）不关不移锚
      const targetEl = target instanceof Element ? target : null;
      // 打开方元素 + 来源区追踪对**所有**点击形态生效（键盘激活也改写来源区——
      // locate 作用域与可见焦点一致）。
      const openerCard =
        targetEl?.closest<HTMLElement>('[data-node-id]') ?? null;
      // CR3（edge P-4）：仅命中卡/chip 时刷新——区外无卡点击（菜单项/列头钮等中间
      // 操作）保留上次值，不抹掉作者正看的锚；陈旧风险由关闭清空（无选中 effect）
      // + 消费侧身份校验（handleLocate）共同兜住。
      if (openerCard) sourceOpenerRef.current = openerCard;
      if (targetEl) {
        if (targetEl.closest('[data-skeleton="workbench"]')) sourceRegionRef.current = 'workbench';
        else if (targetEl.closest('[data-skeleton="causal"]')) sourceRegionRef.current = 'causal';
      }
      // 三层回退闭合：L1 事件坐标 → L2 打开方 rect → L3 null（defaultAnchor）。
      const anchor = resolveClickAnchor(
        e.clientX,
        e.clientY,
        openerCard ?? targetEl
      );
      if (anchor) {
        // T1 配对标记：卡片点击的锚带 nodeId 存活（跨提交等它的选中提交——
        // pendingAnchorRef 头注）；非卡片锚（空白外点）不带——关闭态清扫即清，
        // 程序化打开不吃过路锚的 CR 组 3a 语义不变。
        pendingAnchorRef.current = {
          ...anchor,
          nodeId: openerCard?.getAttribute('data-node-id') ?? null,
        };
        setAnchorTick((tick) => tick + 1);
      }
      const onScene = targetEl !== null && targetEl.closest('[data-node-id]') !== null;
      if (!onScene && useAppStore.getState().selectedNodeId !== null) {
        setSelectedNodeId(null); // 外点关闭
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick, true);
    };
  }, [setSelectedNodeId]);

  // ── 自由文本（标题/摘要）：本地态 + 500ms debounce + 切场景/卸载 flush ──
  // mirror OutlineEditor（latestRef/lastWrittenRef/userEditedRef 简化版）：
  // pendingRef 记未落盘的 {nodeId, title, summary}；flush 用 getState 最新图投影
  // update_scene（空串 = 清除该字段——schema optional，空串无意义）。
  const [titleText, setTitleText] = useState('');
  const [summaryText, setSummaryText] = useState('');
  const pendingTextRef = useRef<{ nodeId: string; title: string; summary: string } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastWrittenGraphRef = useRef<SceneGraph | undefined>(undefined);

  /**
   * 立刻落盘挂起的标题/摘要。**按 pending.nodeId 对最新图写**（不依赖当前选中节点）——
   * 切场景时旧场景的挂起字在此被如实写出而非丢弃。空串 = 清除字段（schema optional，
   * 空串无意义）；无净变化不写（空转防御）。写出的 graph 引用记入 lastWrittenGraphRef
   * 供回声判别（store 回流时 adoption effect 跳过领养）。
   */
  const flushText = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = undefined;
    }
    const pending = pendingTextRef.current;
    pendingTextRef.current = null;
    if (!pending) return;
    const raw = useAppStore.getState().creativeFields.scene_graph;
    if (!isSceneGraphLike(raw)) return;
    const prev = raw.nodes.find((n) => n.id === pending.nodeId);
    if (!prev) return; // 场景已被删（编辑中途）——挂起作废
    const nextTitle = pending.title.trim() === '' ? undefined : pending.title;
    const nextSummary = pending.summary.trim() === '' ? undefined : pending.summary;
    if ((prev.title ?? '') === (nextTitle ?? '') && (prev.summary ?? '') === (nextSummary ?? '')) {
      return; // 无净变化——不写
    }
    const action: SceneGraphAction = {
      op: 'update_scene',
      scene: { id: pending.nodeId, title: nextTitle, summary: nextSummary },
    };
    const next = applySceneGraphActions(raw, [action]);
    lastWrittenGraphRef.current = next;
    updateField('scene_graph', next);
  };
  const flushTextRef = useRef(flushText);
  flushTextRef.current = flushText;

  const scheduleTextFlush = (next: { title: string; summary: string }) => {
    if (!node) return;
    pendingTextRef.current = { nodeId: node.id, title: next.title, summary: next.summary };
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => flushTextRef.current(), TEXT_DEBOUNCE_MS);
  };

  // 切场景：先 flush 旧场景的挂起文本，再领养新场景的现值 + 重置各草稿态。
  const selectedIdRef = useRef(selectedNodeId);
  useEffect(() => {
    if (selectedIdRef.current !== selectedNodeId) {
      flushTextRef.current();
      selectedIdRef.current = selectedNodeId;
    }
    if (node) {
      setTitleText(node.title ?? '');
      setSummaryText(node.summary ?? '');
    }
    pendingTextRef.current = null;
    setStoryDraft(null);
    setOutcomeCustom(null);
    setPacingCustom(null);
    setEdgeDraft({ to: '', type: 'CAUSAL' });
  }, [selectedNodeId, node?.id]);

  // 外部图变化（agent patch / undo）：自己的回声（=== lastWritten）不领养；否则重新领养
  // 文本现值（本地无挂起时）。挂起未 flush 时不覆盖作者正打的字。
  useEffect(() => {
    if (sceneGraph === lastWrittenGraphRef.current) return;
    if (pendingTextRef.current) return; // 作者有未落盘输入——保本地态
    if (node) {
      setTitleText(node.title ?? '');
      setSummaryText(node.summary ?? '');
    }
  }, [sceneGraph, node]);

  // 卸载：立刻 flush（0–500ms 窗口的字不丢）。
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    flushTextRef.current();
  }, []);

  // ── 一次性手势写（机械字段：一次手势一次 updateField，无 debounce）──
  // CR-11 no-op 写守卫：同值提交直接 return——免得无净变化的手势也产版本 bump +
  // undo 入栈 + source 翻转（'user' 盖掉元数据）。字段级 === 比较；数组类字段
  // （lineTags）由手势侧保证只产真变化（增/删成员恒不等）。
  const writeScenePatch = (patch: Record<string, unknown>) => {
    if (!node) return;
    const current = node as unknown as Record<string, unknown>;
    if (Object.keys(patch).every((k) => current[k] === patch[k])) return;
    applyActions([{ op: 'update_scene', scene: { id: node.id, ...patch } }]);
  };

  // storyTime：number input 本地草稿，blur/Enter 提交（严格整数校验 + 非负钳；
  // 无净变化不写）。
  const [storyDraft, setStoryDraft] = useState<string | null>(null);
  const commitStoryTime = () => {
    if (storyDraft === null || !node) {
      setStoryDraft(null);
      return;
    }
    setStoryDraft(null);
    const trimmed = storyDraft.trim();
    // CR 组 3a 严格数字校验：只认整数字面（可带负号）。'1e9'（parseInt 会静默截成
    // 1）、'2.7'、空串、任意非数字一律还原现值不写——非法输入绝不静默变成另一个
    // 值。负整数仍走既有 clamp 钳 0（timelineLifecycle 锁定的语义：-4 提交写出
    // t=0，负数直接落低而非拒绝）。
    if (!/^-?\d+$/.test(trimmed)) return;
    const parsed = clampStoryTime(Number(trimmed));
    if (parsed !== node.storyTime) {
      writeScenePatch({ storyTime: parsed });
    }
  };

  // 叙事枚举：select（词表）+ 自定义输入（Enter/blur 提交、Esc 回退 select）。
  const [outcomeCustom, setOutcomeCustom] = useState<string | null>(null);
  const [pacingCustom, setPacingCustom] = useState<string | null>(null);

  // 连边草稿：to = 目标场景 id（'' 未选），type 两选。
  const [edgeDraft, setEdgeDraft] = useState<{ to: string; type: SceneEdge['type'] }>({ to: '', type: 'CAUSAL' });

  // ── 校验面（CR 组 3a：门控对齐 + 单源 memo）── issues 区与工具栏「校验」开关
  // 同门控（关 → 图例徽标与本区一致地不显示，校验问题不再两处口径分叉）；
  // validateSceneGraph 在本组件内只跑一次（图引用/开关稳定即命中 memo），下面按
  // 目标过滤出本节点份额。工作台侧共享同一口径的接线归其自身 memo。
  const graphIssues = useMemo<SceneGraphIssue[]>(
    () => (sceneGraph && validationOverlayOn ? validateSceneGraph(sceneGraph) : []),
    [sceneGraph, validationOverlayOn]
  );
  const nodeIssues = useMemo<SceneGraphIssue[]>(
    () => (node
      ? graphIssues.filter((i) => i.targets.some((tg) => tg.kind === 'node' && tg.id === node.id))
      : []),
    [graphIssues, node]
  );

  // Resolved acts + episode (opportunistic — null/[] hides the section).
  const acts = useMemo(
    () => (sceneGraph && node ? resolveSceneActs(sceneGraph, outline, node.id) : []),
    [sceneGraph, outline, node]
  );
  const episode = useMemo(
    () => (sceneGraph && node ? resolveSceneEpisode(episodeOutlines, node.id, sceneGraph) : null),
    [sceneGraph, episodeOutlines, node]
  );

  // Edges touching this node (incoming: to===id; outgoing: from===id)。
  const { incoming, outgoing } = useMemo(() => {
    if (!sceneGraph || !node) return { incoming: [], outgoing: [] };
    const incoming = sceneGraph.edges.filter((e) => e.to === node.id);
    const outgoing = sceneGraph.edges.filter((e) => e.from === node.id);
    return { incoming, outgoing };
  }, [sceneGraph, node]);

  // 删除确认（SP-1：有边时文案带边数——投影器不级联，action 数组补齐，故文案如实说「断开」）。
  const [deleteOpen, setDeleteOpen] = useState(false);
  const touchingEdges = useMemo(
    () => (sceneGraph && node ? edgesTouchingNode(sceneGraph, node.id) : []),
    [sceneGraph, node]
  );

  const nodeById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of sceneGraph?.nodes ?? []) m.set(n.id, n.title ?? n.id);
    return m;
  }, [sceneGraph?.nodes]);
  const lineNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of sceneGraph?.lines ?? []) m.set(l.id, l.name);
    return m;
  }, [sceneGraph?.lines]);

  if (!sceneGraph || selectedNodeId === null || !node) return null;

  // CR-001: defensively read beat arrays (carried over from 1.5).
  const emotionalBeats = episode && Array.isArray(episode.emotional_beats) ? episode.emotional_beats : [];
  const pacingBeats = episode && Array.isArray(episode.pacing_beats) ? episode.pacing_beats : [];

  const handleClose = () => setSelectedNodeId(null);

  const handleLocate = () => {
    // D2 定位态：滚动到该场景的格（nearest——不抢页面滚动条）。jsdom 下 setup.ts 已
    // stub scrollIntoView 为 no-op（测试以 spy 断言调用）。
    // CR 组 2a/3a：①attr 选择器值经转义——nodeId 含引号/反斜杠不再把整层
    // querySelector 打成 SyntaxError；②按打开来源区作用域查询——同名 [data-node-id]
    // 因果卡/工作台 chip 各一枚，裸全局 querySelector 恒中文档序第一个（多线图里从
    // 工作台打开却滚去因果侧）。区内 miss 再走兜底链。
    // R2 异区错锚根修（#66c）兜底链：①区内作用域；②**打开方元素自身**（作者正看的
    // 那枚——已失联也优先：scrollIntoView 对游离节点是诚实 no-op，绝不反手跳去另一
    // 区的文档序副本；多线节点双份元素是常态非异常）；③仅在从无打开方记录（纯程序
    // 化路径）时才最后回全图第一枚。
    // CR3（blind P-F1 + edge P-3）：tier② 消费 opener 前校验身份（data-node-id ===
    // 当前选中节点）——「存活但属于他场」的陈旧 opener（点 A 后 agent 直写换选中 B，
    // 未经关闭/点击刷新）不得把定位滚去 A；tier② 被跳过时如实降 tier③（全图第一
    // 枚是当前节点自己的实例，绝不会滚去无关场景）。
    const escaped = escapeSelector(node.id);
    const doc = window.document;
    const scoped = doc.querySelector(
      `[data-skeleton="${sourceRegionRef.current}"] [data-node-id="${escaped}"]`
    );
    const opener = sourceOpenerRef.current;
    const openerOfNode =
      opener !== null && opener.getAttribute('data-node-id') === node.id
        ? opener
        : null;
    const cell =
      scoped ?? (openerOfNode !== null ? openerOfNode : doc.querySelector(`[data-node-id="${escaped}"]`));
    cell?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  };

  const handleAddEdge = () => {
    if (!node || !edgeDraft.to) return;
    const action = buildAddEdgeAction(sceneGraph, { from: node.id, to: edgeDraft.to, type: edgeDraft.type });
    if (!action) return; // 自环/同向重复——按钮已禁用，防御双保险
    applyActions([action]);
    setEdgeDraft({ to: '', type: 'CAUSAL' });
  };

  const handleAiSummary = () => {
    // CR-10：消息常带节点 id——title 可编辑可重复（同名场景/改名中途），id 是唯一
    // 稳定寻址键。有标题用「title (id)」形，无标题退 id 本身。
    const sceneRef = node.title ? `${node.title} (${node.id})` : node.id;
    void sendAgentMessage(t('structure.drawer.aiSummaryMessage', { scene: sceneRef }));
  };

  const edgeAddBlocked = !edgeDraft.to
    || edgeDraft.to === node.id
    || sceneGraph.edges.some((e) => e.from === node.id && e.to === edgeDraft.to);
  const addableLines = sceneGraph.lines.filter((l) => !node.lineTags.includes(l.id));
  const otherScenes = sceneGraph.nodes.filter((n) => n.id !== node.id);

  return (
    <aside
      ref={popoverRef}
      className="scene-edit-popover"
      data-popover="scene-edit"
      data-scene-id={node.id}
      aria-label={t('structure.drawer.title')}
      style={pos ?? { visibility: 'hidden' }}
    >
      {/* ── 标题栏（拖动把手——输入/按钮除外）· 标题直写 · 定位 · 关闭 ── */}
      <header
        className="scene-edit-popover-header"
        data-popover-drag
        title={t('structure.drawer.dragHint')}
        onMouseDown={handleHeaderMouseDown}
      >
        <input
          ref={titleInputRef}
          className="scene-detail-title-input"
          data-field="title"
          value={titleText}
          placeholder={node.id}
          onChange={(e) => {
            setTitleText(e.target.value);
            scheduleTextFlush({ title: e.target.value, summary: summaryText });
          }}
          onKeyDown={swallowEscape}
          aria-label={t('structure.drawer.titleField')}
        />
        <button
          type="button"
          className="scene-detail-icon-btn"
          data-action="locate"
          onClick={handleLocate}
          aria-label={t('structure.drawer.locate')}
          title={t('structure.drawer.locate')}
        >
          <span className="material-symbols-outlined" aria-hidden="true">my_location</span>
        </button>
        <button
          type="button"
          className="scene-detail-icon-btn"
          data-action="close"
          onClick={handleClose}
          aria-label={t('structure.drawer.close')}
          title={t('structure.drawer.close')}
        >
          <span className="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>

      <div className="scene-edit-popover-body">
        {/* ── 状态区（机械·直写）：role select 四项 + storyTime ── */}
        <section className="scene-detail-section scene-detail-section--mech" data-section="state">
          <h4 className="scene-detail-section-title">
            {t('structure.drawer.stateSection')}
            <span
              className="scene-detail-zone-badge"
              tabIndex={0}
              title={t('structure.drawer.mechBadgeTip')}
            >{t('structure.drawer.mechBadge')}</span>
          </h4>
          <SectionHint text={t('structure.drawer.stateSectionHint')} />
          <div className="scene-detail-field-row">
            <span className="scene-detail-field-label">{t('structure.drawer.role')}</span>
            <select
              className="scene-detail-select"
              data-field="role"
              value={node.role}
              onChange={(e) => writeScenePatch({ role: e.target.value })}
            >
              {ROLE_KEYS.map(({ value, labelKey }) => (
                <option key={value} value={value}>{t(labelKey)}</option>
              ))}
            </select>
          </div>
          <div className="scene-detail-field-row">
            <span className="scene-detail-field-label">{t('structure.drawer.storyTime')}</span>
            <input
              type="number"
              min={0}
              step={1}
              className="scene-detail-select scene-detail-number"
              data-field="storyTime"
              value={storyDraft ?? String(node.storyTime)}
              onChange={(e) => setStoryDraft(e.target.value)}
              onBlur={commitStoryTime}
              onKeyDown={(e) => {
                swallowEscape(e); // 编辑中的 Esc 只取消输入，不冒泡关浮层
                if (e.key === 'Enter') commitStoryTime();
              }}
            />
          </div>
        </section>

        {/* ── 叙事线区（机械）：lineTags chip 增删 ── */}
        <section className="scene-detail-section scene-detail-section--mech" data-section="lines">
          <h4 className="scene-detail-section-title">
            {t('structure.drawer.linesSection')}
            <span
              className="scene-detail-zone-badge"
              tabIndex={0}
              title={t('structure.drawer.mechBadgeTip')}
            >{t('structure.drawer.mechBadge')}</span>
          </h4>
          <SectionHint text={t('structure.drawer.linesSectionHint')} />
          {node.lineTags.length === 0 && addableLines.length === 0 ? (
            <p className="scene-detail-empty">{t('structure.drawer.noLines')}</p>
          ) : (
            <div className="scene-detail-chips">
              {node.lineTags.map((tag) => (
                <span key={tag} className="scene-detail-chip" data-line-tag={tag}>
                  {lineNameById.get(tag) ?? tag}
                  <button
                    type="button"
                    className="scene-detail-chip-remove"
                    data-action="remove-line-tag"
                    data-line-id={tag}
                    aria-label={t('structure.drawer.removeLineTag')}
                    onClick={() => writeScenePatch({ lineTags: node.lineTags.filter((x) => x !== tag) })}
                  >
                    ×
                  </button>
                </span>
              ))}
              {addableLines.length > 0 && (
                <select
                  className="scene-detail-select scene-detail-chip-add"
                  data-action="add-line-tag"
                  value=""
                  onChange={(e) => {
                    if (e.target.value) writeScenePatch({ lineTags: [...node.lineTags, e.target.value] });
                  }}
                  aria-label={t('structure.drawer.addLineTag')}
                >
                  <option value="">{t('structure.drawer.addLineTag')}</option>
                  {addableLines.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}
        </section>

        {/* ── 叙事枚举区（机械）：outcomeType / pacingRole（词表先验 + 自定义自由输入）── */}
        <section className="scene-detail-section scene-detail-section--mech" data-section="enums">
          <h4 className="scene-detail-section-title">
            {t('structure.drawer.enumsSection')}
            <span
              className="scene-detail-zone-badge"
              tabIndex={0}
              title={t('structure.drawer.mechBadgeTip')}
            >{t('structure.drawer.mechBadge')}</span>
          </h4>
          <SectionHint text={t('structure.drawer.enumsSectionHint')} />
          <EnumField
            fieldKey="outcomeType"
            label={t('structure.drawer.outcomeType')}
            value={node.outcomeType}
            vocab={OUTCOME_TYPE_VOCAB}
            customDraft={outcomeCustom}
            onSetCustomDraft={setOutcomeCustom}
            onCommit={(v) => writeScenePatch({ outcomeType: v })}
            customLabel={t('structure.drawer.customValue')}
            unsetLabel={t('structure.drawer.unset')}
            vocabTitle={t('structure.drawer.vocabPrior')}
          />
          <EnumField
            fieldKey="pacingRole"
            label={t('structure.drawer.pacingRole')}
            value={node.pacingRole}
            vocab={PACING_ROLE_VOCAB}
            customDraft={pacingCustom}
            onSetCustomDraft={setPacingCustom}
            onCommit={(v) => writeScenePatch({ pacingRole: v })}
            customLabel={t('structure.drawer.customValue')}
            unsetLabel={t('structure.drawer.unset')}
            vocabTitle={t('structure.drawer.vocabPrior')}
          />
        </section>

        {/* ── 关联区（机械）：边列表（每边删除）+ 连边（to 选择器 + type 两选）── */}
        <section className="scene-detail-section scene-detail-section--mech" data-section="edges">
          <h4 className="scene-detail-section-title">
            {t('structure.drawer.edgesSection')}
            <span
              className="scene-detail-zone-badge"
              tabIndex={0}
              title={t('structure.drawer.mechBadgeTip')}
            >{t('structure.drawer.mechBadge')}</span>
          </h4>
          <SectionHint text={t('structure.drawer.edgesSectionHint')} />
          {incoming.length === 0 && outgoing.length === 0 ? (
            <p className="scene-detail-empty">{t('structure.drawer.noEdges')}</p>
          ) : (
            <ul className="scene-detail-edge-list">
              {incoming.map((e) => (
                <li key={e.id} className="scene-detail-edge" data-edge-dir="in" data-edge-type={e.type}>
                  <span className="scene-detail-edge-dir">{t('structure.drawer.edgeIncoming')}</span>
                  <span className="scene-detail-edge-endpoint" data-edge-endpoint={e.from}>
                    {nodeById.get(e.from) ?? e.from}
                  </span>
                  <span className="scene-detail-edge-type" data-edge-type-label={e.type}>{edgeTypeLabel(e.type, t)}</span>
                  <button
                    type="button"
                    className="scene-detail-chip-remove"
                    data-action="remove-edge"
                    data-edge-id={e.id}
                    aria-label={t('structure.drawer.removeEdge')}
                    onClick={() => applyActions([{ op: 'remove_edge', id: e.id }])}
                  >
                    ×
                  </button>
                </li>
              ))}
              {outgoing.map((e) => (
                <li key={e.id} className="scene-detail-edge" data-edge-dir="out" data-edge-type={e.type}>
                  <span className="scene-detail-edge-dir">{t('structure.drawer.edgeOutgoing')}</span>
                  <span className="scene-detail-edge-endpoint" data-edge-endpoint={e.to}>
                    {nodeById.get(e.to) ?? e.to}
                  </span>
                  <span className="scene-detail-edge-type" data-edge-type-label={e.type}>{edgeTypeLabel(e.type, t)}</span>
                  <button
                    type="button"
                    className="scene-detail-chip-remove"
                    data-action="remove-edge"
                    data-edge-id={e.id}
                    aria-label={t('structure.drawer.removeEdge')}
                    onClick={() => applyActions([{ op: 'remove_edge', id: e.id }])}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {otherScenes.length > 0 && (
            <div className="scene-detail-field-row scene-detail-edge-add">
              <select
                className="scene-detail-select"
                data-field="edge-to"
                value={edgeDraft.to}
                onChange={(e) => setEdgeDraft((d) => ({ ...d, to: e.target.value }))}
                aria-label={t('structure.drawer.edgeTo')}
              >
                <option value="">{t('structure.drawer.edgeToPlaceholder')}</option>
                {otherScenes.map((n) => (
                  <option key={n.id} value={n.id}>{n.title ?? n.id}</option>
                ))}
              </select>
              <select
                className="scene-detail-select"
                data-field="edge-type"
                value={edgeDraft.type}
                onChange={(e) => setEdgeDraft((d) => ({ ...d, type: e.target.value as SceneEdge['type'] }))}
                aria-label={t('structure.drawer.edgeType')}
              >
                {EDGE_TYPES.map((ty) => (
                  <option key={ty} value={ty}>{edgeTypeLabel(ty, t)}</option>
                ))}
              </select>
              <button
                type="button"
                className="scene-detail-mini-btn"
                data-action="add-edge"
                disabled={edgeAddBlocked}
                onClick={handleAddEdge}
              >
                {t('structure.drawer.addEdge')}
              </button>
            </div>
          )}
        </section>

        {/* ── 语义区（作者主权·直写 + AI 建议）：summary textarea + 让 AI 补全 ── */}
        <section className="scene-detail-section scene-detail-section--semantic" data-section="semantic">
          <h4 className="scene-detail-section-title">
            {t('structure.drawer.semanticSection')}
          {/* tabIndex（CR3 edge P-6）：title-only 对键盘/触屏不可达——可聚焦后焦点
              悬停/触点长按可揭示同一 tooltip 文案（R12 新手解释不再只属鼠标用户）。 */}
            <span
              className="scene-detail-zone-badge scene-detail-zone-badge--author"
              tabIndex={0}
              title={t('structure.drawer.authorBadgeTip')}
            >{t('structure.drawer.authorBadge')}</span>
            <span
              className="scene-detail-zone-badge scene-detail-zone-badge--ai"
              tabIndex={0}
              title={t('structure.drawer.aiBadgeTip')}
            >{t('structure.drawer.aiBadge')}</span>
          </h4>
          <SectionHint text={t('structure.drawer.semanticSectionHint')} />
          <textarea
            className="scene-detail-textarea"
            data-field="summary"
            rows={3}
            value={summaryText}
            placeholder={t('structure.drawer.summaryPlaceholder')}
            onChange={(e) => {
              setSummaryText(e.target.value);
              scheduleTextFlush({ title: titleText, summary: e.target.value });
            }}
            onKeyDown={swallowEscape}
            aria-label={t('structure.drawer.summaryField')}
          />
          <button
            type="button"
            className="scene-detail-ai-btn"
            data-action="ai-summary"
            disabled={agentRunActive}
            title={agentRunActive ? t('structure.drawer.aiBusy') : undefined}
            onClick={handleAiSummary}
          >
            <span className="material-symbols-outlined" aria-hidden="true">auto_awesome</span>
            {t('structure.drawer.aiSummary')}
          </button>
        </section>

        {/* ── 保留区：校验（现状只读）── */}
        <section className="scene-detail-section" data-section="issues">
          <h4 className="scene-detail-section-title">{t('structure.drawer.issuesSection')}</h4>
          <SectionHint text={t('structure.drawer.issuesSectionHint')} />
          {nodeIssues.length === 0 ? (
            <p className="scene-detail-empty">{t('structure.drawer.noIssues')}</p>
          ) : (
            <ul className="scene-detail-issue-list">
              {nodeIssues.map((i, idx) => (
                <li
                  key={`${i.code}-${idx}`}
                  className={`scene-detail-issue scene-detail-issue--${i.severity}`}
                  data-issue-code={i.code}
                  data-issue-severity={i.severity}
                >
                  <p className="scene-detail-issue-message">{i.message}</p>
                  {i.suggestion && (
                    <p className="scene-detail-issue-suggestion">→ {i.suggestion}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── 保留区：幕（opportunistic）── */}
        {acts.length > 0 && (
          <section className="scene-detail-section" data-section="act">
            <h4 className="scene-detail-section-title">{t('structure.drawer.actSection')}</h4>
            <SectionHint text={t('structure.drawer.actSectionHint')} />
            <ul className="scene-detail-act-list">
              {acts.map((a) => (
                <li key={a.phaseId} className="scene-detail-act" data-phase-id={a.phaseId}>
                  {a.title}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── 保留区：分集节拍（opportunistic）── */}
        {episode && (
          <section className="scene-detail-section" data-section="beat">
            <h4 className="scene-detail-section-title">{t('structure.drawer.beatSection')}</h4>
            <SectionHint text={t('structure.drawer.beatSectionHint')} />
            <div className="scene-detail-beat-block">
              <p className="scene-detail-beat-kind">{t('structure.drawer.emotionalBeats')}</p>
              {emotionalBeats.length === 0 ? (
                <p className="scene-detail-empty">{t('structure.drawer.noBeats')}</p>
              ) : (
                <ul className="scene-detail-beat-list" data-beat-kind="emotional">
                  {emotionalBeats.map((b, idx) => (
                    <li key={`e-${idx}`} className="scene-detail-beat">{b}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="scene-detail-beat-block">
              <p className="scene-detail-beat-kind">{t('structure.drawer.pacingBeats')}</p>
              {pacingBeats.length === 0 ? (
                <p className="scene-detail-empty">{t('structure.drawer.noBeats')}</p>
              ) : (
                <ul className="scene-detail-beat-list" data-beat-kind="pacing">
                  {pacingBeats.map((b, idx) => (
                    <li key={`p-${idx}`} className="scene-detail-beat">{b}</li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {/* ── 保留区：坐标只读（presentationOrder 改位走工作台拖拽——不做第二
             入口；episodeId/actRef/storyTimeLabel 照旧展示）+ 删除场景 ── */}
        <section className="scene-detail-section" data-section="retention">
          <h4 className="scene-detail-section-title">{t('structure.drawer.retentionSection')}</h4>
          <SectionHint text={t('structure.drawer.retentionSectionHint')} />
          <dl className="scene-detail-meta">
            <div className="scene-detail-meta-row">
              <dt>{t('structure.drawer.presentationOrder')}</dt>
              {/* CR 组 1/5：渲染路径不直解引用可缺形态（as-cast 图下
                  presentationOrder 缺失会 throw）——「-」兜底；哨兵章译「待编排」。 */}
              <dd data-meta="presentationOrder">
                {formatPresentationOrder(node.presentationOrder, t('structure.workbench.pendingColumn'))}
                <span className="scene-detail-meta-hint">{t('structure.drawer.poDragHint')}</span>
              </dd>
            </div>
            {node.storyTimeLabel && (
              <div className="scene-detail-meta-row">
                <dt>{t('structure.drawer.storyTimeLabel')}</dt>
                <dd data-meta="storyTimeLabel">{node.storyTimeLabel}</dd>
              </div>
            )}
            {node.episodeId && (
              <div className="scene-detail-meta-row">
                <dt>{t('structure.drawer.episode')}</dt>
                {/* R12 / #73：ep-05 字面 → 「第 N 章 · {title}」人读格式；lookup
                    缺失/畸形索引防级回退原文 id（存储值不动）。 */}
                <dd data-meta="episodeId">
                  {formatEpisodeMembership(episode, node.episodeId, t)}
                </dd>
              </div>
            )}
            {node.actRef && (
              <div className="scene-detail-meta-row">
                <dt>{t('structure.drawer.actRef')}</dt>
                <dd data-meta="actRef">{node.actRef}</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="scene-detail-delete-btn"
            data-action="delete-scene"
            onClick={() => setDeleteOpen(true)}
          >
            <span className="material-symbols-outlined" aria-hidden="true">delete</span>
            {t('structure.drawer.deleteScene')}
          </button>
        </section>
      </div>

      {/* SP-1 删除确认：边数据实（投影器不级联 → action 数组补齐 remove_edge——文案说
          「断开」即最终行为，非预告校验噪音）。复用 model-settings DeleteConfirmDialog。
          渲染在浮层 DOM 内——外点关闭判定视其为浮层内点击（contains）。 */}
      <DeleteConfirmDialog
        open={deleteOpen}
        title={t('structure.drawer.deleteScene')}
        description={
          touchingEdges.length > 0
            ? t('structure.drawer.deleteDescEdges', { n: touchingEdges.length })
            : t('structure.drawer.deleteDescPlain')
        }
        confirmLabel={t('structure.drawer.deleteConfirm')}
        cancelLabel={t('structure.drawer.deleteCancel')}
        onConfirm={() => {
          setDeleteOpen(false);
          applyActions(buildRemoveSceneActions(sceneGraph, node.id));
          setSelectedNodeId(null);
        }}
        onCancel={() => setDeleteOpen(false)}
      />
    </aside>
  );
}

// ── 叙事枚举字段：词表 select + 自定义自由输入 ──

/**
 * R12 / #73 分区说明前置（一句话教育位）。样式借用既有 `.scene-detail-empty` 弱化
 * 文本（V 片收口可加 `.scene-detail-section-hint` 专属样式——类名钩子已备）。
 */
function SectionHint({ text }: { text: string }) {
  return (
    <p className="scene-detail-empty scene-detail-section-hint" data-role="section-hint">
      {text}
    </p>
  );
}

type EnumFieldProps = {
  fieldKey: string;
  label: string;
  value: string | undefined;
  vocab: ReadonlyArray<{ value: string; gloss: string }>;
  customDraft: string | null;
  onSetCustomDraft: (v: string | null) => void;
  onCommit: (v: string | undefined) => void;
  customLabel: string;
  unsetLabel: string;
  vocabTitle: string;
};

/**
 * 词表是先验非门禁（详设 SP-2 / narrative-enums.ts）：select 出词表值 + 未设置 +
 * 自定义…；值在词表外（AI 产出/手输的历史值）作附加 option 如实显示；「自定义…」切换
 * 自由输入（Enter/blur 提交非空值、Esc 回退 select）。清除 = 未设置（undefined）。
 *
 * CR-14 commit-once 守卫：Enter/Esc 同步卸载输入框（customDraft → null 切回
 * select），个别引擎对被移除的聚焦元素补派 blur → 取消后仍写值。锁位随
 * customDraft 变化重置（新一轮自定义输入重新武装），卸载后到达的 blur 被吞。
 *
 * 08-26 批 4：Esc 在此 stopPropagation——取消自定义输入不冒泡到 window 的浮层
 * Esc 关闭监听（「取消这轮输入」≠「关浮层」）。
 */
function EnumField({
  fieldKey,
  label,
  value,
  vocab,
  customDraft,
  onSetCustomDraft,
  onCommit,
  customLabel,
  unsetLabel,
  vocabTitle,
}: EnumFieldProps) {
  const inVocab = vocab.some((v) => v.value === value);
  const commitLockRef = useRef(false);
  useEffect(() => {
    if (customDraft !== null) commitLockRef.current = false;
  }, [customDraft]);
  if (customDraft !== null) {
    const commit = () => {
      if (commitLockRef.current) return;
      commitLockRef.current = true;
      const trimmed = customDraft.trim();
      onSetCustomDraft(null);
      if (trimmed !== '' && trimmed !== value) onCommit(trimmed);
    };
    const cancel = () => {
      if (commitLockRef.current) return;
      commitLockRef.current = true;
      onSetCustomDraft(null);
    };
    return (
      <div className="scene-detail-field-row">
        <span className="scene-detail-field-label">{label}</span>
        <input
          type="text"
          className="scene-detail-select"
          data-field={`${fieldKey}-custom`}
          value={customDraft}
          autoFocus
          placeholder={value ?? customLabel}
          onChange={(e) => onSetCustomDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              e.stopPropagation();
              cancel();
            }
          }}
        />
      </div>
    );
  }
  return (
    <div className="scene-detail-field-row">
      <span className="scene-detail-field-label">{label}</span>
      <select
        className="scene-detail-select"
        data-field={fieldKey}
        title={vocabTitle}
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM_SENTINEL) {
            onSetCustomDraft('');
            return;
          }
          onCommit(v === '' ? undefined : v);
        }}
      >
        <option value="">{unsetLabel}</option>
        {vocab.map((v) => (
          <option key={v.value} value={v.value} title={v.gloss}>{v.value}</option>
        ))}
        {/* CR-23 哨兵撞值：存量值恰为 '__custom__' 时不再渲染附加 option——否则与
            哨兵 option 值重复（DOM 两枚同值 option，选择态错显）。撞值时如实落在
            哨兵 option 上（该值本就是词表外自由值，自定义入口即其如实编辑路径）。 */}
        {value !== undefined && !inVocab && value !== CUSTOM_SENTINEL && (
          <option value={value}>{value}</option>
        )}
        <option value={CUSTOM_SENTINEL}>{customLabel}</option>
      </select>
    </div>
  );
}

// ── store selector (one useShallow call — stable slices, minimal re-renders) ──

/**
 * Pulls everything the popover reads in one `useShallow` pass. `outline` /
 * `episode_outlines` are loose-cast at the seam (same pattern as 1.5 / OutlineEditor).
 * agentRunActive 禁用 AI 入口（sendAgentMessage 运行中静默 no-op——防点击假死，
 * mirror OutlineEditor 的 isProjectRunActive 用法）。
 */
function useShallowSelect() {
  return useAppStore(
    useShallow((s) => ({
      // CR-001: shape-guard scene_graph so the popover's accesses can't crash on a
      // partial graph (same seam as 1.5).
      sceneGraph: isSceneGraphLike(s.creativeFields.scene_graph) ? s.creativeFields.scene_graph as SceneGraph : undefined,
      outline: s.creativeFields.outline as OutlineV2 | undefined,
      episodeOutlines: s.creativeFields.episode_outlines as EpisodeOutline[] | undefined,
      selectedNodeId: s.selectedNodeId,
      setSelectedNodeId: s.setSelectedNodeId,
      updateField: s.updateField,
      sendAgentMessage: s.sendAgentMessage,
      resolvedLocale: s.resolvedLocale,
      drawerTitleFocus: s.drawerTitleFocus,
      setDrawerTitleFocus: s.setDrawerTitleFocus,
      agentRunActive: isProjectRunActive(s),
      // CR 组 3a 门控对齐：issues 区跟随工具栏「校验」开关（与图例徽标同一口径）。
      validationOverlayOn: s.overlayToggles.validation,
    }))
  );
}
