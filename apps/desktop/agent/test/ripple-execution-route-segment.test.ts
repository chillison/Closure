import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 4.1：涟漪执行路由引导 segment 注入测试。
//
// Phase 4.1 在 buildInteractionModeSegment 末尾（stale 段之后）追加「执行路由引导」段——
// 仅当有 stale 时注入。引导 leader 按 impactType + autonomy 轴路由到既有工具
// （scene_graph_update / field_update / write_chapter / dismiss_stale_fields），非新建执行器。
//
// 测四态：
// 1. has stale → 含执行路由引导 + impactType 路由分类 + dismiss_stale_fields + autonomy 映射。
// 2. no stale / degraded → 不含执行路由引导段（仅 stale 段，无执行段）。
// 3. autonomy 映射三档（auto / suggest / readonly）→ 含对应权限 hint。
// 4. present_result 收尾契约在执行段末（mirror 涟漪流程收尾）。
//
// 测试方法：buildInteractionModeSegment 非 exported → 经 sendMessage end-to-end 验
// （generate mock 收 system prompt 断言含期望文本，mirror stale-fields-segment.test.ts 模式）。
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

describe('Story 3.4 Phase 4.1 — 涟漪执行路由引导 segment injection', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-ripple-route-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    try { rmSync(projectPath, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    vi.resetModules();
  });

  /** Write a project.yaml with the given field_metadata stale map + optional permissionMode hint. */
  function writeProjectYaml(staleFields: string[]) {
    const fm: Record<string, { stale: boolean }> = {};
    for (const f of staleFields) {
      fm[f] = { stale: true };
    }
    writeFileSync(
      path.join(projectPath, 'project.yaml'),
      JSON.stringify({ name: 'Test', field_metadata: fm }),
      'utf-8',
    );
  }

  /** Build runtime with given permissionMode + capture system prompt via generate mock. */
  async function captureSystemPrompt(permissionMode?: 'readonly' | 'suggest' | 'auto') {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    let capturedSystem = '';
    const generate = vi.fn(async (_messages: unknown, system: string) => {
      capturedSystem = system;
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({
      agentName: 'writer',
      projectPath,
      ...(permissionMode ? { mode: permissionMode } : {}),
    });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check impact.',
      abortSignal: new AbortController().signal,
    });
    return capturedSystem;
  }

  it('has stale：含执行路由引导段 + impactType 分类路由 + dismiss_stale_fields + present_result 收尾', async () => {
    writeProjectYaml(['scene_graph']);

    const system = await captureSystemPrompt();

    // 执行路由引导段标题。
    expect(system).toContain('涟漪执行路由');
    // impactType 分类路由（conflict/contradiction / stale-derivative / opportunity / no-impact/no-events）。
    expect(system).toContain('conflict');
    expect(system).toContain('contradiction');
    expect(system).toContain('stale-derivative');
    expect(system).toContain('opportunity');
    expect(system).toContain('no-impact');
    // 涉及正文 → Epic 7 定点修路径（write_chapter + revisionIntent）。
    expect(system).toContain('write_chapter');
    expect(system).toContain('revisionIntent');
    // dismiss 通路（clearStale dismiss）。
    expect(system).toContain('dismiss_stale_fields');
    // 既有 field_update 工具指引（非新建执行器）。
    expect(system).toContain('scene_graph_update');
    expect(system).toContain('outline_update');
    // 冲突灰区两选项（V1 文字两选项 + adjudicator 专属派发根 TODO）。
    expect(system).toContain('两选项');
    expect(system).toContain('TODO');
    // present_result 收尾契约。
    expect(system).toContain('present_result');
    expect(system).toContain('awaiting_intent_confirmation');
  });

  it('no stale（全最新）：不含执行路由引导段（仅 stale 段「均为最新」）', async () => {
    writeProjectYaml([]);

    const system = await captureSystemPrompt();

    // stale 段在（「均为最新」）。
    expect(system).toContain('均为最新');
    // 执行路由引导段不在（无 stale 无需路由）。
    expect(system).not.toContain('涟漪执行路由');
  });

  it('degraded（project.yaml 不可读）：不含执行路由引导段', async () => {
    // 不写 project.yaml → readFile 失败 → loadStaleFieldsForLeader 返 null。
    const system = await captureSystemPrompt();

    // stale 段降级提示在。
    expect(system).toContain('stale 状态暂不可用');
    // 执行路由引导段不在。
    expect(system).not.toContain('涟漪执行路由');
  });

  it('autonomy=auto → 执行路由段含「全权模式」+ 直接执行 hint', async () => {
    writeProjectYaml(['scene_graph']);
    const system = await captureSystemPrompt('auto');
    expect(system).toContain('全权模式');
    expect(system).toContain('直接调 bounded-action 工具');
  });

  it('autonomy=suggest → 执行路由段含「半自动模式」+ PatchReview hint', async () => {
    writeProjectYaml(['scene_graph']);
    const system = await captureSystemPrompt('suggest');
    expect(system).toContain('半自动模式');
    expect(system).toContain('PatchReview');
  });

  it('autonomy=readonly → 执行路由段含「微操模式」+ 只提建议 hint', async () => {
    writeProjectYaml(['scene_graph']);
    const system = await captureSystemPrompt('readonly');
    expect(system).toContain('微操模式');
    expect(system).toContain('只提建议');
  });
});
