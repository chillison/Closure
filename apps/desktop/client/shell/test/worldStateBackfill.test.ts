import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock worldStateRepository deps (hasAnyWorldState / resetWorldStateForBackfill / rebuildChapterSummaries
// 归类读依赖的对象）+ worldStateMaterialize（materialize 组装函数 + episode 归类器 + outlines gate 读取
// ——Story 8.1 Step 6 起 worldStateBackfill 静态复用；CR-8 修复批起该核心住 db/worldStateMaterialize。
// 本 suite 不跑真物化，mock 防其真实模块链加载 better-sqlite3）+ logger。
// 这样 suite 不依赖 better-sqlite3 ABI（mirror worldStateHandlers.test.ts mock 模式）；真 db round-trip
// 见 worldStateBackfillSummary.test.ts（ABI-gated）。
const { listWorldSlices, resetWorldState, materializeChapterSummaryCore, worldSliceEpisodeId, readKnownEpisodeIds, info } =
  vi.hoisted(() => ({
    listWorldSlices: vi.fn(),
    resetWorldState: vi.fn(),
    materializeChapterSummaryCore: vi.fn(),
    worldSliceEpisodeId: vi.fn(),
    readKnownEpisodeIds: vi.fn(),
    info: vi.fn(),
  }));

vi.mock('../main/db/worldStateRepository', () => ({ listWorldSlices, resetWorldState }));
vi.mock('../main/db/worldStateMaterialize', () => ({
  materializeChapterSummaryCore,
  worldSliceEpisodeId,
  readKnownEpisodeIds,
  // X1：rebuildChapterSummaries 尾部 prune 前排空后台摘要索引队列——本 suite 不调 rebuild，
  // mock 提供形参防 import 面 undefined。
  waitForSummaryIndexQueue: vi.fn(async () => undefined),
}));
vi.mock('../main/logger', () => ({ getLogger: () => ({ info }) }));

import { hasAnyWorldState, resetWorldStateForBackfill } from '../main/db/worldStateBackfill';

describe('worldStateBackfill shell helpers (Story 3.4 C-A1)', () => {
  beforeEach(() => {
    listWorldSlices.mockReset();
    resetWorldState.mockReset();
    materializeChapterSummaryCore.mockReset();
    worldSliceEpisodeId.mockReset();
    info.mockReset();
  });

  // ── hasAnyWorldState ──
  it('有 slices → true（诊断前置检查通过，无需 backfill）', () => {
    listWorldSlices.mockReturnValue([{ id: 'ep1:5', storyTime: 5 }]);
    expect(hasAnyWorldState('00001')).toBe(true);
    expect(listWorldSlices).toHaveBeenCalledWith('00001', {});
  });

  it('空 slices → false（无 world state，建议触发 backfill）', () => {
    listWorldSlices.mockReturnValue([]);
    expect(hasAnyWorldState('00001')).toBe(false);
  });

  it('不取 patches（轻量查询，listWorldSlices 不带 withPatches）', () => {
    listWorldSlices.mockReturnValue([]);
    hasAnyWorldState('00001');
    // 第二参数 opts 不含 withPatches:true（只计数 slice 行）
    expect(listWorldSlices).toHaveBeenCalledWith('00001', {});
    expect(listWorldSlices.mock.calls[0][1]).toEqual({});
  });

  // ── resetWorldStateForBackfill ──
  it('委托 resetWorldState（首个 caller，给 resetWorldState 生产消费者）', () => {
    resetWorldStateForBackfill('00042');
    expect(resetWorldState).toHaveBeenCalledWith('00042');
  });

  it('记 info 日志（全量 clean 可观测）', () => {
    resetWorldStateForBackfill('00042');
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: '00042' }),
      expect.stringContaining('clearing derived + amendment'),
    );
  });
});
