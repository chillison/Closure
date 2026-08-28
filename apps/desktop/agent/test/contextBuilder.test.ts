import { describe, expect, it } from 'vitest';
import { creativeRunContextSchema, creativeFieldKeys } from '@orison/shared-contracts';
import { buildCreativeRunContext } from '../src/engine/contextBuilder';

describe('contextBuilder', () => {
  it('从最小 request 构建完整 context', () => {
    const ctx = buildCreativeRunContext({
      projectPath: 'I:/workspace/demo',
      requirement: '写一个悬疑故事'
    });

    expect(ctx.runId).toMatch(/^run_/);
    expect(ctx.projectPath).toBe('I:/workspace/demo');
    expect(ctx.requirement).toBe('写一个悬疑故事');
    expect(ctx.runIntent).toBe('create');
    expect(ctx.projectDocument).toBeNull();
    expect(ctx.projectDocumentStatus).toBe('missing');
    expect(ctx.staleFields).toEqual([]);
    expect(ctx.syncEvents).toEqual([]);
  });

  it('fieldVersions 初始化为全 0', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    for (const key of creativeFieldKeys) {
      expect(ctx.fieldVersions[key]).toBe(0);
    }
  });

  it('dependencyGraph 包含依赖边', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    expect(ctx.dependencyGraph.edges.length).toBeGreaterThan(0);
  });

  it('有 projectDocument 时 status 为 loaded', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test',
      projectDocument: {
        meta: { id: 'p1' },
        outline_v2: { title: 'Test', synopsis: '测试故事' }
      }
    });

    expect(ctx.projectDocumentStatus).toBe('loaded');
    expect(ctx.projectDocument).not.toBeNull();
    // outline 存在，版本应为 1
    expect(ctx.fieldVersions.outline).toBe(1);
  });

  it('projectDocument 不完整时 status 为 partial', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test',
      projectDocument: { outline_v2: { title: 'Test' } }
    });

    expect(ctx.projectDocumentStatus).toBe('partial');
  });

  it('targetFields 默认为全部字段', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    expect(ctx.targetFields).toEqual([...creativeFieldKeys]);
  });

  it('targetFields 可指定', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test',
      targetFields: ['outline', 'episode_outlines']
    });

    expect(ctx.targetFields).toEqual(['outline', 'episode_outlines']);
  });

  it('constraints 使用请求中的值', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test',
      constraints: { language: 'en-US', episodeCount: 12 }
    });

    expect(ctx.constraints.language).toBe('en-US');
    expect(ctx.constraints.episodeCount).toBe(12);
  });

  it('agentPolicy 默认值正确', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    expect(ctx.agentPolicy.outputJsonOnly).toBe(true);
    expect(ctx.agentPolicy.defaultLanguage).toBe('zh-CN');
    expect(ctx.agentPolicy.fieldNameCase).toBe('snake_case');
  });

  it('构建结果能通过 creativeRunContextSchema 校验', () => {
    const ctx = buildCreativeRunContext({
      projectPath: '/p',
      requirement: 'test'
    });

    expect(() => creativeRunContextSchema.parse(ctx)).not.toThrow();
  });

  describe('patternGuide 派生（Story 1.4 §4 / Step 5c）', () => {
    it('无 projectDocument 时 patternGuide undefined', () => {
      const ctx = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      expect(ctx.patternGuide).toBeUndefined();
    });

    it('projectDocument 无 creative_brief 时 patternGuide undefined', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { meta: { id: 'p1' }, outline_v2: { central_conflict: 'x' } },
      });
      expect(ctx.patternGuide).toBeUndefined();
    });

    it('structure_pattern 为 blank 时 patternGuide undefined（无注入）', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { structure_pattern: 'blank', rawRequirement: 'x' } },
      });
      expect(ctx.patternGuide).toBeUndefined();
    });

    it('structure_pattern 缺省时 patternGuide undefined', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { rawRequirement: 'x' } },
      });
      expect(ctx.patternGuide).toBeUndefined();
    });

    it('structure_pattern 非法时 patternGuide undefined（safeParse 兜底，不抛错）', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { structure_pattern: 'not-a-pattern', rawRequirement: 'x' } },
      });
      expect(ctx.patternGuide).toBeUndefined();
    });

    it('structure_pattern 非 blank 时 patternGuide 含 pattern 中文名 + 生长规则', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { structure_pattern: 'lotus-converging', rawRequirement: 'x' } },
      });
      expect(ctx.patternGuide).toContain('总分总莲花');
      expect(ctx.patternGuide).toContain('生长规则');
      expect(ctx.patternGuide).toContain('CAUSAL');
    });

    it('patternGuide 派生后 ctx 仍通过 creativeRunContextSchema 校验', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { structure_pattern: 'anchor-single', rawRequirement: 'x' } },
      });
      expect(() => creativeRunContextSchema.parse(ctx)).not.toThrow();
    });
  });

  describe('narrativeEnumGuide 恒在（Story 1.9 §3.2）', () => {
    it('无 projectDocument 时 narrativeEnumGuide 仍非 undefined（恒在，非派生）', () => {
      const ctx = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      // 区别于 patternGuide（读 structure_pattern 派生）：narrative enum 词表是通用先验，恒在
      expect(ctx.narrativeEnumGuide).not.toBeUndefined();
      expect(typeof ctx.narrativeEnumGuide).toBe('string');
      expect(ctx.narrativeEnumGuide!.length).toBeGreaterThan(0);
    });

    it('有 projectDocument 时 narrativeEnumGuide 同样恒在', () => {
      const ctx = buildCreativeRunContext({
        projectPath: '/p',
        requirement: 'test',
        projectDocument: { creative_brief: { structure_pattern: 'lotus-converging', rawRequirement: 'x' } },
      });
      expect(ctx.narrativeEnumGuide).not.toBeUndefined();
    });

    it('narrativeEnumGuide 含三段词表标题 + 词表值（先验注入完整）', () => {
      const ctx = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      expect(ctx.narrativeEnumGuide).toContain('【场·结果类型 outcomeType】');
      expect(ctx.narrativeEnumGuide).toContain('【场·张弛角色 pacingRole】');
      expect(ctx.narrativeEnumGuide).toContain('【线·叙事单元 mice_type】');
      // 含词表值（如「惨胜」「铺垫」「观念」等）
      expect(ctx.narrativeEnumGuide).toContain('惨胜');
      expect(ctx.narrativeEnumGuide).toContain('铺垫');
      expect(ctx.narrativeEnumGuide).toContain('观念');
    });

    it('narrativeEnumGuide 含「先验，可超出」头注（词表非门禁）', () => {
      const ctx = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      expect(ctx.narrativeEnumGuide).toContain('先验');
      expect(ctx.narrativeEnumGuide).toContain('可超出');
    });

    it('ctx 仍通过 creativeRunContextSchema 校验（narrativeEnumGuide 进 schema）', () => {
      const ctx = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      expect(() => creativeRunContextSchema.parse(ctx)).not.toThrow();
    });

    it('确定性：两次构建 narrativeEnumGuide 内容相同（静态生成）', () => {
      const a = buildCreativeRunContext({ projectPath: '/p', requirement: 'test' });
      const b = buildCreativeRunContext({ projectPath: '/p2', requirement: 'other' });
      expect(a.narrativeEnumGuide).toBe(b.narrativeEnumGuide);
    });
  });
});
