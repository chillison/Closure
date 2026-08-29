import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { handle, warn, info, getSession } = vi.hoisted(() => ({
  handle: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  // D4 闸所需：sessionId → projectPath 解析（mirror stream-message / execute-skill 的
  // handler 既有形态）。默认 undefined（会话不在内存 → 不闸，seam 自身 false 路径覆盖）；
  // per-test 改返回值驱动「同项目占用 / 空闲」两态。返回类型显式标注（mirror
  // projectRunGate 的 session meta 最小 shape）——否则 vi.fn 推断返回 undefined 字面量，
  // mockReturnValue({...}) 过不了 typecheck。
  getSession: vi.fn(
    (): { id: string; projectPath: string; status: string } | undefined => undefined,
  ),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock('../main/logger', () => ({ getLogger: () => ({ warn, info }) }));

// Mutable stub runtime: agentIpc captures whatever createWorkflowRuntime returned
// at registration time in its module-level `runtime`, so per-test shape changes
// (add / delete manualCompactSession) exercise both seam states without
// re-registering (production registers once for the app lifetime — the
// `registered` guard).
const stubRuntime: Record<string, unknown> = { getSession };

vi.mock('@orison/desktop-agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@orison/desktop-agent')>();
  return {
    ...actual,
    createWorkflowRuntime: vi.fn(() => stubRuntime),
  };
});

// agentIpc only forwards tool executions through handleToolExecute — stub it so
// this file never pulls the full toolHandlers graph.
vi.mock('../main/ipc/toolExecution', () => ({ handleToolExecute: vi.fn() }));

import { registerAgentIpc, acquireProjectRun, getProjectActiveRuns } from '../main/ipc/agentIpc';
import { normalizeProjectKey } from '../main/ipc/pathGuard';
import { _setModelConfigDirForTest } from '../main/ipc/configIpc';

type CompactHandler = (event: unknown, sessionId: string) => Promise<boolean>;

let compactHandler: CompactHandler;

/** D4 用例的项目路径（normalizeProjectKey 纯词法归一，任意确定性路径即可）。 */
const PROJ = '/proj/compact-gate-proj';

/** CR-005 用例的隔离模型目录（防读到真实 ~/.orison/model 的 sidecar）。 */
const TEST_MODEL_DIR = path.join(process.cwd(), 'test-tmp-compact-session');
const SIDECAR = () => path.join(TEST_MODEL_DIR, 'task-models.yaml');

// 08-25 thinking-controls S3：agent:compact-session 三处同步的 shell 侧——防御式
// runtime.manualCompactSession seam 调用（S4 定名 manualCompactSession，避开既有
// legacy 纯函数成员 compactSession 的同名冲突）：
// - 缺位（S4 未落地）→ false + warn（UI 可按 false 呈现「不可用」，不 throw）；
// - 落地 → sessionId 透传、boolean 结果透传；
// - 非 boolean 返回 / seam 抛错 → false（形态漂移守卫 + 模式 A，无 IPC rejection）。
describe('agent:compact-session handler (08-25 manual compaction entry)', () => {
  beforeAll(() => {
    registerAgentIpc(() => null);
    const registered = handle.mock.calls.find(([c]) => c === 'agent:compact-session');
    expect(registered).toBeDefined();
    compactHandler = registered![1] as CompactHandler;
  });

  beforeEach(() => {
    warn.mockReset();
    info.mockReset();
    delete stubRuntime.manualCompactSession;
    getSession.mockReset();
    getSession.mockReturnValue(undefined); // 默认：会话不在内存 → 不闸
    // CR-005：handler 现读 task-models sidecar 解析窗口——模型目录指向空隔离目录
    //（缺省无 sidecar → opts 不传），防读到真实 ~/.orison/model 使断言环境相关。
    _setModelConfigDirForTest(TEST_MODEL_DIR);
    rmBestEffort(TEST_MODEL_DIR);
    mkdirSync(TEST_MODEL_DIR, { recursive: true });
    // 每测前清 D4 注册表（mirror projectRunGate.test 形态——生产只在启动空表，测试直驱
    // 需复位；断言中途失败时防租约泄漏到下一测）。
    for (const key of [...getProjectActiveRuns().keys()]) {
      (getProjectActiveRuns() as Map<string, unknown>).delete(key);
    }
  });

  afterEach(() => {
    _setModelConfigDirForTest(null);
    rmBestEffort(TEST_MODEL_DIR);
  });

  it('runtime without manualCompactSession → false + warn (agent-side S4 batch not landed)', async () => {
    await expect(compactHandler({}, 'sess-1')).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain('not wired');
  });

  it('wired manualCompactSession → sessionId passthrough + true result passthrough', async () => {
    stubRuntime.manualCompactSession = vi.fn(async () => true);
    await expect(compactHandler({}, 'sess-42')).resolves.toBe(true);
    // CR-005：第二参为窗口 opts——隔离目录无 sidecar → undefined（现行为）。
    expect(stubRuntime.manualCompactSession).toHaveBeenCalledWith('sess-42', undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it('wired manualCompactSession returning false (missing session / refused) → false passthrough, no warn', async () => {
    stubRuntime.manualCompactSession = vi.fn(async () => false);
    await expect(compactHandler({}, 'nope')).resolves.toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a non-boolean return (shape drift during the parallel-landing window) → false, never leaks the payload', async () => {
    // Shape-drift guard: whatever lands on the runtime under this name must
    // honor the boolean contract — a wrong payload must not cross the IPC
    // boundary as if it were the contract shape.
    stubRuntime.manualCompactSession = vi.fn(async () => ({ summary: 's' }));
    await expect(compactHandler({}, 'sess-1')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('a throwing seam → false + warn, no IPC rejection', async () => {
    stubRuntime.manualCompactSession = vi.fn(() => {
      throw new Error('session not found');
    });
    await expect(compactHandler({}, 'ghost')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('an async-throwing seam → false + warn, no IPC rejection', async () => {
    stubRuntime.manualCompactSession = vi.fn(async () => {
      throw new Error('compaction failed');
    });
    await expect(compactHandler({}, 'sess-1')).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  // ── D4 per-project run 闸（trellis-check 发现的漏接车道）：手动压缩发起一次 LLM 摘要
  // 调用——同项目链/流/skill 在途时须拒。布尔契约通道 → false + warn（非结构化 rejected，
  // 非 IPC rejection）+ 不调 seam。会话缺失不闸（seam 自身 false 路径覆盖）由上方既有用例
  // （getSession 默认 undefined）钉住。──
  it('D4: lease held by another session in the same project → false + warn, manualCompactSession never called', async () => {
    stubRuntime.manualCompactSession = vi.fn(async () => true);
    getSession.mockReturnValue({ id: 'sess-1', projectPath: PROJ, status: 'idle' });
    // 他 session 同项目占住租约（模拟链/流/skill 在途）。
    const holder = acquireProjectRun(PROJ, 'sess-other');
    expect(holder.ok).toBe(true);

    await expect(compactHandler({}, 'sess-1')).resolves.toBe(false);
    expect(stubRuntime.manualCompactSession).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toContain('another run active');

    if (holder.ok) holder.release();
    expect(getProjectActiveRuns().size).toBe(0);
  });

  it('D4: lease idle → call proceeds with the lease held, released in finally', async () => {
    // 在 seam 执行中观测注册表——钉「acquire 先于调用」而非只在前后各摸一次表。
    let refCountDuringCall = -1;
    stubRuntime.manualCompactSession = vi.fn(async () => {
      refCountDuringCall = getProjectActiveRuns().get(normalizeProjectKey(PROJ))?.refCount ?? 0;
      return true;
    });
    getSession.mockReturnValue({ id: 'sess-1', projectPath: PROJ, status: 'idle' });

    await expect(compactHandler({}, 'sess-1')).resolves.toBe(true);
    expect(stubRuntime.manualCompactSession).toHaveBeenCalledWith('sess-1', undefined);
    expect(refCountDuringCall).toBe(1); // 调用进行中租约确实持有
    expect(getProjectActiveRuns().size).toBe(0); // finally 释放（含本键）
    expect(warn).not.toHaveBeenCalled();
  });

  // ── CR-005（08-25 BMad CR）：窗口解析接线——dialogue 档 assignment（经既有 slot
  // resolver 单源 readTaskModelSlots）的 registry limits.contextWindow 传入 seam；
  // 无指派 / 未知模型（无 limits）→ 不传（= 现行为，seam 回落缺省目标）。删掉接线则
  // 态一断言变红（「窗口盲视」回归——固定 500K 目标治不了小窗模型）。──
  it('CR-005 态一：dialogue 档指派已知 limits 模型（glm-5.1）→ windowTokens = registry 窗口 204800', async () => {
    writeFileSync(
      SIDECAR(),
      ['dialogue.keyId: key_001', 'dialogue.modelId: glm-5.1'].join('\n') + '\n',
      'utf8',
    );
    stubRuntime.manualCompactSession = vi.fn(async () => true);

    await expect(compactHandler({}, 'sess-w1')).resolves.toBe(true);
    expect(stubRuntime.manualCompactSession).toHaveBeenCalledWith('sess-w1', { windowTokens: 204_800 });
  });

  it('CR-005 态二变体：指派未知模型（qwen-max 无 limits）→ opts 同样不传', async () => {
    writeFileSync(
      SIDECAR(),
      ['dialogue.keyId: key_001', 'dialogue.modelId: qwen-max'].join('\n') + '\n',
      'utf8',
    );
    stubRuntime.manualCompactSession = vi.fn(async () => true);

    await expect(compactHandler({}, 'sess-w3')).resolves.toBe(true);
    expect(stubRuntime.manualCompactSession).toHaveBeenCalledWith('sess-w3', undefined);
  });
});
