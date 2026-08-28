import type { AgentMessage } from '../api/agent';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 Stage 4（design §6.1 / r4 / r7 一致结论）：slice 层 per-session delta 缓冲。
//
// delta 高频事件（分钟级数千条）**不进 zustand**——模块级 Map 按 messageId 累积，250ms
// interval flush 才写 store（更新占位消息 content，新消息对象）。首条 delta 到达即创建
// 占位消息（id = 预分配 assistantId，streaming:true）；终帧 assistant 事件同 id 整条替换
//（透传 reasoning/kind/toolCalls）+ 清缓冲项 + streaming:false（AgentMessageItem 双轨收敛）。
//
// 占位废弃规则（S2 遗留坑）：plan/discuss 打回丢弃的 response 若已流 delta，其占位永远等
// 不到终帧——同 session 新 messageId 的首条 delta 到达即废弃旧占位（只删 streaming=true 的
// 等终帧占位，用户/工具消息不动）。CR-T1-014 补口：同 session 下一条 assistant 终帧也废弃
// 旧占位（打回后重试走非流式降级成功 → 无新 delta id，首条 delta 规则不触发的逃逸路径）。
// done/error 事件兜底清位（打回后 run 直接结束等残余）。
//
// 仅活跃视图会话落 store（后台会话消息不追——切回 fetch 对账，agentEvents dispatcher 同款
// 谓词；本模块入口与 flush 双重校验）。测试经 handleAgentStreamEvent 直接驱动（store 透传）。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 缓冲写回所需的 store 结构面（appStore 的 AppState 结构满足；结构性类型避免
 * appStore ↔ slice ↔ buffer 循环 import，mirror agentEvents.AgentDispatchStore 模式）。
 */
export type StreamBufferState = {
  agentSessionId: string | null;
  agentMessages: AgentMessage[];
};

export type StreamBufferStore<S extends StreamBufferState = StreamBufferState> = {
  getState: () => S;
  setState: (partial: Partial<S> | ((state: S) => Partial<S>)) => void;
};

type StreamBufferEntry = {
  sessionId: string;
  text: string;
  reasoning: string;
  /**
   * dogfood T1 Stage 5（design §6.4，D5）：child 条目的分组前缀（`[source:role(:dN)]`）——
   * flush 重建 content 时必须拼回（占位/终帧都被既有 groupChildTags 前缀分组识别）。
   * leader 条目无 tag（undefined）。
   */
  tag?: string;
  /**
   * dogfood T1 CR-T1-038a：最近一条 delta 到达时刻——UI stall 看门狗数据源（60s 无增量 →
   * 占位标停滞，破「caret 永闪」假活；新 delta 到达下一 flush 窗自动摘标）。
   */
  lastDeltaAt: number;
  /** R2 #30：tool 通道首块携带的工具名（streamingToolName 标记的缓冲侧源）。 */
  toolName?: string;
};

/** messageId → 累积内容（不进 store；跨 250ms flush 窗存活）。 */
const streamBuffers = new Map<string, StreamBufferEntry>();

/** sessionId → 当前流式占位 messageId（废弃规则 + 终帧对账用；leader 维度）。 */
const activeStreamBySession = new Map<string, string>();

/**
 * dogfood T1 Stage 5：childSessionId → 当前流式占位 messageId。child 占位的废弃规则按
 * **childSessionId** 维度跟踪（S2 打回坑 child 侧同样存在：child loop 下一 turn 新
 * assistantId 的首条 delta 废弃旧占位）——与 leader 的 session 维度互不干扰。
 */
const activeChildStreamByChildSession = new Map<string, string>();

/**
 * child delta 的分组元数据（事件 child 包装自带，design §6.4「占位消息复用 child assistant
 * 消息构造——带同款分组元数据被既有分组逻辑识别」）。
 */
export type ChildStreamScope = {
  childSessionId: string;
  source: 'subagent' | 'skill';
  role: string;
  depth: number;
};

