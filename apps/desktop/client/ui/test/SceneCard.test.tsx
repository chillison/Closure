/**
 * 08-26 结构页重构 批 2（implement 2.1）：SceneCard 状态类矩阵 + 卡化语义。
 *
 * 直接组件渲染（不挂 NTP）锁定六维状态语法矩阵（design §5「一轴一维」）：
 *   线身份=lane-hue 类 / 角色=形状 glyph（类在 DOM、无色彩面）/ 位移=边框类 /
 *   可见性=hidden 类 / 选中=--selected 外环类 / AI 新增=--highlight + ✦ 角标 /
 *   校验=ValidationBadges 角标 / 情绪=卡内 .emotion-bar 底条。
 * 交互（拖拽/点击/右键）与 NTP 集成面在 NarrativeTimelinePanel.test——不重复。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run SceneCard`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EmotionPoint, SceneGraphIssue } from '@orison/shared-contracts';
import { SceneCard, ROLE_GLYPH } from '../src/features/structure/SceneCard';
import { lineHueIndex } from '../src/features/structure/linePalette';
// 批 7 换轴注：卡数据类型自 layout.ts 的 TimelineCell 迁到 workbenchLayout.ts 的
// CausalCardData（字段面全同——旧名随 deriveTimelineLayout 退役删除）。
import type { CausalCardData } from '../src/features/structure/workbenchLayout';

function makeCell(overrides: Partial<CausalCardData> = {}): CausalCardData {
  return {
    nodeId: 's1',
    lineId: 'l_main',
    colValue: 3,
    role: 'normal',
    title: '被亚人包围',
    subIndex: 0,
    ...overrides,
  };
}

const OPEN = { status: 'open' } as const;

function makeIssues(...severities: SceneGraphIssue['severity'][]): SceneGraphIssue[] {
  return severities.map((severity, i) => ({
    code: 'test-issue',
    severity,
    message: `问题 ${i}`,
    targets: [{ kind: 'node' as const, id: 's1' }],
  }));
}

describe('SceneCard state matrix (08-26 批 2)', () => {
  afterEach(() => cleanup());

  it('carries the line-hue class from lineHueIndex(lineId) — 线身份色单源挂法', () => {
    const { container } = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    const card = container.querySelector('.scene-card') as HTMLElement;
    expect(card.classList.contains(`lane-hue--c${lineHueIndex('l_main')}`)).toBe(true);
  });

  it.each(['normal', 'core-anchor', 'secondary-anchor', 'fork-point'] as const)(
    'role=%s → role class + shape glyph（形状轴，无角色色彩面）',
    (role) => {
      const { container } = render(
        <SceneCard cell={makeCell({ role })} displacement="none" visibility={OPEN} showDisplacement showVisibility />
      );
      const card = container.querySelector(`.scene-card--${role}`);
      expect(card).not.toBeNull();
      // glyph = 形状轴（ROLE_GLYPH 同源——WeavingCell 复用同一映射）。
      expect(card!.querySelector('.scene-card-glyph')?.textContent).toBe(ROLE_GLYPH[role]);
    }
  );

  it('selected: 外环类 + data-selected（selectedNodeId 命中该 node 的所有卡）', () => {
    const { container } = render(
      <SceneCard
        cell={makeCell()}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
        selectedNodeId="s1"
      />
    );
    const card = container.querySelector('.scene-card') as HTMLElement;
    expect(card.classList.contains('scene-card--selected')).toBe(true);
    expect(card.getAttribute('data-selected')).toBe('true');
  });

  it('not selected when selectedNodeId misses or is null（外环只属选中）', () => {
    const { container } = render(
      <SceneCard
        cell={makeCell()}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
        selectedNodeId="other"
      />
    );
    const card = container.querySelector('.scene-card') as HTMLElement;
    expect(card.classList.contains('scene-card--selected')).toBe(false);
    expect(card.getAttribute('data-selected')).toBe('false');
  });

  it('highlight: --highlight 类 + 左上 ✦ 角标（形状载体，非边框色）', () => {
    const { container } = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility highlighted />
    );
    const card = container.querySelector('.scene-card') as HTMLElement;
    expect(card.classList.contains('scene-card--highlight')).toBe(true);
    expect(card.getAttribute('data-highlighted')).toBe('true');
    expect(card.querySelector('.scene-card-new')?.textContent).toBe('✦');
  });

  it('no ✦ badge when not highlighted（角标随条件渲染，非常驻）', () => {
    const { container } = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    expect(container.querySelector('.scene-card-new')).toBeNull();
  });

  it('displacement: 线级位移类只在 showDisplacement 且非 none 时落（门控在类级）', () => {
    const on = render(
      <SceneCard cell={makeCell()} displacement="flashback" visibility={OPEN} showDisplacement showVisibility />
    );
    expect(on.container.querySelector('.scene-card--disp-flashback')).not.toBeNull();
    cleanup();
    const toggleOff = render(
      <SceneCard cell={makeCell()} displacement="flashback" visibility={OPEN} showDisplacement={false} showVisibility />
    );
    expect(toggleOff.container.querySelector('.scene-card--disp-flashback')).toBeNull();
    cleanup();
    const none = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    expect(none.container.querySelector('[class*="scene-card--disp-"]')).toBeNull();
  });

  it('visibility: hidden-until 淡出类由 showVisibility 门控', () => {
    const hidden = { status: 'hidden-until' as const, target: 's0' };
    const { container } = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={hidden} showDisplacement showVisibility />
    );
    expect(container.querySelector('.scene-card--hidden')).not.toBeNull();
    cleanup();
    const off = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={hidden} showDisplacement showVisibility={false} />
    );
    expect(off.container.querySelector('.scene-card--hidden')).toBeNull();
  });

  it('validation: ValidationBadges 挂右上（issues 传入渲染 severity pill，无 issues 不渲染）', () => {
    const withIssues = render(
      <SceneCard
        cell={makeCell()}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
        nodeIssues={makeIssues('error', 'warning', 'info')}
      />
    );
    const badges = withIssues.container.querySelectorAll('.validation-badge');
    expect(badges).toHaveLength(3);
    expect(withIssues.container.querySelectorAll('[data-validation-severity="error"]')).toHaveLength(1);
    expect(withIssues.container.querySelector('.scene-card .validation-badges')).not.toBeNull();
    cleanup();
    const clean = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    expect(clean.container.querySelector('.validation-badges')).toBeNull();
  });

  it('emotion: 卡内底条按 tier 着类 + opacity + verbatim title；无点不渲染（批 2 迁入卡内）', () => {
    const pos: EmotionPoint = { refId: 's1', sceneMood: '昂扬', sceneVad: { v: 0.8, a: 1, d: 0 } };
    const { container } = render(
      <SceneCard
        cell={makeCell()}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
        emotionPoint={pos}
      />
    );
    const bar = container.querySelector('[data-emo-node="s1"]') as HTMLElement;
    expect(bar).not.toBeNull();
    expect(bar.classList.contains('emotion-bar--pos')).toBe(true);
    // arousal +1 → 满不透明度（deriveEmotionTint 纯函数锁定，此处只断接线）。
    expect(bar.style.opacity).toBe('1');
    expect(bar.getAttribute('title')).toBe('昂扬');
    // 底条在卡内（非独立 overlay 层）。
    expect(bar.closest('.scene-card')).not.toBeNull();
    cleanup();
    const none = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    expect(none.container.querySelector('.emotion-bar')).toBeNull();
  });

  it('title: 有人类标题显标题、缺省回退 id；卡级 title 恒含 nodeId（悬停快显）', () => {
    const withTitle = render(
      <SceneCard cell={makeCell()} displacement="none" visibility={OPEN} showDisplacement showVisibility />
    );
    const card = withTitle.container.querySelector('.scene-card') as HTMLElement;
    expect(card.querySelector('.scene-card-title')?.textContent).toBe('被亚人包围');
    expect(card.getAttribute('title')).toContain('被亚人包围');
    expect(card.getAttribute('title')).toContain('s1');
    cleanup();
    const fallback = render(
      <SceneCard
        cell={makeCell({ title: undefined })}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
      />
    );
    expect(
      (fallback.container.querySelector('.scene-card') as HTMLElement).querySelector('.scene-card-title')?.textContent
    ).toBe('s1');
  });

  it('data anchors for DOM traceability（node/line/role 同 SceneCell 契约）', () => {
    const { container } = render(
      <SceneCard
        cell={makeCell({ nodeId: 's9', lineId: 'l_side', role: 'fork-point' })}
        displacement="none"
        visibility={OPEN}
        showDisplacement
        showVisibility
      />
    );
    const card = container.querySelector('.scene-card') as HTMLElement;
    expect(card.getAttribute('data-node-id')).toBe('s9');
    expect(card.getAttribute('data-line-id')).toBe('l_side');
    expect(card.getAttribute('data-role')).toBe('fork-point');
  });
});
