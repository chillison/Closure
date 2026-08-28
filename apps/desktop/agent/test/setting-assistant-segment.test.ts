import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/skill/discovery', () => ({
  discoverSkills: vi.fn(async () => []),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Story 2.2 WP-A/WP-C：loadSettingCoverageForLeader + buildInteractionModeSegment
// 设定深化引导段 + coverage 三态段注入测试。
//
// 深化段（九条协议文案常驻）+ coverage 三态（mirror 结构健康度/stale 三态模式）：
// 1. has gaps（dangling_ref warning / scene_no_refs info / 截断 top-5+总数）→ 注入缺口消息。
// 2. no gaps（全 refs 命中）→ 「已检查过，无已知设定覆盖缺口」。
// 3. degraded（project.yaml 不可读 / scene_graph 缺 / asset_cards 形态坏）→ 「暂不可用」。
//
// 测试方法：loadSettingCoverageForLeader / buildInteractionModeSegment 非 exported → 经 sendMessage
// end-to-end 验（generate mock 收 system prompt 断言含期望文本，mirror stale-fields-segment.test.ts）。
// ─────────────────────────────────────────────────────────────────────────────

/** 合法 character 卡（过 assetCardsSchema discriminatedUnion）。 */
const CHAR_CARD = {
  id: 'char-1', type: 'character', name: '林动', tier: 'core', summary: '坚韧少年',
  narrative: { storyFunction: '主角' },
  desireAndBottomline: { coreDesire: '变强' },
  personality: { coreTraits: ['坚韧'] },
};