/** child 分组前缀（mirror agentEvents 既有 tag 构造，groupChildTags 正则同源）。 */
export function childTagPrefix(scope: { source: 'subagent' | 'skill'; role: string; depth: number }): string {
  return `[${scope.source}:${scope.role}${scope.depth > 1 ? `:d${scope.depth}` : ''}]`;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

/** flush 间隔（250ms，design §6.1）；测试可调（fake-timer 快进）。 */
let flushIntervalMs = 250;

/**
 * dogfood T1 CR-T1-038a：流停滞判定窗（60s 无新 delta）——分钟级静默断流时占位标停滞
 * （视觉提示而非永转的假活）；非终态，新 delta 到达自动摘标。
 */
export const STREAM_STALL_MS = 60_000;

/** flush 需要写 store——取最近一次 bufferStreamDelta 调用透传的 store（计时器仅在缓冲
 * 非空时运行，非空 ⟹ 已有调用 ⟹ store 已就位）。 */
let latestStore: StreamBufferStore | null = null;

export function setStreamFlushIntervalMs(ms: number): void {
  flushIntervalMs = ms;
}

/** 测试 helper：清模块级缓冲 + 停计时器。 */
export function __clearAgentStreamBuffers(): void {
  streamBuffers.clear();
  activeStreamBySession.clear();
  activeChildStreamByChildSession.clear();
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  latestStore = null;
}

function ensureFlushTimer(store: StreamBufferStore): void {
  latestStore = store;
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => {
    // 计时器回调内最新 store 优先（视图可能已换 store 引用——测试多 store 场景）。
    const target = latestStore;
    if (!target || streamBuffers.size === 0) {
      stopFlushTimer();
      return;
    }
    flushStreamBuffers(target);
  }, flushIntervalMs);
}

function stopFlushTimer(): void {
  if (flushTimer !== null) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

/** 泛型 S 收敛到基形态（S extends StreamBufferState 只收窄——cast 运行时安全，
 * mirror agentEvents.writeState 的写面单一收口哲学：泛型 S 下「具体 partial => Partial<S>」
 * 不可证，内部统一按 StreamBufferState 写）。 */
function asBaseStore<S extends StreamBufferState>(store: StreamBufferStore<S>): StreamBufferStore {
  return store as unknown as StreamBufferStore;
}

function writeState(
  store: StreamBufferStore,
  partial: Partial<StreamBufferState> | ((state: StreamBufferState) => Partial<StreamBufferState>),
): void {
  store.setState(partial);
}

/**
 * delta 到达：追加进缓冲；新 messageId 首条 delta 时创建占位消息（streaming:true）+
 * 废弃同 session 旧占位（废弃规则）。仅活跃视图会话落 store（调用方 dispatcher 已按
 * 活跃分支路由；此处二次校验防时序漂移——flush 窗内视图可能已切走）。
 */
export function bufferStreamDelta<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
  messageId: string,
  channel: 'text' | 'reasoning' | 'tool',
  delta: string,
  toolName?: string,
): void {
  const base = asBaseStore(store);
  if (base.getState().agentSessionId !== sessionId) return; // 非活跃视图：不建占位（切回 fetch 对账）

  let entry = streamBuffers.get(messageId);
  if (!entry) {
    // 废弃规则：同 session 上一占位（等不到终帧的 streaming 消息）随新流到达而废弃。
    const prevId = activeStreamBySession.get(sessionId);
    if (prevId && prevId !== messageId) {
      streamBuffers.delete(prevId);
      removeStreamingPlaceholder(base, sessionId, prevId);
    }
    entry = { sessionId, text: '', reasoning: '', lastDeltaAt: Date.now() };
    streamBuffers.set(messageId, entry);
    activeStreamBySession.set(sessionId, messageId);
    createPlaceholder(base, sessionId, messageId);
  }
  if (channel === 'text') entry.text += delta;
  else if (channel === 'reasoning') entry.reasoning += delta;
  // R2 #30：tool 通道不进文本缓冲——只更新活性时钟 + 调用首块把工具名标到流式消息
  //（「正在准备工具调用：X」指示；每调用恰一次 store 写，参数 delta 不打 store）。
  else if (toolName && entry.toolName !== toolName) {
    entry.toolName = toolName;
    markStreamingTool(base, sessionId, messageId, toolName);
  }
  entry.lastDeltaAt = Date.now();
  ensureFlushTimer(base);
}

