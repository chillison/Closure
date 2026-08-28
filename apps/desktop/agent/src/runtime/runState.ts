import type { WorkflowRunStatus } from '../types';
import type { RunSnapshot } from '../contracts/run';

// Story 4.0（ADR-17）：stage 扩节点级 checkpoint（brief 落定 / draft 入库前 / verdict 分叉）。
// union 扩向后兼容——既有 'loop'（session 级粗粒度）仍合法，workflow.ts:654 字符串拼接对新 stage
// 同样工作。三类设点（design §4.6）：brief-compiler 后 'brief' / draft-writer 后 'draft' /
// route 后 'verdict'。pause-at-checkpoint 行为（半自动）= Story 4.3 模式配置（4.0 全自动默认不 pause，
// 只 resumable-abort）。
export type RunCheckpointStage = 'loop' | 'brief' | 'draft' | 'verdict' | 'revision-guard';

export interface RunCheckpoint {
  sessionId: string;
  stage: RunCheckpointStage;
  createdAt: number;
  reason: 'aborted' | 'resume_requested';
}

export interface RunStateSnapshot {
  sessionId: string;
  status: WorkflowRunStatus;
  startedAt?: number;
  updatedAt: number;
  error?: string;
  checkpoint?: RunCheckpoint;
  /**
   * 写章链段 RunSnapshot（ADR-17「RunSnapshot + 编排状态一起持久」）。resume 时恢复
   * artifacts + completedNodes。4.0 in-memory 持久（resume 跨 abort 不跨进程重启）；
   * disk 持久 follow-up（design §4.6 / §6 tradeoffs 记档）。
   *
   * 由 chainRunner（Step 4）经 checkpoint 回调写入；本 Step 1 仅预留字段 + 在生命周期重建时
   * 保留既有值（abort→resume 不丢链段状态）。type-only import 避免循环（contracts/run.ts 无反向依赖）。
   */
  chainSnapshot?: RunSnapshot;
}

interface ActiveRun {
  controller: AbortController;
  checkpoint?: RunCheckpoint;
}

export class SessionRunAlreadyActiveError extends Error {
  constructor(sessionId: string) {
    super(`run already active for session "${sessionId}"`);
  }
}

export class RunStateStore {
  private readonly snapshots = new Map<string, RunStateSnapshot>();
  private readonly activeRuns = new Map<string, ActiveRun>();

