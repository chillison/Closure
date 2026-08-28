/**
 * Story 8.2 arc ledger shell handler tests (mirror promiseLedgerHandlers.test.ts).
 *
 * Locks the creative-field bounded-write pattern (add_beat → field_patch envelope
 * / autoApply direct persist) + corrupt-vs-absent guard + read filter/window +
 * natural-key beat idempotency + close-requires-grounding trust boundary.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// loadProject / onFieldEdited are imported dynamically inside the handler; mock at top level and
// control per-test via vi.mocked. Default loadProject = a valid project doc with NO arc_registry
// field (absent -> fresh empty registry is the correct base). Default onFieldEdited = no-op spy
// （autoApply 路径用，验证落盘调用；非 autoApply 路径不调 onFieldEdited 走 field_patch envelope）。
vi.mock('@orison/desktop-local-bff', () => ({
  loadProject: vi.fn(() => ({ meta: { name: 'P' }, storyboard: { shots: [] } })),
  onFieldEdited: vi.fn(() => ({ syncEvent: { id: 'evt' }, staleFields: [] })),
}));

// query_arc_summary 的 db 侧依赖（getProject registry 解析 + listLatestArcSummaries）mock 掉——
// transitive imports（getDb / electron app / better-sqlite3）不加载，本 suite 在 plain vitest 下零 ABI
// 顾虑（mirror queryStoryHandler.test.ts）。真 db round-trip（含 SQL/级联清理）归
// arcSummaryRepository.test.ts（Electron-as-Node 真跑，mirror 8.1 纪律）。
const { getProject, listLatestArcSummaries, upsertArcSummary, warn } = vi.hoisted(() => ({
  getProject: vi.fn(),
  listLatestArcSummaries: vi.fn(),
  upsertArcSummary: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../main/db/projectRepository', () => ({ getProject }));
vi.mock('../main/db/arcSummaryRepository', () => ({ listLatestArcSummaries, upsertArcSummary }));
vi.mock('../main/logger', () => ({ getLogger: () => ({ warn }) }));

import { loadProject, onFieldEdited } from '@orison/desktop-local-bff';
import {
  arcLedgerUpdateHandler,
  queryArcHandler,
  queryArcSummaryHandler,
  recordArcAuditHandler,
} from '../main/ipc/toolHandlers/arcLedgerHandlers';

const ctx = (params: Record<string, unknown>, projectDir = '/proj') => ({
  params,
  projectDir,
  sessionId: 's1',
  abort: new AbortController().signal,
});

const ABSENT_DOC = { meta: { name: 'P' }, storyboard: { shots: [] } };

const FULL_BEAT = {
  episodeId: 'ep-10',
  episodeIndex: 10,
  arcRef: 'phase-1',
  arcKind: 'volume' as const,
  action: 'advance' as const,
  note: '审判日开庭',
};

const CLOSE_BEAT = {
  episodeId: 'ep-12',
  episodeIndex: 12,
  arcRef: 'phase-1',
  arcKind: 'volume' as const,
  action: 'close' as const,
  grounding: '「判决生效。」法官落槌。',
};

describe('arcLedgerUpdateHandler (Story 8.2)', () => {
  it('合法 add_beat → 投影 schema-valid → 产 field_patch metadata（id 自然键生成）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );

    expect(res.metadata).toBeDefined();
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('arc_registry');
    expect(res.metadata?.action).toBe('set');
    const data = res.metadata?.data as any;
    expect(data.beats).toHaveLength(1);
    expect(data.beats[0]).toMatchObject({ arcRef: 'phase-1', arcKind: 'volume', action: 'advance' });
    expect(data.beats[0].id).toBe('phase-1::ep-10::advance');
  });

  it('absent arc_registry（项目无该字段）→ 当空 registry 投影，产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    // absent = legit empty (new project / 8.2 dormant 直至写手开始登记，design §8)
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any).beats).toHaveLength(1);
  });

  it('corrupt arc_registry（beats 非 array）→ 拒绝 update + 不产 field_patch', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      arc_registry: { beats: 'not-an-array', version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('不是数组');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('per-element 容错：单条坏 beat（缺 arcKind）读侧丢弃，好条目保留可投影（direct 抽取 + per-element safeParse）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      arc_registry: {
        beats: [
          { id: 'b-good', episodeId: 'ep-1', episodeIndex: 1, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
          { id: 'b-bad', episodeId: 'ep-2', episodeIndex: 2, arcRef: 'line-a', action: 'advance' }, // 缺 arcKind
        ],
        version: 3,
        updatedBy: 'user',
      },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    // 好条目保留 + 新 beat 追加；坏条目丢弃（1 坏不丢全 registry）。
    expect(data.beats.map((b: any) => b.id)).toEqual(['b-good', 'phase-1::ep-10::advance']);
    // version/updatedBy 装饰值透传（onFieldEdited 落盘时 bump，非 projector 职责）。
    expect(data.version).toBe(3);
    expect(data.updatedBy).toBe('user');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null（整文档 corrupt/missing）→ 拒绝 update（跨字段污染防护）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('无法读取');
  });

  it('拒绝非法 type 名（schema 层拦截，非投影层）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await arcLedgerUpdateHandler(ctx({ actions: [{ type: 'bogus_op', id: 'x' }] }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('操作格式无效');
  });

  it('close beat 缺 grounding → 拒绝（写入侧 trust-boundary，design §2 close 必带正文锚定）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await arcLedgerUpdateHandler(
      ctx({
        actions: [
          {
            type: 'add_beat',
            beat: { episodeId: 'ep-12', episodeIndex: 12, arcRef: 'phase-1', arcKind: 'volume', action: 'close' },
          },
        ],
      }),
    );
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('grounding');
  });

  it('close beat 带 grounding → 正常投影', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await arcLedgerUpdateHandler(ctx({ actions: [{ type: 'add_beat', beat: CLOSE_BEAT }] }));
    expect(res.metadata?.type).toBe('field_patch');
    expect((res.metadata?.data as any).beats[0].action).toBe('close');
  });

  it('add_beat 幂等：同 (arcRef, episodeId, action) 自然键覆盖 note，保留既有 id，不累积', async () => {
    const existing = {
      ...ABSENT_DOC,
      arc_registry: {
        beats: [
          { id: 'b-existing', episodeId: 'ep-10', episodeIndex: 10, arcRef: 'phase-1', arcKind: 'volume', action: 'advance', note: '旧推进' },
          { id: 'b-other', episodeId: 'ep-9', episodeIndex: 9, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
        ],
        version: 1,
      },
    };
    vi.mocked(loadProject).mockReturnValue(existing as any);
    const res = await arcLedgerUpdateHandler(
      ctx({
        actions: [
          // 自然键命中 (phase-1, ep-10, advance) → 覆盖 note，保留既有 id 'b-existing'
          { type: 'add_beat', beat: { ...FULL_BEAT, note: '新推进' } },
        ],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    const data = res.metadata?.data as any;
    expect(data.beats).toHaveLength(2); // 不累积
    const hit = data.beats.find((b: any) => b.id === 'b-existing');
    expect(hit.note).toBe('新推进');
    expect(hit.id).toBe('b-existing'); // 显式自然键 id 不覆盖既有 id
  });
});

describe('arcLedgerUpdateHandler autoApply (Story 8.2 — arc-emergence 写时声明自动落盘)', () => {
  it('autoApply=true → 调 onFieldEdited（source=agent，projected registry）→ 返 applied metadata（非 field_patch）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockClear();
    const res = await arcLedgerUpdateHandler(
      ctx({ autoApply: true, actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );

    expect(onFieldEdited).toHaveBeenCalledTimes(1);
    const [pDir, field, data, options] = vi.mocked(onFieldEdited).mock.calls[0];
    expect(pDir).toBe('/proj');
    expect(field).toBe('arc_registry');
    expect((data as any).beats).toHaveLength(1);
    expect((data as any).beats[0]).toMatchObject({ arcRef: 'phase-1', action: 'advance' });
    expect((options as { source?: string }).source).toBe('agent');
    expect(typeof (options as { reason?: string }).reason).toBe('string');

    expect(res.metadata).toMatchObject({ ok: true, applied: true, beatCount: 1 });
    expect(res.metadata?.type).toBeUndefined(); // 非 field_patch
    expect(res.output).toContain('已生效');
  });

  it('autoApply 缺省 false → 不调 onFieldEdited，走 field_patch envelope（leader PatchReview 路径）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockClear();
    const res = await arcLedgerUpdateHandler(
      ctx({ actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.metadata?.type).toBe('field_patch');
  });

  it('autoApply=true on corrupt arc_registry → 拒绝（不调 onFieldEdited，不 overwrite）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      arc_registry: { beats: 'not-an-array' },
    } as any);
    vi.mocked(onFieldEdited).mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await arcLedgerUpdateHandler(
      ctx({ autoApply: true, actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(onFieldEdited).not.toHaveBeenCalled();
    expect(res.output).toContain('被拒');
    warn.mockRestore();
  });

  it('graceful：onFieldEdited 抛错（locked field / save fail）→ 不破 handler，返失败提示', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    vi.mocked(onFieldEdited).mockImplementation(() => {
      throw new Error('Field arc_registry is locked and cannot be edited');
    });
    const res = await arcLedgerUpdateHandler(
      ctx({ autoApply: true, actions: [{ type: 'add_beat', beat: FULL_BEAT }] }),
    );
    expect(onFieldEdited).toHaveBeenCalledTimes(1); // 被调（但抛错）
    expect(res.metadata?.applied).toBeUndefined();
    expect(res.output).toContain('自动生效失败');
    expect(res.output).toContain('locked');
  });
});

describe('queryArcHandler (Story 8.2)', () => {
  function registryDoc(beats: unknown[]) {
    return { ...ABSENT_DOC, arc_registry: { beats, version: 1 } } as any;
  }

  it('读全部 beats（无 filter，registry 序透传）', async () => {
    vi.mocked(loadProject).mockReturnValue(
      registryDoc([
        { id: 'b1', episodeId: 'ep-1', episodeIndex: 1, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
        { id: 'b2', episodeId: 'ep-2', episodeIndex: 2, arcRef: 'phase-1', arcKind: 'volume', action: 'close', grounding: 'q' },
      ]),
    );
    const res = await queryArcHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, beatCount: 2, truncated: false });
    expect((res.metadata as any).beats).toHaveLength(2);
  });

  it('按 episodeId / arcRef 收窄', async () => {
    vi.mocked(loadProject).mockReturnValue(
      registryDoc([
        { id: 'b1', episodeId: 'ep-1', episodeIndex: 1, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
        { id: 'b2', episodeId: 'ep-2', episodeIndex: 2, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
        { id: 'b3', episodeId: 'ep-2', episodeIndex: 2, arcRef: 'phase-1', arcKind: 'volume', action: 'advance' },
      ]),
    );
    const byEpisode = await queryArcHandler(ctx({ episodeId: 'ep-2' }));
    expect((byEpisode.metadata as any).beats.map((b: any) => b.id)).toEqual(['b2', 'b3']);

    const byArc = await queryArcHandler(ctx({ arcRef: 'line-a' }));
    expect((byArc.metadata as any).beats.map((b: any) => b.id)).toEqual(['b1', 'b2']);
  });

  it('最近窗 cap 200：超窗取最近 200 条（时间正序呈现）+ truncated 标记', async () => {
    const beats = Array.from({ length: 250 }, (_, i) => ({
      id: `b${String(i).padStart(3, '0')}`,
      episodeId: `ep-${i}`,
      episodeIndex: i,
      arcRef: 'line-a',
      arcKind: 'line',
      action: 'advance',
    }));
    vi.mocked(loadProject).mockReturnValue(registryDoc(beats));

    const res = await queryArcHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, beatCount: 200, truncated: true });
    const windowed = (res.metadata as any).beats as any[];
    // 最近 200 条 = index 50..249（截掉最早 50 条），正序呈现。
    expect(windowed[0].episodeIndex).toBe(50);
    expect(windowed[199].episodeIndex).toBe(249);

    // 收窄后 ≤ 200 → 不截断。
    const narrow = await queryArcHandler(ctx({ arcRef: 'line-a', episodeId: 'ep-100' }));
    expect(narrow.metadata).toMatchObject({ beatCount: 1, truncated: false });
  });

  it('absent（项目无 arc_registry）→ 友好空提示 + count 0（additive，非 corrupt）', async () => {
    vi.mocked(loadProject).mockReturnValue(ABSENT_DOC as any);
    const res = await queryArcHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, beatCount: 0, truncated: false });
    expect(res.output).toContain('尚未登记');
  });

  it('filter 无匹配 → 友好提示 + count 0', async () => {
    vi.mocked(loadProject).mockReturnValue(
      registryDoc([
        { id: 'b1', episodeId: 'ep-1', episodeIndex: 1, arcRef: 'line-a', arcKind: 'line', action: 'advance' },
      ]),
    );
    const res = await queryArcHandler(ctx({ arcRef: 'nope' }));
    expect(res.metadata).toMatchObject({ ok: true, beatCount: 0 });
    expect(res.output).toContain('未找到');
  });

  it('corrupt arc_registry（beats 非 array）→ 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue({
      ...ABSENT_DOC,
      arc_registry: { beats: 'not-an-array', version: 0 },
    } as any);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await queryArcHandler(ctx({}));
    expect(res.output).toContain('无法读取');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('loadProject 返 null → 友好不可读提示（永不抛）', async () => {
    vi.mocked(loadProject).mockReturnValue(null);
    const res = await queryArcHandler(ctx({}));
    expect(res.output).toContain('无法读取');
  });

  it('参数非法（空 episodeId）→ invalid_params 提示（永不抛）', async () => {
    const res = await queryArcHandler(ctx({ episodeId: '' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(res.output).toContain('参数无效');
  });
});

describe('queryArcSummaryHandler (Story 8.2)', () => {
  beforeEach(() => {
    getProject.mockReset();
    listLatestArcSummaries.mockReset();
    warn.mockReset();
  });

  it('项目未注册（getProject 无命中）→ notRegistered 友好提示', async () => {
    getProject.mockReturnValue(undefined);
    const res = await queryArcSummaryHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
    expect(res.output).toContain('未注册');
    expect(listLatestArcSummaries).not.toHaveBeenCalled();
  });

  it('参数非法（空 arcRef）→ invalid_params 提示', async () => {
    const res = await queryArcSummaryHandler(ctx({ arcRef: '' }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
  });

  it('已注册 + 有摘要行 → markdown 行呈现（findings 计数 + degraded/corrupt 标记）+ metadata 携带 records', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    listLatestArcSummaries.mockReturnValue([
      {
        arcRef: 'phase-1',
        arcKind: 'volume',
        auditKind: 'closure',
        fromEpisodeIndex: 0,
        toEpisodeIndex: 12,
        result: {
          arcRef: 'phase-1',
          arcKind: 'volume',
          span: { fromEpisodeIndex: 0, toEpisodeIndex: 12 },
          arcSummary: { synopsis: '第一卷梗概' },
          findings: [
            {
              category: 'theme-earning',
              route: 'defect',
              verdict: 'missing',
              entityId: 'theme-power',
              entityLabel: '权力主题',
              quote: '原文',
              location: 'ep-5',
              explanation: '主题未挣得',
              suggestedFix: '下卷补呼应',
            },
          ],
          degraded: false,
        },
        tokenEstimate: 1800,
        producedAt: '2026-08-17T00:00:00.000Z',
      },
      {
        arcRef: 'line-sub-a',
        arcKind: 'line',
        auditKind: 'stagnation',
        fromEpisodeIndex: 3,
        toEpisodeIndex: 14,
        corruptPayload: true, // 坏 JSON 行：result 缺省 + 标记
        tokenEstimate: 0,
        producedAt: '2026-08-17T00:00:00.000Z',
      },
    ]);

    const res = await queryArcSummaryHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: true, count: 2 });
    expect(res.output).toContain('phase-1〔volume/closure〕span #0-#12');
    expect(res.output).toContain('findings 1');
    expect(res.output).toContain('line-sub-a〔line/stagnation〕');
    expect(res.output).toContain('result JSON 损坏'); // corrupt 标记可见（不静默）
    expect(listLatestArcSummaries).toHaveBeenCalledWith('00042', undefined);
  });

  it('已注册 + arcRef 收窄 → 透传 filter；空结果 → 友好提示', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    listLatestArcSummaries.mockReturnValue([]);
    const res = await queryArcSummaryHandler(ctx({ arcRef: 'phase-9' }));
    expect(res.metadata).toMatchObject({ ok: true, count: 0 });
    expect(res.output).toContain('phase-9');
    expect(listLatestArcSummaries).toHaveBeenCalledWith('00042', 'phase-9');
  });

  it('repository 抛错 → graceful 失败提示（永不抛）', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    listLatestArcSummaries.mockImplementation(() => {
      throw new Error('db exploded');
    });
    const res = await queryArcSummaryHandler(ctx({}));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'list_failed' });
    expect(res.output).toContain('查询失败');
  });
});

describe('recordArcAuditHandler (Story 8.2 Step 4)', () => {
  /** 合法 closure ArcAuditResult（arcRef/arcKind/span 机械字段 caller 派生已覆写形态）。 */
  const CLOSURE_RESULT = {
    arcRef: 'phase-1',
    arcKind: 'volume',
    span: { fromEpisodeIndex: 0, toEpisodeIndex: 12 },
    arcSummary: {
      synopsis: '第一卷梗概',
      lineSections: [{ lineId: 'line-a', name: '主线', summary: '收束' }],
      characterArcs: [],
      openThreads: ['南方的信'],
    },
    findings: [],
    degraded: false,
  };

  beforeEach(() => {
    vi.mocked(getProject).mockReset();
    vi.mocked(upsertArcSummary).mockReset();
  });

  it('closure + 合法 result → upsertArcSummary 调用（projectId + 冗余列 + result + tokenEstimate）', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    upsertArcSummary.mockReturnValue(undefined);
    const res = await recordArcAuditHandler(ctx({ auditKind: 'closure', result: CLOSURE_RESULT }));
    expect(res.metadata).toMatchObject({ ok: true, arcRef: 'phase-1', auditKind: 'closure', findingsCount: 0 });
    expect(upsertArcSummary).toHaveBeenCalledTimes(1);
    const [projectId, row] = upsertArcSummary.mock.calls[0];
    expect(projectId).toBe('00042');
    expect(row).toMatchObject({
      arcRef: 'phase-1',
      arcKind: 'volume',
      auditKind: 'closure',
      fromEpisodeIndex: 0,
      toEpisodeIndex: 12,
    });
    expect(row.result).toStrictEqual(CLOSURE_RESULT);
    expect(typeof row.tokenEstimate).toBe('number');
  });

  it('kind mismatch belt（stagnation + volume result）→ 拒收不落表', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    const res = await recordArcAuditHandler(ctx({ auditKind: 'stagnation', result: CLOSURE_RESULT }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'kind_mismatch' });
    expect(upsertArcSummary).not.toHaveBeenCalled();
  });

  it('schema 违（arcKind 非 enum）→ invalid_params 拒收', async () => {
    const res = await recordArcAuditHandler(
      ctx({
        auditKind: 'closure',
        result: { arcRef: 'x', arcKind: 'bogus', span: { fromEpisodeIndex: 0, toEpisodeIndex: 1 }, findings: [] },
      }),
    );
    expect(res.metadata).toMatchObject({ ok: false, reason: 'invalid_params' });
    expect(upsertArcSummary).not.toHaveBeenCalled();
  });

  it('growth 停滞弧（stagnation + growth result）→ 接受落表（终审 F2：诚实标注不拒收）', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    upsertArcSummary.mockReturnValue(undefined);
    const growthResult = {
      arcRef: 'growth:char-1',
      arcKind: 'growth',
      span: { fromEpisodeIndex: 0, toEpisodeIndex: 8 },
      findings: [],
      degraded: false,
    };
    const res = await recordArcAuditHandler(ctx({ auditKind: 'stagnation', result: growthResult }));
    expect(res.metadata).toMatchObject({ ok: true, arcRef: 'growth:char-1', auditKind: 'stagnation' });
    expect(upsertArcSummary).toHaveBeenCalledWith('00042', expect.objectContaining({ arcKind: 'growth' }));
  });

  it('closure + growth result → kind_mismatch 拒收（growth 只属停滞审）', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    const res = await recordArcAuditHandler(
      ctx({ auditKind: 'closure', result: { arcRef: 'growth:char-1', arcKind: 'growth', span: { fromEpisodeIndex: 0, toEpisodeIndex: 1 }, findings: [] } }),
    );
    expect(res.metadata).toMatchObject({ ok: false, reason: 'kind_mismatch' });
    expect(upsertArcSummary).not.toHaveBeenCalled();
  });

  it('项目未注册 → project_not_registered 不落表', async () => {
    getProject.mockReturnValue(undefined);
    const res = await recordArcAuditHandler(ctx({ auditKind: 'closure', result: CLOSURE_RESULT }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'project_not_registered' });
    expect(upsertArcSummary).not.toHaveBeenCalled();
  });

  it('upsert 抛错 → graceful upsert_failed（永不抛）', async () => {
    getProject.mockReturnValue({ projectId: '00042' });
    upsertArcSummary.mockImplementation(() => {
      throw new Error('wal busy');
    });
    const res = await recordArcAuditHandler(ctx({ auditKind: 'closure', result: CLOSURE_RESULT }));
    expect(res.metadata).toMatchObject({ ok: false, reason: 'upsert_failed' });
  });
});