/**
 * R2 #30：把流式消息的 streamingToolName 标记写上（终帧 assistant 替换整条消息，
 * 标记自然消失——无需显式清除路径）。消息不在（终帧已落/视图切走）则跳过。
 */
function markStreamingTool(
  store: StreamBufferStore,
  sessionId: string,
  messageId: string,
  toolName: string,
): void {
  const state = store.getState();
  if (state.agentSessionId !== sessionId) return;
  const index = state.agentMessages.findIndex((m) => m.id === messageId && m.streaming === true);
  if (index === -1) return;
  if (state.agentMessages[index].streamingToolName === toolName) return;
  writeState(store, (s) => ({
    agentMessages: s.agentMessages.map((m, i) => (i === index ? { ...m, streamingToolName: toolName } : m)),
  }));
}

/**
 * dogfood T1 Stage 5（design §6.4，D5）：child delta 入缓冲——与 leader 同节流思想（模块级
 * Map + 250ms flush），差异在两处：
 * - 废弃规则按 **childSessionId** 维度跟踪（child loop 每 turn 预分配新 assistantId，旧占位
 *   等不到终帧即废弃——S2 打回坑 child 侧同款）；
 * - 占位 content 带 `[source:role(:dN)]` 前缀（复用 child assistant 消息构造形状，被既有
 *   groupChildTags 分组识别 → ChildExecutionGroup 组内流式）。
 */
export function bufferChildStreamDelta<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
  scope: ChildStreamScope,
  messageId: string,
  channel: 'text' | 'reasoning' | 'tool',
  delta: string,
  toolName?: string,
): void {
  const base = asBaseStore(store);
  if (base.getState().agentSessionId !== sessionId) return; // 非活跃视图：不建占位（切回 fetch 对账）

  let entry = streamBuffers.get(messageId);
  if (!entry) {
    // 废弃规则（child 维度）：同 childSessionId 上一占位随新流到达而废弃。
    const prevId = activeChildStreamByChildSession.get(scope.childSessionId);
    if (prevId && prevId !== messageId) {
      streamBuffers.delete(prevId);
      removeStreamingPlaceholder(base, sessionId, prevId);
    }
    entry = { sessionId, text: '', reasoning: '', tag: childTagPrefix(scope), lastDeltaAt: Date.now() };
    streamBuffers.set(messageId, entry);
    activeChildStreamByChildSession.set(scope.childSessionId, messageId);
    createChildPlaceholder(base, sessionId, messageId, scope);
  }
  if (channel === 'text') entry.text += delta;
  else if (channel === 'reasoning') entry.reasoning += delta;
  // R2 #30：tool 通道同 leader 路径——活性 + 首块工具名标记（组内子代理消息同样渲染指示）。
  else if (toolName && entry.toolName !== toolName) {
    entry.toolName = toolName;
    markStreamingTool(base, sessionId, messageId, toolName);
  }
  entry.lastDeltaAt = Date.now();
  ensureFlushTimer(base);
}

/** 首条 child delta 建占位（content = 分组前缀——分组识别 + parseChildTag 剥离后正文为空）。 */
function createChildPlaceholder(
  store: StreamBufferStore,
  sessionId: string,
  messageId: string,
  scope: ChildStreamScope,
): void {
  const state = store.getState();
  if (state.agentSessionId !== sessionId) return;
  if (state.agentMessages.some((m) => m.id === messageId)) return;
  const placeholder: AgentMessage = {
    id: messageId,
    role: 'assistant',
    content: childTagPrefix(scope),
    streaming: true,
    createdAt: Date.now(),
  };
  writeState(store, (s) => ({ agentMessages: [...s.agentMessages, placeholder] }));
}

// ── dogfood 第二轮 findings #3（子 agent 派发起点零信号）：started 占位 ──

/**
 * started 占位的合成 messageId 前缀（每派发一个 child 会话恰一个 id：`child-start:<childSessionId>`
 * ——dispatchSubagent 每次派发新建 child 会话，id 天然不撞）。与真实 messageId（runLoop 预分配
 * assistantId 的 UUID）空间隔离。
 */
