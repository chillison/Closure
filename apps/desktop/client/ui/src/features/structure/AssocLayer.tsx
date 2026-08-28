import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import type { z } from 'zod';
import { outlineV2Schema, type SceneGraph } from '@orison/shared-contracts';
import { episodeOutlineSchema } from '@orison/shared-contracts';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import { isSceneGraphLike } from './layout';
import {
  deriveWorkbenchLayout,
  type PendingChipData,
  type WorkbenchChipData,
} from './workbenchLayout';
import { useNodeHoverKey } from './nodeSharedState';
import { lineHueIndex } from './linePalette';
import { useDomMeasure } from './useGridGeometry';
import type { PixelPoint } from './timelineGeometry';

type EpisodeOutline = z.infer<typeof episodeOutlineSchema>;

/**
 * 08-26 结构页重构 批 4（implement 4.2 / design §1.1 §3.3 §6.1 / prd R1）：关联线层
 * ——因果骨架卡 ↔ 章节工作台 chip 的短连线（旧 AssociationLayer 的重建：端点锚定
 * 的 reading 网格已随批 3 退役，本层改 **DOM 实测端点** + **规则驱动显隐**）。
 *
 * 连线回答「时序位置落到阅读结构哪里」（design §6.1 拍板）——只在查特定场景时产
 * 生，全量常驻在百万字规模回到 #39 飞线问题。**T17（08-27 用户拍板 re-baseline）
 * 起「显示」的唯一门槛 = 渲染滤集：悬停该场景任一端 ∨ 选中该场景**——每实例的弧
 * 仅当「悬停键 (nodeId, lineId) 全等 ∨ nodeId === selectedNodeId」时渲染，默认零弧
 * （拉宽操作普及后 spansChapters 异常类膨胀，「异常默认常显」沦为噪声被推翻）。
 * classifyAssoc 分类保留但只承载 paint 语义：倒叙钢蓝（--accent，与工作台 chip 倒
 * 叙圆号同轴）、selected 描边增粗的优先级、data-assoc-kind 标记——不再门控显示。
 *
 * 端点实测（design §3.3/§11）：批 7 同构锁步后两区同章轴 subgrid 锁步——同一场景的
 * 卡与 chip 落同一轨道，关联线**趋竖直**（对齐=短竖线 / 微错位斜率承载倒叙信号）；
 * → 每实例取「因果卡（该实例线 的 .scene-card）底边中点 → 工作台 chip（同线
 * .workbench-chip）顶边中点」，getBoundingClientRect 相对 `.structure-canvas` 原
 * 点换算自然坐标（**÷ zoom**——SVG 自身住 canvas 内、user unit 是自然坐标，而
 * rect 是 zoom 后屏坐标；两测相除后 zoom 天然兼容）。SVG 自身尺寸与端点**同一
 * 原点同一公式**（canvas rect ÷ zoom，BMad CR 组2a 端点原点混用的收敛——scrollWidth/
 * Height 不再进本层换算链：它是不含 padding 边界的整数量纲，与 rect 除 zoom 的用户
 * 单位不同值不同义，曾经两基准并插同一张 svg）。
 *
 * 重测触发（共享底座 useDomMeasure 单份生命期）：布局期首测 + ResizeObserver
 * （rAF 去抖，design §9.2）跟随行高/列宽变化；外加 `.structure-page` 横滚源——
 * pin-right 钉驻列头随页滚动的位移 RO 是盲的，关联线几何显式跟随（节流复用同一
 * rAF 句柄合流）。大规模降级预案归批 9。
 *
 * 测量热路径（BMad CR 组2a）：candidates memo **不含 selectedNodeId**——选中态变化
 * 只翻渲染层的 kind 分类（classifyAssoc 在渲染期吃 selection），不重建候选集、不
 * 触发全量 DOM 重测（点选/缩放即全量 getBoundingClientRect 的热路径消除）。测量
 * 回调只随布局数据（图/episodes/outline/zoom）变化。
 *
 * ── 08-27 结构页修复第三轮 追记 ──
 *   - #76 有界曲率：buildAssocPath 控制点纵距钳入两端点 y 带（lift 下限 10px 退役）
 *     ——曲线 y 值域/方向单调由构造保证，采样性质测试锁定。
 *   - #68 待编排折叠 → **T4 用户拍板推翻（08-27 深夜目检）**：指向待编排列的关联线
 *     **一律不渲染**——含代表线、折叠束、悬停揭示与 anomaly/selected 豁免成员，
 *     无例外（用户原话「会很奇怪，特别影响体验」）。渲染期滤除 pending links；
 *     折叠计划纯函数族（planPendingAggregation/PENDING_ASSOC_FOLD_THRESHOLD）按
 *     dispatch 许可保留但零渲染消费。
 *   - T4 连带退役（删不留档）：buildReorderedByNode 透传（倒叙 dangling 场景的
 *     钢蓝关联线不再产出——透传零消费者）；图例 linkFold 教育条款；
 *     `.assoc-link--folded` CSS 族与 fold DOM 投影契约（data-assoc-fold*）。
 *   - T17（发现批·用户拍板 re-baseline）：锚弧**默认零渲染**——hover∨selected 渲
 *     染滤集取代 classifyAssoc 门控与 lineHover 的 `--show` 类揭示（CSS 隐匿族
 *     〔minor opacity:0 / 揭示组合 / dim 复活守卫〕与 applyLineHover 的 assoc 揭
 *     示段一并退役，删不留档）。悬停态 = 组件内自建 per-NODE 委托（canvas 上
 *     mouseover/mouseout + mouseleave 兜底真离场），与 lineHover 的 per-LINE 通
 *     道互不干扰。
 *   - T7（发现批4·深夜二轮视觉终审）：真机残留的「汇入待编排列」弧族**不是本层
 *     关联线**（DOM 已证 .assoc-link 零汇入）——是因果边（EdgeLayer）端点落待编排
 *     哨兵列的成员，滤除落在 NarrativeTimelinePanel.resolvedEdges（任一端点
 *     pending 即零渲染，无选中豁免）。本层 pending 滤面经 T4+测试锁定已完备，
 *     未再改动。
 *   - #75 异色渐变基建：resolveAssocPaint/assocGradientId + userSpaceOnUse defs
 *     （端色=lane-hue token 的 .assoc-stop）。当前配对恒同 hue 恒实色分支；跨线
 *     两端接入即生效。钢蓝倒叙族短路保持单色。
 *   - T19（发现批9·悬停归属可读）：每条揭示弧两端加锚点圆点（r=3）——「悬停的
 *     卡与弧的对应读不出」的解；**刻意不加箭头**（对照弧是配对不是因果，方向
 *     箭头归 EdgeLayer 因果边——用户拍板裁决）。
 *   - BMad CR 三轮修补：assocGradientId 单射转义+owner 域+渲染序（防同层/跨层
 *     撞 id）；linkEquals 补布局旗标（防陈旧分类/T4 滤集吃旧事实）；
 *     planPendingAggregation 非有限阈值回落默认（防 NaN 全折）。
 *   - T25/T26（发现批10·多线实例锚定）：候选从 primaryCellByNode 单份升级为
 *     **(nodeId × lineId) 逐实例**——多线场景每线一枚候选（骨架卡侧
 *     `.scene-card[data-node-id][data-line-id]` ↔ 工作台 chip 侧同线配对），
 *     悬停哪份拷贝画哪份的弧（旧实线恒从主线份画=用户自诊「歧义错锚」）；
 *     选中态亮该场景**全部线**的弧（顺带回答「这场景活在哪些线」）。悬停身份
 *     源 = nodeSharedState mini-store 的 (nodeId, lineId) 键（WorkbenchChip/
 *     SceneCard 的 onMouseEnter 发布——本层订阅渲染滤集；组件内自建 canvas 委托
 *     随之退役，单一悬停源）。成本注记：候选量 ~N → ~N×平均线数（30→~60
 *     querySelector/次重测）——实测面本就 DOM 查表驱动，数量级可接受。
 *
 * jsdom 降级：rect 全 0 → 端点全 0（不崩）；测试走 classifyAssoc/buildChapterVolumeKey
 * 纯函数矩阵 + 类驱动显隐断言（坐标换算走 mock getBoundingClientRect 的专用用例）。
 *
 * 派生口径记档（BMad CR 组5 defer 案）：本层持第四份 `deriveWorkbenchLayout`
 * 整图派生实例（StructurePage/NTP/CW 各一份）。消费页面单源需把 layout 提到 props/
 * store 选择器穿两层组件边界，改面横跨禁改文件面（NTP/CW 属 A/B 片）；按 prd
 * Review Findings 的 [Defer] 判归批 9 与测量面收敛同期——此处不改，仅记档防再次
 * 手抄第五份。
 *
 * Paradigm guard（ADR-3）：显隐规则是对派生事实（倒叙/跨章/跨卷）的确定性分类，
 * 纯函数可单测；「哪场该倒叙」的语义决策在作者/agent，本层只反映数据。
 */

