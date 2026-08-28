/**
 * Story 8.5 Step 5 builtin registration + classification tests — arc-pipeline write trio
 * （mirror builtin-curation.test.ts）。
 *
 * B01 三处同步 checklist（agent-tools.md）的可测面：
 * - tool ids MUST match the shell handler registrations in toolExecution.ts（remoteToolProxy 按 id
 *   路由）——本 suite 锁 id + zod surface；shell 侧 register 与 UI WRITE_TOOLS 由各包测试锚定。
 * - classifyTool 'diff'（缺省产 field_patch envelope 走 PatchReview——suggest 可用 mirror
 *   scene_graph_update / asset_cards_update，readonly 拦）。
 * - toolPolicy mode filtering：suggest 档可见（B01 断链形态 = suggest 档 envelope 被 UI 门丢，
 *   前提是 suggest 档工具可见）。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool, filterToolsForPolicy } from '../src/runtime/toolPolicy';

registerBuiltinTools();

const TRIO = ['growth_curve_update', 'pacing_curve_update', 'episode_outlines_update'] as const;

describe('registerBuiltinTools — Story 8.5 arc-pipeline write trio', () => {
  it('三工具全部注册（id 与 shell toolExecution register 逐字一致——B01 是名字漂移漏登）', () => {
    for (const id of TRIO) {
      expect(registry.get(id), `${id} 应已注册`).toBeDefined();
      expect(registry.get(id)!.id).toBe(id);
    }
  });

  it('growth_curve_update：bounded action array surface（add 已存在=partial merge 语义进 describe）+ 空 actions 拒', () => {
    const tool = registry.get('growth_curve_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      actions: [
        {
          op: 'add_curve',
          curve: {
            character_id: 'char-lin',
            start_state: '封闭自保',
            desire: '查清真相',
            turning_points: [{ turning_point: '审判日作证', linked_episode_ids: ['ep-10'] }],
          },
        },
        { op: 'update_curve', character_id: 'char-lin', patch: { end_state: '学会信任' } },
        { op: 'remove_curve', character_id: 'ghost' },
      ],
    });
    expect(params.actions).toHaveLength(3);
    // actions 必填 + 空数组拒（P16：零 action 不是一次编辑）。
    expect(() => parse.parse({})).toThrow();
    expect(() => parse.parse({ actions: [] })).toThrow();
    // 坏 action（缺 character_id）zod 层拒。
    expect(() => parse.parse({ actions: [{ op: 'add_curve', curve: { start_state: 'x' } }] })).toThrow();
    // autoApply optional。
    expect(() => parse.parse({ actions: [{ op: 'remove_curve', character_id: 'c' }], autoApply: true })).not.toThrow();
    // description 与 Step 4 prompt 措辞对齐（弧设计语义词表进 LLM-facing 描述）。
    expect(tool.description).toContain('wound_or_lack');
    expect(tool.description).toContain('turning_points');
  });

  it('pacing_curve_update：add/update/remove point by refId surface', () => {
    const tool = registry.get('pacing_curve_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      actions: [
        { op: 'add_point', point: { refId: 'ep-3', intensity: 7, note: '审判日' } },
        { op: 'update_point', point: { refId: 'ep-3', intensity: 9 } },
        { op: 'remove_point', refId: 'ghost' },
      ],
    });
    expect(params.actions).toHaveLength(3);
    // 坏 point（intensity 超 0-10）zod 层拒。
    expect(() => parse.parse({ actions: [{ op: 'add_point', point: { refId: 'e', intensity: 11 } }] })).toThrow();
    expect(() => parse.parse({ actions: [] })).toThrow();
    expect(tool.description).toContain('refId');
  });

  it('episode_outlines_update：add/update/remove episode by id surface + phase_ref 措辞对齐 episode-planner prompt', () => {
    const tool = registry.get('episode_outlines_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      actions: [
        {
          op: 'add_episode',
          episode: {
            id: 'ep-10',
            index: 10,
            title: '审判日',
            character_progressions: [{ characterId: 'char-lin', from: '自保沉默', to: '为同伴作证' }],
            phase_ref: 'phase-1',
          },
        },
        { op: 'update_episode', episodeId: 'ep-10', patch: { hook: '城门关闭' } },
        { op: 'remove_episode', episodeId: 'ghost' },
      ],
    });
    expect(params.actions).toHaveLength(3);
    // 坏 episode（缺 title）zod 层拒。
    expect(() => parse.parse({ actions: [{ op: 'add_episode', episode: { id: 'e', index: 0 } }] })).toThrow();
    expect(() => parse.parse({ actions: [] })).toThrow();
    // description 与 Step 4 episode-planner yaml 措辞对齐（phase_ref 挂钩 + progression 对号）。
    expect(tool.description).toContain('phase_ref');
    expect(tool.description).toContain('character_progressions');
    expect(tool.description).toContain('turning_points.linked_episode_ids');
  });
});

describe('Story 8.5 分类与 mode filtering（B01 checklist 行为面）', () => {
  it('三工具 classifyTool 全 diff（field_patch 人审——suggest 可用 mirror asset_cards_update）', () => {
    for (const id of TRIO) {
      expect(classifyTool(id), `${id} 应为 diff`).toBe('diff');
    }
  });

  it('readonly：三工具全拦（diff 类不可用）', () => {
    const visible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'readonly' }).map((t) => t.id);
    for (const id of TRIO) {
      expect(visible, `${id} readonly 应拦`).not.toContain(id);
    }
  });

  it('suggest：三工具保留（缺省档主路径——B01 断链形态的前提是 suggest 可见，UI WRITE_TOOLS 门由 ui 测试锚定）', () => {
    const visible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'suggest' }).map((t) => t.id);
    for (const id of TRIO) {
      expect(visible, `${id} suggest 应可用`).toContain(id);
    }
  });

  it('auto：三工具可用', () => {
    const visible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'auto' }).map((t) => t.id);
    for (const id of TRIO) {
      expect(visible).toContain(id);
    }
  });
});

describe('Story 5.2 emotion_curve_update B01 追补（8.5 Step 5 latent finding）', () => {
  // 5.2 只落了 shell handler，agent 侧注册三处同步全缺——runAgentWithExplicitSystem 的 allowedTools
  // 经 registry.all().filter 把未注册 id 静默滤掉，Director auto 档从未见过此工具。write-chapter-director
  // 测试 mock 了 runAgentWithExplicitSystem（只锁声明的 allowedTools 列表），故该断链在 mock 层不可见——
  // 本 block 锚定真 registry 面（注册 + 分类 + mode filtering），防回归。
  it('已注册（id 与 shell toolExecution register 逐字一致）', () => {
    expect(registry.get('emotion_curve_update')).toBeDefined();
    expect(registry.get('emotion_curve_update')!.id).toBe('emotion_curve_update');
  });

  it('classifyTool diff + readonly 拦 + suggest/auto 可用', () => {
    expect(classifyTool('emotion_curve_update')).toBe('diff');
    const readonlyVisible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'readonly' }).map((t) => t.id);
    expect(readonlyVisible).not.toContain('emotion_curve_update');
    const suggestVisible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'suggest' }).map((t) => t.id);
    expect(suggestVisible).toContain('emotion_curve_update');
    const autoVisible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'auto' }).map((t) => t.id);
    expect(autoVisible).toContain('emotion_curve_update');
  });
});
