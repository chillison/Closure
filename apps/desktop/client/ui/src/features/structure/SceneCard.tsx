import { useEffect } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import type { EmotionPoint, SceneGraphIssue, SceneLine, SceneNodeRole } from '@orison/shared-contracts';
import type { CausalCardData } from './workbenchLayout';
import {
  clearNodeHover,
  setNodeHover,
  useNodeHoverLit,
} from './nodeSharedState';
import { lineHueIndex } from './linePalette';
import { deriveEmotionTint } from './EmotionOverlay';
import { ValidationBadges } from './ValidationOverlay';

/**
 * 08-26 结构页重构 批 2（implement 2.1 / design §3.2 §4 §5 / prd R2）：SceneCard
 * ——SceneCell 的卡化重做。格从 30px 定宽方块变成**填充列宽的自适应卡**（min-height
 * 50、标题 3 行 clamp 后省略 + `title` 悬停快显——#31「静置不可读」的解）。
 *
 * 状态视觉语法矩阵（design §5「一轴一维」——每个维度一个载体，不再三重绿框相撞 #33）：
 *   - 线身份 → **色相**：`lane-hue--c{n}`（n = lineHueIndex(线 id)，12 hue 稳定绑定）
 *     挂本元素 → 局部变量 --structure-line-color，左缘色条 + 淡底 + glyph 同源消费。
 *   - 角色 → **形状**（★◆●◇ glyph）+ 色随线不随角色（角色去色相——语义色只留语义）。
 *   - 位移 → **边框样式**（线级 displacement，dashed/dotted——既有类迁移）。
 *   - 可见性 → **透明度**（hidden-until 淡出——既有类迁移）。
 *   - 选中 → **外环 outline**（线色加深 12%、2px、offset 2px——公式在 CSS，非边框色）。
 *   - AI 新增 → **左上 ✦ 角标 + 脉冲**（形状载体，D2 类迁移；非边框色）。
 *   - 校验 → **右上角标**（ValidationBadges 既有通道，外移出格 + surface 描环防相邻碰撞）。
 *   - 悬停 → **底色加深**（只属悬停语义，永不占选中——mockup 四轮拍板）。
 *
 * 情绪底条（批 2 迁入卡内）：emotion_curve 有该场景点时卡底 3px 色条
 * （deriveEmotionTint 三档 + arousal 不透明度）——原 EmotionOverlay 绝对定位层退役
 * （30px 格常量坐标对不上自适应卡，mockup `.cell .emo` 本就画在卡内）。
 *
 * 其余交互契约与 SceneCell 完全一致（E3 拖拽/点击选中/右键菜单；HTML5 DnD 保证
 * 无位移点击不触发 dragstart）。Paradigm guard：组件只反映数据——选锚点/定位移是
 * agent + 作者的事（sceneGraphAction ops 写通道不变）。
 *
 * Cell identity for React keys is the combination `(nodeId, lineId, subIndex)`
 * — a multi-line node legitimately produces several cards with the same
 * `nodeId` (one per valid lineTag). The panel composes the key; the card just
 * exposes `data-*` attributes for tests/DOM.
 */
