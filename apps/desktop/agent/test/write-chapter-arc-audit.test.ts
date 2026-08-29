import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/types';
import type { RunSnapshotSummary } from '../src/contracts/run';
import type { SessionState } from '../src/types';
import type { ArcBeat } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.2 Step 4：write_chapter 弧审 post-settle 单测（design §2/§5，implement.md Step 4 tests）。
//
// mock skillExecutor（runChapterChain summary 携 arcEmergenceBeats + runAgentWithExplicitSystem
// role-aware）+ registry 动态 mock（query_arc 全量 beats / query_arc_summary 已物化行 /
// record_arc_audit spy，mirror write-chapter-story-sync registerStorySyncTool 模式）。验：
// (a) dispatch 门控：无卷弧 close beat → arc-audit 零派发（AC2 零成本路径）；
// (b) close beat 命中 → 派大审（allowedTools + requirement）→ parse → record_arc_audit 落表 + 文案；
// (c) 停滞触发 + 防重（同 stagnation 窗已审 → 跳过；新窗 → 派专注审）；
// (d) 三档路由文案分支（defect surface / deviation auto vs suggest / gray 裁决器附弧上下文）；
// (e) formatArcFeedback 投影（Director vars 含 arcFeedback）；
// (f) arcSnapshot 注入与空降级（initialArtifacts['arc_snapshot']）。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/agent/session', () => ({
  getSession: vi.fn(),
  loadSession: vi.fn(),
  createSession: vi.fn(),
  deleteSession: vi.fn(),
  addMessage: vi.fn(),
  updateStatus: vi.fn(),
  loadSessionMeta: vi.fn(),
}));

import { getSession } from '../src/agent/session';

const mockedGetSession = vi.mocked(getSession);

function setSession(mode: 'readonly' | 'suggest' | 'auto' | undefined): void {
  if (mode === undefined) {
    mockedGetSession.mockReturnValue(undefined);
    return;
  }
  mockedGetSession.mockReturnValue({ permissionMode: mode } as SessionState);
}

/** 合法 volume close beat（本章声明）。 */
function volumeCloseBeat(episodeId: string, episodeIndex: number, arcRef = 'phase-1'): ArcBeat {
  return {
    id: `${arcRef}::${episodeId}::close`,
    episodeId,
    episodeIndex,
    arcRef,
    arcKind: 'volume',
    action: 'close',
    grounding: '城门在他身后轰然关闭。',
  };
}

/** 合法 arc-audit-agent 输出（content schema：无 arcRef/arcKind/span——caller 派生覆写）。 */
const ARC_AUDIT_CONTENT = {
  arcSummary: {
    synopsis: '主角从荒野抵达 B 城并在城门决战中完成第一卷的目标。',
    lineSections: [{ lineId: 'line-main', name: '主线', summary: '推进至城门收束' }],
    characterArcs: [{ characterId: 'char-1', summary: '从逃避到直面' }],
    openThreads: ['南方的信未拆'],
  },
  findings: [
    {
      category: 'volume-arc',
      route: 'defect',
      verdict: 'under-developed',
      entityId: 'phase-1',
      entityLabel: '第一卷卷弧',
      quote: '他推开门，走了进去。',
      location: '第8章段2',
      explanation: '卷 climax 落定仓促，反派动机未铺垫',
      suggestedFix: '下卷补反派视角场',
    },
    {
      category: 'character-arc',
      route: 'deviation',
      verdict: 'drifted',
      entityId: 'char-1',
      entityLabel: '主角成长弧',
      quote: '我没有别的选择。',
      location: '第6章段1',
      explanation: '正文让主角主动放弃成长弧的关键转折，走了另一条路',
      suggestedFix: '登记决策：成长弧改走被动觉醒线',
    },
    {
      category: 'arc-drift',
      route: 'gray',
      verdict: 'stalled',
      entityId: 'line-side',
      entityLabel: '支线：密信',
      quote: '信还在怀里。',
      location: '第5章段3',
      explanation: '支线停滞可能是故意的压抑期',
      suggestedFix: '下卷安排密信揭露或明示搁置',
    },
  ],
  degraded: false,
};

