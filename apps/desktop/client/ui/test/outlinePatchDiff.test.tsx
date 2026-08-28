/**
 * dogfood R2 批次 D1：OutlinePatchDiff 结构化 diff 卡 + outlinePatchDiffModel 纯模型。
 * 三主场景（任务验收：纯新增卷 / 核心字改写 / 转折点增删）+ episode_outlines R1 简版 +
 * 模型防御（残缺形态跳过 / firstAddedPhaseId 跳转目标）。t 用真实 i18n（translate）——
 * 顺带守卫键缺失（缺键会渲染裸键名，断言即失败）。
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { OutlinePatchDiff } from '../src/features/agent-panel/OutlinePatchDiff';
import {
  diffEpisodes,
  diffOutline,
  firstAddedPhaseId,
  isStructuredDiffable,
} from '../src/features/agent-panel/outlinePatchDiffModel';
import { translate } from '../src/shared/i18n/useI18n';

const t = (key: string, vars?: Record<string, string | number>) => translate('en-US', key, vars);

afterEach(() => cleanup());

const outlineCard = (before: unknown, after: unknown) =>
  render(<OutlinePatchDiff field="outline" before={before} after={after} t={t} />);

describe('OutlinePatchDiff 三主场景（D1）', () => {
  it('纯新增卷：+2 卷 chip + 两张「新」卷卡（字段行渲染）+ 绿描边，无裸 JSON', () => {
    const after = {
      phases: [
        { id: 'p1', title: 'Volume One', goal: 'find the source', climax: 'festival scene', hook: 'the mama appears' },
        { id: 'p2', title: 'Volume Two', hook: 'next world?' },
      ],
    };
    const { container } = outlineCard(undefined, after);

    // 统计 chip：+2 vols（en-US creative.patch.outlineDiff.statsPhases）。
    expect(container.querySelector('.outline-diff-chip')?.textContent).toBe('+2 vols');
    // 两张新增卷卡 + 「新」徽章 + 脉冲类（动画一次）。
    expect(container.querySelectorAll('.outline-diff-phase--new')).toHaveLength(2);
    expect(container.querySelectorAll('.outline-diff-tag')).toHaveLength(2);
    const [card1, card2] = container.querySelectorAll('.outline-diff-phase--new');
    expect(card1.textContent).toContain('Volume One');
    expect(card1.textContent).toContain('find the source');
    expect(card1.textContent).toContain('festival scene');
    expect(card1.textContent).toContain('the mama appears');
    // 空字段不渲染行：卷二只有 hook。
    expect(card2.textContent).toContain('next world?');
    expect(card2.textContent).not.toContain('Phase Goal');
    // 结构化路径：无裸 pre。
    expect(container.querySelector('pre')).toBeNull();
  });

  it('核心字改写：旧值删除线 → 新值 +「改写」徽章；未变字段不出现；chip 1 field rewrites', () => {
    const before = { central_conflict: 'old conflict text', main_goal: 'unchanged goal', phases: [] };
    const after = { central_conflict: 'new conflict text', main_goal: 'unchanged goal', phases: [] };
    const { container } = outlineCard(before, after);

    // 旧值（删除线）+ 新值（带 Rewritten 徽章）。
    expect(container.querySelector('.outline-diff-old')?.textContent).toBe('old conflict text');
    const newVals = [...container.querySelectorAll('.outline-diff-new')];
    expect(newVals.some((el) => el.textContent?.includes('Rewritten') && el.textContent.includes('new conflict text'))).toBe(true);
    // 未变字段不出现（main_goal 同值 → 无行）。
    expect(container.textContent).not.toContain('unchanged goal');
    // chip：1 field rewrites；无卷/转折点 chip。
    const chips = [...container.querySelectorAll('.outline-diff-chip')].map((c) => c.textContent);
    expect(chips).toContain('1 field rewrites');
    expect(chips.some((c) => c?.includes('vols'))).toBe(false);
    // 行 label 用既有 outline.centralConflict（单源标签）。
    expect(container.querySelector('.outline-diff-row-label')?.textContent).toBe('Central Conflict');
  });

  it('转折点增删改：同位 label 改写（旧删除线→新）+ 尾部新增（type 徽章 + 新）+ 尾部删除', () => {
    const base = (tps: Array<{ type: string; label: string }>) => ({ phases: [], major_turning_points: tps });
    const before = base([
      { type: 'core-anchor', label: 'Awakening' },
      { type: 'secondary-anchor', label: 'Stable point' },
      { type: 'core-anchor', label: 'Doomed tail' },
    ]);
    const after = base([
      { type: 'core-anchor', label: 'Awakening, rewritten' },
      { type: 'secondary-anchor', label: 'Stable point' },
      { type: 'fork-point', label: 'Fresh fork' },
    ]);
    const { container } = outlineCard(before, after);
    // 按位配对：pos0 changed / pos1 不变不显 / pos2 type+label 变 = changed（fork 徽章）。
    expect(container.querySelector('.outline-diff-old')?.textContent).toBe('Awakening');
    const newVals = [...container.querySelectorAll('.outline-diff-new')];
    expect(newVals.some((el) => el.textContent?.includes('Awakening, rewritten'))).toBe(true);
    expect(container.textContent).not.toContain('Stable point');
    expect(newVals.some((el) => el.textContent?.includes('Fresh fork'))).toBe(true);
    // type 徽章：changed 位取 after 类型（Fork (IF branch)）。
    expect(container.querySelector('.outline-diff-tp-type--fork')?.textContent).toBe('Fork (IF branch)');

    // 尾部删除：before 多一项 → 删除线（removed 行无「新/改写」徽章，type 徽章取 before 类型）。
    const { container: removedContainer } = outlineCard(
      base([{ type: 'core-anchor', label: 'Keep' }, { type: 'core-anchor', label: 'Doomed' }]),
      base([{ type: 'core-anchor', label: 'Keep' }]),
    );
    expect(removedContainer.querySelector('.outline-diff-old')?.textContent).toBe('Doomed');
    expect(removedContainer.querySelector('.outline-diff-tag')).toBeNull();

    // 尾部新增：chip +1 turning points。
    const { container: addedContainer } = outlineCard(
      base([{ type: 'core-anchor', label: 'Keep' }]),
      base([{ type: 'core-anchor', label: 'Keep' }, { type: 'secondary-anchor', label: 'Fresh' }]),
    );
    const chips = [...addedContainer.querySelectorAll('.outline-diff-chip')].map((c) => c.textContent);
    expect(chips).toContain('+1 turning points');
  });

  it('episode_outlines（R1 简版）：计数 chips + 每集一行式（id + purpose，changed 标黄类）', () => {
    const before = [
      { id: 'ep1', index: 0, title: 'T1', purpose: 'old purpose' },
      { id: 'ep2', index: 1, title: 'T2', purpose: 'kept purpose' },
      { id: 'ep4', index: 3, title: 'T4', purpose: 'doomed' },
    ];
    const after = [
      { id: 'ep1', index: 0, title: 'T1', purpose: 'new purpose' },
      { id: 'ep2', index: 1, title: 'T2', purpose: 'kept purpose' },
      { id: 'ep3', index: 2, title: 'T3', purpose: 'brand new' },
    ];
    const { container } = render(
      <OutlinePatchDiff field="episode_outlines" before={before} after={after} t={t} />,
    );
    const chips = [...container.querySelectorAll('.outline-diff-chip')].map((c) => c.textContent);
    expect(chips).toContain('+1 episodes');
    expect(chips).toContain('1 changed');
    expect(chips).toContain('-1 episodes');
    // 一行式：changed 行含 id + 新 purpose，且挂 changed 修饰类；未变集不出现；删除集删除线。
    const changedRow = container.querySelector('.outline-diff-ep--changed');
    expect(changedRow?.textContent).toContain('ep1');
    expect(changedRow?.textContent).toContain('new purpose');
    expect(container.querySelector('.outline-diff-ep--added')?.textContent).toContain('brand new');
    expect(container.querySelector('.outline-diff-ep--removed')?.textContent).toContain('doomed');
    expect(container.textContent).not.toContain('kept purpose');
  });

  it('diff 无可见变化 / 形态不完整 → 裸 JSON 回退（零回归路径）', () => {
    // outline envelope 非对象（防御位，shell zod 已校验）→ pre 回退。
    const { container: malformed } = outlineCard(undefined, 'not-an-object');
    expect(malformed.querySelector('pre')).not.toBeNull();
    expect(malformed.querySelector('.outline-diff')).toBeNull();
    // 结构 diff 全空（仅未覆盖字段也无变化）→ pre 回退。
    const { container: empty } = outlineCard({ phases: [] }, { phases: [] });
    expect(empty.querySelector('pre')).not.toBeNull();
  });
});

describe('outlinePatchDiffModel 纯模型（D1）', () => {
  it('firstAddedPhaseId：首个新增卷 id；无新增 / 残缺形态 → null', () => {
    expect(firstAddedPhaseId(undefined, { phases: [{ id: 'p1', title: 'a' }, { id: 'p2', title: 'b' }] })).toBe('p1');
    expect(firstAddedPhaseId({ phases: [{ id: 'p1', title: 'a' }] }, { phases: [{ id: 'p1', title: 'a' }] })).toBeNull();
    expect(firstAddedPhaseId({ phases: [{ id: 'p1', title: 'a' }] }, { phases: [{ id: 'p1', title: 'a' }, { id: 'p9', title: 'c' }] })).toBe('p9');
    expect(firstAddedPhaseId(undefined, 'garbage')).toBeNull();
    expect(firstAddedPhaseId(undefined, { phases: [{ title: 'no-id' }] })).toBeNull();
  });

  it('diffOutline：残缺卷（缺 id/title）跳过不炸；约束增删按位配对', () => {
    const diff = diffOutline(
      { phases: [{ id: 'p1', title: 'a' }, { noId: true }], constraints: ['keep', 'old'] },
      { phases: [{ id: 'p1', title: 'a renamed' }, { title: 'still no id' }], constraints: ['keep', 'rewritten'] },
    );
    // p1 changed（title）；残缺项两侧都被 guard 跳过，不产生假 diff。
    expect(diff.phases).toHaveLength(1);
    expect(diff.phases[0].kind).toBe('changed');
    expect(diff.constraints).toHaveLength(1);
    expect(diff.constraints[0]).toMatchObject({ kind: 'changed', before: 'old', after: 'rewritten' });
  });

  it('diffEpisodes：非数组输入 → 空结果（防御）', () => {
    expect(diffEpisodes('nope', undefined)).toEqual({ entries: [], stats: { added: 0, removed: 0, changed: 0 } });
  });

  it('isStructuredDiffable：outline 需对象 / episode 需数组 / 其他字段 false', () => {
    expect(isStructuredDiffable('outline', { phases: [] })).toBe(true);
    expect(isStructuredDiffable('outline', ['array'])).toBe(false);
    expect(isStructuredDiffable('episode_outlines', [])).toBe(true);
    expect(isStructuredDiffable('episode_outlines', { a: 1 })).toBe(false);
    expect(isStructuredDiffable('scene_graph', { nodes: [] })).toBe(false);
  });
});