const CHILD_START_ID_PREFIX = 'child-start:';

function childStartedPlaceholderId(childSessionId: string): string {
  return `${CHILD_START_ID_PREFIX}${childSessionId}`;
}

/**
 * dogfood 第二轮 findings #3：child started 事件（runLoop 启动前起点信号）到达时建 live 占位
 * ——派发到首批 LLM 输出之间（慢首字节端点可达分钟级）的组级「已派发、正在跑」信号。复用
 * createChildPlaceholder（本身幂等——重复 started / 切回重建均安全）+ 占 childSessionId 维度
 * 跟踪表（activeChildStreamByChildSession）。
 *
 * 衔接（废弃路径全覆盖）：
 * - 首批**真 delta** 到达时 bufferChildStreamDelta 的既有废弃规则（prevId 路径）自动删掉 started
 *   占位、无缝接真占位（streaming 语义连续，组不闪断）；
 * - 首批**终帧 assistant**（非流式车道无 delta）由 agentEvents 的 child assistant 分支调
 *   discardChildStartedPlaceholder 显式废弃（settleStreamPlaceholder 不知道 childSessionId，
 *   在分发层丢弃）；
 * - done/error 兜底 purgeSessionStreams 清残余（removeSessionStreamingPlaceholders 按
 *   streaming 标记全清——started 占位恒 streaming:true）。
 *
 * 仅活跃视图会话落 store（mirror bufferChildStreamDelta——后台会话不追，切回 fetch 对账）。
 */
export function ensureChildStartedPlaceholder<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
  scope: ChildStreamScope,
): void {
  const base = asBaseStore(store);
  if (base.getState().agentSessionId !== sessionId) return; // 非活跃视图：不建占位（切回 fetch 对账）
  createChildPlaceholder(base, sessionId, childStartedPlaceholderId(scope.childSessionId), scope);
  activeChildStreamByChildSession.set(scope.childSessionId, childStartedPlaceholderId(scope.childSessionId));
}

/**
 * dogfood 第二轮 findings #3：started 占位的显式废弃（child assistant 终帧到达 = 首批输出已落地，
 * 起点信号使命完成——非流式车道无 delta 废弃路径，不弃则空占位带 caret 滞留到 done/error 兜底，
 * 成「永转假活」）。只清跟踪表仍指向合成 id 的项（真 delta 已接管跟踪时不碰）+ 只删 id 匹配且
 * streaming=true 的占位；占位不存在时零写（legacy 流量 no-op，非派发路径零变化）。
 */
export function discardChildStartedPlaceholder<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
  childSessionId: string,
): void {
  const base = asBaseStore(store);
  const syntheticId = childStartedPlaceholderId(childSessionId);
  if (activeChildStreamByChildSession.get(childSessionId) === syntheticId) {
    activeChildStreamByChildSession.delete(childSessionId);
  }
  removeStreamingPlaceholder(base, sessionId, syntheticId);
}

/** 首条 delta 建占位（幂等：视图切回等场景下同 id 已在列表则不重复插入）。 */
function createPlaceholder(
  store: StreamBufferStore,
  sessionId: string,
  messageId: string,
): void {
  const state = store.getState();
  if (state.agentSessionId !== sessionId) return;
  if (state.agentMessages.some((m) => m.id === messageId)) return;
  const placeholder: AgentMessage = {
    id: messageId,
    role: 'assistant',
    content: '',
    streaming: true,
    createdAt: Date.now(),
  };
  writeState(store, (s) => ({ agentMessages: [...s.agentMessages, placeholder] }));
}

/** 废弃规则删除：只删 id 匹配且 streaming=true 的占位（用户/工具消息不动）。 */
function removeStreamingPlaceholder(
  store: StreamBufferStore,
  sessionId: string,
  messageId: string,
): void {
  const state = store.getState();
  if (state.agentSessionId !== sessionId) return;
  const next = state.agentMessages.filter((m) => !(m.id === messageId && m.streaming === true));
  if (next.length === state.agentMessages.length) return;
  writeState(store, { agentMessages: next });
}