describe('write_chapter 弧审 post-settle（Story 8.2 Step 4）', () => {
  let projectPath = '';
  let runChapterChain: ReturnType<typeof vi.fn>;
  let runAgentWithExplicitSystem: ReturnType<typeof vi.fn>;
  let ctx: ToolContext;

  /** 注册 mock query_arc（返指定 beats）。 */
  async function registerQueryArc(beats: ArcBeat[]): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'query_arc',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return { title: 'mock', output: '', metadata: { ok: true, beatCount: beats.length, beats, truncated: false } };
      },
    });
  }

  /** 注册 mock query_arc_summary（返已物化行）。 */
  async function registerQueryArcSummary(rows: unknown[]): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'query_arc_summary',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return { title: 'mock', output: '', metadata: { ok: true, count: rows.length, summaries: rows } };
      },
    });
  }

  /** 注册 spy record_arc_audit（mirror registerStorySyncTool 模式）。 */
  async function registerRecordArcAudit(): Promise<ReturnType<typeof vi.fn>> {
    const { registry } = await import('../src/tool/registry');
    const execute = vi.fn().mockResolvedValue({
      title: 'record_arc_audit: mock',
      output: 'mock',
      metadata: { ok: true, arcRef: 'phase-1', auditKind: 'closure', findingsCount: 3 },
    });
    registry.register({ id: 'record_arc_audit', description: 'mock', parameters: z.object({}), execute });
    return execute;
  }

  function makeAcceptSummary(beats?: ArcBeat[]): RunSnapshotSummary {
    return {
      status: 'completed',
      routeDecision: { decision: 'accept_as_truth', reason: '通过' },
      ...(beats ? { arcEmergenceBeats: beats } : {}),
      errors: [],
    };
  }

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-write-chapter-arc-audit-'));
    runChapterChain = vi.fn();
    runAgentWithExplicitSystem = vi.fn(async (_sid: string, role: string) => {
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      if (role === 'arc-audit-agent') return { content: JSON.stringify(ARC_AUDIT_CONTENT) };
      if (role === 'adjudicator-agent') {
        return {
          content: JSON.stringify({
            analysis: '弧语境分析',
            recommendation: 'accept',
            recommendationReason: '压抑期是铺垫',
            options: [
              { label: '接受为真相', reason: '保铺垫' },
              { label: '改稿', reason: '推进支线' },
            ],
          }),
        };
      }
      return { content: '{}' };
    });
    ctx = {
      sessionId: 'leader-session-1',
      projectPath,
      abort: new AbortController().signal,
      skillExecutor: { runChapterChain, runSubagent: vi.fn(), executeSkillByName: vi.fn(), runAgentWithExplicitSystem },
    };
    mockedGetSession.mockReset();
    setSession('suggest');
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({
        meta: { id: 'proj-1', name: 'demo', type: 'novel', version: 1, created_at: '2026-08-17T00:00:00Z', updated_at: '2026-08-17T00:00:00Z' },
        creative_brief: { genre: '都市奇幻', genre_tags: ['都市'] },
        world_setting: { premise: '灵气复苏都市' },
        asset_cards: [{ id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年', narrative: { storyFunction: '主角' }, desireAndBottomline: { coreDesire: '变强' }, personality: { coreTraits: ['坚韧'] } }],
        scene_graph: {
          nodes: [
            { id: 's1', episodeId: 'ep1', storyTime: 0, presentationOrder: { chapter: 0, pos: 0 } },
            { id: 's2', episodeId: 'ep2', storyTime: 1, presentationOrder: { chapter: 1, pos: 0 } },
          ],
          edges: [],
          lines: [
            { id: 'line-main', name: '主线', topology_role: 'converging' },
            { id: 'line-side', name: '密信支线', topology_role: 'side' },
          ],
        },
        outline: { phases: [{ id: 'phase-1', title: '第一卷', goal: '抵达 B 城', climax: '城门决战', hook: '南方的信' }] },
        promise_registry: { promises: [], beats: [], version: 0 },
        episode_outlines: [
          { id: 'ep1', index: 0, title: '开篇' },
          { id: 'ep2', index: 1, title: '入城' },
        ],
      }),
      'utf8',
    );
  });

  afterEach(() => {
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  /** 从 runAgentWithExplicitSystem 调用记录过滤某 role 的调用。 */
  function callsForRole(role: string): Array<Record<string, unknown>> {
    return runAgentWithExplicitSystem.mock.calls.filter((c) => c[1] === role);
  }

  // ─── (a) dispatch 门控：无 close beat → 零派发（AC2）───

  it('本章无卷弧 close beat（仅 advance / 零 beats）→ arc-audit 零派发 + 无停滞 → 零成本路径', async () => {
    await registerQueryArc([
      { id: 'b1', episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'advance' },
    ]);
    runChapterChain.mockResolvedValueOnce(
      makeAcceptSummary([
        { id: 'b1', episodeId: 'ep2', episodeIndex: 1, arcRef: 'line-main', arcKind: 'line', action: 'advance' },
      ]),
    );
    const recordExecute = await registerRecordArcAudit();
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    expect(callsForRole('arc-audit-agent')).toHaveLength(0);
    expect(recordExecute).not.toHaveBeenCalled();
    expect(result.output).not.toContain('弧审核');
  });

  it('query_arc 未注册（registry 空）→ 弧审 post-settle 整体跳过（graceful）', async () => {
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1)]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    expect(callsForRole('arc-audit-agent')).toHaveLength(0);
    expect(result.output).not.toContain('弧审核');
  });

  // ─── (b) close beat 命中 → 大审派发 + record + 文案 ───

  it('卷弧 close beat → 派 arc-audit 大审（span=beats 区间）→ record_arc_audit 落表 + 文案（defect/deviation/gray 计数）', async () => {
    const allBeats: ArcBeat[] = [
      { id: 'b0', episodeId: 'ep1', episodeIndex: 0, arcRef: 'phase-1', arcKind: 'volume', action: 'advance' },
      volumeCloseBeat('ep2', 1),
    ];
    await registerQueryArc(allBeats);
    await registerQueryArcSummary([]);
    const recordExecute = await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1)]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    // 大审派发一次（closure）
    const arcCalls = callsForRole('arc-audit-agent');
    expect(arcCalls).toHaveLength(1);
    // suggest 档 allowedTools 不含 story_decisions_update（D8 mode-conditional）
    const opts = arcCalls[0][3] as { allowedTools?: string[] };
    expect(opts.allowedTools).toContain('chapter_read');
    expect(opts.allowedTools).not.toContain('story_decisions_update');
    // vars：arcContext 含 phase 结构 + 章清单（span #0-#1 → ep1+ep2）；requirement closure 大审
    const vars = arcCalls[0][2] as Record<string, string>;
    expect(vars.arcContext).toContain('phase-1');
    expect(vars.arcContext).toContain('ep2');
    expect(vars.requirement).toContain('closure');
    // 产物落表一次（closure）
    expect(recordExecute).toHaveBeenCalledTimes(1);
    const [recordParams] = recordExecute.mock.calls[0] as [{ auditKind: string; result: { arcRef: string; span: { fromEpisodeIndex: number } } }];
    expect(recordParams.auditKind).toBe('closure');
    // 机械字段 caller 派生覆写（不信 LLM 回显——content schema 本就无这些字段）
    expect(recordParams.result.arcRef).toBe('phase-1');
    expect(recordParams.result.arcKind).toBe('volume');
    expect(recordParams.result.span.fromEpisodeIndex).toBe(0);
    expect(recordParams.result.span.toEpisodeIndex).toBe(1);
    // 文案：计数 + 三档路由
    expect(result.output).toContain('弧审核');
    expect(result.output).toContain('defect 1/deviation 1/gray 1');
    expect(result.output).toContain('卷摘要已物化');
  });

  it('close beat 但全量 beats 无该弧区间（读窗截断）→ 不假跑，文案告知（永不静默 fail）', async () => {
    // query_arc 只回本章 close beat（该弧早期 beat 被最近窗截断）→ deriveArcSpan 单 beat 区间退化 #1-#1？
    // ——不：单 beat 也可派 span（min=max）。真「无区间」= 全量 beats 里没有该 arcRef 的任何 beat。
    await registerQueryArc([
      { id: 'other', episodeId: 'ep1', episodeIndex: 0, arcRef: 'line-main', arcKind: 'line', action: 'advance' },
    ]);
    const recordExecute = await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1, 'phase-missing')]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    expect(callsForRole('arc-audit-agent')).toHaveLength(0);
    expect(recordExecute).not.toHaveBeenCalled();
    expect(result.output).toContain('不可解析');
  });

  it('大审派发/解析失败 → 文案告知未审（不假 pass，mirror adjudicator graceful）', async () => {
    await registerQueryArc([volumeCloseBeat('ep2', 1)]);
    await registerQueryArcSummary([]);
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'arc-audit-agent') return { content: 'totally not json' };
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      return { content: '{}' };
    });
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1)]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    expect(result.output).toContain('派发/解析失败');
    expect(result.output).toContain('本次未审');
  });

  // ─── (c) 停滞触发 + 防重 ───

  it('活跃弧不误触（线弧末拍距今 1 章 <= N=10）→ 不派专注审（AC4）', async () => {
    // line-side 末拍 ep1(#0)，当前 ep2(#1)——gap 1 不足阈值，即使已有同窗 stagnation 行也不该触发。
    const stagnantBeat: ArcBeat = { id: 's0', episodeId: 'ep1', episodeIndex: 0, arcRef: 'line-side', arcKind: 'line', action: 'advance' };
    await registerQueryArc([stagnantBeat]);
    await registerQueryArcSummary([]);
    const recordExecute = await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    expect(callsForRole('arc-audit-agent')).toHaveLength(0);
    expect(result.output).not.toContain('停滞');
    expect(recordExecute).not.toHaveBeenCalled();
  });

  it('停滞弧新窗（无既有 stagnation 行覆盖）→ 专注审派发 + arcKind line + findings 不产摘要', async () => {
    // 停滞窗：line-side 末拍 ep1(#0)，当前 ep12(#11)——gap 11 > 10 停滞。
    const episodes = Array.from({ length: 13 }, (_, i) => ({ id: `ep${i + 1}`, index: i, title: `第${i + 1}章` }));
    const doc = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(path.join(projectPath, 'project.yaml'), 'utf8')));
    doc.episode_outlines = episodes;
    doc.scene_graph.nodes.push({ id: 's12', episodeId: 'ep12', storyTime: 12, presentationOrder: { chapter: 12, pos: 0 } });
    await import('node:fs').then((fs) => fs.writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8'));

    const stagnantBeat: ArcBeat = { id: 's0', episodeId: 'ep1', episodeIndex: 0, arcRef: 'line-side', arcKind: 'line', action: 'advance' };
    await registerQueryArc([stagnantBeat]);
    await registerQueryArcSummary([]);
    const recordExecute = await registerRecordArcAudit();
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      if (role === 'arc-audit-agent') {
        // 停滞专注审输出：无 arcSummary（该弧未完，摘要无终态语义）
        return {
          content: JSON.stringify({
            findings: [
              {
                category: 'arc-drift',
                route: 'defect',
                verdict: 'stalled',
                entityId: 'line-side',
                entityLabel: '密信支线',
                quote: '信还在怀里。',
                location: '第1章段3',
                explanation: '12 章无推进，非铺垫是遗忘',
                suggestedFix: '下章安排密信揭露',
              },
            ],
            degraded: false,
          }),
        };
      }
      return { content: '{}' };
    });
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep12', chapterBrief: { goal: 'g' } }, ctx);

    const arcCalls = callsForRole('arc-audit-agent');
    expect(arcCalls).toHaveLength(1);
    const vars = arcCalls[0][2] as Record<string, string>;
    expect(vars.requirement).toContain('stagnation');
    expect(vars.requirement).toContain('已连续 11 章无新节拍');
    // 落表：stagnation + arcKind line（storage enum——growth/线停滞弧均落 line 语义）
    expect(recordExecute).toHaveBeenCalledTimes(1);
    const [recordParams] = recordExecute.mock.calls[0] as [{ auditKind: string; result: { arcKind: string; arcSummary?: unknown } }];
    expect(recordParams.auditKind).toBe('stagnation');
    expect(recordParams.result.arcKind).toBe('line');
    expect(recordParams.result.arcSummary).toBeUndefined();
    expect(result.output).toContain('停滞弧「line-side」专注审完成');
    expect(result.output).toContain('stalled');
  });

  it('growth 弧停滞 → 专注审 arcKind 诚实标注 growth（终审 F2：不落 line 错标）', async () => {
    // 停滞窗：growth:char-1 末拍 ep1(#0)，当前 ep12(#11)——gap 11 > 10 停滞；growth 弧参与停滞检测（角色弧停滞）。
    const episodes = Array.from({ length: 13 }, (_, i) => ({ id: `ep${i + 1}`, index: i, title: `第${i + 1}章` }));
    const doc = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(path.join(projectPath, 'project.yaml'), 'utf8')));
    doc.episode_outlines = episodes;
    doc.scene_graph.nodes.push({ id: 's12', episodeId: 'ep12', storyTime: 12, presentationOrder: { chapter: 12, pos: 0 } });
    await import('node:fs').then((fs) => fs.writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8'));

    const stagnantBeat: ArcBeat = { id: 'g0', episodeId: 'ep1', episodeIndex: 0, arcRef: 'growth:char-1', arcKind: 'growth', action: 'advance' };
    await registerQueryArc([stagnantBeat]);
    await registerQueryArcSummary([]);
    const recordExecute = await registerRecordArcAudit();
    runAgentWithExplicitSystem.mockImplementation(async (_sid: string, role: string) => {
      if (role === 'director-agent') return { content: JSON.stringify({ infoRelease: [], emotionPoints: [] }) };
      if (role === 'arc-audit-agent') return { content: JSON.stringify({ findings: [], degraded: false }) };
      return { content: '{}' };
    });
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep12', chapterBrief: { goal: 'g' } }, ctx);

    expect(recordExecute).toHaveBeenCalledTimes(1);
    const [recordParams] = recordExecute.mock.calls[0] as [{ auditKind: string; result: { arcRef: string; arcKind: string } }];
    expect(recordParams.auditKind).toBe('stagnation');
    expect(recordParams.result.arcRef).toBe('growth:char-1');
    expect(recordParams.result.arcKind).toBe('growth');
    // arcContext 结构段：growth 分支带 characterId（前缀剥离），不查 scene_graph lines
    const vars = callsForRole('arc-audit-agent')[0][2] as Record<string, string>;
    expect(vars.arcContext).toContain('"characterId":"char-1"');
  });

  it('停滞弧同窗已审（toEpisodeIndex >= lastBeatEpisodeIndex）→ 防重跳过（每章不重派）', async () => {
    const episodes = Array.from({ length: 13 }, (_, i) => ({ id: `ep${i + 1}`, index: i, title: `第${i + 1}章` }));
    const doc = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(path.join(projectPath, 'project.yaml'), 'utf8')));
    doc.episode_outlines = episodes;
    doc.scene_graph.nodes.push({ id: 's12', episodeId: 'ep12', storyTime: 12, presentationOrder: { chapter: 12, pos: 0 } });
    await import('node:fs').then((fs) => fs.writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8'));

    const stagnantBeat: ArcBeat = { id: 's0', episodeId: 'ep1', episodeIndex: 0, arcRef: 'line-side', arcKind: 'line', action: 'advance' };
    await registerQueryArc([stagnantBeat]);
    // 既有 stagnation 行：toEpisodeIndex=0 >= lastBeatEpisodeIndex=0 → 同窗已审
    await registerQueryArcSummary([
      {
        arcRef: 'line-side',
        arcKind: 'line',
        auditKind: 'stagnation',
        fromEpisodeIndex: 0,
        toEpisodeIndex: 0,
        result: { findings: [], degraded: false },
        tokenEstimate: 10,
        producedAt: '2026-08-17T00:00:00Z',
      },
    ]);
    const recordExecute = await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep12', chapterBrief: { goal: 'g' } }, ctx);

    expect(callsForRole('arc-audit-agent')).toHaveLength(0);
    expect(recordExecute).not.toHaveBeenCalled();
    expect(result.output).not.toContain('专注审完成');
  });

  // ─── (d) 三档路由文案分支 ───

  it('suggest 档 deviation → 不登记只 surface「建议登记的决策」；gray → 裁决器附弧上下文（arcContext var）', async () => {
    await registerQueryArc([volumeCloseBeat('ep2', 1)]);
    await registerQueryArcSummary([]);
    await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1)]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    // deviation suggest 档：建议登记的决策（不产 envelope 不程序化登记）
    expect(result.output).toContain('建议登记的决策');
    // gray：裁决器派发一次（弧语境）+ arcContext 含 synopsis + grayFindings
    const adjudicatorCalls = callsForRole('adjudicator-agent');
    expect(adjudicatorCalls).toHaveLength(1);
    const vars = adjudicatorCalls[0][2] as Record<string, string>;
    expect(vars.arcContext).toContain('arcSynopsis');
    expect(vars.arcContext).toContain('grayFindings');
    expect(vars.arcContext).toContain('支线：密信');
    // 裁决器建议呈现
    expect(result.output).toContain('弧语境裁决器初审');
    expect(result.output).toContain('压抑期是铺垫');
    // defect surface
    expect(result.output).toContain('卷 climax 落定仓促');
  });

  it('auto 档 → allowedTools 含 story_decisions_update（deviation 审内登记授权）+ 文案注明', async () => {
    setSession('auto');
    await registerQueryArc([volumeCloseBeat('ep2', 1)]);
    await registerQueryArcSummary([]);
    await registerRecordArcAudit();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([volumeCloseBeat('ep2', 1)]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    const result = await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    const arcCalls = callsForRole('arc-audit-agent');
    expect(arcCalls).toHaveLength(1);
    const opts = arcCalls[0][3] as { allowedTools?: string[] };
    expect(opts.allowedTools).toContain('story_decisions_update');
    const vars = arcCalls[0][2] as Record<string, string>;
    expect(vars.requirement).toContain('autoApply=true');
    expect(result.output).toContain('已被授权审内登记');
  });

  // ─── (e) formatArcFeedback 投影（Director 反哺）───

  it('Director vars 含 arcFeedback（最近弧审 findings 投影，mirror completenessFeedback）', async () => {
    await registerQueryArc([]);
    await registerQueryArcSummary([
      {
        arcRef: 'phase-1',
        arcKind: 'volume',
        auditKind: 'closure',
        fromEpisodeIndex: 0,
        toEpisodeIndex: 1,
        result: {
          findings: [
            {
              category: 'volume-arc',
              route: 'defect',
              verdict: 'under-developed',
              entityId: 'phase-1',
              entityLabel: '第一卷卷弧',
              quote: 'q',
              location: 'l',
              explanation: 'e',
              suggestedFix: '下卷补反派视角',
            },
          ],
          degraded: false,
        },
        tokenEstimate: 10,
        producedAt: '2026-08-17T01:00:00Z',
      },
    ]);
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    const directorCalls = callsForRole('director-agent');
    expect(directorCalls).toHaveLength(1);
    const vars = directorCalls[0][2] as Record<string, string>;
    // arcFeedback = findings JSON 数组（纯机械投影）
    expect(vars.arcFeedback).toContain('volume-arc');
    expect(vars.arcFeedback).toContain('下卷补反派视角');
  });

  it('无弧审 → arcFeedback 空串（Director 照常规划，零回归）', async () => {
    await registerQueryArc([]);
    await registerQueryArcSummary([]);
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    const directorCalls = callsForRole('director-agent');
    const vars = directorCalls[0][2] as Record<string, string>;
    expect(vars.arcFeedback).toBe('');
  });

  // ─── (f) arcSnapshot 注入与空降级 ───

  it('有卷弧摘要 → initialArtifacts["arc_snapshot"] 注入（4.4 长程视野）；无 → 不注入（空降级）', async () => {
    await registerQueryArc([]);
    await registerQueryArcSummary([
      {
        arcRef: 'phase-1',
        arcKind: 'volume',
        auditKind: 'closure',
        fromEpisodeIndex: 0,
        toEpisodeIndex: 1,
        result: {
          arcSummary: { synopsis: '第一卷梗概', lineSections: [{ lineId: 'line-main', name: '主线', summary: 's' }], openThreads: ['t1'] },
          findings: [],
          degraded: false,
        },
        tokenEstimate: 10,
        producedAt: '2026-08-17T01:00:00Z',
      },
    ]);
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    const { writeChapterTool } = await import('../src/tool/write-chapter');

    await writeChapterTool.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);

    const [, artifacts] = runChapterChain.mock.calls[0] as [string, Record<string, unknown>];
    expect(artifacts['arc_snapshot']).toBeDefined();
    const snapshot = artifacts['arc_snapshot'] as string;
    expect(snapshot).toContain('第一卷梗概');
    expect(snapshot).toContain('lineSections');
    expect(snapshot).toContain('openThreads');
    // outline_phases 同批注入（arc-emergence 卷弧候选）
    expect(artifacts['outline_phases']).toBeDefined();

    // 空降级：无 query_arc_summary → 不注入
    runChapterChain.mockReset();
    runChapterChain.mockResolvedValueOnce(makeAcceptSummary([]));
    vi.resetModules();
    // registry 是模块级单例，resetModules 后重新注册空 query_arc_summary。
    const { registry } = await import('../src/tool/registry');
    registry.register({
      id: 'query_arc',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return { title: 'mock', output: '', metadata: { ok: true, beatCount: 0, beats: [], truncated: false } };
      },
    });
    registry.register({
      id: 'query_arc_summary',
      description: 'mock',
      parameters: z.object({}),
      async execute() {
        return { title: 'mock', output: '', metadata: { ok: true, count: 0, summaries: [] } };
      },
    });
    const { writeChapterTool: tool2 } = await import('../src/tool/write-chapter');
    await tool2.execute({ episodeId: 'ep2', chapterBrief: { goal: 'g' } }, ctx);
    const [, artifacts2] = runChapterChain.mock.calls[0] as [string, Record<string, unknown>];
    expect(artifacts2['arc_snapshot']).toBeUndefined();
  });
});
