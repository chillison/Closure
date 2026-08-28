// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 6（design §4 / §6.2 / §7.5，r1）：写章链运行态 + delta 缓冲。
//
// chain-delta 高频事件**不直进 zustand**（r4/r7 一致结论）——模块级 Map 按 (nodeId, seq)
// 维度累积当前流（新 seq / 新 messageId 轮 = 新段），节流 flush 才写 store 的
// chainRunBySession[sid].streamText（ChainRunCard 消费）。快照间隔自适应：累积 >20K 字符
// 时拉长到 500ms（防线性 MD 解析成本，design §6.2 尾坑）。
//
// 状态机（ChainRunState.status）：
// - running：链 run 在途（ChainRunCard 全卡：步进条 + 流式正文）。
// - paused：checkpoint pause / 挂起——卡片降级为**仅步进条**（让位 ChapterReviewPanel，
//   design §7.5「不叠加两卡」）。
// - completed：run 终态正常（accept / auto_revise_pending 视作本轮完成）——卡片卸载
//   （审阅/落盘流程接管：ChapterReviewPanel / PatchReviewPanel / ReviewFindingsCard）。
// - aborted / error：中断/失败——卡片保留已累积文本 + 「已中断/失败」标 + 重试钮
//   （abort 半 JSON 不落盘，UI 缓冲侧标注中断——r1 坑；leader 路径重试 = 重发末条 user 消息）。
//
// 终态后再收到非哨兵链事件 = 新 run（redo / 下一章）→ 重置状态从头累积。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 链 run 级终态帧的哨兵 nodeId——mirror agent 包 `CHAIN_RUN_SENTINEL_NODE_ID`
 * （`@orison/desktop-agent` 导出单源；UI 包不依赖 agent 包，本地镜像此常量。
 * 真实节点 id 不含双下划线前后缀，哨兵无碰撞）。
 */
export const CHAIN_RUN_SENTINEL_NODE_ID = '__chain_run__';

/**
 * 写章链节点权威序——mirror agent 包 `CHAPTER_CHAIN_NODE_IDS`
 * （`apps/desktop/agent/src/nodes/chapter-chain.ts`，链装配权威序）。UI 包不依赖 agent
 * 包，本地镜像驱动步进条「未来节点」空心点（agent 包侧改链序时须同步此表）。
 */
export const CHAIN_NODE_ORDER: readonly string[] = [
  'brief-compiler-node',
  'draft-writer-agent',
  'revision-guard-agent',
  'lint-node',
  'world-extractor-physical',
  'world-extractor-cognitive',
  'world-extractor-emotional',
  'world-extractor-relational',
  'world-extractor-factional',
  'world-merge-node',
  'emotion-verify-node',
  'promise-emergence-node',
  'arc-emergence-node',
  'chapter-summary-node',
  'storytime-drift-node',
  'mention-ledger-node',
  'story-sync-agent',
  'targeted-revision-agent',
  'multi-review-agent',
  'completeness-verify-node',
  'feedback-ledger-node',
  'route-agent',
];

/** 节点步进条显示名（机械去后缀——英文 id 随 #38 另簇中文化，此处只做可读化）。 */
export function chainNodeLabel(nodeId: string): string {
  return nodeId.replace(/-(node|agent)$/, '');
}

export type ChainRunStatus = 'running' | 'completed' | 'error' | 'aborted' | 'paused';

/** 单会话链运行态（ChainRunCard 数据源；ephemeral——刷新即丢，run 本身随主进程死，语义一致）。 */
export type ChainRunState = {
  sessionId: string;
  status: ChainRunStatus;
  /** 已完成节点（chain-node-done 'done' 累积；步进条实心点）。 */
  completedNodes: string[];
  /** 当前步进锚点（最近一次 node-done 的节点；步进条呼吸点）。 */
  currentNodeId: string | null;
  /** 失败/受阻节点（node-done 'error' / 'blocked'）。 */
  errorNodeId: string | null;
  /** 流式正文元数据（当前 (nodeId, seq) 流）。 */
  streamNodeId: string | null;
  streamRole: string | null;
  streamPhase: string | null;
  /** 已 flush 的流式正文累积（终态保留——中断态呈现「已流出部分」）。 */
  streamText: string;
  /** 流仍在途（正文区 caret / 三点 loading 判定）。 */
  streaming: boolean;
  updatedAt: number;
};

