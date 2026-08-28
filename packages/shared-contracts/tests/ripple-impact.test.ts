import { describe, expect, it } from 'vitest';
import {
  rippleImpactFindingSchema,
  rippleImpactResultSchema,
  parseRippleImpacts,
  formatImpactTypeVocab,
  IMPACT_TYPE_VOCAB,
} from '../src/contracts/ripple-impact';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.4 Phase 2.2：ripple-impact finding schema + parseRippleImpacts 测试。
//
// 测三块（implement.md 2.2 验证门）：
// 1. schema 校验：valid/invalid finding + result。
// 2. parseRippleImpacts：三路径鲁棒（fenced / brace-match / bare）+ 坏条目丢弃保其余 + null on 全失败。
// 3. 词表：IMPACT_TYPE_VOCAB + formatImpactTypeVocab。
// ─────────────────────────────────────────────────────────────────────────────

describe('ripple-impact schema（Story 3.4 Phase 2.2）', () => {
  describe('rippleImpactFindingSchema', () => {
    it('合法 finding（全必填字段齐）', () => {
      const finding = rippleImpactFindingSchema.parse({
        code: 'conflict',
        severity: 'error',
        impactType: 'conflict',
        message: '角色已死但场景显示活着',
        targets: [{ kind: 'scene', id: 's1' }],
        suggestion: '修改该场或更新角色状态',
      });
      expect(finding.code).toBe('conflict');
      expect(finding.severity).toBe('error');
      expect(finding.targets).toHaveLength(1);
    });

    it('degraded finding（含 degraded + no-events code）', () => {
      const finding = rippleImpactFindingSchema.parse({
        code: 'no-events',
        severity: 'warning',
        impactType: 'no-events',
        message: '该场无 world state 数据',
        targets: [{ kind: 'scene', id: 's2' }],
        degraded: true,
      });
      expect(finding.degraded).toBe(true);
    });

    it('reject 缺必填字段（无 code）', () => {
      const result = rippleImpactFindingSchema.safeParse({
        severity: 'error',
        impactType: 'conflict',
        message: '...',
        targets: [{ kind: 'scene', id: 's1' }],
      });
      expect(result.success).toBe(false);
    });

    it('reject targets 空（至少 1 条）', () => {
      const result = rippleImpactFindingSchema.safeParse({
        code: 'conflict',
        severity: 'error',
        impactType: 'conflict',
        message: '...',
        targets: [],
      });
      expect(result.success).toBe(false);
    });

    it('reject severity 非法值', () => {
      const result = rippleImpactFindingSchema.safeParse({
        code: 'conflict',
        severity: 'critical',
        impactType: 'conflict',
        message: '...',
        targets: [{ kind: 'scene', id: 's1' }],
      });
      expect(result.success).toBe(false);
    });

    it('多 targets（scene + line + field 混合）', () => {
      const finding = rippleImpactFindingSchema.parse({
        code: 'stale-derivative',
        severity: 'warning',
        impactType: 'stale-derivative',
        message: '规则改动影响多场',
        targets: [
          { kind: 'scene', id: 's1' },
          { kind: 'line', id: 'l1' },
          { kind: 'field', id: 'scene_graph' },
        ],
      });
      expect(finding.targets).toHaveLength(3);
    });
  });

  describe('rippleImpactResultSchema', () => {
    it('合法 result（findings + summary + degraded）', () => {
      const result = rippleImpactResultSchema.parse({
        findings: [
          {
            code: 'conflict',
            severity: 'error',
            impactType: 'conflict',
            message: '矛盾',
            targets: [{ kind: 'scene', id: 's1' }],
          },
        ],
        summary: '发现 1 处冲突',
        degraded: false,
      });
      expect(result.findings).toHaveLength(1);
      expect(result.degraded).toBe(false);
    });

    it('空 findings + degraded=true（L2 parse 失败 fallback）', () => {
      const result = rippleImpactResultSchema.parse({
        findings: [],
        summary: '诊断失败需人工',
        degraded: true,
        degradationNote: 'L2 parse 失败',
      });
      expect(result.findings).toHaveLength(0);
      expect(result.degraded).toBe(true);
      expect(result.degradationNote).toBe('L2 parse 失败');
    });
  });
});