type SceneCardProps = {
  cell: CausalCardData;
  /** resolved from the cell's line (SceneLine.displacement) */
  displacement: SceneLine['displacement'];
  /** resolved from the cell's line (SceneLine.visibility) */
  visibility: SceneLine['visibility'];
  /** overlayToggles.displacement — border treatment only rendered when true */
  showDisplacement: boolean;
  /** overlayToggles.visibility — dim only applied when true */
  showVisibility: boolean;
  /**
   * Issues from `validateSceneGraph` whose targets include this node (via
   * `indexIssuesByTarget`). Undefined when the validation overlay is toggled
   * off (NarrativeTimelinePanel passes nothing) or when the node is clean.
   */
  nodeIssues?: SceneGraphIssue[];
  /**
   * emotion_curve 中指向该场景的点（NTP memo 造 Map 后逐卡传入）。undefined =
   * 叠层关 / 无该场景数据 → 无底条。卡内渲染（见文件头注释）。
   */
  emotionPoint?: EmotionPoint;
  /**
   * Phase E3-drag: when provided, the card is `draggable` and fires this on
   * dragstart. NarrativeTimelinePanel binds it via `useTimelineEdit()`.
   */
  onSceneDragStart?: (e: DragEvent) => void;
  /**
   * Phase E3-interact: when provided, the card is clickable and fires this on
   * click. NarrativeTimelinePanel binds it to `setSelectedNodeId` (opens the
   * detail popover). Omit in isolated card tests to render a non-clickable card.
   */
  onSceneClick?: (nodeId: string) => void;
  /**
   * The currently-selected node (structureSlice.selectedNodeId). When it
   * matches this card's node, the card gets a `scene-card--selected` outline
   * so the author sees which scene is open — across all the node's cards if
   * it's multi-line. 08-26 批 4 将跨视图同步（工作台 chip 同公式外环）。
   */
  selectedNodeId?: string | null;
  /**
   * dogfood R2 批次 A：右键菜单入口。提供时卡响应 contextmenu（NTP 绑定——
   * 菜单数据/动作都在面板层，卡只上报 nodeId + 原始事件坐标）。
   */
  onSceneContextMenu?: (nodeId: string, e: MouseEvent) => void;
  /**
   * dogfood R2 批次 D2：agent 落盘新增节点高亮（structureSlice.highlightNodeIds
   * 命中）。纯视觉态——数据不变；载体是左上 ✦ 角标 + 脉冲（批 2 从绿框边框迁移）。
   */
  highlighted?: boolean;
  /**
   * 08-26 批 7（design §11 定案 1）：待编排镜像态——因果待编排列里的 dangling 场景
   * 卡（灰底，与工作台 chip/slot 灰同源语义）。非 episode 写入信号，纯渲染镜像。
   */
  pending?: boolean;
};

export const ROLE_GLYPH: Record<SceneNodeRole, string> = {
  normal: '●',
  'core-anchor': '★',
  'secondary-anchor': '◇',
  'fork-point': '◆',
};

/**
 * Build the className for the card from hue + role + displacement + visibility
 * state. Pure (string composition) — kept inline rather than precomputed so the
 * class list visibly tracks every active dimension in one place.
 *
 * Role classes carry NO colour of their own anymore (design §5：角色去色相——形状轴）；
 * they stay on the element for tests/targeting. Hue rides the `lane-hue--c{n}`
 * family which sets --structure-line-color for every downstream consumer.
 */
function buildCardClassName(
  lineId: string,
  role: SceneNodeRole,
  displacement: SceneLine['displacement'],
  visibility: SceneLine['visibility'],
  showDisplacement: boolean,
  showVisibility: boolean
): string {
  const cls = ['scene-card', `scene-card--${role}`, `lane-hue--c${lineHueIndex(lineId)}`];
  if (showDisplacement && displacement !== 'none') {
    cls.push(`scene-card--disp-${displacement}`);
  }
  if (showVisibility && visibility.status === 'hidden-until') {
    cls.push('scene-card--hidden');
  }
  return cls.join(' ');
}

