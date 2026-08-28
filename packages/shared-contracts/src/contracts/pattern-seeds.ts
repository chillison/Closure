// Pattern seeds - 6 预铸结构骨架 + instantiate 纯函数 + prompt 指引格式化。
// Story 1.4（epics.md:281-286）：作者选 pattern 起步 -> story-planner 读
// creative_brief.structure_pattern -> 注入 PATTERN_SEEDS[id] 的骨架 + 生长规则进 prompt
// -> 初始产主线骨架 / 增量按生长规则加线。复用 1.3 scene_graph 工具链产/改。
//
// 范式判据 (ADR-3 / .trellis/spec/core/creative-vs-mechanical.md): PATTERN_SEEDS 是
// 确定性结构骨架（线 topology_role + 节点 role + CAUSAL 边），instantiatePattern 是
// 纯函数（填机械默认 storyTime/presentationOrder/visibility），零 LLM 调用、零主观阈值。
// 锚点选址 / 场景内容 / Type 判定 / 线型选择归 LLM（prompt 侧）；pattern 选择归作者
// （NewProjectDialog，非 intake 推断）。seed 不落盘--作 story-planner 生成支架，落盘的是
// LLM 产出的 scene_graph + creative_brief.structure_pattern。
//
// 6 pattern 权威：child3 `07-23-planning-graph-emotion/design.md` §1.10 + epics.md:1134 方法论映射。

import type {
  LineTopologyRole,
  LineVisibility,
  SceneEdge,
  SceneLine,
  SceneNode,
  SceneNodeRole,
  StructurePattern,
} from './creative-fields';

// ── 骨架蓝图类型（PatternSeed.skeleton）──
// skeleton 是结构占位蓝图，无具体场景内容（无 title/summary/storyTimeLabel）。
// instantiatePattern 把 skeleton 转 SceneGraph 子集（填机械默认）。线 name 是结构性标签
// （主线/副线/暗藏线/平行线/独立单元），非场景内容。visibility/worldEventRef/themeRef 等 pattern
// 形态字段在 skeleton 中表达（如 triple-interactive 暗藏线 hidden-until、parallel-weak
// worldEventRef），instantiatePattern 对缺省字段填 schema 默认。
//
// CR-013（2026-07-26）：seed 是「形态示范」非「写死线数」。skeleton 给 1-2 条示范线体现
// 该 pattern 的递角色（如 triple-interactive 三递角色 = 主线/独立单元/暗藏汇聚；lotus fan-in
// 需 ≥2 线示汇聚形态），线数 / 节点数 / 阶段数按故事需要增减归 LLM（growthRule 文本指引）。
// anchor-single 单脊恒 1 线是形态本身（非写死）。范式守线：seed 纯数据 + instantiatePattern
// 纯函数，零 LLM；线数增减归 LLM。

interface PatternSkeletonLine {
  id: string;
  name: string; // 结构性标签（主线/副线/暗藏线/平行线），非场景内容
  topology_role: LineTopologyRole;
  is_main_thread?: boolean;
  convergence_target?: string;
  worldEventRef?: string;
  themeRef?: string;
  visibility?: LineVisibility;
}

interface PatternSkeletonNode {
  id: string;
  role: SceneNodeRole;
  lineTags: string[];
}

interface PatternSkeletonEdge {
  id: string;
  from: string;
  to: string;
  type: 'CAUSAL';
}

export interface PatternSeed {
  id: Exclude<StructurePattern, 'blank'>;
  name: string; // 中文名（给作者看 + prompt 注入）
  description: string; // 一句话形态描述（给作者看 + prompt 注入）
  growthRule: string; // 生长规则文本（注入 story-planner prompt：增量加线往哪长）
  skeleton: {
    lines: PatternSkeletonLine[];
    nodes: PatternSkeletonNode[];
    edges: PatternSkeletonEdge[];
  };
}