// ── 分类规则（design §6.1 拍板定稿——纯函数，规则矩阵单测锁定）──
// T17 起 kind 只承载 paint 语义与 data-assoc-kind 标记，不门控显示（渲染滤集承担）。

/** 关联线分类：anomaly 异常着色 / selected 描边增粗 / minor 基线（三族 paint）。 */
export type AssocKind = 'anomaly' | 'selected' | 'minor';

/** classifyAssoc 的入参事实集（全部可由 graph+layout+selection 确定性派生）。 */
export type AssocSceneFacts = {
  /** 倒叙：storyRank !== readIndex（workbenchLayout 派生单源；pending 占位见下）。 */
  reordered: boolean;
  /** 跨章 span：chip 的章归属 range colEnd > colStart。 */
  spansChapters: boolean;
  /** 跨卷跳跃：章归属经 episode.phase_ref→outline.phases 链解析，两章异卷。 */
  crossVolume: boolean;
  /** 当前 selectedNodeId 命中该场景。 */
  isSelected: boolean;
};

/**
 * 关联线分类纯函数（08-26 拍板）：anomaly = 倒叙 ∨ 跨章 span ∨ 跨卷跳跃（优先级
 * 最高——选中态命中异常场景时不取 selected 描边，倒叙钢蓝/基线 paint 胜出）；次
 * selected；其余 minor（基线 paint）。T17 后三族都只在 hover∨selected 渲染滤集放
 * 行的弧上落类——「何时显示」与本分类解耦。
 */