/**
 * 终帧对账（dispatcher assistant 事件调用）：按 id 替换占位为终态消息（透传
 * reasoning/kind/toolCalls，streaming:false——AgentMessageItem renderedHtml 收敛），
 * 无占位则照旧 append（非流式路径零回归）。替换保留占位 createdAt（生成起点更准）。
 */
export function settleStreamPlaceholder<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
  terminal: AgentMessage,
): void {
  const base = asBaseStore(store);
  streamBuffers.delete(terminal.id);
  const active = activeStreamBySession.get(sessionId);
  if (active === terminal.id) activeStreamBySession.delete(sessionId);
  // CR-T1-014：废弃规则补口——同 session 的 assistant 终帧到达时，跟踪表仍指向**另一条**等终帧
  // 占位 = 打回丢弃的废稿占位逃逸（打回后重试走非流式降级成功 → 无新 delta id，S2「新 messageId
  // delta 废弃旧占位」规则不触发）——随终帧一并废弃（删缓冲 + 移除占位），不再滞留到 done/error
  // purge。安全性：leader loop 每 turn generate 严格串行（上一 assistant 终帧落地后才开下一
  // assistantId），终帧 ≠ 跟踪 id 只会出自打回丢弃路径。
  else if (active !== undefined) {
    streamBuffers.delete(active);
    activeStreamBySession.delete(sessionId);
    removeStreamingPlaceholder(base, sessionId, active);
  }
  // dogfood T1 Stage 5：child 终帧同走本对账——child 维度跟踪表按 messageId 反查清理
  //（childSessionId 不在参数面，遍历小表即可；leader/child messageId 互不冲突）。
  for (const [childSid, mid] of activeChildStreamByChildSession) {
    if (mid === terminal.id) activeChildStreamByChildSession.delete(childSid);
  }
  if (streamBuffers.size === 0) stopFlushTimer();

  const state = base.getState();
  if (state.agentSessionId !== sessionId) return; // 后台终帧：占位不在视图（fetch 对账补）
  const index = state.agentMessages.findIndex((m) => m.id === terminal.id);
  // 两分支同款归一：streaming 恒 false（append 分支也显式置位——消费点统一走 === true 判定）。
  const settled: AgentMessage = {
    ...terminal,
    streaming: false,
    // 替换分支保留占位 createdAt（生成起点更准）；append 用事件侧 createdAt。
    ...(index !== -1 ? { createdAt: state.agentMessages[index].createdAt } : {}),
  };
  if (index === -1) {
    writeState(base, (s) => ({ agentMessages: [...s.agentMessages, settled] }));
    return;
  }
  writeState(base, (s) => ({
    agentMessages: s.agentMessages.map((m) => (m.id === terminal.id ? settled : m)),
  }));
}

/**
 * dogfood T1 CR-T1-029：会话删除时修剪模块级缓冲（无 store 面——视图消息若属该会话由
 * deleteAgentSession 的整段清理负责）。清该 session 的全部缓冲条目 + leader/child 跟踪表。
 */
export function forgetSessionStreams(sessionId: string): void {
  for (const [messageId, entry] of streamBuffers) {
    if (entry.sessionId === sessionId) streamBuffers.delete(messageId);
  }
  if (activeStreamBySession.has(sessionId)) activeStreamBySession.delete(sessionId);
  for (const [childSid, mid] of activeChildStreamByChildSession) {
    const entry = streamBuffers.get(mid);
    if (!entry || entry.sessionId === sessionId) activeChildStreamByChildSession.delete(childSid);
  }
  if (streamBuffers.size === 0) stopFlushTimer();
}

/**
 * done/error 兜底：清该 session 全部缓冲 + 移除等不到终帧的残余占位（打回丢弃的
 * response 已流 delta、run 却直接结束——占位内容是「被要求重做」的废稿，应移除；
 * 移除后 done 对账 fetch 长度差触发权威替换）。
 */
