import { mkdtempSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.7 S9：loadMentionSignalsForLeader + buildInteractionModeSegment
// 出场账对拍信号注入段测试（mirror arc-coverage-segment.test.ts）。
//
// 覆盖：
// 1. 管线能力段静态句（实体目录 + 出场史可翻——S9 接线面交付 4）。
// 2. 信号段三态（mirror 结构健康度三态）：has（信号行 + 处置指向——alias→asset_cards_update 建议指向）
//    / no（近期章全对上或账未建立）/ degraded（query_mentions 未注册→暂不可用）。
//
// 测试方法：loader 非 exported → 经 sendMessage end-to-end 验（generate mock 收 system prompt 断言，
// mirror arc-coverage-segment.test.ts）。信号数据源 = 真 registry 注册 fake query_mentions
// （view='signals' metadata 形态 mirror catalogHandlers 实产）——「loader 读落表值」的取数契约在此锚定
// （信号持久化本身的 db round-trip 在 shell mentionLedger* Electron 真跑 suite 锚定）。
// ─────────────────────────────────────────────────────────────────────────────

describe('Story 8.7 S9 — 实体与出场账能力句 + 出场账对拍信号段注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-mention-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmBestEffort(projectPath);
    vi.resetModules();
  });

  /** 在真 registry 注册 fake query_mentions（signals 视图 metadata 形态 mirror catalogHandlers 实产）。 */
  async function registerQueryMentionsSignals(
    episodes: Array<{ episodeId: string; signals: unknown[] }>,
  ): Promise<void> {
    const { registry } = await import('../src/tool/registry');
    const { z } = await import('zod');
    registry.register({
      id: 'query_mentions',
      description: 'fake query_mentions',
      parameters: z.object({}),
      execute: async () => ({
        title: 'query_mentions: signals',
        output: '',
        metadata: { ok: true, view: 'signals', episodes },
      }),
    });
  }

  async function runTurn(expectSystem: (system: string) => void): Promise<void> {
    const { createWorkflowRuntime } = await import('../src/runtime/workflow');
    const generate = vi.fn(async (_messages: unknown, system: string) => {
      expectSystem(system);
      return { content: 'ok', finishReason: 'stop' };
    });
    const runtime = createWorkflowRuntime({ generate });
    const session = runtime.createSession({ agentName: 'writer', projectPath });
    await runtime.sendMessage({
      sessionId: session.id,
      content: 'Check cast ledger.',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── 能力段静态句（S9 接线面交付 4——与段内既有句式一致，无条件注入）──

  it('管线能力段含实体与出场账句（目录可查 + 出场史可翻 + 先翻账再动笔）', async () => {
    // 不注册 query_mentions——能力句是静态注入，与信号段数据态无关。
    await runTurn((system) => {
      expect(system).toContain('实体与出场账可翻');
      expect(system).toContain('catalog_entries');
      expect(system).toContain('query_mentions');
      expect(system).toContain('先翻账再动笔');
    });
  });

  // ── 信号段三态（mirror 结构健康度 has/no/degraded）──

  it('has：近期章有信号 → 注入信号行 + 处置指向（alias 建议→asset_cards_update；新面孔不自动建卡）', async () => {
    await registerQueryMentionsSignals([
      {
        episodeId: 'ep-5',
        signals: [
          { kind: 'alias_suggestion', episodeId: 'ep-5', name: '三师叔', entryId: 'card-li' },
          { kind: 'hard_miss', episodeId: 'ep-5', entryId: 'card-wang' },
        ],
      },
      { episodeId: 'ep-4', signals: [] }, // 零信号章被 loader 滤除
    ]);
    await runTurn((system) => {
      expect(system).toContain('出场账对拍信号');
      expect(system).toContain('申报与实际落笔对账');
      // 信号行（describeMentionSignal 单源文案）。
      expect(system).toContain('三师叔');
      expect(system).toContain('card-li');
      expect(system).toContain('card-wang');
      expect(system).toContain('没把他报进本章人物表');
      // 处置指向：alias → asset_cards_update（默认先呈作者确认）；新面孔 → 创作决定归作者。
      expect(system).toContain('asset_cards_update');
      expect(system).toContain('不自动建');
      expect(system).toContain('先呈作者确认');
    });
  });

  it('no：近期章全无信号 → 「已检查过全对上」graceful 句（含账未建立提示，非静默）', async () => {
    await registerQueryMentionsSignals([]);
    await runTurn((system) => {
      expect(system).toContain('出场账对拍信号');
      expect(system).toContain('全部对得上');
      expect(system).toContain('出场账尚未随写作建立');
    });
  });

  it('degraded：query_mentions 未注册 → 「暂不可用」单行（非静默，leader 知道没查）', async () => {
    await runTurn((system) => {
      expect(system).toContain('出场账对拍信号：暂不可用');
      expect(system).not.toContain('全部对得上');
    });
  });

  it('BMad CR-007 silent：项目未注册 → 信号段零注入（常态非降级，不产「暂不可用」噪音行）', async () => {
    // handler notRegistered 实产形态：ok:false + reason='project_not_registered'。
    const { registry } = await import('../src/tool/registry');
    const { z } = await import('zod');
    registry.register({
      id: 'query_mentions',
      description: 'fake query_mentions',
      parameters: z.object({}),
      execute: async () => ({
        title: 'query_mentions: signals',
        output: '当前项目未注册到数据库，无法访问出场账。',
        metadata: { ok: false, reason: 'project_not_registered' },
      }),
    });
    await runTurn((system) => {
      // 静默：无信号段任何形态（has 行 / no 行 / 降级行都不出现）。他段（弧覆盖等）自有「暂不可用」
      // 措辞，断言锚「出场账对拍信号」前缀防误伤。
      expect(system).not.toContain('出场账对拍信号');
      expect(system).not.toContain('出场账对拍信号：暂不可用');
      // 静态能力句不受影响（另一段，无条件注入）。
      expect(system).toContain('实体与出场账可翻');
    });
  });

  it('has 截断标注：信号超 8 条 → 前 8/共 N（mirror Edge-002 防幻影回归）', async () => {
    const signals = Array.from({ length: 10 }, (_, i) => ({
      kind: 'hard_miss',
      episodeId: 'ep-5',
      entryId: `char-${i}`,
    }));
    await registerQueryMentionsSignals([{ episodeId: 'ep-5', signals }]);
    await runTurn((system) => {
      expect(system).toContain('此处列前 8 条 / 共 10 条');
      // 第 9/10 条不注入（截断防段膨胀）。
      expect(system).not.toContain('char-8');
      expect(system).not.toContain('char-9');
    });
  });
});