export function classifyAssoc(facts: AssocSceneFacts): AssocKind {
  if (facts.reordered || facts.spansChapters || facts.crossVolume) return 'anomaly';
  if (facts.isSelected) return 'selected';
  return 'minor';
}

/**
 * 章号 → 卷键（episode.phase_ref 经 outline.phases 解析到的 phase id）。phase_ref
 * 缺失/dangling → null（未分卷——保守不参与跨卷判定，与卷带「未分卷灰带」同口径）。
 * 纯函数；episodes/phaseIds 数组来自 store 既有 schema 值。
 */
export function buildChapterVolumeKey(
  episodes: readonly EpisodeOutline[],
  phaseIds: readonly string[]
): ReadonlyMap<number, string | null> {
  const phaseExists = new Set(phaseIds);
  const m = new Map<number, string | null>();
  for (const ep of episodes) {
    m.set(ep.index, ep.phase_ref && phaseExists.has(ep.phase_ref) ? ep.phase_ref : null);
  }
  return m;
}

/**
 * 跨卷判定（classifyAssoc 的 anomaly 第三支）：两章归属经 buildChapterVolumeKey
 * 解析后异卷 → 跨卷。任一章未分卷/未解析（null）→ 不判跨卷（保守：不可证不为真）。
 * 纯函数。
 */
export function chaptersCrossVolume(
  chapterA: number,
  chapterB: number,
  volumeByChapter: ReadonlyMap<number, string | null>
): boolean {
  const a = volumeByChapter.get(chapterA);
  const b = volumeByChapter.get(chapterB);
  return a != null && b != null && a !== b;
}

// ── 注入防御（BMad CR 组2a/3a 同族）：属性选择器值转义 ──

/**
 * querySelector 属性值的 CSS 转义。nodeId/lineId 是作者可编辑的自由字符串——含
 * 引号/反斜杠/括号的 id 直拼进 `[data-node-id="…"]` 会抛出覆盖整层的 SyntaxError
 * （一例脏 id 即灭掉全部关联线渲染）。优先 CSS.escape（Chromium/jsdom 均有），无
 * CSS 对象的环境退化为逐字符反斜杠转义。
 */
function cssAttrEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

// ── 路径几何（纯函数）──

/**
 * 因果卡底边中点 → chip 顶边中点的垂直三次贝塞尔（进场垂直 → 中段平缓 → 出场垂直
 * 的 ease 形态）。08-27 结构页修复第三轮 **有界曲率改造**（#76/design §4 第二段）：
 *
 * 控制点只沿 **y 轴** 伸出（C1 与 from 同 x、C2 与 to 同 x——端点切线恒垂直，
 * 「对齐=短竖线」语义保留），但纵距恒取端点落差的一半——两个控制点全部落在
 * 两端点的 y 带内且按序排列。三次贝塞尔值域被其控制多边形包络，因此：
 *   - 曲线 y 值域 ⊆ [min(from.y,to.y), max(from.y,to.y)]（构造保证，采样测试锁定）；
 *   - 曲线 y 方向单调（≤1 个平滑段）——旧实现的 `max(lift 下限 10px)` 在落差 <20px
 *     时把控制点推出 y 带，产生「深俯冲回环大 U 弯」，已退役（AC15）。
 *   - 落差 ≈0（两端同高）时任何弯都必然越带 → 直线段退化（本函数唯一出口）。
 * 纯函数，导出供采样性质测试与单测。
 */