describe('parseRippleImpacts（三路径鲁棒，mirror parseAdjudication）', () => {
  it('路径 1：fenced ```json 块', () => {
    const content = '这是诊断结果：\n```json\n{"findings":[],"summary":"无影响","degraded":false}\n```';
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('无影响');
    expect(parsed!.degraded).toBe(false);
  });

  it('路径 1：multi-fence（推理 fenced + 结果 fenced，取合法块）', () => {
    const content =
      '```text\n思考...\n```\n结果：\n```json\n{"findings":[],"summary":"ok","degraded":false}\n```';
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('ok');
  });

  it('路径 2：brace-match（裸 JSON 带前导文字）', () => {
    const content = '诊断完成，结果如下：\n{"findings":[],"summary":"无碍","degraded":false}\n以上。';
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('无碍');
  });

  it('路径 3：整体 parse（纯 JSON 无围栏无前导）', () => {
    const content = '{"findings":[],"summary":"干净","degraded":false}';
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.summary).toBe('干净');
  });

  it('含 findings 的完整 parse', () => {
    const content = JSON.stringify({
      findings: [
        {
          code: 'conflict',
          severity: 'error',
          impactType: 'World-building.rules',
          message: '新规则与场 s1 矛盾',
          targets: [{ kind: 'scene', id: 's1' }],
          suggestion: '更新场 s1 或调整规则',
        },
        {
          code: 'no-events',
          severity: 'warning',
          impactType: 'no-events',
          message: '场 s2 无数据',
          targets: [{ kind: 'scene', id: 's2' }],
          degraded: true,
        },
      ],
      summary: '1 error + 1 degraded',
      degraded: true,
      degradationNote: 's2 无 world state',
    });
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.findings).toHaveLength(2);
    expect(parsed!.findings[0].impactType).toBe('World-building.rules');
    expect(parsed!.findings[1].degraded).toBe(true);
  });

  it('坏条目 finding 丢弃保其余（mirror revision-guard filterValidFindings）', () => {
    const content = JSON.stringify({
      findings: [
        'not-an-object', // 坏：非 object
        {
          code: 'conflict',
          // 坏：缺 severity
          impactType: 'conflict',
          message: '...',
          targets: [{ kind: 'scene', id: 's1' }],
        },
        {
          code: 'opportunity',
          severity: 'info',
          impactType: 'opportunity',
          message: '新可能',
          targets: [{ kind: 'scene', id: 's2' }],
        },
      ],
      summary: '保留好的',
      degraded: false,
    });
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.findings).toHaveLength(1); // 只保留第 3 条（好的）
    expect(parsed!.findings[0].code).toBe('opportunity');
  });

  it('坏 target 丢弃（targets 整条丢 → finding 丢）', () => {
    const content = JSON.stringify({
      findings: [
        {
          code: 'conflict',
          severity: 'error',
          impactType: 'conflict',
          message: '...',
          targets: [{ kind: 'invalid-kind', id: 's1' }], // 坏 kind
        },
      ],
      summary: 'targets 全坏 → finding 丢',
      degraded: false,
    });
    const parsed = parseRippleImpacts(content);
    // finding 的 targets 校验后全坏 → targets 空 → finding 丢（min(1) 守卫）
    expect(parsed).not.toBeNull();
    expect(parsed!.findings).toHaveLength(0);
  });

  it('空 content → null', () => {
    expect(parseRippleImpacts('')).toBeNull();
    expect(parseRippleImpacts('   ')).toBeNull();
  });

  it('summary 缺 → null（硬要求）', () => {
    const content = JSON.stringify({ findings: [], degraded: false });
    expect(parseRippleImpacts(content)).toBeNull();
  });

  it('非 JSON 文字 → null', () => {
    expect(parseRippleImpacts('这不是 JSON')).toBeNull();
  });

  it('degraded 缺省 false（LLM 漏标）', () => {
    const content = JSON.stringify({ findings: [], summary: 'ok' });
    const parsed = parseRippleImpacts(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.degraded).toBe(false);
  });
});

describe('IMPACT_TYPE_VOCAB + formatImpactTypeVocab', () => {
  it('词表含核心类型', () => {
    const values = IMPACT_TYPE_VOCAB.map((e) => e.value);
    expect(values).toContain('conflict');
    expect(values).toContain('contradiction');
    expect(values).toContain('stale-derivative');
    expect(values).toContain('opportunity');
    expect(values).toContain('no-impact');
    expect(values).toContain('no-events');
  });

  it('formatImpactTypeVocab 返非空串含所有 value', () => {
    const formatted = formatImpactTypeVocab();
    expect(formatted.length).toBeGreaterThan(0);
    for (const entry of IMPACT_TYPE_VOCAB) {
      expect(formatted).toContain(entry.value);
    }
  });
});