// ── 6 预铸骨架（child3 §1.10 + epics.md:1134 + design §1.2 表）──
// 每骨架：lines（topology_role + is_main_thread + convergence_target + 可选 visibility/
// worldEventRef/themeRef 表达 pattern 形态）+ nodes（role + lineTags）+ edges（全 CAUSAL）。
// 骨架无具体场景内容；锚点选址 / 场景粒度切分归 LLM。骨架节点 role 用 core-anchor /
// secondary-anchor / normal（1.1 sceneNodeRoleSchema）；线 topology_role 用 1.2 enum。
//
// CR-013：skeleton 给「形态示范」（1-2 条示范线体现递角色），非写死线数。growthRule 文本
// 说明增减规则，线数 / 节点数 / 阶段数增减归 LLM 语义判断（范式守线）。
export const PATTERN_SEEDS: Record<Exclude<StructurePattern, 'blank'>, PatternSeed> = {
  'anchor-single': {
    id: 'anchor-single',
    name: '锚点单线',
    description: '单脊贯穿：一条主线朝核心锚点收敛，不开支线。',
    growthRule: '深化主线：沿单脊加锚点节点，每加一段都朝核心锚点收敛。线数恒为 1（单脊贯穿是形态本身，非写死），不开新支线；锚点选址与场景粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'n_anchor' },
      ],
      nodes: [
        { id: 'n_start', role: 'normal', lineTags: ['l_main'] },
        { id: 'n_anchor', role: 'core-anchor', lineTags: ['l_main'] },
      ],
      edges: [
        { id: 'e1', from: 'n_start', to: 'n_anchor', type: 'CAUSAL' },
      ],
    },
  },
  'lotus-converging': {
    id: 'lotus-converging',
    name: '总分总莲花',
    description: '花瓣汇聚：多条支线 fan-in 到同一个全局锚点，呈莲花形态。',
    growthRule: '加支线皆 fan-in 到全局锚点：每条新支线（converging）都指向同一个 core-anchor，形成花瓣汇聚。支线数按故事需要增减（seed 示 2 条 fan-in 形态）；锚点选址与场景粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'n_core' },
        { id: 'l_branch', name: '支线', topology_role: 'converging', convergence_target: 'n_core' },
      ],
      nodes: [
        { id: 'n_entry', role: 'normal', lineTags: ['l_main'] },
        { id: 'n_branch_start', role: 'normal', lineTags: ['l_branch'] },
        { id: 'n_core', role: 'core-anchor', lineTags: ['l_main', 'l_branch'] },
      ],
      edges: [
        { id: 'e1', from: 'n_entry', to: 'n_core', type: 'CAUSAL' },
        { id: 'e2', from: 'n_branch_start', to: 'n_core', type: 'CAUSAL' },
      ],
    },
  },
  'main-sub-dual': {
    id: 'main-sub-dual',
    name: '主副双线',
    description: '双轨汇聚：主线 + 副线各自收敛，在汇聚点交叉。',
    growthRule: '加副轨汇聚主线：新支线作为副轨（converging），在某处与主线交汇（共享 core-anchor 节点）。副轨数按故事需要增减（seed 示 主+副 2 条双轨形态）；锚点选址与场景粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'n_merge' },
        { id: 'l_sub', name: '副线', topology_role: 'converging', convergence_target: 'n_merge' },
      ],
      nodes: [
        { id: 'n_main_a', role: 'normal', lineTags: ['l_main'] },
        { id: 'n_sub_a', role: 'normal', lineTags: ['l_sub'] },
        { id: 'n_merge', role: 'core-anchor', lineTags: ['l_main', 'l_sub'] },
      ],
      edges: [
        { id: 'e1', from: 'n_main_a', to: 'n_merge', type: 'CAUSAL' },
        { id: 'e2', from: 'n_sub_a', to: 'n_merge', type: 'CAUSAL' },
      ],
    },
  },
  'progressive-jigsaw': {
    id: 'progressive-jigsaw',
    name: '递进阶梯拼图',
    description: '分阶段揭示：主线跨多阶段，逐步拼出终极目标。',
    growthRule: '加阶段子图：每阶段一个 secondary-anchor，逐步揭示终极目标（core-anchor），阶段间 CAUSAL 递进。阶段数按故事需要增减（seed 示 2 阶段递进形态）；锚点选址与场景粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'n_final' },
      ],
      nodes: [
        { id: 'n_phase1', role: 'secondary-anchor', lineTags: ['l_main'] },
        { id: 'n_phase2', role: 'secondary-anchor', lineTags: ['l_main'] },
        { id: 'n_final', role: 'core-anchor', lineTags: ['l_main'] },
      ],
      edges: [
        { id: 'e1', from: 'n_phase1', to: 'n_phase2', type: 'CAUSAL' },
        { id: 'e2', from: 'n_phase2', to: 'n_final', type: 'CAUSAL' },
      ],
    },
  },
  'parallel-weak': {
    id: 'parallel-weak',
    name: '并列弱主线',
    description: '平行单元：并列事件单元 + 弱全局锚，单元间不交汇。',
    growthRule: '加平行单元不交汇：新单元加入 parallel-worldview 线，给 worldEventRef 或 themeRef 锚定，单元间不开 CAUSAL。平行单元数按故事需要增减（seed 示 2 单元并列形态）；单元选址与粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_parallel', name: '平行线', topology_role: 'parallel-worldview', worldEventRef: 'we_world_event' },
      ],
      nodes: [
        { id: 'n_unit1', role: 'normal', lineTags: ['l_parallel'] },
        { id: 'n_unit2', role: 'normal', lineTags: ['l_parallel'] },
      ],
      edges: [], // 并列不交汇：平行单元间无 CAUSAL
    },
  },
  'triple-interactive': {
    id: 'triple-interactive',
    name: '三线交互',
    description: '三递角色：主线 + 独立单元 + 暗藏汇聚线，暗藏线在交汇点揭示真相（如神秘人=自己）。',
    growthRule: '保持三递角色：主线（converging）+ 独立单元（parallel-worldview，不交汇）+ 暗藏汇聚线（converging，visibility hidden-until，交汇点揭示真相）。线数按故事需要增减，但保持这三种递角色（主线/独立单元/暗藏汇聚）共存；暗藏交汇点选址与场景粒度由你决定。',
    skeleton: {
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true, convergence_target: 'n_reveal' },
        { id: 'l_independent', name: '独立单元', topology_role: 'parallel-worldview', worldEventRef: 'we_world_event' },
        { id: 'l_hidden', name: '暗藏线', topology_role: 'converging', convergence_target: 'n_reveal', visibility: { status: 'hidden-until', target: 'n_reveal' } },
      ],
      nodes: [
        { id: 'n_main_a', role: 'normal', lineTags: ['l_main'] },
        { id: 'n_independent_a', role: 'normal', lineTags: ['l_independent'] },
        { id: 'n_hidden_a', role: 'normal', lineTags: ['l_hidden'] },
        { id: 'n_reveal', role: 'core-anchor', lineTags: ['l_main', 'l_hidden'] },
      ],
      edges: [
        { id: 'e1', from: 'n_main_a', to: 'n_reveal', type: 'CAUSAL' },
        { id: 'e2', from: 'n_hidden_a', to: 'n_reveal', type: 'CAUSAL' },
        // 独立单元 parallel-worldview 不交汇：无 CAUSAL 边
      ],
    },
  },
};

