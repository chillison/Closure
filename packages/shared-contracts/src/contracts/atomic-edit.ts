// ── Story 7.3 原子编辑词汇（child3 R2 / PLOTTER Table 8）──
//
// 结构修订用 5 个标准原子操作（加桥段/加悬念/加伏笔/插反转/改事件）表达，使修订结构化、可追踪。
// 范式判据（ADR-3 / .trellis/spec/core/creative-vs-mechanical.md）：
//   - 原子操作**执行**（图操作展开 + 约束校验）= 纯代码（expandAtomicEditOp / validateAtomicEditOps）；
//   - 编辑**提议**（哪个 issue 用哪个操作 + 目标参数 + 创作判断）= LLM Director（director-agent.yaml 重规划段）。
// 纯代码只做机械展开 + 图约束校验（DAG/reachability/dangling），**绝不判**「这个反转/桥段合理吗」——归 Director。
//
// 🔑 设计决断（code reality 驱动，design §1）：
//   5 操作是 schema 层**复合宏**，expander 展开成既有 SceneGraphAction/PromiseAction bounded primitives，
//   喂既有 applySceneGraphActions/applyPromiseActions（projector 零改）→ 既有 handler 落地（零新 IPC/写工具）。
//   完全 mirror Story 1.7 expandForkBranch（图操作 intent → 纯代码 expander → bounded actions 批次）。
//
// 5 操作改**结构化数据**（scene_graph / promise_registry 创作字段），**不改正文 prose**。
// prose 重生成 + isomorphic-git 落地 + 护栏联动 = Story 7.4 范围（design §5）。

import { z } from 'zod';
import type {
  PromiseAction,
  PromiseRegistry,
  SceneGraph,
  SceneGraphAction,
} from './creative-fields';
import {
  promiseActionSchema,
  promiseBeatKindSchema,
  promiseRegistrySchema,
  sceneGraphActionSchema,
  sceneGraphSchema,
  sceneNodeSchema,
} from './creative-fields';
import {
  applySceneGraphActions,
  validateSceneGraph,
  type SceneGraphIssue,
} from './scene-graph-analytics';

// ── 共用 partial shape（复用既有 schema，保持 single source of truth）──
//
// sceneNodeSchema 的写入 partial：id 必填（语义命名），其余 optional。直接复用既有 sceneNodeSchema
// （export const，creative-fields:1489），与 sceneGraphActionSchema add_scene/update_scene 分支同形
// （sceneNodeSchema.partial().required({ id: true })）。零重复声明。
const sceneNodeWritePartial = sceneNodeSchema.partial().required({ id: true });

// ── 5 原子操作 schema（discriminated union by `op`）──
//
// 每 op 的 params 来自 PLOTTER Table 8（planning-graph-emotion design §2.2:226-230）+ design §2 创作语义。
// 字段语义（非机械结构）由 LLM Director 定（哪个节点、埋在哪场、桥段内容），expander 只机械展开。

