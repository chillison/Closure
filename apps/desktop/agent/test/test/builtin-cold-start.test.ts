/**
 * Story 8.6 Step 3 builtin registration + classification tests — cold-start write trio
 * （mirror builtin-arc-pipeline.test.ts）。
 *
 * B01 三处同步 checklist（agent-tools.md）的可测面：
 * - tool ids MUST match the shell handler registrations in toolExecution.ts（remoteToolProxy 按 id
 *   路由）——本 suite 锁 id + zod surface；shell 侧 register（Step 2 已落）与 UI WRITE_TOOLS
 *   （Step 6）由各包测试锚定。
 * - classifyTool 'diff'（缺省产人审 envelope——suggest 可用 mirror growth_curve_update，readonly 拦）。
 * - CR-001 红线：三工具参数 schema 必须同时带 autoApply + selfReviewConfirmed（漏后者 = zod strip
 *   后自审闸门永拦死循环——8.5 教训）。
 * - 描述说人话双规则（agent-tools.md :89-109）：零实现词汇（patch/envelope/落盘/PatchReview/
 *   Story 编号）+ 统一句式「默认你的…会先呈现给作者」。
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool, filterToolsForPolicy, shouldGateAutoApply } from '../src/runtime/toolPolicy';

registerBuiltinTools();

const TRIO = ['creative_brief_update', 'creative_preferences_update', 'author_profile_update'] as const;

/** 各工具的最小合法 params 探针（CR-001 双参数存活测试用）。 */
function minimalParams(id: string): Record<string, unknown> {
  if (id === 'author_profile_update') return { note: '作者偏好短答' };
  if (id === 'creative_brief_update') return { updates: { genre: '仙侠' } };
  return { updates: { outline_depth: 'skeleton' } };
}