// ── instantiatePattern（纯函数，design §1.3）──
// 非 blank：返回 skeleton 转 SceneGraph 子集（填机械默认 storyTime 0 / presentationOrder
// {0,0} / displacement 'none' / visibility open（缺省时）/ weight undefined）。确定性，零 LLM。
// blank：返回 null（空白起步，无 seed）。
// 返回对象 schema-valid（sceneGraphSchema.parse({nodes,edges,lines}) 过），落盘 reload 不 corrupt。
// 不填 storyTimeLabel/episodeId/actRef/thread_ref/phase_ref/story_time_span/presentationSpans（optional，LLM/作者后续填；presentationSpans 缺省 = 单章场，Story 1.8）。
//
// CR-007：visibility / presentationOrder 等对象默认值须 spread 拷贝，避免多实例共享同一引用
// （下游 mutate 一实例连带变）。instantiatePattern 当前零生产消费者（1.5 Timeline 才用），
// 但 spread 防护让 1.5 消费时不踩共享引用坑。

const SCENE_MECHANICAL_DEFAULTS = {
  storyTime: 0,
  presentationOrder: { chapter: 0, pos: 0 },
} as const;

const LINE_MECHANICAL_DEFAULTS = {
  displacement: 'none' as const,
  visibility: { status: 'open' as const },
} as const;