  beginRun(sessionId: string, externalAbort?: AbortSignal): AbortSignal {
    const current = this.snapshots.get(sessionId);
    if (current?.status === 'running' || this.activeRuns.has(sessionId)) {
      throw new SessionRunAlreadyActiveError(sessionId);
    }

    const controller = new AbortController();
    if (externalAbort) {
      if (externalAbort.aborted) {
        controller.abort(externalAbort.reason);
      } else {
        externalAbort.addEventListener('abort', () => controller.abort(externalAbort.reason), { once: true });
      }
    }

    this.activeRuns.set(sessionId, { controller });
    // Story 4.3 / CR-2：beginRun 保留既有 chainSnapshot（与其他生命周期方法 completeRun/failRun/
    // abortRun/markAborted/resumeRun 一致——本字段 :30-31 文档意图「生命周期重建时保留既有值」）。
    // resume 跨 turn：pause 结束 turn → resume 是新 turn（新 beginRun）→ 若不保留，chainSnapshot 被
    // 清→getChainSnapshot 读 undefined→降级从头跑（CR-2 闭环在生产跨 turn 断）。chainSnapshot 只在
    // 显式 resume directive 时被读，保留无害（新链段 onCheckpoint 覆盖写）。
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      chainSnapshot: this.snapshots.get(sessionId)?.chainSnapshot,
    });
    return controller.signal;
  }

  completeRun(sessionId: string): void {
    this.activeRuns.delete(sessionId);
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'completed',
      startedAt: this.snapshots.get(sessionId)?.startedAt,
      updatedAt: Date.now(),
      checkpoint: this.snapshots.get(sessionId)?.checkpoint,
      chainSnapshot: this.snapshots.get(sessionId)?.chainSnapshot,
    });
  }

  failRun(sessionId: string, error: string): void {
    this.activeRuns.delete(sessionId);
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'error',
      startedAt: this.snapshots.get(sessionId)?.startedAt,
      updatedAt: Date.now(),
      error,
      checkpoint: this.snapshots.get(sessionId)?.checkpoint,
      chainSnapshot: this.snapshots.get(sessionId)?.chainSnapshot,
    });
  }

  abortRun(sessionId: string): boolean {
    const active = this.activeRuns.get(sessionId);
    if (!active) return false;

    const checkpoint: RunCheckpoint = {
      sessionId,
      stage: 'loop',
      createdAt: Date.now(),
      reason: 'aborted',
    };
    active.checkpoint = checkpoint;
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'aborted',
      startedAt: this.snapshots.get(sessionId)?.startedAt,
      updatedAt: Date.now(),
      checkpoint,
      chainSnapshot: this.snapshots.get(sessionId)?.chainSnapshot,
    });
    active.controller.abort(new DOMException('Aborted', 'AbortError'));
    return true;
  }

  markAborted(sessionId: string, reason: RunCheckpoint['reason'] = 'aborted'): void {
    const checkpoint: RunCheckpoint = {
      sessionId,
      stage: 'loop',
      createdAt: Date.now(),
      reason,
    };
    this.activeRuns.delete(sessionId);
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'aborted',
      startedAt: this.snapshots.get(sessionId)?.startedAt,
      updatedAt: Date.now(),
      checkpoint,
      chainSnapshot: this.snapshots.get(sessionId)?.chainSnapshot,
    });
  }

  resumeRun(sessionId: string): RunCheckpoint | undefined {
    const snapshot = this.snapshots.get(sessionId);
    const checkpoint = snapshot?.checkpoint;
    if (!checkpoint) return undefined;

    this.snapshots.set(sessionId, {
      sessionId,
      status: 'idle',
      startedAt: snapshot?.startedAt,
      updatedAt: Date.now(),
      checkpoint,
      chainSnapshot: snapshot?.chainSnapshot,
    });
    return checkpoint;
  }

  getSnapshot(sessionId: string): RunStateSnapshot | undefined {
    return this.snapshots.get(sessionId);
  }

  /**
   * 写链段 RunSnapshot 到 RunStateStore（Story 4.0 Step 5 persistChainSnapshot 落地点）。
   *
   * chainRunner 的 onCheckpoint 回调（经 runChapterChain → persistChainSnapshot）调用本方法，把链段
   * RunSnapshot 持久到 sessionId 下（ADR-17「RunSnapshot + 编排状态一起持久」）。resume 时从 snapshot
   * 恢复 artifacts + completedNodes（resumedCompletedNodes）。
   *
   * 4.0 in-memory 持久（resume 跨 abort 不跨进程重启）；disk 持久 follow-up（design §4.6 / §6 记档）。
   *
   * 若 sessionId 无既有 RunStateSnapshot（chain 在 SubagentRuntime.dispatch child session 内跑，未走
   * beginRun 生命周期），创建一个 idle 占位 snapshot 持 chainSnapshot——单纯作 chain 状态载体，不参与
   * run 生命周期守卫（child session 的 run 生命周期由 dispatch 管理）。
   */
  setChainSnapshot(sessionId: string, chainSnapshot: RunSnapshot): void {
    const existing = this.snapshots.get(sessionId);
    if (existing) {
      this.snapshots.set(sessionId, {
        ...existing,
        chainSnapshot,
        updatedAt: Date.now(),
      });
      return;
    }
    this.snapshots.set(sessionId, {
      sessionId,
      status: 'idle',
      updatedAt: Date.now(),
      chainSnapshot,
    });
  }

  /**
   * 读链段 RunSnapshot（Story 4.3 Step 1 / CR-2：resume 读回入口）。
   *
   * setChainSnapshot 的读回对应（4.0 只写无读——CR-2 缺口确认，design §3.3 / §10 证据表）。resume 时
   * runChapterChain 调本方法读 parent 会话下的 chainSnapshot → 推导 resumedCompletedNodes +
   * initialArtifacts → 喂 runChain（跳过已完成节点，runChain `:84→completedSet→:113` 已实现 skip 逻辑，
   * 4.0 只单测用，4.3 Step 1 接通生产）。
   *
   * 纯读（无副作用）：返持久 RunSnapshot 的引用；sessionId 无 / 未写过 chainSnapshot → undefined
   * （caller graceful 降级从头跑 + warn 日志，AC7 不静默认错）。in-memory 持久范围同 setChainSnapshot
   * （resume 跨 abort 不跨进程重启，4.0 follow-up 不变）。
   */
  getChainSnapshot(sessionId: string): RunSnapshot | undefined {
    return this.snapshots.get(sessionId)?.chainSnapshot;
  }

  /**
   * Story 4.3 Step 3：清链段 RunSnapshot（abort 入口，design §3.5 / controller resume 设计）。
   *
   * `closure:resume-chapter-chain` action='abort' 调本方法弃链段——从 RunStateSnapshot 清除 chainSnapshot
   * （resume 读回 undefined → 后续若误触发 resume 降级从头跑，AC7 graceful）。纯清（不动其他生命周期字段：
   * status/checkpoint 等保留——abort chain ≠ abort run；leader runLoop 的 run 状态由 abortRun 管）。
   *
   * 返是否有既有 chainSnapshot 被清（caller 可据此出文案「已放弃」/「无可放弃链段」）。
   */
  clearChainSnapshot(sessionId: string): boolean {
    const existing = this.snapshots.get(sessionId);
    if (!existing?.chainSnapshot) return false;
    this.snapshots.set(sessionId, {
      ...existing,
      chainSnapshot: undefined,
      updatedAt: Date.now(),
    });
    return true;
  }
}

const defaultRunStateStore = new RunStateStore();

export function getDefaultRunStateStore(): RunStateStore {
  return defaultRunStateStore;
}