/**
 * 缓冲写回所需的 store 结构面（appStore 的 AppState 结构满足；结构性类型避免
 * appStore ↔ buffer 循环 import，mirror agentStreamBuffer 模式）。
 */
export type ChainBufferState = {
  chainRunBySession: Record<string, ChainRunState>;
  /**
   * dogfood T1 CR-T1-049：finalizeChainRun 终态同步 run 态（agentRunStates）所需的结构面。
   * agentEvents 传入的 store 结构满足（AgentDispatchState 超集）；最小测试 store 可缺省
   * （缺省不写——链缓冲行为独立可测）。类型 import 自 agentEvents（type-only，无运行时环）。
   */
  setAgentRunState?: (sessionId: string, patch: import('./agentEvents').AgentRunStatePatch) => void;
};

export type ChainBufferStore<S extends ChainBufferState = ChainBufferState> = {
  getState: () => S;
  setState: (partial: Partial<S> | ((state: S) => Partial<S>)) => void;
};

/** 终态集合（再收到非哨兵链事件 = 新 run → 重置）。paused 非终态（resume 续同链）。 */
const TERMINAL_STATUSES: ReadonlySet<ChainRunStatus> = new Set(['completed', 'error', 'aborted']);

type ChainBufferEntry = {
  /** 流标识 `${nodeId}#${seq}`——新流（redo 重跑 seq+1）开新段。 */
  key: string;
  nodeId: string;
  role: string;
  phase: string | null;
  /** 当前轮 messageId（makeAgentLoop 预分配轮 assistantId）——同流内换轮 = 新段。 */
  messageId: string;
  text: string;
  /**
   * dogfood T1 CR-T1-051：上次 flush 时刻——>20K 长文降频（500ms）按 entry 生效。旧
   * nextFlushDelayMs 全局扫描会让 A 会话超 20K 拖慢 B 会话的 flush（块5 附注跨会话耦合）。
   */
  lastFlushAt: number;
};

/** sessionId → 当前流缓冲（不进 store；跨 flush 窗存活）。 */
const chainBuffers = new Map<string, ChainBufferEntry>();

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 基准 flush 间隔 250ms（design §6.2）；>20K 字符自适应拉长到 500ms（§6.2 尾坑）。 */
const BASE_FLUSH_MS = 250;
const LONG_FLUSH_MS = 500;
const LONG_TEXT_THRESHOLD = 20000;

let latestStore: ChainBufferStore | null = null;

/** 测试 helper：清模块级缓冲 + 停计时器。 */
export function __clearChainStreamState(): void {
  chainBuffers.clear();
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  latestStore = null;
}

function asBaseStore<S extends ChainBufferState>(store: ChainBufferStore<S>): ChainBufferStore {
  return store as unknown as ChainBufferStore;
}

function writeForSession(
  store: ChainBufferStore,
  sessionId: string,
  patch: (prev: ChainRunState | undefined) => ChainRunState,
): void {
  const state = store.getState();
  const prev = state.chainRunBySession[sessionId];
  const next = patch(prev);
  if (prev === next) return;
  store.setState({ chainRunBySession: { ...state.chainRunBySession, [sessionId]: next } });
}

function freshRun(sessionId: string): ChainRunState {
  return {
    sessionId,
    status: 'running',
    completedNodes: [],
    currentNodeId: null,
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: Date.now(),
  };
}

/**
 * chain-delta 到达：终态后首条 delta = 新 run（重置）；缓冲按 (nodeId, seq) 开段（新流 /
 * 同流换 messageId 轮均重置文本）；确保 store 记录在 + status running + streaming。
 */