export function buildAssocPath(from: PixelPoint, to: PixelPoint): string {
  const dy = to.y - from.y;
  if (Math.abs(dy) < 0.5) {
    return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  }
  const c1y = from.y + dy / 2;
  const c2y = to.y - dy / 2;
  return `M ${from.x} ${from.y} C ${from.x} ${c1y}, ${to.x} ${c2y}, ${to.x} ${to.y}`;
}

// ── 待编排关联线折叠（#68/design §4：同线线束超阈值收一条代表线）──
//
// ⚠️ T4 状态（08-27 深夜目检·用户拍板）：指向待编排列的关联线**一律不渲染**——
// 折叠的「可见性策略」消费面整体退役。本段纯函数族（阈值常量/类型/计划函数）按
// dispatch 明示许可**保留**：零生产调用、由纯函数测试矩阵锁定行为，后续若恢复
// 某种待编排可见性策略（收代表线/数量徽标等）无需重写机制层。

/**
 * 同一线指向待编排列的关联线条数超过该阈值时折叠：束内第一条保持可见作代表线，
 * 其余隐匿（T4 前的历史可见性行为；现零渲染消费，机制保留注见上）。取 3：4 条起
 * 步折（≤3 条维持现状密度不加规则成本）。
 */
export const PENDING_ASSOC_FOLD_THRESHOLD = 3;

/** 单条候选关联的折叠判定输出（代表线/被折叠成员各执一份组元数据）。 */
export type PendingFoldInfo = {
  /**
   * 该线束（同线 × 待编排方向）成员总数——含代表线与渲染期豁免成员。
   * （历史注：曾伴生 `data-assoc-fold-size` DOM 投影契约「只写真折叠成员」；
   * 该属性随 T4 零渲染一并退役，本字段现仅供纯函数消费。）
   */
  groupSize: number;
  /** 本条是束的代表线（默认可见的那条——候选序最先者，确定性可选测）。 */
  representative: boolean;
  /** 本条被折叠（默认隐匿，hover 该线揭示）。 */
  folded: boolean;
};

/**
 * 待编排方向关联线的折叠计划（纯函数）：同 `lineId` 的 pending 候选为一束，
 * 束大小 > 阈值时首条为代表线、其余 folded。分组键不含坐标——只看「落向待编排
 * 列」（虚拟列唯一）与线身份。selectedNodeId 刻意不入参：折叠是 memo 态默认
 * 计划，选中态在渲染期按 kind 豁免（T4 后组件不再调用本函数——机制保留注见上）。
 */
export function planPendingAggregation(
  candidates: readonly AssocCandidate[],
  threshold: number = PENDING_ASSOC_FOLD_THRESHOLD
): ReadonlyMap<string, PendingFoldInfo> {
  // edge V-8（08-27 三轮 CR）：非有限阈值防呆——NaN 曾穿透 Math.max(0,·) 使
  // `length <= NaN` 恒 false → 连单成员束也全体折叠；±Infinity 同族归入回退。
  // 非有限值回落默认阈值（与 PENDING_ASSOC_FOLD_THRESHOLD 拍板值同源）。
  const t = Number.isFinite(threshold) ? Math.max(0, threshold) : PENDING_ASSOC_FOLD_THRESHOLD;
  const groups = new Map<string, string[]>();
  for (const cand of candidates) {
    if (!cand.pending) continue;
    const arr = groups.get(cand.lineId);
    if (arr) arr.push(cand.nodeId);
    else groups.set(cand.lineId, [cand.nodeId]);
  }
  const plan = new Map<string, PendingFoldInfo>();
  for (const members of groups.values()) {
    if (members.length <= t) continue;
    members.forEach((nodeId, i) => {
      plan.set(nodeId, {
        groupSize: members.length,
        representative: i === 0,
        folded: i !== 0,
      });
    });
  }
  return plan;
}

// ── 异色渐变（#75/user 提案三规则：linearGradient·userSpaceOnUse·两锚点为轴）──

