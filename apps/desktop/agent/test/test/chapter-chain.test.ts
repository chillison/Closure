import { describe, expect, it, vi } from 'vitest';
import {
  createChapterChainNodes,
  CHAPTER_CHAIN_NODE_IDS,
  CHAPTER_CHAIN_REVISION_LOOP,
} from '../src/nodes/chapter-chain';
import type { GenerateFn } from '../src/nodes/llm-node';
import type { SessionState } from '../src/types';
import type { RunSnapshot } from '../src/contracts/run';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4 / implement.md 5.5：createChapterChainNodes 装配测试。
//
// 核心断言（dispatch 5.5 列表）：
// 1. 返回正确链序（6 节点 id 序 = [brief-compiler, draft-writer, storySync,
//    targeted-revision, multi-review, route]）—— 切片约束（from<=through）。
// 2. revisionLoop 配置 {from:'targeted-revision-agent', through:'route-agent', cap:3}。
// 3. revisionLoop.from index <= through index（chainRunner 切片约束满足）。
// 4. 每节点 contract 形态正确（requiredArtifactKeys / producedArtifactKeys）。
// 5. targeted-revision skip 首跑（无 review.latest → pass-through draft.initial，不调 generate）。
// 6. targeted-revision overwrite 闭环（有 review.latest → 改稿 overwrite draft.initial）。
// 7. storySync 读 draft.initial + foreshadow_registry 新 key（5.1c 对齐）。
// ─────────────────────────────────────────────────────────────────────────────

const noopGenerate = vi.fn<GenerateFn>(async () => ({ content: '{}', finishReason: 'stop' }));