export function applyChainDelta<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  data: { nodeId: string; role: string; phase?: string; messageId: string; delta: string; seq: number },
): void {
  const base = asBaseStore(store);
  const state = base.getState();
  const prev = state.chainRunBySession[sessionId];
  if (prev === undefined || TERMINAL_STATUSES.has(prev.status) || prev.status === 'paused') {
    // 终态后首条 delta = 新 run（重置）；paused 后 delta = redo 重跑已开流 → 回 running
    //（精简态只属于「停在 checkpoint 等审阅」窗口）。delta 只在 run 在途时流动。
    writeForSession(base, sessionId, (p) =>
      p === undefined || TERMINAL_STATUSES.has(p.status)
        ? freshRun(sessionId)
        : { ...p, status: 'running', streaming: true, updatedAt: Date.now() },
    );
  }

  const key = `${data.nodeId}#${data.seq}`;
  let entry = chainBuffers.get(sessionId);
  if (!entry || entry.key !== key) {
    entry = { key, nodeId: data.nodeId, role: data.role, phase: data.phase ?? null, messageId: data.messageId, text: '', lastFlushAt: Date.now() };
    chainBuffers.set(sessionId, entry);
    writeForSession(base, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      streamNodeId: data.nodeId,
      streamRole: data.role,
      streamPhase: data.phase ?? null,
      streamText: '',
      streaming: true,
      updatedAt: Date.now(),
    }));
  } else if (entry.messageId !== data.messageId) {
    // 同流内换 generate 轮（阶段二查询轮后另起写作轮）——新轮文本另起一段。
    entry.messageId = data.messageId;
    entry.text = '';
  } else {
    entry.phase = data.phase ?? entry.phase;
  }
  entry.text += data.delta;
  ensureFlushTimer(base);
}

/**
 * chain-node-done 到达：哨兵 nodeId = run 级终态帧（status → 卡片状态机映射）；普通 nodeId =
 * 节点步进（completedNodes 累积 / 当前锚点 / error 节点标注）。终态后普通事件 = 新 run（重置）。
 */
export function applyChainNodeDone<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  data: { nodeId: string; status: string },
): void {
  const base = asBaseStore(store);

  if (data.nodeId === CHAIN_RUN_SENTINEL_NODE_ID) {
    // CR-T1-051：终帧先 flush 后删——「中断保留已流出文本」承诺此前只兑现到上个 flush 点
    //（丢 ≤500ms 尾巴）。force 跳过 per-entry 降频门（终态一帧定形，尾巴必须落）。
    flushChainBuffers(base, { force: true });
    chainBuffers.delete(sessionId);
    if (chainBuffers.size === 0) stopFlushTimer();
    // run 终态映射：auto_revise_pending 视作本轮完成（leader 自动 redo 会开新 run 流新事件）；
    // blocked 归 error（链未走通）。paused 保留累积（步进条降级态可见）。
    let status: ChainRunStatus;
    if (data.status === 'completed' || data.status === 'auto_revise_pending') status = 'completed';
    else if (data.status === 'paused') status = 'paused';
    else if (data.status === 'aborted') status = 'aborted';
    else status = 'error'; // 'error' | 'blocked' | 未知终态归失败
    writeForSession(base, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      status,
      streaming: false,
      updatedAt: Date.now(),
    }));
    return;
  }

  const state = base.getState();
  const prev = state.chainRunBySession[sessionId];
  if (prev === undefined || TERMINAL_STATUSES.has(prev.status)) {
    writeForSession(base, sessionId, (p) => (p === undefined || TERMINAL_STATUSES.has(p.status) ? freshRun(sessionId) : p!));
  }
  const isNodeError = data.status === 'error' || data.status === 'blocked';
  writeForSession(base, sessionId, (p) => {
    const cur = p ?? freshRun(sessionId);
    const completedNodes =
      data.status === 'done' && !cur.completedNodes.includes(data.nodeId)
        ? [...cur.completedNodes, data.nodeId]
        : cur.completedNodes;
    return {
      ...cur,
      // paused 后 resume/redo 续跑（新节点事件到达）→ 回 running（全卡形态；paused 精简态
      // 只属于「停在 checkpoint 等审阅」窗口）。
      status: cur.status === 'paused' ? 'running' : cur.status,
      completedNodes,
      currentNodeId: data.nodeId,
      errorNodeId: isNodeError ? data.nodeId : cur.errorNodeId,
      // dogfood T1 CR-T1-050：普通 node-done 命中流节点 → streaming 收口（此前只在哨兵复位
      // ——draft-writer done 后整个 JSON 节点尾期正文区恒流式态 = auto 档数十分钟假「正在
      // 写作」+ caret 残留）。streamText 保留（终态呈现「已流出部分」；JSON 节点期正文区
      // 让位占位——组件侧按 streaming 判定，design §7.5）。
      streaming: data.nodeId === cur.streamNodeId ? false : cur.streaming,
      updatedAt: Date.now(),
    };
  });
}