const _atomicEditOpSchemaRaw = z.discriminatedUnion('op', [
  // 加桥段（修断裂）：A 线到 B 线中间断了，补一个桥节点 + 因果边连上。最常用叙事完整性修复。
  z.object({
    op: z.literal('add_plot_bridge'),
    between: z.object({
      fromSceneId: z.string().min(1),
      toSceneId: z.string().min(1),
    }),
    bridgeScene: sceneNodeWritePartial,
    causality: z.enum(['forward', 'flashback']).optional(),
  }),
  // 加悬念线索：某段太平，插一个悬而未决的线索钩子。SUSPENSE 边入因果 DAG。
  z.object({
    op: z.literal('add_suspense'),
    atSceneId: z.string().min(1),
    suspenseScene: sceneNodeWritePartial.optional(),
    resolveTowardsSceneId: z.string().min(1),
  }),
  // 加伏笔：后面有兑现但前面没埋。补一条 Promise + plant beat 在前场景。promise ledger（6.5）头号用例。
  z.object({
    op: z.literal('add_foreshadow'),
    promise: z.object({
      id: z.string().min(1),
      title: z.string().min(1).max(200),
      summary: z.string().min(1),
      payoffExpectation: z.string().optional(),
      category: z.string().min(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      deadlineEpisodeId: z.string().min(1).optional(),
    }),
    plantBeatSceneId: z.string().min(1),
    payoffBeatSceneId: z.string().min(1),
    // CR-002：plant==payoff 同场碰撞在 schema 顶层 refine 检（见 atomicEditOpSchema 顶层 refine，非 member 层——
    // member 层 .refine 返 ZodEffects 破 discriminatedUnion 推断 → expandAtomicEditOp switch 失穷尽性）。
  }),
  // 插反转：太平直没转折，在某节点后插反转节点 + 改后续因果指向。第二幕转折/中点反转常用。
  z.object({
    op: z.literal('insert_twist'),
    afterSceneId: z.string().min(1),
    twistScene: sceneNodeWritePartial,
    rewireEdgesTo: z.array(z.string().min(1)).default([]),
  }),
  // 改现有事件：节点动机弱/关系不合理（Reader-Audit Motive-Weak）。改语义字段，不删不增节点。最外科手术。
  z.object({
    op: z.literal('revise_event'),
    sceneId: z.string().min(1),
    patch: sceneNodeWritePartial,
  }),
]);
// CR-002：顶层 refine 检 add_foreshadow plant≠payoff（member 层 .refine 会破 discriminatedUnion 推断，
// 致 expandAtomicEditOp switch 失穷尽性——顶层 refine 不改 z.infer 类型，保 switch 穷尽）。
// plant==payoff 同场时两 beat 同 `${promiseId}::${sceneRef}` 自然键（creative-fields.ts:581 normalizeBeat），
// upsertBeat 全量覆盖 → plant 被 payoff 覆盖，Promise 瞬间 paid_off、plant 丢失。创作上埋即兑现=没埋。
export const atomicEditOpSchema = _atomicEditOpSchemaRaw.refine(
  (op) => op.op !== 'add_foreshadow' || op.plantBeatSceneId !== op.payoffBeatSceneId,
  {
    message: 'add_foreshadow: plantBeatSceneId 与 payoffBeatSceneId 不能同场（同场则 plant 被 payoff 自然键覆盖，Promise 瞬间 paid_off）',
    path: ['payoffBeatSceneId'],
  },
);
export type AtomicEditOp = z.infer<typeof atomicEditOpSchema>;

// ── AtomicEditProposal（Director 输出契约）──
//
// Director 对 Reader-Audit findings 产提议：用哪个 op + 目标参数 + 来源 issue 关联 + 创作理由 + 预期效果。
// sourceIssueRef / rationale / predictedEffect 是创作语义说明（归 LLM），expander/validator 不消费它们。

export const atomicEditProposalSchema = z.object({
  op: atomicEditOpSchema,
  /** 关联的 Reader-Audit finding（issue id / 维度/类型描述），审计追溯用。optional——人直接提议时无。 */
  sourceIssueRef: z.string().min(1).optional(),
  /** 创作理由：为什么这个 issue 该用这个操作（LLM 创作判断说明）。 */
  rationale: z.string().min(1),
  /** 预期效果：操作后叙事结构预期改善（LLM 预判，供人审参考）。optional。 */
  predictedEffect: z.string().min(1).optional(),
});
export type AtomicEditProposal = z.infer<typeof atomicEditProposalSchema>;

// ── expandAtomicEditOp（纯代码 expander，mirror expandForkBranch）──
//
// 图操作 intent（AtomicEditOp）→ 既有 SceneGraphAction[] / PromiseAction[] 批次。
// 纯函数零副作用零语义判断（AGENT-001）：只机械生成 id / 连边 / rewire，不判「这个桥合理吗」。
// 边 id 用确定性命名（`${op}:${from}:${to}` 类），projector by-id 幂等（重复提议不重复落）。

/** expander 输出：graph 边与 promise 边分离（两套既有 projector 各自吃）。 */
export interface AtomicEditExpansion {
  sceneGraphActions: SceneGraphAction[];
  promiseActions: PromiseAction[];
}

/** 既有 scene_graph 读上下文（查 dangling ref / rewire 目标存在性 / 既有边）。 */
export interface ExpandContext {
  sceneGraph: SceneGraph;
}

/** 生成确定性 edge id（projector by-id 幂等，重复提议同 op 同端点 = 覆盖非重复追加）。 */
function edgeId(kind: string, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

/**
 * 把一个 AtomicEditOp 机械展开成既有 bounded actions 批次（design §2）。
 *
 * - add_plot_bridge：add_scene(桥) + add_edge(CAUSAL from→桥) + add_edge(CAUSAL 桥→to)。
 *   flashback 时 bridge.storyTime 语义由 LLM 定（expander 不碰 storyTime 排序——归校验/writer）。
 * - add_suspense：可选 add_scene(钩子) + add_edge(SUSPENSE at→resolve)。钩子可挂既有场（suspenseScene 缺省）。
 * - add_foreshadow：add_promise(promise + firstBeat kind=plant) + add_beat(kind=payoff)。
 *   beat id 缺省——projector 按 (promiseId, sceneRef) 自然键生成（applyPromiseActions 既有）。
 * - insert_twist：add_scene(twistScene outcomeType=反转) + add_edge(CAUSAL after→twist) +
 *   rewire：remove 既有 afterScene→下游 CAUSAL 直边 + add_edge(CAUSAL twist→下游)。
 *   rewire 只动 CAUSAL 直边（from===afterSceneId 的），SUSPENSE/其他边不动（反转改因果不改悬念指向）。
 * - revise_event：update_scene(sceneId + patch)。
 *
 * 不做校验（校验归 validateAtomicEditOps）；不判目标节点是否存在（校验层报 dangling）。
 */
export function expandAtomicEditOp(op: AtomicEditOp, _ctx: ExpandContext): AtomicEditExpansion {
  switch (op.op) {
    case 'add_plot_bridge': {
      const bridgeId = op.bridgeScene.id;
      const edgeType = 'CAUSAL' as const;
      return {
        sceneGraphActions: [
          { op: 'add_scene', scene: op.bridgeScene },
          { op: 'add_edge', edge: { id: edgeId('bridge-in', op.between.fromSceneId, bridgeId), from: op.between.fromSceneId, to: bridgeId, type: edgeType } },
          { op: 'add_edge', edge: { id: edgeId('bridge-out', bridgeId, op.between.toSceneId), from: bridgeId, to: op.between.toSceneId, type: edgeType } },
        ],
        promiseActions: [],
      };
    }
    case 'add_suspense': {
      const sceneGraphActions: SceneGraphAction[] = [];
      if (op.suspenseScene) {
        sceneGraphActions.push({ op: 'add_scene', scene: op.suspenseScene });
        // CR-001：钩子场须连进因果链——补 atSceneId→suspenseScene 边（CAUSAL），否则钩子场作为孤立节点进图。
        // 悬念指向边（hook→resolve）仍发 SUSPENSE。无此边时 atSceneId 字段对图零影响（既有 bug）。
        sceneGraphActions.push({
          op: 'add_edge',
          edge: { id: edgeId('suspense-attach', op.atSceneId, op.suspenseScene.id), from: op.atSceneId, to: op.suspenseScene.id, type: 'CAUSAL' as const },
        });
        sceneGraphActions.push({
          op: 'add_edge',
          edge: { id: edgeId('suspense', op.suspenseScene.id, op.resolveTowardsSceneId), from: op.suspenseScene.id, to: op.resolveTowardsSceneId, type: 'SUSPENSE' },
        });
      } else {
        // 无独立钩子场：悬念边直接挂既有 atScene。
        sceneGraphActions.push({
          op: 'add_edge',
          edge: { id: edgeId('suspense', op.atSceneId, op.resolveTowardsSceneId), from: op.atSceneId, to: op.resolveTowardsSceneId, type: 'SUSPENSE' },
        });
      }
      return { sceneGraphActions, promiseActions: [] };
    }
    case 'add_foreshadow': {
      return {
        sceneGraphActions: [],
        promiseActions: [
          {
            type: 'add_promise',
            promise: op.promise,
            firstBeat: { kind: 'plant', promiseId: op.promise.id, sceneRef: op.plantBeatSceneId },
          },
          {
            type: 'add_beat',
            beat: { kind: 'payoff', promiseId: op.promise.id, sceneRef: op.payoffBeatSceneId },
          },
        ],
      };
    }
    case 'insert_twist': {
      const twistId = op.twistScene.id;
      const sceneGraphActions: SceneGraphAction[] = [
        // 反转节点：outcomeType=反转（1.9 开放语义枚举，LLM 可超词表）。
        { op: 'add_scene', scene: { ...op.twistScene, outcomeType: op.twistScene.outcomeType ?? '反转' } },
        { op: 'add_edge', edge: { id: edgeId('twist-in', op.afterSceneId, twistId), from: op.afterSceneId, to: twistId, type: 'CAUSAL' as const } },
      ];
      // rewire：既有 afterScene→下游 CAUSAL 直边 remove（反转改因果指向），twist→下游 add。
      // 下游 id 来自 rewireEdgesTo（LLM 定哪些下游因果改道）；既有边查 ctx.sceneGraph（纯代码图遍历）。
      // CR-006：dedup rewireEdgesTo——`['s2','s2']` 否则产重复 remove/add（projector 幂等图不变但 action 列表污染）。
      const seenDownstream = new Set<string>();
      for (const downstreamId of op.rewireEdgesTo) {
        if (seenDownstream.has(downstreamId)) continue;
        seenDownstream.add(downstreamId);
        // remove afterScene→downstream 的既有 CAUSAL 直边（若存在；不存在幂等跳过）。
        for (const e of _ctx.sceneGraph.edges) {
          if (e.from === op.afterSceneId && e.to === downstreamId && e.type === 'CAUSAL') {
            sceneGraphActions.push({ op: 'remove_edge', id: e.id });
          }
        }
        sceneGraphActions.push({
          op: 'add_edge',
          edge: { id: edgeId('twist-out', twistId, downstreamId), from: twistId, to: downstreamId, type: 'CAUSAL' as const },
        });
      }
      return { sceneGraphActions, promiseActions: [] };
    }
    case 'revise_event': {
      return {
        sceneGraphActions: [{ op: 'update_scene', scene: { ...op.patch, id: op.sceneId } }],
        promiseActions: [],
      };
    }
  }
}

// ── validateAtomicEditOps（纯代码校验，复用既有 validateSceneGraph + diff）──
//
// 两道校验（design §3）：
// 1. 展开后跑既有 validateSceneGraph（projected graph）—— DAG/reachability/mesh/IF/dangling 全检。
// 2. diff 校验（新薄层）：对比展开前后 issue 列表——要求「不引入新 error 级 issue」。
//    art_overrides 可显式豁免某 check（既有机制，Type3 林奇式故意打破因果留痕）。
//
// 注意：add_foreshadow 改 promise_registry（非 scene_graph），scene_graph validator 不覆盖——
// CR-008（7.4 DEFER 补）：validatePromiseActions 加 promise 形态/碰撞校验（duplicate promiseId /
// dangling beat sceneRef），mirror scene graph 校验复用哲学。beat sceneRef 锚定检查用 projected graph
// （含批次创建场，batch-aware）。promise 链完整性（派生态机）仍靠既有 resolvePromiseFulfillment + applyPromiseActions
// 内 sync，CR-008 不重造（只加批次级结构校验）。

export interface AtomicEditValidation {
  valid: boolean;
  /** 展开后新引入的 issue（展开后有、展开前无）。warning/error 都列，供人审/Director 参考。 */
  newIssues: SceneGraphIssue[];
  /** 新引入的 error 级 issue（阻断落地）。art_override 未豁免的。 */
  blockingIssues: SceneGraphIssue[];
}

/** issue 标识（code + severity + targets.id 排序）用于 diff 前后（同 code 同 severity 同 targets = 同 issue）。
 *  CR-003：含 severity——否则 before 有 warning 级 issue、expansion 引入 error 级同 code 同 targets 时，
 *  被 beforeKeys 吞掉 → blockingIssues 漏报 → valid 假阴（漏 canon cycle）。severity 是 issue 身份一部分。 */
function issueKey(issue: SceneGraphIssue): string {
  const targets = [...issue.targets].map((t) => `${t.kind}:${t.id}`).sort().join(',');
  return `${issue.severity}|${issue.code}|${targets}`;
}

/**
 * 校验一组 AtomicEditOp 展开后是否引入图约束违规（design §3）。
 *
 * 算法：
 * 1. 展开 ops → sceneGraphActions（promise_actions 不入 graph 校验）。
 * 2. projected = applySceneGraphActions(currentGraph, sceneGraphActions)。
 * 3. beforeIssues = validateSceneGraph(currentGraph)；afterIssues = validateSceneGraph(projected)。
 * 4. newIssues = afterIssues 中 beforeIssues 没有的（key diff）。
 * 5. blockingIssues = newIssues 中 severity==='error' 的（art_override 已在 validateSceneGraph 内降级）。
 *
 * valid = blockingIssues.length === 0。warning 级 newIssues 不阻断（供参考，mirror 既有 art_overrides 软降级哲学）。
 *
 * 失败处置（design §3，mirror 7.2 hard-violation）：blocking → Director 重提议 OR 人审改 OR art_override 豁免。
 * **不静默落地**（落地公理延伸：校验失败不悄悄改图）。
 */
export function validateAtomicEditOps(
  ops: AtomicEditOp[],
  ctx: ExpandContext,
): AtomicEditValidation {
  // 展开（promise_actions 收集入 allPromiseActions，CR-008 promise 校验消费）。
  const allSceneGraphActions: SceneGraphAction[] = [];
  const allPromiseActions: PromiseAction[] = [];
  for (const op of ops) {
    const expansion = expandAtomicEditOp(op, ctx);
    allSceneGraphActions.push(...expansion.sceneGraphActions);
    allPromiseActions.push(...expansion.promiseActions);
  }

  const projected = applySceneGraphActions(ctx.sceneGraph, allSceneGraphActions);

  const beforeIssues = validateSceneGraph(ctx.sceneGraph);
  const afterIssues = validateSceneGraph(projected);

  const beforeKeys = new Set(beforeIssues.map(issueKey));
  const newIssues = afterIssues.filter((i) => !beforeKeys.has(issueKey(i)));
  // CR-008（7.3 DEFER 补，design §5）：promise-only 批次校验（add_foreshadow 只产 promiseActions，
  // graph validator 不覆盖）。promise issues 全是批次新引入（before 无 promise 校验），合入 newIssues。
  // projected graph 含批次创建的新场（applySceneGraphActions 已应用），故 beat sceneRef 锚批次内
  // add_plot_bridge 创的场不会被误报（batch-aware，同 CR-009）。
  const promiseIssues = validatePromiseActions(allPromiseActions, projected);
  newIssues.push(...promiseIssues);

  const blockingIssues = newIssues.filter((i) => i.severity === 'error');

  return {
    valid: blockingIssues.length === 0,
    newIssues,
    blockingIssues,
  };
}

// ── CR-008（7.3 DEFER 补）：promise-only 批次校验 ──
//
// add_foreshadow 只产 promiseActions（无 sceneGraphActions），validateSceneGraph 不覆盖 promise 链。
// 7.3 design §3 注释明 defer 7.4 补。mirror validateSceneGraph 哲学：纯代码机械结构校验（duplicate id /
// dangling sceneref），不判语义（「这个伏笔合理吗」归 Director / 人审）。复用 SceneGraphIssue 形态（code/
// severity/targets 复用，art_override 按 id scope 匹配不受 kind 'node' 限制）。
//
// 两道检查：
// 1. 同 promiseId 批次内重复登记（两 add_promise 同 id → applyPromiseActions 后者 clobber 前者，数据丢失风险）。
// 2. beat sceneRef dangling（plant/payoff beat 指向 projected graph 不存在的场景——projected 含批次创建场，
//    故锚批次内 add_plot_bridge 创的场不误报）。

/**
 * 校验一批 promiseActions 的结构完整性（CR-008，design §5）。
 *
 * 纯函数零副作用：只读 promiseActions + projectedGraph.nodes，产 SceneGraphIssue[]（severity='error'）。
 * caller (validateAtomicEditOps) 合入 newIssues + blockingIssues（severity='error' 自动进 blocking）。
 *
 * 不校验 plant==payoff 同场（schema 顶层 refine CR-002 已拒）。
 * 不校验 promise 字段完整性（promiseEntryWriteSchema 已守）。
 */
function validatePromiseActions(
  promiseActions: readonly PromiseAction[],
  projectedGraph: SceneGraph,
): SceneGraphIssue[] {
  if (promiseActions.length === 0) return [];
  const issues: SceneGraphIssue[] = [];
  const sceneIds = new Set(projectedGraph.nodes.map((n) => n.id));

  // 1. 同 promiseId 批次内重复登记（两 add_promise 同 id 不同内容 → 后者 clobber 前者）。
  const addPromiseCounts = new Map<string, number>();
  for (const action of promiseActions) {
    if (action.type === 'add_promise') {
      const id = action.promise.id;
      addPromiseCounts.set(id, (addPromiseCounts.get(id) ?? 0) + 1);
    }
  }
  for (const [promiseId, count] of addPromiseCounts) {
    if (count > 1) {
      issues.push({
        code: 'promise-duplicate-id',
        severity: 'error',
        message: `批次内多个 add_promise 登记同一 promise id "${promiseId}"（${count} 次），后者覆盖前者`,
        targets: [{ kind: 'node', id: promiseId }],
      });
    }
  }

  // 2. beat sceneRef dangling（firstBeat / add_beat 指向 projected graph 不存在的场景）。
  for (const action of promiseActions) {
    if (action.type === 'add_promise' && action.firstBeat) {
      const ref = action.firstBeat.sceneRef;
      if (!sceneIds.has(ref)) {
        issues.push({
          code: 'promise-dangling-sceneref',
          severity: 'error',
          message: `promise plant beat 指向不存在的场景 "${ref}"`,
          targets: [{ kind: 'node', id: ref }],
        });
      }
    } else if (action.type === 'add_beat') {
      const ref = action.beat.sceneRef;
      if (!sceneIds.has(ref)) {
        issues.push({
          code: 'promise-dangling-sceneref',
          severity: 'error',
          message: `promise beat 指向不存在的场景 "${ref}"`,
          targets: [{ kind: 'node', id: ref }],
        });
      }
    }
  }

  return issues;
}

// ── CR-009（7.3 DEFER 补）：batch-aware filter 支持 ──

/**
 * 收集一批 ops 将要创建的新场景 id（CR-009 batch-aware filter 支持，design §5）。
 *
 * add_plot_bridge/add_suspense/insert_twist 创建新场景（expand 后 add_scene action）；add_foreshadow/
 * revise_event 不创建。用于 write-chapter.ts proposalAnchorsExistingScene 预过滤——proposal B 锚 proposal A
 * 创的新场（如 B 的 atSceneId = A 的 bridgeScene.id）不应被当幻觉滤掉。将批次创建场 id 合入既有场景集后
 * 过滤，B 正确保留。
 *
 * 纯代码机械提取（op→sceneId 字段），mirror expandAtomicEditOp 的 add_scene 分支场景 id 来源。
 */
export function collectCreatedSceneIds(ops: readonly AtomicEditOp[]): Set<string> {
  const ids = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case 'add_plot_bridge':
        ids.add(op.bridgeScene.id);
        break;
      case 'add_suspense':
        if (op.suspenseScene) ids.add(op.suspenseScene.id);
        break;
      case 'insert_twist':
        ids.add(op.twistScene.id);
        break;
      case 'add_foreshadow':
      case 'revise_event':
        // 不创建场景（add_foreshadow 只产 promise/beats，revise_event 只 update 既有场）
        break;
    }
  }
  return ids;
}

