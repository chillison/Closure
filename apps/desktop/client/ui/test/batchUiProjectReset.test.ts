import { describe, expect, it } from 'vitest';
import { useAppStore } from '../src/shared/store/appStore';
import { runProjectResets } from '../src/shared/store/resetRegistry';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 8：BatchGroup 折叠态偏好（panelsSlice.agentBatchExpanded，按
// batchId 键控）是项目级 viewing 态——切项目必须清空（state-management spec
// registerProjectReset），否则旧项目的 batch id 在新项目里保持展开。
// 不持久化（内存态），故无 storage 复活路径。
// ─────────────────────────────────────────────────────────────────────────────

describe('Story 3.5 — agentBatchExpanded project reset', () => {
  it('runProjectResets 清空批量折叠偏好（切项目后所有组回到默认折叠）', () => {
    useAppStore.setState({ agentBatchExpanded: { 'b-1': true, 'b-2': false } } as any);
    runProjectResets();
    expect(useAppStore.getState().agentBatchExpanded).toEqual({});
  });

  it('setAgentBatchExpanded 按 batchId 记录展开态', () => {
    useAppStore.setState({ agentBatchExpanded: {} } as any);
    useAppStore.getState().setAgentBatchExpanded('b-9', true);
    expect(useAppStore.getState().agentBatchExpanded['b-9']).toBe(true);
    useAppStore.getState().setAgentBatchExpanded('b-9', false);
    expect(useAppStore.getState().agentBatchExpanded['b-9']).toBe(false);
  });
});
