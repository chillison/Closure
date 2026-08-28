import { describe, expect, it } from 'vitest';
import {
  structurePatternSchema,
  creativeBriefSchema,
  sceneGraphSchema,
  PATTERN_SEEDS,
  instantiatePattern,
  formatPatternGuide,
  type StructurePattern,
} from '../src';

const SIX_PATTERNS = [
  'anchor-single',
  'lotus-converging',
  'main-sub-dual',
  'progressive-jigsaw',
  'parallel-weak',
  'triple-interactive',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Step 1a: structurePatternSchema enum（7 值：6 pattern + blank）
// ─────────────────────────────────────────────────────────────────────────────
describe('structurePatternSchema enum（Story 1.4 §1.1）', () => {
  it('接受 6 pattern + blank（共 7 值）', () => {
    for (const id of [...SIX_PATTERNS, 'blank'] as const) {
      expect(structurePatternSchema.parse(id)).toBe(id);
    }
  });

  it('拒绝非法 patternId', () => {
    expect(() => structurePatternSchema.parse('invalid')).toThrow();
    expect(() => structurePatternSchema.parse('')).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 1d: creative_brief.structure_pattern 字段（零 migration，optional）
// ─────────────────────────────────────────────────────────────────────────────
describe('creative_brief.structure_pattern 字段（Story 1.4 §2）', () => {
  it('接受含 structure_pattern 的 brief', () => {
    const brief = creativeBriefSchema.parse({
      rawRequirement: '写一个悬疑故事',
      structure_pattern: 'lotus-converging',
    });
    expect(brief.structure_pattern).toBe('lotus-converging');
  });

  it('接受 blank', () => {
    const brief = creativeBriefSchema.parse({
      rawRequirement: '自由创作',
      structure_pattern: 'blank',
    });
    expect(brief.structure_pattern).toBe('blank');
  });

  it('缺省 structure_pattern 仍 parse 通过（零 migration）', () => {
    const brief = creativeBriefSchema.parse({ rawRequirement: '无 pattern' });
    expect(brief.structure_pattern).toBeUndefined();
  });

  it('拒绝非法 structure_pattern 值', () => {
    expect(() =>
      creativeBriefSchema.parse({ rawRequirement: 'x', structure_pattern: 'not-a-pattern' })
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2a: 6 PATTERN_SEEDS 形态合法（引用一致 + enum 合法 + edges 全 CAUSAL）
// ─────────────────────────────────────────────────────────────────────────────
describe('PATTERN_SEEDS 6 骨架形态合法（Story 1.4 §1.2）', () => {
  it('PATTERN_SEEDS 覆盖 6 pattern（exhaustive，无 blank）', () => {
    expect(Object.keys(PATTERN_SEEDS).sort()).toEqual([...SIX_PATTERNS].sort());
  });

  for (const id of SIX_PATTERNS) {
    describe(`pattern ${id}`, () => {
      const seed = PATTERN_SEEDS[id];

      it('id / name / description / growthRule 非空', () => {
        expect(seed.id).toBe(id);
        expect(seed.name.length).toBeGreaterThan(0);
        expect(seed.description.length).toBeGreaterThan(0);
        expect(seed.growthRule.length).toBeGreaterThan(0);
      });

      it('lines: id 唯一 + topology_role 合法 enum + 引用一致', () => {
        const lineIds = seed.skeleton.lines.map((l) => l.id);
        expect(new Set(lineIds).size).toBe(lineIds.length); // 唯一
        for (const l of seed.skeleton.lines) {
          expect(['converging', 'parallel-worldview', 'offline', 'if-branch', 'side']).toContain(l.topology_role);
        }
      });

      it('nodes: id 唯一 + role 合法 enum + lineTags 都解析到 line', () => {
        const nodeIds = seed.skeleton.nodes.map((n) => n.id);
        expect(new Set(nodeIds).size).toBe(nodeIds.length);
        const lineIds = new Set(seed.skeleton.lines.map((l) => l.id));
        for (const n of seed.skeleton.nodes) {
          expect(['normal', 'core-anchor', 'secondary-anchor', 'fork-point']).toContain(n.role);
          for (const tag of n.lineTags) {
            expect(lineIds.has(tag)).toBe(true); // 无 dangling lineTag
          }
        }
      });

      it('edges: 全 CAUSAL + from/to 都解析到 node', () => {
        const nodeIds = new Set(seed.skeleton.nodes.map((n) => n.id));
        for (const e of seed.skeleton.edges) {
          expect(e.type).toBe('CAUSAL');
          expect(nodeIds.has(e.from)).toBe(true);
          expect(nodeIds.has(e.to)).toBe(true);
        }
      });

      it('骨架无具体场景内容（无 storyTimeLabel / title / summary）', () => {
        for (const n of seed.skeleton.nodes) {
          expect(n).not.toHaveProperty('storyTimeLabel');
          expect(n).not.toHaveProperty('title');
          expect(n).not.toHaveProperty('summary');
        }
      });
    });
  }

  it('parallel-weak 骨架边为空（并列不交汇）', () => {
    expect(PATTERN_SEEDS['parallel-weak'].skeleton.edges).toEqual([]);
  });

  it('triple-interactive 暗藏线 visibility hidden-until', () => {
    const hidden = PATTERN_SEEDS['triple-interactive'].skeleton.lines.find((l) => l.id === 'l_hidden');
    expect(hidden?.visibility).toEqual({ status: 'hidden-until', target: 'n_reveal' });
  });

  it('parallel-weak 线 worldEventRef 锚定（Type2 mesh）', () => {
    const parallel = PATTERN_SEEDS['parallel-weak'].skeleton.lines[0];
    expect(parallel.worldEventRef).toBeTruthy();
    expect(parallel.topology_role).toBe('parallel-worldview');
  });

  it('main-sub-dual 两条 converging 线汇聚同一 target', () => {
    const lines = PATTERN_SEEDS['main-sub-dual'].skeleton.lines;
    expect(lines).toHaveLength(2);
    const targets = lines.map((l) => l.convergence_target);
    expect(new Set(targets).size).toBe(1); // 同一汇聚点
  });

  // CR-013：lotus-converging seed 给 fan-in 形态示范（≥2 线汇聚同一 target），非写死线数。
  it('lotus-converging 示 fan-in 形态（≥2 线汇聚同一 target）', () => {
    const lines = PATTERN_SEEDS['lotus-converging'].skeleton.lines;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const targets = lines.map((l) => l.convergence_target);
    expect(new Set(targets).size).toBe(1); // 全 fan-in 同一全局锚点
  });

  // CR-013：triple-interactive 三递角色形态示范（主线 + 独立单元 + 暗藏汇聚），非写死 3 线。
  it('triple-interactive 示三递角色（main converging + independent parallel-worldview + hidden converging）', () => {
    const lines = PATTERN_SEEDS['triple-interactive'].skeleton.lines;
    const main = lines.find((l) => l.id === 'l_main');
    const independent = lines.find((l) => l.id === 'l_independent');
    const hidden = lines.find((l) => l.id === 'l_hidden');
    expect(main?.topology_role).toBe('converging');
    expect(main?.is_main_thread).toBe(true);
    expect(independent?.topology_role).toBe('parallel-worldview'); // 独立单元不交汇
    expect(independent?.worldEventRef).toBeTruthy(); // Type2 mesh 锚定
    expect(hidden?.topology_role).toBe('converging');
    expect(hidden?.visibility).toEqual({ status: 'hidden-until', target: 'n_reveal' });
    // 独立单元不与主线/暗藏线交汇：n_reveal 仅 main+hidden 汇聚，independent 不带 tag
    const reveal = PATTERN_SEEDS['triple-interactive'].skeleton.nodes.find((n) => n.id === 'n_reveal');
    expect(reveal?.lineTags).toEqual(['l_main', 'l_hidden']);
    expect(reveal?.lineTags).not.toContain('l_independent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Step 2b: instantiatePattern（纯函数：非 blank 返回 schema-valid 子集 / blank null / 确定性）
// ─────────────────────────────────────────────────────────────────────────────
describe('instantiatePattern（Story 1.4 §1.3）', () => {
  it('blank 返回 null（空白起步，无 seed）', () => {
    expect(instantiatePattern('blank')).toBeNull();
  });

  for (const id of SIX_PATTERNS) {
    it(`${id} 返回非 null 子集且 schema-valid`, () => {
      const result = instantiatePattern(id);
      expect(result).not.toBeNull();
      // 投影后整体 sceneGraph schema-valid（落盘 reload 不 corrupt）
      expect(() => sceneGraphSchema.parse({ nodes: result!.nodes, edges: result!.edges, lines: result!.lines })).not.toThrow();
    });
  }

  it('6 pattern 各返回与 skeleton 一致的线/节点/边数量', () => {
    for (const id of SIX_PATTERNS) {
      const seed = PATTERN_SEEDS[id];
      const result = instantiatePattern(id)!;
      expect(result.lines).toHaveLength(seed.skeleton.lines.length);
      expect(result.nodes).toHaveLength(seed.skeleton.nodes.length);
      expect(result.edges).toHaveLength(seed.skeleton.edges.length);
    }
  });

  it('instantiate 填机械默认（storyTime 0 / presentationOrder {0,0} / displacement none / visibility open）', () => {
    const result = instantiatePattern('anchor-single')!;
    expect(result.nodes[0].storyTime).toBe(0);
    expect(result.nodes[0].presentationOrder).toEqual({ chapter: 0, pos: 0 });
    expect(result.lines[0].displacement).toBe('none');
    // anchor-single 主线无显式 visibility -> 默认 open
    expect(result.lines[0].visibility).toEqual({ status: 'open' });
  });

  it('保留 skeleton 的 pattern 形态字段（convergence_target / is_main_thread / worldEventRef / visibility）', () => {
    // anchor-single 主线 is_main_thread + convergence_target
    const single = instantiatePattern('anchor-single')!;
    expect(single.lines[0].is_main_thread).toBe(true);
    expect(single.lines[0].convergence_target).toBe('n_anchor');

    // parallel-weak worldEventRef
    const parallel = instantiatePattern('parallel-weak')!;
    expect(parallel.lines[0].worldEventRef).toBe('we_world_event');

    // triple-interactive 暗藏线 hidden-until visibility 保留
    const triple = instantiatePattern('triple-interactive')!;
    const hidden = triple.lines.find((l) => l.id === 'l_hidden')!;
    expect(hidden.visibility).toEqual({ status: 'hidden-until', target: 'n_reveal' });
  });

  it('instantiate 不填具体场景内容（无 storyTimeLabel / episodeId / actRef）', () => {
    const result = instantiatePattern('lotus-converging')!;
    for (const n of result.nodes) {
      expect(n.storyTimeLabel).toBeUndefined();
      expect(n.episodeId).toBeUndefined();
      expect(n.actRef).toBeUndefined();
    }
  });

  it('确定性：同 id 调两次返回深相等', () => {
    for (const id of SIX_PATTERNS) {
      expect(instantiatePattern(id)).toEqual(instantiatePattern(id));
    }
  });

  // CR-007：instantiatePattern 不共享可变引用--两次 instantiate 的实例互不影响。
  // visibility / presentationOrder 等对象默认值须 spread 拷贝，防 1.5 Timeline 消费时踩坑。
  it('两次 instantiate 实例独立（mutate 一实例不影响另一实例）', () => {
    const a = instantiatePattern('triple-interactive')!;
    const b = instantiatePattern('triple-interactive')!;
    expect(a).not.toBe(b); // 不同对象引用
    // mutate a 的节点 presentationOrder + 线 visibility，b 不受影响
    a.nodes[0].presentationOrder = { chapter: 99, pos: 99 };
    a.lines[0].visibility = { status: 'hidden-until', target: 'n_x' };
    expect(b.nodes[0].presentationOrder).toEqual({ chapter: 0, pos: 0 });
    expect(b.lines[0].visibility).toEqual({ status: 'open' });
    // 默认值常量本身未被污染（再 instantiate 一次仍是默认）
    const c = instantiatePattern('anchor-single')!;
    expect(c.nodes[0].presentationOrder).toEqual({ chapter: 0, pos: 0 });
    expect(c.lines[0].visibility).toEqual({ status: 'open' });
  });

  it('instantiate 结果跑 validateSceneGraph 无 error（骨架自带结构合法）', async () => {
    const { validateSceneGraph } = await import('../src');
    for (const id of SIX_PATTERNS) {
      const result = instantiatePattern(id)!;
      const g = sceneGraphSchema.parse({ nodes: result.nodes, edges: result.edges, lines: result.lines });
      const issues = validateSceneGraph(g);
      // 骨架是 seed，可能缺 convergence_target 等 warning，但不应有 error（因果环）
      expect(issues.some((i) => i.severity === 'error')).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatPatternGuide（Story 1.4 §4 / Step 5c：prompt 注入文本）
// ─────────────────────────────────────────────────────────────────────────────
describe('formatPatternGuide（Story 1.4 §4）', () => {
  it('blank 返回 null（无注入）', () => {
    expect(formatPatternGuide('blank')).toBeNull();
  });

  for (const id of SIX_PATTERNS) {
    it(`${id} 返回非 null 指引文本（含 name / 形态 / 生长规则 / 骨架）`, () => {
      const guide = formatPatternGuide(id as StructurePattern);
      expect(guide).not.toBeNull();
      expect(guide!).toContain(PATTERN_SEEDS[id].name);
      expect(guide!).toContain('形态：');
      expect(guide!).toContain('生长规则：');
      expect(guide!).toContain('主线骨架：');
      expect(guide!).toContain('CAUSAL');
    });
  }

  it('指引文本含 pattern 中文名（给作者/story-planner 可读）', () => {
    expect(formatPatternGuide('anchor-single')).toContain('锚点单线');
    expect(formatPatternGuide('triple-interactive')).toContain('三线交互');
  });

  // CR-010：formatPatternGuide 输出中性角色标签，不含 skeleton 占位符 ID（n_*/we_*/l_*），
  // 防 LLM 原样输出占位符 ID 致悬空 ref。
  it('指引文本不含 skeleton 占位符 ID（用中性角色标签替代）', () => {
    for (const id of SIX_PATTERNS) {
      const guide = formatPatternGuide(id as StructurePattern)!;
      // 占位符 ID 模式：n_anchor / n_core / we_world_event / l_main 等
      expect(guide).not.toMatch(/\bn_[a-z_]+\b/);
      expect(guide).not.toMatch(/\bwe_[a-z_]+\b/);
      expect(guide).not.toMatch(/\bl_[a-z_]+\b/);
      // 仍含拓扑/角色形态信息（中性标签）
      expect(guide).toContain('CAUSAL');
    }
  });

  it('确定性：同 id 调两次返回相同文本', () => {
    for (const id of SIX_PATTERNS) {
      expect(formatPatternGuide(id as StructurePattern)).toBe(formatPatternGuide(id as StructurePattern));
    }
  });
});