describe('registerBuiltinTools — Story 8.6 cold-start write trio', () => {
  it('三工具全部注册（id 与 shell toolExecution register 逐字一致——B01 是名字漂移漏登）', () => {
    for (const id of TRIO) {
      expect(registry.get(id), `${id} 应已注册`).toBeDefined();
      expect(registry.get(id)!.id).toBe(id);
    }
  });

  it('CR-001 红线：三工具参数 schema 均带 autoApply + selfReviewConfirmed（parse 不 strip，闸门重发可达）', () => {
    for (const id of TRIO) {
      const parse = registry.get(id)!.parameters as z.ZodType<Record<string, unknown>>;
      const parsed = parse.parse({ ...minimalParams(id), autoApply: true, selfReviewConfirmed: true });
      expect(parsed.autoApply, `${id} autoApply 不得被 strip`).toBe(true);
      expect(parsed.selfReviewConfirmed, `${id} selfReviewConfirmed 不得被 strip`).toBe(true);
    }
  });

  it('creative_brief_update：updates 字段级 surface（structure_pattern enum 拦非法值；updates 必填）', () => {
    const tool = registry.get('creative_brief_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      updates: {
        genre: '都市异能',
        tone: '冷峻',
        structure_pattern: 'main-sub-dual',
        rawRequirement: '一个能看到别人寿命倒计时的人',
        taboos: ['虐主'],
        userConstraints: ['每章 3000 字左右'],
      },
    });
    expect(params.updates).toMatchObject({ genre: '都市异能', structure_pattern: 'main-sub-dual' });
    // 坏 structure_pattern zod 层拒。
    expect(() => parse.parse({ updates: { structure_pattern: 'spiral' } })).toThrow();
    // updates 必填（缺 key 拒；空对象由 shell handler 友好 no-op——宽松 provider 兜底层）。
    expect(() => parse.parse({})).toThrow();
    // 描述：灵感原文字段名 + 领地路由（防双写通道）。
    expect(tool.description).toContain('rawRequirement');
    expect(tool.description).toContain('genre_contract_update');
  });

  it('creative_preferences_update：四轴 enum surface（轴值非法 zod 拒；updates 必填）', () => {
    const tool = registry.get('creative_preferences_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({
      updates: { outline_depth: 'skeleton', arc_timing: 'as_you_go', note: '先写起来再说' },
    });
    expect(params.updates).toMatchObject({ outline_depth: 'skeleton', arc_timing: 'as_you_go' });
    // 四轴 enum 单源 shared-contracts（Step 1 导出的独立轴 schema）——词表外值 zod 拒。
    expect(() => parse.parse({ updates: { outline_depth: 'deep' } })).toThrow();
    expect(() => parse.parse({ updates: { arc_timing: 'later' } })).toThrow();
    expect(() => parse.parse({ updates: { world_depth: 'medium' } })).toThrow();
    expect(() => parse.parse({ updates: { character_depth: 'rich' } })).toThrow();
    expect(() => parse.parse({})).toThrow();
    // 描述：四轴名 + 各档位就地解释（特殊名词就地解释规则）。
    expect(tool.description).toContain('outline_depth');
    expect(tool.description).toContain('arc_timing');
    expect(tool.description).toContain('world_depth');
    expect(tool.description).toContain('character_depth');
    expect(tool.description).toContain('as_you_go');
  });

  it('author_profile_update：note 必填 min(1)（缺 key / 空串拒）', () => {
    const tool = registry.get('author_profile_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    expect(parse.parse({ note: '作者偏好先看例子再听原理' })).toMatchObject({ note: '作者偏好先看例子再听原理' });
    expect(() => parse.parse({})).toThrow();
    expect(() => parse.parse({ note: '' })).toThrow();
    // CR-018：note 上限 4000（与 shared-contracts IPC schema / shell 校验同步——LLM 失控超长拦在参数层）。
    expect(parse.parse({ note: 'x'.repeat(4000) })).toMatchObject({ note: 'x'.repeat(4000) });
    expect(() => parse.parse({ note: 'x'.repeat(4001) })).toThrow();
    // 描述：档案语义就地解释（跨项目 / 只增不删 / 非创作素材）。
    expect(tool.description).toContain('观察');
    expect(tool.description).toContain('只增不删');
  });

  it('CR-018：creative_preferences_update 的 note 参数上限 4000（同 family 同步）', () => {
    const tool = registry.get('creative_preferences_update')!;
    const parse = tool.parameters as z.ZodType<Record<string, unknown>>;
    expect(parse.parse({ updates: { note: 'x'.repeat(4000) } }).updates).toMatchObject({ note: 'x'.repeat(4000) });
    expect(() => parse.parse({ updates: { note: 'x'.repeat(4001) } })).toThrow();
  });

  it('描述说人话双规则（agent-tools.md :89-109）：三工具描述零实现词汇 + 统一默认句式', () => {
    const FORBIDDEN = ['patch', 'envelope', '落盘', 'PatchReview', 'Story 8', 'source:'];
    for (const id of TRIO) {
      const description = registry.get(id)!.description;
      for (const word of FORBIDDEN) {
        expect(description, `${id} 描述不得含实现词汇「${word}」`).not.toContain(word);
      }
      expect(description, `${id} 须含统一句式（默认呈现作者）`).toContain('默认你的');
    }
  });
});

describe('Story 8.6 分类与 mode filtering（B01 checklist 行为面）', () => {
  it('三工具 classifyTool 全 diff（缺省人审——suggest 可用 mirror growth_curve_update）', () => {
    for (const id of TRIO) {
      expect(classifyTool(id), `${id} 应为 diff`).toBe('diff');
    }
  });

  it('autoApply 自审闸门覆盖三工具（首发拦 / 自审重发放行 / 人审路径不拦）', () => {
    for (const id of TRIO) {
      expect(shouldGateAutoApply(id, { autoApply: true }), `${id} 首发应拦`).toBe(true);
      expect(shouldGateAutoApply(id, { autoApply: true, selfReviewConfirmed: true }), `${id} 重发应放行`).toBe(false);
      expect(shouldGateAutoApply(id, { autoApply: false }), `${id} 人审路径不拦`).toBe(false);
    }
  });

  it('readonly：三工具全拦（diff 类不可用）', () => {
    const visible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'readonly' }).map((t) => t.id);
    for (const id of TRIO) {
      expect(visible, `${id} readonly 应拦`).not.toContain(id);
    }
  });

  it('suggest：三工具保留（缺省档主路径——B01 断链形态的前提是 suggest 可见，UI 门由 ui 测试锚定）', () => {
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