export function instantiatePattern(
  id: StructurePattern
): { lines: SceneLine[]; nodes: SceneNode[]; edges: SceneEdge[] } | null {
  if (id === 'blank') return null;
  const seed = PATTERN_SEEDS[id];

  const lines: SceneLine[] = seed.skeleton.lines.map((l) => ({
    id: l.id,
    name: l.name,
    topology_role: l.topology_role,
    displacement: LINE_MECHANICAL_DEFAULTS.displacement,
    // CR-007：spread 拷贝 visibility 对象，避免多线/多实例共享 LINE_MECHANICAL_DEFAULTS.visibility 引用。
    visibility: l.visibility ? { ...l.visibility } : { ...LINE_MECHANICAL_DEFAULTS.visibility },
    ...(l.is_main_thread !== undefined ? { is_main_thread: l.is_main_thread } : {}),
    ...(l.convergence_target !== undefined ? { convergence_target: l.convergence_target } : {}),
    ...(l.worldEventRef !== undefined ? { worldEventRef: l.worldEventRef } : {}),
    ...(l.themeRef !== undefined ? { themeRef: l.themeRef } : {}),
  }));

  const nodes: SceneNode[] = seed.skeleton.nodes.map((n) => ({
    id: n.id,
    role: n.role,
    lineTags: [...n.lineTags],
    storyTime: SCENE_MECHANICAL_DEFAULTS.storyTime,
    // CR-007：spread 拷贝 presentationOrder 对象，避免多节点/多实例共享 SCENE_MECHANICAL_DEFAULTS.presentationOrder 引用。
    presentationOrder: { ...SCENE_MECHANICAL_DEFAULTS.presentationOrder },
  }));

  const edges: SceneEdge[] = seed.skeleton.edges.map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    type: e.type,
  }));

  return { lines, nodes, edges };
}

// ── formatPatternGuide（纯函数，design §4 / Step 5c）──
// 把 PATTERN_SEEDS[id] 格式化成 prompt 注入文本（name + description + growthRule + skeleton
// 摘要）。story-planner prompt 经 contextBuilder 拼进 context（mustache `{{patternGuide}}`），
// 因 prompt 模板 mustache 是扁平标识符（不支持 `{{creative_brief.structure_pattern}}` 嵌套），
// 走 design §4 fallback「contextBuilder 拼 pattern seed 描述进 context」。
// blank / 缺省 -> null（无注入，story-planner 自由产）。确定性字符串格式化，零 LLM。
//
// CR-010：输出用中性角色标签（线结构性 name + topology + 中性「交汇锚点」/「世界事件锚」，
// 节点按 role 聚合计数），不输出 skeleton 占位符 ID（n_anchor/n_core/we_world_event 等），
// 防 LLM 原样输出占位符 ID 致悬空 ref。中性标签不依赖 LLM 遵守「替换占位符」指引。
export function formatPatternGuide(id: StructurePattern): string | null {
  if (id === 'blank') return null;
  const seed = PATTERN_SEEDS[id];
  const lineSummary = seed.skeleton.lines
    .map((l) => {
      const tag = l.is_main_thread ? '（主线）' : '';
      const target = l.convergence_target ? ' -> 交汇锚点' : '';
      const mesh = l.worldEventRef ? ' [世界事件锚]' : l.themeRef ? ' [主题锚]' : '';
      const hidden = l.visibility && l.visibility.status === 'hidden-until' ? ' {暗藏至交汇}' : '';
      return `${l.name}${tag}${target}${mesh}${hidden}`;
    })
    .join('、');
  // 节点按 role 聚合（中性标签 + 计数），不输出占位符 ID，防 LLM 原样输出致悬空 ref。
  const roleCounts = new Map<string, number>();
  for (const n of seed.skeleton.nodes) {
    roleCounts.set(n.role, (roleCounts.get(n.role) ?? 0) + 1);
  }
  const nodeSummary = [...roleCounts.entries()].map(([role, count]) => `${count}×${role}`).join('、');
  const edgeCount = seed.skeleton.edges.length;

  return [
    `【${seed.name}】`,
    `形态：${seed.description}`,
    `生长规则：${seed.growthRule}`,
    `主线骨架：线[${lineSummary}]；节点[${nodeSummary}]；CAUSAL 边 ${edgeCount} 条`,
  ].join('\n');
}