/**
 * dogfood T1 CR-T1-029：会话删除时修剪模块级缓冲（store 侧 chainRunBySession 条目由
 * deleteAgentSession 清——本函数只管模块 Map + 计时器）。
 */
export function forgetChainRunBuffer(sessionId: string): void {
  chainBuffers.delete(sessionId);
  if (chainBuffers.size === 0) stopFlushTimer();
}

/**
 * run 级兜底终态（dispatcher 'done' / 'error' 事件调用）：链仍 running 时标中断/失败——
 * 正常完成路径哨兵帧先到（status 已 completed），此处只兜「链中途被掐」（abort / 流错误）。
 */
export function finalizeChainRun<S extends ChainBufferState>(
  store: ChainBufferStore<S>,
  sessionId: string,
  status: 'aborted' | 'error',
): void {
  const base = asBaseStore(store);
  // CR-T1-051：终帧先 flush 后删（同哨兵分支——force 跳过降频门，中断尾巴不丢）。
  flushChainBuffers(base, { force: true });
  chainBuffers.delete(sessionId);
  if (chainBuffers.size === 0) stopFlushTimer();
  // dogfood T1 CR-T1-049：终态同步 run 态（agentRunStates）——finalize 是链终态漏斗（done/
  // error 事件兜底路径），dogfood stub 会话的链车道无 done 事件复位（普通 node-done 分支置
  // running）→ 不在此归位则 stub 会话永久 running 徽标 + 停止钮。aborted 归 idle（mirror
  // 哨兵映射——中断非 error 相位）。paused 早退保持（审阅等待由键控槽承载，run 态已 idle）。
  base.getState().setAgentRunState?.(sessionId, {
    phase: status === 'error' ? 'error' : 'idle',
    activity: undefined,
  });
  const prev = base.getState().chainRunBySession[sessionId];
  if (prev === undefined) return;
  if (prev.status === 'paused') return; // 审阅面板在等（ChapterReviewPanel 接管），保持 paused
  if (TERMINAL_STATUSES.has(prev.status)) return; // 哨兵帧已定终态（正常完成 / 显式中断）
  writeForSession(base, sessionId, (p) => ({
    ...(p ?? freshRun(sessionId)),
    status,
    streaming: false,
    updatedAt: Date.now(),
  }));
}

function ensureFlushTimer(store: ChainBufferStore): void {
  latestStore = store;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const target = latestStore;
    if (!target || chainBuffers.size === 0) return;
    flushChainBuffers(target);
    // dogfood T1 CR-T1-051：计时器恒按基准窗重排——长文降频改为 per-entry 门（flushChainBuffers
    // 内按 entry.lastFlushAt + 文本长度判）。旧 nextFlushDelayMs 全局扫描会让 A 会话超 20K
    // 拖慢 B 会话的 flush（块5 附注跨会话耦合）；>20K 的 entry 隔一窗（500ms）才写。
    ensureFlushTimer(target);
  }, BASE_FLUSH_MS);
}

function stopFlushTimer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * 节流 flush：缓冲累积文本 → store streamText（每 250/500ms 一次 set，memo 友好）。
 * per-entry 降频（CR-T1-051）：>20K 长文隔窗到 500ms 才写，短文会话不受拖累；
 * `force`（终帧前最后落盘）跳过降频门——中断尾巴必须落，同点不重写（streamText 等值跳过）。
 */
function flushChainBuffers(store: ChainBufferStore, opts: { force?: boolean } = {}): void {
  const now = Date.now();
  for (const [sessionId, entry] of chainBuffers) {
    const prev = store.getState().chainRunBySession[sessionId];
    if (prev === undefined || prev.streamNodeId !== entry.nodeId) continue;
    if (prev.streamText === entry.text) continue;
    if (!opts.force) {
      const delayMs = entry.text.length > LONG_TEXT_THRESHOLD ? LONG_FLUSH_MS : BASE_FLUSH_MS;
      if (now - entry.lastFlushAt < delayMs) continue;
    }
    entry.lastFlushAt = now;
    writeForSession(store, sessionId, (p) => ({
      ...(p ?? freshRun(sessionId)),
      streamText: entry.text,
      updatedAt: now,
    }));
  }
}