export function purgeSessionStreams<S extends StreamBufferState>(
  store: StreamBufferStore<S>,
  sessionId: string,
): void {
  for (const [messageId, entry] of streamBuffers) {
    if (entry.sessionId === sessionId) streamBuffers.delete(messageId);
  }
  if (activeStreamBySession.get(sessionId) !== undefined) activeStreamBySession.delete(sessionId);
  // dogfood T1 Stage 5：child 维度跟踪表同步清（该 leader session 的全部 child 占位随
  // done/error 兜底移除——removeSessionStreamingPlaceholders 按 streaming 标记全清）。
  for (const [childSid, mid] of activeChildStreamByChildSession) {
    const entry = streamBuffers.get(mid);
    if (!entry || entry.sessionId === sessionId) activeChildStreamByChildSession.delete(childSid);
  }
  if (streamBuffers.size === 0) stopFlushTimer();
  removeSessionStreamingPlaceholders(asBaseStore(store), sessionId);
}

function removeSessionStreamingPlaceholders(
  store: StreamBufferStore,
  sessionId: string,
): void {
  const state = store.getState();
  if (state.agentSessionId !== sessionId) return;
  const next = state.agentMessages.filter((m) => m.streaming !== true);
  if (next.length === state.agentMessages.length) return;
  writeState(store, { agentMessages: next });
}

/**
 * 250ms flush：缓冲累积 → 占位消息 content/reasoning（新消息对象，memo 友好）。
 * 仅活跃视图条目写 store；无变化跳过写（防空转 set）。缓冲空 → 停计时器。
 *
 * - CR-T1-037：缓冲非空但占位缺失（切走切回 fetch 整体替换 / done 对账整体替换两形态触发）
 *   → 重建占位——否则同 messageId 后续 delta 命中冻结 entry 永跳过（index===-1 continue），
 *   分钟级生成切回后正文冻结到终帧一次性倾倒。终帧已落地的非流式形态不重建（防重复消息）。
 * - CR-T1-038a：60s（STREAM_STALL_MS）无新 delta → 占位标 stalled（AgentMessageItem 停滞
 *   提示）；lastDeltaAt 随新 delta 刷新，停滞恢复后下一窗摘标。
 */
function flushStreamBuffers(store: StreamBufferStore): void {
  const state = store.getState();
  const activeSessionId = state.agentSessionId;
  const now = Date.now();
  let messages: AgentMessage[] | null = null;
  for (const [messageId, entry] of streamBuffers) {
    if (entry.sessionId !== activeSessionId) continue; // 视图已切走：占位不在 store，留缓冲待终帧/purge
    const base: AgentMessage[] = messages ?? state.agentMessages;
    const index = base.findIndex((m) => m.id === messageId && m.streaming === true);
    if (index === -1) {
      // 同 id 消息已以非流式形态存在（终帧已落地）——勿重建（settle 已清缓冲，belt 防重复）。
      if (base.some((m) => m.id === messageId)) continue;
      const revivedContent = entry.tag
        ? (entry.text ? `${entry.tag} ${entry.text}` : entry.tag)
        : entry.text;
      if (!revivedContent && !entry.reasoning) continue;
      const revived: AgentMessage = {
        id: messageId,
        role: 'assistant',
        content: revivedContent,
        streaming: true,
        ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
        ...(entry.toolName ? { streamingToolName: entry.toolName } : {}),
        createdAt: now,
      };
      messages = [...base, revived];
      continue;
    }
    const current = base[index];
    // dogfood T1 Stage 5：child 条目 content 拼回分组前缀（占位在组内的分组识别不因
    // flush 重建而断流；text 空 = 纯前缀，与占位建立时同形）。
    const nextContent = entry.tag
      ? (entry.text ? `${entry.tag} ${entry.text}` : entry.tag)
      : entry.text;
    const stalled = now - entry.lastDeltaAt >= STREAM_STALL_MS;
    if (
      current.content === nextContent
      && (current.reasoning ?? '') === entry.reasoning
      && (current.stalled === true) === stalled
    ) continue;
    const { stalled: _prevStalled, ...rest } = current;
    const updated: AgentMessage = {
      ...rest,
      content: nextContent,
      ...(entry.reasoning ? { reasoning: entry.reasoning } : {}),
      ...(stalled ? { stalled: true } : {}),
    };
    messages = base.map((m, i) => (i === index ? updated : m));
  }
  if (messages) writeState(store, { agentMessages: messages });
  if (streamBuffers.size === 0) stopFlushTimer();
}