/**
 * 关联线着色解析：
 *   - 两端色相同 → 实色（走既有 `.assoc-link` 的 `--structure-line-color` 基线，
 *     零开销退化为纯色）；
 *   - 两端色相不同 → userSpaceOnUse 线性渐变，渐变轴 = 连线两端锚点（x1/y1/x2/y2
 *     取自实测端点），端色 = 各自线色的 `lane-hue` token（stop 元素挂
 *     `.lane-hue--c{n} .assoc-stop` 复用单一挂法）。
 * 异常强调线（钢蓝倒叙族）由调用方**跳过本解析**保持单色——信号完整性优先于过渡
 * 观感（dispatch 明文）；visibility/minor 族透明度语义独立于 stroke 不受影响。
 *
 * 当前 primary 配对两端恒同线（同 hue）→ 本层渐变天然退化为实色分支；跨线两端
 * （如因果边红卡↔绿卡）接入时同一套 resolveAssocPaint 直接生效。纯函数，导出供
 * 测试与 EdgeLayer 移植复用（red-green 整条源色突兀即 #75 主诉现场）。
 */
export type AssocPaint =
  | { mode: 'solid' }
  | { mode: 'gradient'; fromHue: number; toHue: number; gradientId: string };

/**
 * SVG defs id 构造。08-27 三轮 CR（blind V-F5 + edge V-7）三层防撞：
 *   1. **owner 域前缀**（node/edge）：AssocLayer 与 EdgeLayer 两张 svg 同文档共存，
 *      前缀域互斥——nodeId="edge-e1" 不再与 EdgeLayer 的 edgeId="e1" 种子撞车
 *      （跨层 url(#…) 文档全局解析取首个 def 的错色根修）。
 *   2. **单射转义**：白名单 [A-Za-z0-9-] 保留，`_` 与一切白名单外字符 →
 *      `_xxxx`（charCode 4 位十六进制补零）。`_` 自身入转义域（0x5f → `_005f`）
 *      ——旧 `_xxhex_` 编码里 "a.b"（→`_2e_`）与字面 "a_2e_b" 同码的非单射碰撞
 *      消除；输出可前缀解码（`_` 恒起 4 位 hex 组）故单射。
 *   3. **渲染序号后缀**：脏数据同 id 重复项也各得其所（path 与 def 消费同一数组
 *      同一下标，引用两处恒一致）。
 * 确定性：同输入同串（React key/url 引用两处自洽）。id 只做引用键，无须可逆。
 * 纯函数。
 */
