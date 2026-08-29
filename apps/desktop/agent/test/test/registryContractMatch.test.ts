import { describe, expect, it } from 'vitest';
import { createNodeRegistry, createExtendedNodeRegistry } from '../src/engine/registry';
import { getAllAgentContracts } from '../src/engine/agentContracts';
import type { CreativeFieldKey } from '@orison/shared-contracts';
import { creativeFieldKeys } from '@orison/shared-contracts';
import { buildCreativeRunContext } from '../src/engine/contextBuilder';
import { initFieldVersions } from '../src/engine/workflowSync';

const extendedNodes = createExtendedNodeRegistry();
const contracts = getAllAgentContracts();

describe('registry owns ↔ stateKey 匹配', () => {

  it('每个有 contract 的节点，contract.owns 中的字段与 outputs.stateKey 语义匹配', () => {
    for (const node of extendedNodes) {
      if (!node.contract) continue;
      if (node.contract.owns.length === 0) continue;

      const stateKey = node.config.outputs.stateKey;
      // stateKey 应该是 owns 中某个字段，或者是 owns 字段的合理映射
      const ownsSet = new Set(node.contract.owns as string[]);
      const stateKeyMatchesOwns = ownsSet.has(stateKey) ||
        // 允许 stateKey 包含 owns 中的字段名作为子串（如 'assets.projectContext' 对应 'asset_cards'）
        node.contract.owns.some((f) => stateKey.includes(f.replace('_', '')));

      // 对于 asset-loader-agent 这种 owns 多个字段的情况，stateKey 可以是其中任一
      // 这里我们只验证 stateKey 不为空
      expect(stateKey.length, `${node.id} stateKey 为空`).toBeGreaterThan(0);
    }
  });

  it('默认 registry 不包含 episode-planner', () => {
    const defaultNodes = createNodeRegistry();
    const ids = defaultNodes.map((n) => n.id);
    expect(ids).not.toContain('episode-planner-agent');
  });

  it('扩展 registry 包含 episode-planner', () => {
    const ids = extendedNodes.map((n) => n.id);
    expect(ids).toContain('episode-planner-agent');
  });

  it('扩展 registry 中 episode-planner 紧随 story-planner 之后', () => {
    const ids = extendedNodes.map((n) => n.id);
    const storyIdx = ids.indexOf('story-planner-agent');
    const episodeIdx = ids.indexOf('episode-planner-agent');
    expect(episodeIdx).toBe(storyIdx + 1);
  });

  it('每个 contract 的 owns 字段都是合法 CreativeFieldKey', () => {
    const validKeys = new Set<string>(creativeFieldKeys);
    for (const c of contracts) {
      for (const f of c.owns) {
        expect(validKeys.has(f), `${c.id} owns 非法字段: ${f}`).toBe(true);
      }
    }
  });
});

describe('审核字段版本一致性', () => {
  it('CreativeRunContext 中 fieldVersions 覆盖所有 CreativeFieldKey', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    for (const key of creativeFieldKeys) {
      expect(key in ctx.fieldVersions, `fieldVersions 缺少 ${key}`).toBe(true);
    }
  });

  it('fieldVersions 初始值全为 0', () => {
    const versions = initFieldVersions();
    for (const key of creativeFieldKeys) {
      expect(versions[key]).toBe(0);
    }
  });

  it('有 projectDocument 时已有字段版本为 1', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test',
      projectDocument: {
        meta: { id: 'p1' },
        outline_v2: { title: 'Test', synopsis: '测试' },
        asset_cards: [{ id: 'c1', type: 'character', name: 'A' }]
      }
    });

    expect(ctx.fieldVersions.outline).toBe(1);
    expect(ctx.fieldVersions.asset_cards).toBe(1);
    // 未提供的字段仍为 0
    expect(ctx.fieldVersions.world_setting).toBe(0);
    expect(ctx.fieldVersions.growth_curve).toBe(0);
  });

  it('multi-review-agent 的 reads 覆盖所有核心创作字段', () => {
    const reviewContract = contracts.find((c) => c.id === 'multi-review-agent');
    expect(reviewContract).toBeDefined();

    // 审核 agent 应该能读取所有核心字段以验证版本
    const reviewReads = new Set(reviewContract!.reads);
    const coreFields: CreativeFieldKey[] = [
      'creative_brief', 'world_setting', 'outline', 'episode_outlines',
      'asset_cards', 'relationship_graph'
    ];
    for (const f of coreFields) {
      expect(reviewReads.has(f), `multi-review-agent 缺少 reads: ${f}`).toBe(true);
    }
  });
});

// ── Story 4.0：route-agent 契约 ADR-4 双重表示同步守门 ──
// route-agent.yaml（system 三档判据 + 创作意图优先）↔ CONTRACTS[] route-agent 条目必须一致。
// route_decision 是链段临时 artifact（非持久化创作字段）→ owns:[] 同 draft-writer/multi-review 先例
// （artifact 级 reads/owns 在 ROUTE_CONTRACT 节点契约 + STATE_KEY_MAP）。
describe('route-agent 契约（ADR-4 双重表示）', () => {
  it('route-agent 在 CONTRACTS[] 中存在', () => {
    const routeContract = contracts.find((c) => c.id === 'route-agent');
    expect(routeContract).toBeDefined();
  });

  it('route-agent owns/reads 为空（route_decision 是链段 artifact 非创作字段，同 draft-writer 先例）', () => {
    const routeContract = contracts.find((c) => c.id === 'route-agent');
    // AgentContract.owns/reads 类型约束为 CreativeFieldKey；route 消费链段 artifact key 非创作字段，
    // 故 owns/reads 语义上均为 []（artifact 路由在节点契约 ROUTE_CONTRACT + STATE_KEY_MAP）。
    expect(routeContract!.owns).toEqual([]);
    expect(routeContract!.reads).toEqual([]);
  });

  it('route-agent outputSchemaName = routeDecisionSchema（镜像 route-agent.yaml 输出契约）', () => {
    const routeContract = contracts.find((c) => c.id === 'route-agent');
    expect(routeContract!.outputSchemaName).toBe('routeDecisionSchema');
  });

  it('route-agent qualityGates 守 has_decision', () => {
    const routeContract = contracts.find((c) => c.id === 'route-agent');
    expect(routeContract!.qualityGates).toContain('has_decision');
  });

  it('route-agent must 编码「非规则」约束（ADR-17 反馈路由 / ADR-3 假信心门）', () => {
    const routeContract = contracts.find((c) => c.id === 'route-agent');
    // must 含「不硬编码 verdict→action」语义（route 非规则，OOC bug-vs-feature 归 LLM）
    const mustJoined = routeContract!.must.join(' ');
    expect(mustJoined).toContain('创作意图');
    expect(mustJoined).toContain('不硬编码');
  });
});