function makeSession(): SessionState {
  return {
    id: 'sess_chain',
    agentName: 'chapter-chain',
    projectPath: '/test/project',
    status: 'idle',
    messages: [],
    children: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeRun(artifacts: Record<string, unknown>): RunSnapshot {
  return {
    runId: 'run_chain',
    status: 'running',
    currentNodeId: null,
    projectPath: '/test',
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1-3. 链序 + revisionLoop 配置
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — 链序 + revisionLoop', () => {
  it('返回 22 节点，id 序含 revision-guard（draft 紧后）+ lint-node（revision-guard 紧后，C1.2）+ 5 轴 world-extractor + world-merge + emotion-verify + promise-emergence + arc-emergence + chapter-summary + storytime-drift + mention-ledger（draft 后、storySync 前）+ completeness-verify（route 后）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    expect(chain.map((c) => c.id)).toEqual([...CHAPTER_CHAIN_NODE_IDS]);
    expect(chain).toHaveLength(22);
    // 5 轮 world-extractor 紧随 draft-writer（design §6：draft 后挂提取器，物理串行）
    const ids = chain.map((c) => c.id);
    const axes = ['physical', 'cognitive', 'emotional', 'relational', 'factional'];
    for (const axis of axes) {
      expect(ids).toContain(`world-extractor-${axis}`);
    }
    // 5 轴提取器紧随 revision-guard 之后（Story 7.2：revision-guard 紧随 draft-writer）
    const guardIdx = ids.indexOf('revision-guard-agent');
    expect(guardIdx).toBe(ids.indexOf('draft-writer-agent') + 1);
    // C1.2：lint-node 紧随 revision-guard（design §3.1——draft.initial 在 revision-guard splice 后落定，
    // lint 扫的是终版章正文；world-extractor 前不影响五轴）
    expect(ids[guardIdx + 1]).toBe('lint-node');
    expect(ids.slice(guardIdx + 2, guardIdx + 7)).toEqual([
      'world-extractor-physical',
      'world-extractor-cognitive',
      'world-extractor-emotional',
      'world-extractor-relational',
      'world-extractor-factional',
    ]);
    // world-merge 紧随 5 轴提取器
    expect(ids.indexOf('world-merge-node')).toBe(ids.indexOf('world-extractor-factional') + 1);
    // Story 5.3：emotion-verify 紧随 world-merge（emotional patches 写 db 后消费，design §3）
    expect(ids.indexOf('emotion-verify-node')).toBe(ids.indexOf('world-merge-node') + 1);
    // Story 6.5：promise-emergence 紧随 emotion-verify（emergence 读 payoff 联动须在 verify 后，design §3）
    expect(ids.indexOf('promise-emergence-node')).toBe(ids.indexOf('emotion-verify-node') + 1);
    // Story 8.2：arc-emergence 紧随 promise-emergence（同「涌现登记」家族，revision 闭环外；与 promise
    // 认知任务不同故独立节点，design §7）
    expect(ids.indexOf('arc-emergence-node')).toBe(ids.indexOf('promise-emergence-node') + 1);
    // Story 8.1：chapter-summary 紧随 arc-emergence（summary 伏笔字段取数须在 promise_registry 写后新鲜，
    // design §2 链位理由）
    expect(ids.indexOf('chapter-summary-node')).toBe(ids.indexOf('arc-emergence-node') + 1);
    // Story 8.4 C2：storytime-drift 紧随 chapter-summary（design §3.3「chapter-summary 链位旁」——同属
    // 提取落表后机械观测族；world_state.events 输入自 world-merge 已产）
    expect(ids.indexOf('storytime-drift-node')).toBe(ids.indexOf('chapter-summary-node') + 1);
    // Story 8.7 S8：mention-ledger 紧随 storytime-drift（design §2.2 链位：chapter-summary 物化后
    // ——synopsis 回填前提；storySync 前）
    expect(ids.indexOf('mention-ledger-node')).toBe(ids.indexOf('storytime-drift-node') + 1);
    // storySync 在 mention-ledger 之后（物化+守卫+记账先于 prose 同步）
    expect(ids.indexOf('story-sync-agent')).toBe(ids.indexOf('mention-ledger-node') + 1);
    // BMad CR-001/002 fix：completeness-verify 在 route 前（multi-review 后）——原 route 后 through-break 不可达。
    expect(ids.indexOf('completeness-verify-node')).toBe(ids.indexOf('multi-review-agent') + 1);
    // Story 7.4 + CR-001 fix：feedback-ledger 紧随 completeness-verify（route 前，原 route 后不可达）
    expect(ids.indexOf('feedback-ledger-node')).toBe(ids.indexOf('completeness-verify-node') + 1);
    // route-agent 是末节点（through 节点放链尾，pre-route 节点在 through-break 前跑完）
    expect(ids[ids.length - 1]).toBe('route-agent');
  });

  it('revisionLoop 配置 = {from:targeted-revision-agent, through:route-agent, cap:3}', () => {
    expect(CHAPTER_CHAIN_REVISION_LOOP).toEqual({
      from: 'targeted-revision-agent',
      through: 'route-agent',
      cap: 3,
    });
  });

  it('revisionLoop.from index <= through index（chainRunner 切片约束 [13..17]）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ids = chain.map((c) => c.id);
    const fromIdx = ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.from);
    const throughIdx = ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.through);
    expect(fromIdx).toBeGreaterThanOrEqual(0);
    expect(throughIdx).toBeGreaterThan(fromIdx);
    // BMad CR-001/002 fix 后切片体含 completeness-verify + feedback-ledger（移 route 前）：
    // [targeted-revision, multi-review, completeness-verify, feedback-ledger, route]
    expect(ids.slice(fromIdx, throughIdx + 1)).toEqual([
      'targeted-revision-agent',
      'multi-review-agent',
      'completeness-verify-node',
      'feedback-ledger-node',
      'route-agent',
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 节点契约形态
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — 节点契约', () => {
  it('每节点带 contract（非 null）+ 唯一 nodeId', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const nodeIds = chain.map((c) => c.node.contract?.nodeId);
    for (const def of chain) {
      expect(def.node.contract).not.toBeNull();
    }
    // 唯一 nodeId（链内唯一标识）
    expect(new Set(nodeIds).size).toBe(22);
  });

  it('brief-compiler 读 chapter_brief_input+scene_graph → owns chapter_brief', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const brief = chain.find((c) => c.id === 'brief-compiler-node')!;
    expect(brief.node.contract?.producedArtifactKeys).toContain('chapter_brief');
    expect(brief.node.contract?.requiredArtifactKeys).toEqual(['chapter_brief_input', 'scene_graph']);
  });

  it('draft-writer 读 chapter_brief+scene_graph+settings_context → owns draft.initial', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const dw = chain.find((c) => c.id === 'draft-writer-agent')!;
    // Story 8.4 A2/A9：draft-writer 位换 createWriterNode（节点内两阶段 agent 循环）。research_brief 是
    // may-produce（自查成功/复用时 mutate 写；降级路径写 degraded 形态——mirror revision_guard 先例）。
    // Story 8.7 S7：cast_declaration 加入（阶段 2.5 申报轮 mutate 写；降级直写/段落级路径不写）。
    expect(dw.node.contract?.producedArtifactKeys).toEqual(['draft.initial', 'research_brief', 'cast_declaration']);
  });

  it('Story 7.2：revision-guard 读 draft.initial → owns draft.initial + revision_guard + checkpointStage=revision-guard', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const guard = chain.find((c) => c.id === 'revision-guard-agent')!;
    expect(guard.checkpointStage).toBe('revision-guard');
    expect(guard.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    // clean splice 落 draft.initial（下游主读）+ guard 报告 revision_guard（mutate 写）。
    expect(guard.node.contract?.producedArtifactKeys).toEqual(['draft.initial', 'revision_guard']);
    expect(guard.node.contract?.sideEffects).toContain('call_model');
  });

  it('C1.2：lint-node 读 draft.initial → owns lint_report + 无 checkpointStage + 纯代码零副作用（design §3.1）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ln = chain.find((c) => c.id === 'lint-node')!;
    expect(ln).toBeDefined();
    expect(ln.checkpointStage).toBeUndefined(); // 链外增强节点，mirror emotion-verify 不触发 checkpoint
    // draft.initial 必填门（lint 扫终版正文；链位上 revision-guard 恒先产）。
    expect(ln.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(ln.node.contract?.producedArtifactKeys).toEqual(['lint_report']);
    // 纯代码扫描零副作用（无 LLM / 无 db / 无文件写——终稿账归 post-settle lintLedger）。
    expect(ln.node.contract?.sideEffects).toEqual([]);
  });

  it('world-extractor 读 draft.initial+scene_graph → owns world_events.<axis>（6.6 Phase C1/C2，5 轴）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const axes = ['physical', 'cognitive', 'emotional', 'relational', 'factional'];
    for (const axis of axes) {
      const node = chain.find((c) => c.id === `world-extractor-${axis}`)!;
      expect(node).toBeDefined();
      expect(node.node.contract?.nodeId).toBe(`world-extractor-${axis}`);
      expect(node.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
      expect(node.node.contract?.producedArtifactKeys).toEqual([`world_events.${axis}`]);
      expect(node.node.contract?.sideEffects).toContain('call_model');
    }
  });

  it('world-merge 读 5 轴 world_events → owns world_state.events（6.6 Phase C2，5 轴 required）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const wm = chain.find((c) => c.id === 'world-merge-node')!;
    expect(wm.node.contract?.requiredArtifactKeys).toEqual([
      'world_events.physical',
      'world_events.cognitive',
      'world_events.emotional',
      'world_events.relational',
      'world_events.factional',
    ]);
    expect(wm.node.contract?.producedArtifactKeys).toEqual(['world_state.events']);
  });

  it('Story 8.1：chapter-summary requiredArtifactKeys=[] → owns chapter_summary_result + 无 checkpointStage（链外增强节点）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const cs = chain.find((c) => c.id === 'chapter-summary-node')!;
    expect(cs.checkpointStage).toBeUndefined(); // mirror emotion-verify / feedback-ledger 不触发 checkpoint
    // graceful：requiredArtifactKeys=[]——chapter_brief_input 缺 / episodeId 缺不阻断链。
    expect(cs.node.contract?.requiredArtifactKeys).toEqual([]);
    expect(cs.node.contract?.producedArtifactKeys).toEqual(['chapter_summary_result']);
    // 写 closure_chapter_summary / checkpoint 派生表（DB 副作用，mirror world-merge）。
    expect(cs.node.contract?.sideEffects).toContain('persist_artifact');
  });

  it('Story 8.4 C2：storytime-drift requiredArtifactKeys=[] → owns storytime_drift + 无 checkpointStage + 无副作用（链外观测节点）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const sd = chain.find((c) => c.id === 'storytime-drift-node')!;
    expect(sd.checkpointStage).toBeUndefined(); // mirror chapter-summary 不触发 checkpoint
    // graceful：requiredArtifactKeys=[]——episodeId 缺 / world_state.events 缺不阻断链。
    expect(sd.node.contract?.requiredArtifactKeys).toEqual([]);
    expect(sd.node.contract?.producedArtifactKeys).toEqual(['storytime_drift']);
    // 纯观测节点无副作用（不写 db / 不调 LLM）。
    expect(sd.node.contract?.sideEffects).toEqual([]);
    // 链位：chapter-summary 紧后（design §3.3）+ route（through）之前（through-break 可达性）。
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf('storytime-drift-node')).toBe(ids.indexOf('chapter-summary-node') + 1);
    expect(ids.indexOf('storytime-drift-node')).toBeLessThan(ids.indexOf('route-agent'));
  });

  it('Story 8.7 S8：mention-ledger 读 draft.initial+scene_graph → owns mention_signals + persist_artifact + 无 checkpointStage（链外增强节点，切片外）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ml = chain.find((c) => c.id === 'mention-ledger-node')!;
    expect(ml).toBeDefined();
    expect(ml.checkpointStage).toBeUndefined(); // mirror chapter-summary 不触发 checkpoint
    // dispatch 指定：draft.initial（粗筛源）+ scene_graph（计划对拍源）硬依赖；chapter_brief_input 读
    // episodeId（optional 消费，不列 required——缺则跳过记账不阻断链）。
    expect(ml.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
    expect(ml.node.contract?.producedArtifactKeys).toEqual(['mention_signals']);
    // 链上写节点（写 closure_mention + synopsis 回填），mirror chapter-summary sideEffects。
    expect(ml.node.contract?.sideEffects).toContain('persist_artifact');
    // revision loop 切片外（auto_revise 闭环重跑不重复记账；redo 重跑 per-episode 全量替换幂等）。
    const ids = chain.map((c) => c.id);
    expect(ids.indexOf('mention-ledger-node')).toBeLessThan(ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.from));
  });

  it('Story 8.2：arc-emergence 读 draft.initial+scene_graph → owns arc_emergence + 无 checkpointStage（链外增强节点，切片外）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const arc = chain.find((c) => c.id === 'arc-emergence-node')!;
    expect(arc.checkpointStage).toBeUndefined(); // mirror promise-emergence 不触发 checkpoint
    expect(arc.node.contract?.requiredArtifactKeys).toEqual(['draft.initial', 'scene_graph']);
    expect(arc.node.contract?.producedArtifactKeys).toEqual(['arc_emergence']);
    // 经 arc_ledger_update builtin 写 arc_registry creative field（autoApply 直落）。
    expect(arc.node.contract?.sideEffects).toContain('persist_artifact');
    // revision loop 切片外（auto_revise 闭环重跑不重复登记；redo 重跑幂等覆盖）。
    const ids = chain.map((c) => c.id);
    const arcIdx = ids.indexOf('arc-emergence-node');
    expect(arcIdx).toBeLessThan(ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.from));
  });

  it('Story 8.1：chapter-summary-node 在 revision loop 切片外（auto_revise 闭环重跑不重复物化）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ids = chain.map((c) => c.id);
    const fromIdx = ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.from);
    const throughIdx = ids.indexOf(CHAPTER_CHAIN_REVISION_LOOP.through);
    const csIdx = ids.indexOf('chapter-summary-node');
    expect(csIdx).toBeGreaterThanOrEqual(0);
    expect(csIdx).toBeLessThan(fromIdx); // 切片 [from..through] 之前 → loop 重跑不触达
    expect(csIdx).toBeLessThan(throughIdx);
  });

  it('storySync 读 draft.initial → owns story.sync（5.1c 单源对齐）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ss = chain.find((c) => c.id === 'story-sync-agent')!;
    expect(ss.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(ss.node.contract?.producedArtifactKeys).toEqual(['story.sync']);
  });

  it('targeted-revision 读 draft.initial → owns draft.initial（5.1b overwrite，无 review.latest required）', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const tr = chain.find((c) => c.id === 'targeted-revision-agent')!;
    expect(tr.node.contract?.requiredArtifactKeys).toEqual(['draft.initial']);
    expect(tr.node.contract?.producedArtifactKeys).toEqual(['draft.initial']);
    // 关键：review.latest 不在 required（首跑无 review.latest 不 blocked）
    expect(tr.node.contract?.requiredArtifactKeys).not.toContain('review.latest');
  });

  it('route 读 review.latest+chapter_brief+draft.initial → owns route_decision', () => {
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const rt = chain.find((c) => c.id === 'route-agent')!;
    expect(rt.node.contract?.producedArtifactKeys).toEqual(['route_decision']);
    expect(rt.node.contract?.requiredArtifactKeys).toEqual(['review.latest', 'chapter_brief', 'draft.initial']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5-6. targeted-revision skip / overwrite（链装配后行为）
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — targeted-revision skip / overwrite（链内行为）', () => {
  it('首跑无 review.latest → skip（pass-through draft.initial，不调 generate）', async () => {
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify({ title: 't', text: 'x', wordCount: 1 }),
      finishReason: 'stop',
    }));
    const chain = createChapterChainNodes(generate, undefined, makeSession());
    const tr = chain.find((c) => c.id === 'targeted-revision-agent')!;

    const initialDraft = { title: '初稿', text: '原稿', wordCount: 100, chapterId: 'ch_1' };
    const result = await tr.node.run({
      run: makeRun({ 'draft.initial': initialDraft }), // 无 review.latest（链首跑态）
      requirement: '',
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toBe(initialDraft); // pass-through 原对象
  });

  it('闭环重跑（有 review.latest）→ 改稿 overwrite draft.initial', async () => {
    const revised = { title: '修订', text: '修订正文', wordCount: 200, chapterId: 'ch_1', revisionNotes: ['补动机'] };
    const generate = vi.fn<GenerateFn>(async () => ({
      content: JSON.stringify(revised),
      finishReason: 'stop',
    }));
    const chain = createChapterChainNodes(generate, undefined, makeSession());
    const tr = chain.find((c) => c.id === 'targeted-revision-agent')!;

    const result = await tr.node.run({
      run: makeRun({
        'draft.initial': { title: '初稿', text: '原稿', wordCount: 100 },
        'review.latest': { verdict: 'revise', reasons: ['动机不足'] }, // 闭环态
      }),
      requirement: '',
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.stateKey).toBe('draft.initial');
    expect(result.artifact).toEqual(revised);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. storySync 新 key（5.1c 对齐）+ Story 6.5 收缩（foreshadow 提取移除）
// ════════════════════════════════════════════════════════════════════════════

describe('createChapterChainNodes — storySync 读 draft.initial（6.5 收缩：foreshadow 提取移除）', () => {
  it('读 draft.initial.text → 产 story.sync（rules 现无提取，patches 空——CR-E7 防线）', async () => {
    // Story 6.5：foreshadow prose 提取已移除（design §10 D10 / AC7）。旧「铜钥匙命中 foreshadow_registry
    // merge patch」随 foreshadow_registry → promise_registry 改名 + Promise 走涌现节点废弃。story-sync rules
    // 现返空 patches（promise_registry 不进 story-sync，走 promise-emergence-node LLM 涌现登记）。
    const chain = createChapterChainNodes(noopGenerate, undefined, makeSession());
    const ss = chain.find((c) => c.id === 'story-sync-agent')!;

    const result = await ss.node.run({
      run: makeRun({
        'draft.initial': { chapterId: 'ch_1', text: '他取出一把铜钥匙。' },
      }),
      requirement: '',
    });

    expect(result.stateKey).toBe('story.sync');
    const artifact = result.artifact as { patches: unknown[] };
    // rules 收缩后无提取规则 → patches 空（铜钥匙不再命中任何 patch）。
    expect(artifact.patches).toEqual([]);
  });
});