export function assocGradientId(owner: 'node' | 'edge', id: string, seq: number): string {
  const safe = id.replace(
    /_|[^A-Za-z0-9-]/g,
    (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `assoc-grad-${owner}-${safe}-${seq}`;
}

export function resolveAssocPaint(
  fromHue: number,
  toHue: number,
  owner: 'node' | 'edge',
  id: string,
  seq: number
): AssocPaint {
  if (fromHue === toHue) return { mode: 'solid' };
  return { mode: 'gradient', fromHue, toHue, gradientId: assocGradientId(owner, id, seq) };
}

// ── 组件 ──

/** 候选关联（数据侧已解析；坐标待 DOM 实测）。 */
type AssocCandidate = {
  nodeId: string;
  /**
   * 锚定线（T25：逐实例键的线半边——该候选自己的线，两端同线配对〔骨架卡侧
   * `.scene-card[data-line-id]` ↔ 工作台 chip 侧同线〕，跨视图对读）。
   */
  lineId: string;
  /** 渲染期分类输入（⚠️ 刻意不含 isSelected——选中态在渲染层即时并入，见头注）。 */
  reordered: boolean;
  spansChapters: boolean;
  crossVolume: boolean;
  /**
   * 工作台侧落点是否待编排列（#68 折叠分组键的另一半——同线 × 待编排方向才成束）。
   * memo 面形状的最小扩展：复用既有 `entry.pending === true` 判别位透传，零第二来源。
   */
  pending: boolean;
};

/** 已实测坐标的关联线（kind 不落测量态——渲染期随 selectedNodeId 即时分类）。 */
type AssocLink = AssocCandidate & {
  from: PixelPoint;
  to: PixelPoint;
};

// 无 props：本层自定位宿主——svg 挂 `.structure-canvas` 子位，经 closest 自取
// 坐标原点/ResizeObserver 观察对象。**不用 ref prop**：子组件 layout effect 先于
// 父元素 ref 附着跑（React commit 序——children complete first），拿 prop ref 首测
// 必得 null；closest 走 DOM 树（mutation 相已挂好），时序正确。

/**
 * 挂 StructurePage 的 canvas 内（双视图共同父 → zoom 同比，AC5）。纯读层：
 * pointer-events:none、aria-hidden（视觉注释，非交互面）。必须是
 * `.structure-canvas` 的后代（closest 自定位坐标原点）。
 */
export function AssocLayer() {
  const { sceneGraph, episodes, rawOutline, selectedNodeId, canvasZoom } = useAppStore(
    useShallow((s) => ({
      sceneGraph: isSceneGraphLike(s.creativeFields.scene_graph)
        ? (s.creativeFields.scene_graph as SceneGraph)
        : undefined,
      episodes: s.creativeFields.episode_outlines as EpisodeOutline[] | undefined,
      // outline → phases id 序（卷键解析；unknown 原样取引用，memo 内 safeParse——同 NTP/CW）。
      rawOutline: s.creativeFields.outline,
      selectedNodeId: s.selectedNodeId,
      canvasZoom: s.canvasZoom,
    }))
  );

  // ── 数据侧候选：**逐实例**（nodeId × lineId，T25）+ 异常事实提取（纯 memo；
  // ── selectedNodeId 刻意不进依赖——选中态是高频瞬态，进 memo 即每次点选全量
  // ── 重建候选 + 全量重测）──
  const candidates = useMemo<AssocCandidate[]>(() => {
    if (!sceneGraph) return [];
    // 批 7 单源派生：工作台 chip 桶（slots + pendingByLine）与因果卡同一份
    // layout——换轴后两区同列键，关联线趋竖直。（第四份派生实例——defer 记档
    // 见文件头注。）T25：候选不再经 primaryCellByNode 单份锚定——每 chip 即一枚
    // 候选（同场景多线 = 多候选，各线各自配对各自实测）。
    const workbench = deriveWorkbenchLayout(sceneGraph, episodes);
    // 卷键：episode.phase_ref → outline.phases（safeParse 静默降级，同卷带）。
    const parsed = outlineV2Schema.safeParse(rawOutline);
    const phaseIds = (parsed.success ? parsed.data.phases : []).map((p) => p.id);
    const volumeByChapter = buildChapterVolumeKey(Array.isArray(episodes) ? episodes : [], phaseIds);

    const fromChip = (entry: WorkbenchChipData | PendingChipData): AssocCandidate => {
      const pending = entry.pending === true;
      const spansChapters = !pending && entry.colEnd > entry.colStart;
      const crossVolume = !pending
        ? chaptersCrossVolume(entry.colStart, entry.colEnd, volumeByChapter)
        : false;
      return {
        nodeId: entry.nodeId,
        lineId: entry.lineId,
        // 已编排 chip 用派生旗；pending 占位恒 false（T4 不渲染，旗值无下游消费）。
        reordered: entry.pending === true ? false : entry.reordered,
        spansChapters,
        crossVolume,
        pending,
      };
    };
    return [
      ...[...workbench.slots.values()].flat().map(fromChip),
      ...[...workbench.pendingByLine.values()].flat().map(fromChip),
    ];
  }, [sceneGraph, episodes, rawOutline]);

  // ── DOM 实测端点（首测经共享底座 useDomMeasure；jsdom 全 0 不崩）──
  const svgRef = useRef<SVGSVGElement>(null);
  const [links, setLinks] = useState<AssocLink[]>([]);
  const [size, setSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });

  // ── T17 场景级悬停态（渲染滤集的 hover 半边）──
  // T25 起身份源 = nodeSharedState 的 (nodeId, lineId) 键——WorkbenchChip/SceneCard
  // 的 onMouseEnter/onMouseLeave 发布（本层全键订阅）。旧的组件内 canvas 委托
  // （mouseover/mouseout + mouseleave 兜底）随单一悬停源化退役删除：卡/chip 是
  // 全部交互性 [data-node-id] 载体（SVG 面 pointer-events:none），逐元素发布与
  // 委托覆盖面等价，且天然携带 lineId（逐实例锚定所需）。
  const hover = useNodeHoverKey();

  /** 宿主 canvas（坐标原点 + RO 观察对象）——svg 经 closest 自定位（见组件头注）。 */
  const hostCanvas = useCallback((): HTMLElement | null => {
    const el = svgRef.current?.closest('.structure-canvas');
    return el instanceof HTMLElement ? el : null;
  }, []);

  /** 页横滚重测源：pin-right 钉驻成员随页滚动的位移 RO 盲区补偿（头注「重测触发」）。 */
  const resolveScrollRoot = useCallback((): HTMLElement | null => {
    const el = hostCanvas()?.closest('.structure-page');
    return el instanceof HTMLElement ? el : null;
  }, [hostCanvas]);

  const measure = useCallback(() => {
    const canvas = hostCanvas();
    if (!canvas) return;
    const canvasRect = canvas.getBoundingClientRect();
    const zoomF = canvasZoom > 0 && Number.isFinite(canvasZoom) ? canvasZoom : 1;
    // 屏坐标 → canvas 自然坐标（SVG user unit；zoom 后 rect 相除天然兼容 design §3.4）。
    // 尺寸与端点同一 rect ÷ zoom 公式（同原点同量纲——文件头注「重测触发」上一节的
    // 口径注）。
    const toNaturalX = (left: number, width: number) => (left + width / 2 - canvasRect.left) / zoomF;

    const next: AssocLink[] = [];
    // T25 成本注记：候选自「每场景一份（primary 线）」涨为「每 (场景×线) 一份」——
    // 候选量 ~N → ~N×平均线数（用户工程实测预期 ~30 → ~60 querySelector/次重测）。
    // 重测本就 DOM 查表驱动（RO/横滚/zoom 触发，非指针频率），数量级增长可接受。
    for (const cand of candidates) {
      const escapedNodeId = cssAttrEscape(cand.nodeId);
      const escapedLineId = cssAttrEscape(cand.lineId);
      const cardEl = canvas.querySelector(
        `.scene-card[data-node-id="${escapedNodeId}"][data-line-id="${escapedLineId}"]`
      );
      const chipEl = canvas.querySelector(
        `.workbench-chip[data-node-id="${escapedNodeId}"][data-line-id="${escapedLineId}"]`
      );
      if (!cardEl || !chipEl) continue; // 任一端不在 DOM——跳过（多线节点各线独立配对）
      const a = cardEl.getBoundingClientRect();
      const b = chipEl.getBoundingClientRect();
      next.push({
        ...cand,
        from: { x: toNaturalX(a.left, a.width), y: (a.bottom - canvasRect.top) / zoomF + 2 },
        to: { x: toNaturalX(b.left, b.width), y: (b.top - canvasRect.top) / zoomF - 2 },
      });
    }
    setLinks((prev) =>
      prev.length === next.length && prev.every((l, i) => linkEquals(l, next[i]!)) ? prev : next
    );
    const width = canvasRect.width / zoomF;
    const height = canvasRect.height / zoomF;
    setSize((prev) =>
      prev.width === width && prev.height === height ? prev : { width, height }
    );
    // candidates 是 useCallback dep——measure 随其重建，闭包里的 candidates 恒新鲜。
    // ⚠️ selectedNodeId 刻意不在 dep：选中态只影响渲染层 kind 分类，不重建测量回调
    // （点选/缩放即全量 DOM 重测的热路径，BMad CR 组2a 测量解耦条款）。
  }, [candidates, canvasZoom, hostCanvas]);

  useDomMeasure(measure, hostCanvas, resolveScrollRoot);

  if (candidates.length === 0) return null;

  // T17（08-27 用户拍板 re-baseline）：跨视图锚弧**默认零渲染**——每场景的弧仅当
  // 「悬停该场景任一端（.scene-card/.workbench-chip）∨ 选中」时进渲染面。T4 的
  // pending 滤除外层优先不变：待编排场景 hover/选中也不画（「无论如何不显示」）。
  // T25：悬停半边升级为 (nodeId, lineId) 对——悬停哪份拷贝画哪份的弧；选中半边
  // 仍按 nodeId 放行该场景**全部线**的弧（「这场景活在哪些线」）。
  // 数据面（candidates/links/linkEquals）仍完整携带全部事实：hover/选中翻转只走
  // 本滤集，零测量零候选重建（与选中态解耦同款纪律）。
  // defs 与 path 消费同一滤后数组同一序号——gradientId 引用与 def 恒一致。
  const renderedLinks = links.filter(
    (l) =>
      !l.pending
      && ((hover != null && l.nodeId === hover.nodeId && l.lineId === hover.lineId)
        || (selectedNodeId != null && l.nodeId === selectedNodeId))
  );

  return (
    <svg
      ref={svgRef}
      className="assoc-layer"
      data-assoc-layer
      width={size.width}
      height={size.height}
      aria-hidden="true"
    >
      {/* #75 异色渐变 defs：两端异色的关联线各一枚 userSpaceOnUse 渐变（轴=两端
          锚点，随重测端点同帧刷新——渲染期属性直读）。当前 primary 配对两端恒同
          hue → flatMap 恒空（零 def 开销）；跨线接入时本段即生效。倒叙钢蓝族在
          下方短路不进本枚举（信号完整性优先）。id = owner 域前缀 + 单射转义 +
          渲染序（AssocLayer.tsx assocGradientId 头注——三层防撞）。 */}
      <defs>
        {renderedLinks.flatMap((link, i) => {
          if (link.reordered) return [];
          const hue = lineHueIndex(link.lineId);
          const paint = resolveAssocPaint(hue, hue, 'node', link.nodeId, i);
          if (paint.mode !== 'gradient') return [];
          return [
            <linearGradient
              key={paint.gradientId}
              id={paint.gradientId}
              gradientUnits="userSpaceOnUse"
              x1={link.from.x}
              y1={link.from.y}
              x2={link.to.x}
              y2={link.to.y}
            >
              <stop offset="0" className={`lane-hue--c${paint.fromHue} assoc-stop`} />
              <stop offset="1" className={`lane-hue--c${paint.toHue} assoc-stop`} />
            </linearGradient>,
          ];
        })}
      </defs>
      {renderedLinks.map((link, i) => {
        // 渲染期分类（T17 后纯 paint 语义）：isSelected 即时并入——选中态变化零测
        // 量、只翻类/attr。anomaly 胜出 = 选中+异常场景不取 selected 描边（倒叙钢
        // 蓝/异常基线优先）。显示由上方渲染滤集承担，kind 不再门控显隐；pending
        // links 已被 T4 滤集排除在渲染面外——见 renderedLinks 注。
        const kind = classifyAssoc({
          reordered: link.reordered,
          spansChapters: link.spansChapters,
          crossVolume: link.crossVolume,
          isSelected: selectedNodeId === link.nodeId,
        });
        // #75 着色解析：钢蓝倒叙族短路保持单色；其余按两端 hue 解析实色/渐变
        // （当前配对恒同 hue → 恒实色分支，gradientStyle undefined）。序号 i 与
        // defs 段同一数组同一下标——url 引用与 def 恒一致。
        const hue = lineHueIndex(link.lineId);
        const paint: AssocPaint = link.reordered
          ? { mode: 'solid' }
          : resolveAssocPaint(hue, hue, 'node', link.nodeId, i);
        return (
          <Fragment key={`${link.nodeId}|${link.lineId}`}>
            <path
              className={[
                'assoc-link',
                `assoc-link--${kind}`,
                `lane-hue--c${lineHueIndex(link.lineId)}`,
                link.reordered ? 'assoc-link--reorder' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={paint.mode === 'gradient' ? { stroke: `url(#${paint.gradientId})` } : undefined}
              d={buildAssocPath(link.from, link.to)}
              data-node-id={link.nodeId}
              data-line-id={link.lineId}
              data-assoc-kind={kind}
              data-reordered={link.reordered ? 'true' : 'false'}
            />
            {/* T19（发现批9·悬停归属可读）：两端锚点圆点（r=3）——配对归属可读化
                （悬停的卡 ↔ 弧端一一对应）；**刻意无箭头**——对照弧是配对不是因果，
                加箭头会误导方向（用户拍板裁决：「谁导致谁」的箭头归 EdgeLayer 因果
                边）。圆点自带 lane-hue 类（fill 的 --structure-line-color 是自定义
                属性，兄弟 path 上的类不遗传）；坐标与弧端逐值同源。 */}
            <circle
              className={`assoc-endpoint lane-hue--c${lineHueIndex(link.lineId)}${link.reordered ? ' assoc-endpoint--reorder' : ''}`}
              cx={link.from.x}
              cy={link.from.y}
              r={3}
              data-node-id={link.nodeId}
              data-assoc-end="from"
            />
            <circle
              className={`assoc-endpoint lane-hue--c${lineHueIndex(link.lineId)}${link.reordered ? ' assoc-endpoint--reorder' : ''}`}
              cx={link.to.x}
              cy={link.to.y}
              r={3}
              data-node-id={link.nodeId}
              data-assoc-end="to"
            />
          </Fragment>
        );
      })}
    </svg>
  );
}

/** 渲染态浅等（免每帧 setState 重渲染）。blind V-F6（08-27 三轮 CR）：布局旗标
 * （spansChapters/crossVolume/pending）必须入比——坐标全等但旗标翻转的编辑（如
 * 仅改 outline 卷归属使静止配对跨卷成立）曾保 prev 陈旧 links，分类面吃旧事实
 * 直到任一坐标变化才自愈。T4 后 pending 更是**渲染滤集的键**：挂章/撤章的坐标
 * 在 jsdom 零 rect 下不动，全靠本旗比较驱动 links 换新。 */
function linkEquals(a: AssocLink, b: AssocLink): boolean {
  return a.nodeId === b.nodeId
    && a.lineId === b.lineId
    && a.reordered === b.reordered
    && a.spansChapters === b.spansChapters
    && a.crossVolume === b.crossVolume
    && a.pending === b.pending
    && a.from.x === b.from.x
    && a.from.y === b.from.y
    && a.to.x === b.to.x
    && a.to.y === b.to.y;
}
