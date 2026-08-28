import { describe, expect, it } from 'vitest';
import {
  computeAffectedFields,
  markStaleFields,
  clearStaleFields,
} from '../src/contracts/workflow-sync';
import type { CreativeFieldKey } from '../src/contracts/creative-fields';

describe('workflow-sync DEPENDENCY_EDGES + stale 管理', () => {
  describe('computeAffectedFields（BFS 传递闭包）', () => {
    it('改 asset_cards → 下游含 world_setting / outline / scene_graph 等', () => {
      const affected = computeAffectedFields('asset_cards');
      expect(affected).toContain('world_setting');
      expect(affected).toContain('outline');
      expect(affected).toContain('episode_outlines');
      expect(affected).toContain('growth_curve');
      expect(affected).toContain('scene_graph');
    });

    it('改 outline → 下游含 scene_graph（Story 3.4 新边）', () => {
      const affected = computeAffectedFields('outline');
      expect(affected).toContain('scene_graph');
      expect(affected).toContain('growth_curve');
      expect(affected).toContain('pacing_curve');
      expect(affected).toContain('emotion_curve');
      expect(affected).toContain('episode_outlines');
    });

    it('改 world_setting → 下游含 scene_graph（Story 3.4 新边）', () => {
      const affected = computeAffectedFields('world_setting');
      expect(affected).toContain('scene_graph');
      expect(affected).toContain('outline');
    });

    it('改 relationship_graph → 下游含 scene_graph（Story 3.4 新边）', () => {
      const affected = computeAffectedFields('relationship_graph');
      expect(affected).toContain('scene_graph');
    });

    it('改 scene_graph → 无下游（scene_graph 是叶节点）', () => {
      const affected = computeAffectedFields('scene_graph');
      expect(affected).not.toContain('scene_graph');
      expect(affected).toHaveLength(0);
    });

    it('传递闭包：改 asset_cards → scene_graph 经多路径可达但不重复', () => {
      // asset_cards → outline → scene_graph（经 outline）
      // asset_cards → world_setting → scene_graph（经 world_setting）
      // asset_cards → scene_graph（直连）
      const affected = computeAffectedFields('asset_cards');
      expect(affected).toContain('scene_graph');
      // 多条路径不应重复
      expect(affected.filter((f) => f === 'scene_graph')).toHaveLength(1);
    });
  });

  describe('markStaleFields（累加标记）', () => {
    it('改 world_setting → stale 候选含 scene_graph', () => {
      const stale = markStaleFields([], 'world_setting');
      expect(stale).toContain('scene_graph');
      expect(stale).toContain('outline');
    });

    it('已有 stale 不丢（累加）', () => {
      const stale = markStaleFields(['episode_outlines'], 'outline');
      expect(stale).toContain('episode_outlines');
      expect(stale).toContain('scene_graph');
    });
  });

  describe('clearStaleFields（Story 3.4 C-A3，markStaleFields 对偶）', () => {
    it('从 currentStale 中移除 resolved 字段', () => {
      const result = clearStaleFields(
        ['outline', 'scene_graph', 'episode_outlines'] as CreativeFieldKey[],
        ['scene_graph'] as CreativeFieldKey[],
      );
      expect(result).toEqual(['outline', 'episode_outlines']);
    });

    it('一次 resolve 多个字段', () => {
      const result = clearStaleFields(
        ['outline', 'scene_graph', 'episode_outlines'] as CreativeFieldKey[],
        ['outline', 'episode_outlines'] as CreativeFieldKey[],
      );
      expect(result).toEqual(['scene_graph']);
    });

    it('resolved 含不在 currentStale 中的字段时安全（幂等，不报错）', () => {
      const result = clearStaleFields(
        ['outline'] as CreativeFieldKey[],
        ['scene_graph', 'episode_outlines'] as CreativeFieldKey[],
      );
      expect(result).toEqual(['outline']);
    });

    it('不改入参（纯函数）', () => {
      const input: CreativeFieldKey[] = ['outline', 'scene_graph'];
      clearStaleFields(input, ['outline']);
      expect(input).toEqual(['outline', 'scene_graph']);
    });

    it('清空所有 stale', () => {
      const result = clearStaleFields(
        ['outline', 'scene_graph', 'episode_outlines'] as CreativeFieldKey[],
        ['outline', 'scene_graph', 'episode_outlines'] as CreativeFieldKey[],
      );
      expect(result).toEqual([]);
    });

    it('空 currentStale → 空（noop）', () => {
      const result = clearStaleFields(
        [] as CreativeFieldKey[],
        ['outline'] as CreativeFieldKey[],
      );
      expect(result).toEqual([]);
    });
  });
});