// ── parseDirectorAtomicEdits（三路径鲁棒 + per-element filter，mirror parseRevisionIntent）──
//
// 落 shared-contracts（shell IPC + agent 两入口共享，mirror parseRevisionIntent 同理）。
// 🔑 per-element filter（7.2 CR-EDGE-003 教训）：单条畸形 proposal（LLM 漏 rationale / op params 坏）
// 不丢整体 verdict——逐条 safeParse，drop bad keep good。

/** Director 输出契约 shape（per-element 校验用）。Director 也可输出单对象（非数组），coerce 归一成数组。 */
const directorAtomicEditsEnvelopeSchema = z.object({
  atomicEditProposals: z.array(atomicEditProposalSchema).default([]),
});

/** 逐条 coerce（per-element filter：drop bad keep good，防单条畸形丢整体）。 */
function coerceProposals(raw: unknown): AtomicEditProposal[] {
  if (!Array.isArray(raw)) return [];
  const valid: AtomicEditProposal[] = [];
  for (const item of raw) {
    const result = atomicEditProposalSchema.safeParse(item);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

function tryExtractAtomicEdits(text: string): AtomicEditProposal[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  // 形态 1：{ atomicEditProposals: [...] }（envelope，字段须真实存在——非 default 空数组，
  // 否则裸单 proposal 对象会被 envelope 吞掉返空）。
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'atomicEditProposals' in parsed) {
    const envelope = directorAtomicEditsEnvelopeSchema.safeParse(parsed);
    if (envelope.success) return envelope.data.atomicEditProposals;
  }
  // 形态 2：裸数组 [...]。
  if (Array.isArray(parsed)) return coerceProposals(parsed);
  // 形态 3：裸单 proposal 对象（无 envelope 无数组）。
  const single = atomicEditProposalSchema.safeParse(parsed);
  return single.success ? [single.data] : [];
}

/**
 * 解析 director-agent 返回的 atomicEditProposals JSON 串（三路径鲁棒，mirror parseRevisionIntent）。
 *
 * 三路径：
 * 1. 扫所有 ```json/``` fenced 块（multi-fence tolerant）。
 * 2. brace-match（first `[` or `{` to last `]` or `}`）。
 * 3. 整体试 parse。
 *
 * per-element filter：逐条 safeParse，drop bad keep good（7.2 CR-EDGE-003——单条畸形不丢整体）。
 * 全路径全条失败 → 返空数组（caller graceful 降级，链段照跑）。
 *
 * @param content director-agent 返的 assistant content（期望是 atomicEditProposals JSON 串）。
 * @returns         合法 AtomicEditProposal[]（可能空——无提议或全畸形）。
 */
export function parseDirectorAtomicEdits(content: string): AtomicEditProposal[] {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return [];

  // 路径 1：fenced 块（multi-fence tolerant）。
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    const inner = match[1];
    if (!inner) continue;
    const proposals = tryExtractAtomicEdits(inner);
    if (proposals.length > 0) return proposals;
  }

  // 路径 2：bracket/brace-match（first 开括号 to last 闭括号，mirror parseRevisionIntent brace-match）。
  // 用 indexOf/lastIndexOf 非 $ 锚定——content 可能带 narration 尾巴（「，请确认。」），
  // $ 锚定会漏掉这种「数组后还有文字」的常见形态。
  const openMatch = trimmed.search(/[[{]/);
  const closeBracket = Math.max(trimmed.lastIndexOf(']'), trimmed.lastIndexOf('}'));
  if (openMatch !== -1 && closeBracket > openMatch) {
    const proposals = tryExtractAtomicEdits(trimmed.slice(openMatch, closeBracket + 1));
    if (proposals.length > 0) return proposals;
  }

  // 路径 3：整体试 parse。
  return tryExtractAtomicEdits(trimmed);
}

// ── 重导出既有类型供 dispatch helper 便利（mirror revision-intent.ts 风格）──
export type { PromiseRegistry, SceneGraph, SceneGraphAction, PromiseAction } from './creative-fields';
export type { SceneGraphIssue } from './scene-graph-analytics';

// 防御：导出既有 schema 供 dispatch helper 做信任边界 safeParse（mirror 既有 handler 模式）。
export { sceneGraphSchema, promiseRegistrySchema, promiseActionSchema, promiseBeatKindSchema } from './creative-fields';