describe('Story 2.2 — 设定深化引导段 + coverage 三态段注入', { timeout: 30_000 }, () => {
  let projectPath = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'orison-setting-segment-'));
  });

  afterEach(async () => {
    const { closeDb } = await import('../src/agent/persistence');
    closeDb(projectPath);
    rmSync(projectPath, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Write a project.yaml fixture（JSON——js-yaml 是 JSON 超集）。 */
  function writeProjectYaml(doc: Record<string, unknown>): void {
    writeFileSync(path.join(projectPath, 'project.yaml'), JSON.stringify(doc), 'utf8');
  }

  /** scene node fixture（assetRefs 可选）。 */
  function scene(id: string, assetRefs?: string[]): Record<string, unknown> {
    return {
      id,
      episodeId: 'ep1',
      storyTime: 0,
      presentationOrder: { chapter: 0, pos: 0 },
      ...(assetRefs ? { assetRefs } : {}),
    };
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
      content: 'Deepen setting.',
      abortSignal: new AbortController().signal,
    });
    expect(generate).toHaveBeenCalledOnce();
  }

  // ── WP-A 深化引导段（常驻注入，九条协议文案）──

  it('深化引导段常驻注入：何时深化 + craft 域路由 + 用途锚 + 三层权威 + 落盘路由 + 档位 + gate 补救 + craft 反哺', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      // 段头（何时深化三触发：作者要深化 / gate needs_world_anchor / coverage 段报缺口）。
      expect(system).toContain('设定深化能力（设定助手）');
      expect(system).toContain('needs_world_anchor');
      // craft 域路由表（CRAFT_TYPE_VOCAB 8 类 slug）+ 查空降级明示。
      expect(system).toContain('query_craft');
      expect(system).toContain("'jinzhishao'");
      expect(system).toContain("'playbook'");
      expect(system).toContain('无此域参考');
      // 用途锚（宁缺毋滥）。
      expect(system).toContain('用途锚');
      expect(system).toContain('不提议');
      // 三层权威内联标注。
      expect(system).toContain('【你已定】');
      expect(system).toContain('【craft 参考】');
      expect(system).toContain('【LLM 建议】');
      // 落盘路由三工具 + locked 告知。
      expect(system).toContain('asset_cards_update');
      expect(system).toContain('genre_contract_update');
      expect(system).toContain('setting_md_update');
      expect(system).toContain('已锁');
      // 档位映射（autoApply / PatchReview / 只文字）。
      expect(system).toContain('autoApply=true');
      expect(system).toContain('PatchReview');
      // gate 补救路由（优先序 + 重跑）。
      expect(system).toContain('题材承诺+主角卡');
      expect(system).toContain('重跑 write_chapter');
      // craft 反哺。
      expect(system).toContain('save_craft_doc');
      // 收尾契约。
      expect(system).toContain('present_result');
    });
  });

  // ── WP-C coverage 三态段 ──

  it('has gaps（dangling_ref warning）：scene 引用不存在的卡 → 注入缺口消息 + 引导补卡', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1', 'card-missing'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      expect(system).toContain('设定覆盖');
      expect(system).toContain('「card-missing」不存在');
      expect(system).toContain('[warning]');
      // 引导接深化段流程 + 修正引用路由。
      expect(system).toContain('asset_cards_update');
    });
  });

  it('has gaps（scene_no_refs info）：场无 assetRefs → 注入 info 弱结构信号', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1')], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      expect(system).toContain('[info]');
      expect(system).toContain('还没有标注涉及');
      // info 不算设定债——修 scene_graph_update。
      expect(system).toContain('scene_graph_update');
    });
  });

  it('截断 top-5 + 总数标注（7 条 dangling → 前 5 / 共 7）', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: {
        nodes: [scene('s1', ['missing-1', 'missing-2', 'missing-3', 'missing-4', 'missing-5', 'missing-6', 'missing-7'])],
        edges: [],
        lines: [],
      },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      expect(system).toContain('此处列前 5 条 / 共 7 条');
      expect(system).toContain('「missing-1」不存在');
      // 第 6/7 条不入 top-5（防 prompt 撑大）。
      expect(system).not.toContain('「missing-6」');
      expect(system).not.toContain('「missing-7」');
    });
  });

  it('no gaps（全 refs 命中）→「已检查过，无已知设定覆盖缺口」graceful 提示', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: [CHAR_CARD],
    });
    await runTurn((system) => {
      expect(system).toContain('已检查过，无已知设定覆盖缺口');
      expect(system).not.toContain('设定覆盖检查暂不可用');
    });
  });

  it('asset_cards 缺省（合法空项目）+ scene refs → 机械真相全 dangling（非降级）', async () => {
    // 无 asset_cards 键 = 合法空（无卡项目）——refs 无处可解析，dangling 是机械真相非误报。
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['ghost-card'])], edges: [], lines: [] },
    });
    await runTurn((system) => {
      expect(system).toContain('「ghost-card」不存在');
      expect(system).not.toContain('设定覆盖检查暂不可用');
    });
  });

  it('degraded（project.yaml 不可读）→「设定覆盖检查暂不可用」声明', async () => {
    // 不写 project.yaml → readFile 失败 → loadSettingCoverageForLeader 返 null → undefined 分支。
    await runTurn((system) => {
      expect(system).toContain('设定覆盖检查暂不可用');
      expect(system).toContain('本轮不提供设定缺口信息');
    });
  });

  it('degraded（scene_graph 缺）→「设定覆盖检查暂不可用」（mirror 结构健康度缺 scene_graph 三态）', async () => {
    writeProjectYaml({ name: 'Test', asset_cards: [CHAR_CARD] });
    await runTurn((system) => {
      expect(system).toContain('设定覆盖检查暂不可用');
    });
  });

  it('degraded（asset_cards 形态坏：非数组）→「设定覆盖检查暂不可用」（不可信数据不判，防误报）', async () => {
    writeProjectYaml({
      name: 'Test',
      scene_graph: { nodes: [scene('s1', ['char-1'])], edges: [], lines: [] },
      asset_cards: { not: 'an array' },
    });
    await runTurn((system) => {
      expect(system).toContain('设定覆盖检查暂不可用');
      // 不产 dangling 误报（「有卡却全报悬空」防线）。
      expect(system).not.toContain('「char-1」不存在');
    });
  });
});