export function SceneCard({
  cell,
  displacement,
  visibility,
  showDisplacement,
  showVisibility,
  nodeIssues,
  emotionPoint,
  onSceneDragStart,
  onSceneClick,
  selectedNodeId,
  onSceneContextMenu,
  highlighted,
  pending,
}: SceneCardProps) {
  const selected = selectedNodeId != null && selectedNodeId === cell.nodeId;
  // T26 ②：多线拷贝静态标记——数据随 cell（CausalCardData.multiline，与 WorkbenchChip
  // 的 chip.multiline 同单源）；卡侧形态 = 左线色条旁 1px 回声条（卡无圆号徽记，
  // 与 chip 圆号双环同语义的最小对齐）。
  const multiline = cell.multiline === true;
  // T26 ②：同 nodeId 兄弟柔光（nodeId 级订阅——悬停任一实例〔含工作台 chip 侧〕
  // 全实例点亮；悬停者自身由 CSS :not(:hover) 退让）。
  const siblingLit = useNodeHoverLit(cell.nodeId);
  // T26：悬停中卸载——共享悬停键随葬（按本实例身份条件清，不误杀兄弟的新悬停）。
  useEffect(
    () => () => clearNodeHover({ nodeId: cell.nodeId, lineId: cell.lineId }),
    [cell.nodeId, cell.lineId]
  );
  const className = buildCardClassName(
    cell.lineId,
    cell.role,
    displacement,
    visibility,
    showDisplacement,
    showVisibility
  );
  const emotionTint = emotionPoint ? deriveEmotionTint(emotionPoint) : undefined;

  return (
    <div
      className={[
        className,
        onSceneClick ? 'scene-card--clickable' : '',
        selected ? 'scene-card--selected' : '',
        highlighted ? 'scene-card--highlight' : '',
        pending ? 'scene-card--pending' : '',
        multiline ? 'scene-card--multiline' : '',
        siblingLit ? 'scene-card--sibling-lit' : '',
      ].filter(Boolean).join(' ')}
      data-node-id={cell.nodeId}
      data-line-id={cell.lineId}
      data-role={cell.role}
      data-selected={selected ? 'true' : 'false'}
      data-highlighted={highlighted ? 'true' : 'false'}
      /* T26 ②：多线拷贝静态标记（状态位恒串纪律——单线 false 非缺省）。 */
      data-multiline={multiline ? 'true' : 'false'}
      /* CR 组 3a：状态位统一恒串 true/false（pending 曾条件缺省——测试/上游查询
         不必再判「无属性 vs false」两种形态）。 */
      data-pending={pending ? 'true' : 'false'}
      draggable={!!onSceneDragStart}
      onDragStart={onSceneDragStart}
      onClick={onSceneClick ? () => onSceneClick(cell.nodeId) : undefined}
      onContextMenu={onSceneContextMenu ? (e) => onSceneContextMenu(cell.nodeId, e) : undefined}
      /* T25/T26：悬停键 (nodeId, lineId) 对发布（弧逐实例锚定的身份源 + 兄弟柔光
         触发源——与 WorkbenchChip 同一 store 同一挂法）。 */
      onMouseEnter={() => setNodeHover({ nodeId: cell.nodeId, lineId: cell.lineId })}
      onMouseLeave={() => clearNodeHover({ nodeId: cell.nodeId, lineId: cell.lineId })}
      title={cell.title ? `${cell.title} · ${cell.nodeId} · ${cell.role}` : `${cell.nodeId} · ${cell.role}`}
    >
      {/* D2 新增角标（形状载体）：左上 ✦ + 脉冲；reduced-motion 下静态常显。 */}
      {highlighted && (
        <span className="scene-card-new" aria-hidden="true">
          ✦
        </span>
      )}
      <span className="scene-card-glyph" aria-hidden="true">
        {ROLE_GLYPH[cell.role]}
      </span>
      {/* 有人类标题显标题，缺省回退 id（未命名场景）。tooltip 恒含 nodeId（id 是
          机器名/复制源，标题在卡、id 在尖角提示——长标题 3 行 clamp 后悬停快显）。 */}
      <span className="scene-card-title">{cell.title ?? cell.nodeId}</span>
      {/* 情绪底条（卡内，批 2 迁移）：3px 色条 + 原始情绪词 tooltip。无点不渲染。 */}
      {emotionTint && (
        <span
          className={`emotion-bar emotion-bar--${emotionTint.tier}`}
          style={{ opacity: emotionTint.opacity }}
          data-emo-node={cell.nodeId}
          title={emotionTint.title}
        />
      )}
      <ValidationBadges issues={nodeIssues} />
    </div>
  );
}
