/**
 * Story 2.6 story_decisions_update shell handler tests (mirror genreContractHandlers.test.ts).
 *
 * Locks：三档落盘（autoApply 直写走 applyFieldPatchesWithSkipped 单写路径 / 缺省产 field_patch
 * envelope 人审）+ staging dry-run 守卫早反馈（supersede 目标不存在 / user-source 无 force）+
 * dangling supersededBy warnings 回 tool output + corrupt refuse。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, novel: { chapters: [] } })),
  applyFieldPatchesWithSkipped: vi.fn(() => {
    throw new Error('unexpected: tests override per-case');
  }),
}));

import { loadProject, applyFieldPatchesWithSkipped } from '@orison/desktop-local-bff';
import { storyDecisionsUpdateHandler } from '../main/ipc/toolHandlers/storyDecisionHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const REGISTER_ACTION = {
  op: 'register',
  decision: { id: 'd1', summary: '女主真背叛', reason: '妹妹被挟持', risk: '铺垫不足读者弃书', status: 'open', source: 'user' },
};

function docWithDecisions(decisions: unknown[] | undefined) {
  return {
    meta: { name: 'P' },
    novel: decisions === undefined ? { chapters: [] } : { chapters: [], story_decisions: decisions },
  };
}

describe('storyDecisionsUpdateHandler (Story 2.6)', () => {
  beforeEach(() => {
    vi.mocked(loadProject).mockReturnValue(docWithDecisions([]) as any);
    vi.mocked(applyFieldPatchesWithSkipped).mockReset();
  });

  it('缺省（suggest 档）：register -> 产 story_decisions field_patch envelope（actions 重放语义）', async () => {
    const res = await storyDecisionsUpdateHandler(ctx({ actions: [REGISTER_ACTION] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('story_decisions');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as { actions: unknown[]; force?: boolean };
    // request schema parse 后 decision 带 zod defaults（alternatives: [] 等），比较解析后 shape。
    expect(data.actions).toHaveLength(1);
    expect((data.actions[0] as { op: string; decision: { id: string; status: string; source: string; alternatives: string[] } })).toMatchObject({
      op: 'register',
      decision: { id: 'd1', status: 'open', source: 'user', alternatives: [] },
    });
    expect(data.force).toBeUndefined();
    expect(applyFieldPatchesWithSkipped).not.toHaveBeenCalled();
  });

  it('autoApply=true：走 applyFieldPatchesWithSkipped 单写路径（field story_decisions + actions 透传）', async () => {
    vi.mocked(applyFieldPatchesWithSkipped).mockReturnValue({
      applied: docWithDecisions([{ ...REGISTER_ACTION.decision, createdAt: '2026-08-16T00:00:00Z' }]),
      skipped: [],
    } as any);
    const res = await storyDecisionsUpdateHandler(ctx({ actions: [REGISTER_ACTION], autoApply: true }));
    expect(applyFieldPatchesWithSkipped).toHaveBeenCalledTimes(1);
    const call = vi.mocked(applyFieldPatchesWithSkipped).mock.calls[0];
    expect(call[1].patches[0].field).toBe('story_decisions');
    const passed = (call[1].patches[0].data as { actions: Array<{ op: string; decision: { id: string } }> }).actions;
    expect(passed).toHaveLength(1);
    expect(passed[0].op).toBe('register');
    expect(passed[0].decision.id).toBe('d1');
    expect(res.metadata?.applied).toBe(true);
  });

  it('staging dry-run 守卫早反馈：supersede 目标不存在 -> rejected（不产 envelope 不写盘）', async () => {
    const res = await storyDecisionsUpdateHandler(ctx({
      actions: [{ op: 'supersede', oldId: 'ghost', decision: { id: 'd2', summary: 's', reason: 'r', risk: 'k', status: 'decided' } }],
    }));
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('被守卫拒绝');
    expect(applyFieldPatchesWithSkipped).not.toHaveBeenCalled();
  });

  it('user-source 保护：drop 作者拍板决策无 force -> 守卫拒', async () => {
    vi.mocked(loadProject).mockReturnValue(docWithDecisions([
      { id: 'd1', summary: '作者拍板', reason: 'r', risk: 'k', status: 'decided', source: 'user', createdAt: '2026-08-01T00:00:00Z' },
    ]) as any);
    const res = await storyDecisionsUpdateHandler(ctx({
      actions: [{ op: 'drop', id: 'd1', reason: 'AI 擅自弃' }],
    }));
    expect(res.output).toContain('被守卫拒绝');
  });

  it('user-source 保护：force=true -> dry-run 过 -> 产 envelope（force 随 data 走）', async () => {
    vi.mocked(loadProject).mockReturnValue(docWithDecisions([
      { id: 'd1', summary: '作者拍板', reason: 'r', risk: 'k', status: 'decided', source: 'user', createdAt: '2026-08-01T00:00:00Z' },
    ]) as any);
    const res = await storyDecisionsUpdateHandler(ctx({
      actions: [{ op: 'drop', id: 'd1', reason: '作者本人确认放弃' }],
      force: true,
    }));
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as { force?: boolean }).force).toBe(true);
  });

  it('dangling supersededBy（盘上遗留）-> warnings 回 tool output', async () => {
    vi.mocked(loadProject).mockReturnValue(docWithDecisions([
      { id: 'd1', summary: 's', reason: 'r', risk: 'k', status: 'superseded', supersededBy: 'ghost', createdAt: '2026-08-01T00:00:00Z' },
    ]) as any);
    const res = await storyDecisionsUpdateHandler(ctx({
      actions: [{ op: 'register', decision: { id: 'd2', summary: '新决策', reason: 'r', risk: 'k', status: 'open' } }],
    }));
    expect(res.output).toContain('警告');
    expect(res.output).toContain('ghost');
  });

  it('corrupt refuse：loadProject null -> 拒（不 stage）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await storyDecisionsUpdateHandler(ctx({ actions: [REGISTER_ACTION] }));
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('schema 拒：空 actions -> invalid request shape', async () => {
    const res = await storyDecisionsUpdateHandler(ctx({ actions: [] }));
    expect(res.output).toContain('请求格式无效');
  });

  it('auto 档 applyFieldPatchesWithSkipped 抛（守卫在写路径重判拒）-> 不崩，错误文案回 output', async () => {
    vi.mocked(applyFieldPatchesWithSkipped).mockImplementation(() => {
      throw new Error('决策 d1 是作者拍板--放弃须显式 force');
    });
    const res = await storyDecisionsUpdateHandler(ctx({ actions: [REGISTER_ACTION], autoApply: true }));
    expect(res.metadata?.applied).toBe(false);
    expect(res.output).toContain('失败');
    expect(res.output).toContain('force');
  });
});
