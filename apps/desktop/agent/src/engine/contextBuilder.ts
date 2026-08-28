import {
  creativeFieldKeys,
  formatNarrativeEnumGuide,
  formatPatternGuide,
  structurePatternSchema,
  type CreativeFieldKey,
  type StructurePattern,
} from '@orison/shared-contracts';
import { getDefaultDependencyGraph, initFieldVersions } from './workflowSync';

const FIELD_ALIAS: Record<string, CreativeFieldKey> = {
  outline_v2: 'outline',
  outline: 'outline',
  asset_cards: 'asset_cards',
  world_setting: 'world_setting',
  relationship_graph: 'relationship_graph',
  growth_curve: 'growth_curve',
  pacing_curve: 'pacing_curve',
  emotion_curve: 'emotion_curve',
  episode_outlines: 'episode_outlines',
  // Story 6.5：foreshadow_registry → promise_registry（泛化读者债生命周期账本）。
  // 无 strict Record typecheck 兜底（loose Record<string,CreativeFieldKey>）——手动改，否则
  // buildCreativeRunContext 漏 promise_registry fieldVersion bump（silent data-drop 风险，interface-contracts spec）。
  promise_registry: 'promise_registry',
  creative_brief: 'creative_brief',
  info_release_map: 'info_release_map',
  scene_graph: 'scene_graph',
  // Story 8.2：弧节拍账本（写手写时声明，mirror promise_registry 归属）。加 key 同步承诺
  // （creative-fields.ts 注释点名 agent 消费轮补此行）——漏则 buildCreativeRunContext 漏 arc_registry
  // fieldVersion bump（silent data-drop 风险，interface-contracts spec，mirror promise_registry 注释）。
  arc_registry: 'arc_registry',
};

/**
 * Story 1.4: 从 projectDocument.creative_brief.structure_pattern 派生 story-planner
 * pattern 指引文本（design §4 fallback：mustache 模板不支持 `{{creative_brief.structure_pattern}}`
 * 嵌套 -> contextBuilder 拼 pattern seed 描述进 context）。非 blank -> formatPatternGuide
 * 返回 PATTERN_SEEDS[id] 的 name/description/growthRule/skeleton 摘要；blank/缺省/非法 -> undefined。
 * 纯确定性派生（零 LLM、零主观阈值），守 creative-vs-mechanical 范式判据。
 *
 * Story 8.6（R7 / design D10）：export 供 tool/dispatch-planners.ts 复用（dispatch_story_planner
 * 组 patternGuide var 的单源——不从 buildCreativeRunContext 走，直接调本函数避免复制派生逻辑）。
 */
export function derivePatternGuide(projectDocument: Record<string, unknown> | null | undefined): string | undefined {
  if (!projectDocument) return undefined;
  const brief = (projectDocument as Record<string, unknown>).creative_brief;
  if (!brief || typeof brief !== 'object') return undefined;
  const rawPattern = (brief as Record<string, unknown>).structure_pattern;
  // safeParse 兜底：旧项目 / 手改 yaml 可能写出非法值 -> 视同 blank（无注入），不抛错。
  const parsed = structurePatternSchema.safeParse(rawPattern);
  if (!parsed.success) return undefined;
  const guide = formatPatternGuide(parsed.data as StructurePattern);
  return guide ?? undefined;
}

/**
 * @deprecated Story 3.4（C-A6）：本函数是 OrisonSpace dormant 死代码——零生产 caller
 * （registry.ts 不消费它，写章链段不读它）。涟漪消费端（stale 驱动增量诊断）**不走**本函数，
 * 改走新建 ripple-diagnosis 节点直接读磁盘 field_metadata.stale（design §2.2/§2.3）。
 *
 * 保留不删（保守降风险）：唯一消费者是 `contextBuilder.test.ts`（断言 schema 一致性）。
 * 不改其行为。新消费需求请勿扩本函数——stale 消费走 ripple-diagnosis 节点读磁盘。
 *
 * Story 1.4 pattern seed 注入 + Story 1.9 narrative enum 注入仍在用本函数的 derivePatternGuide /
 * formatNarrativeEnumGuide helper（非 stale 消费）；helper 非 deprecated，仅本 buildCreativeRunContext
 * 编排壳不再有生产 caller。
 */
export function buildCreativeRunContext(request: {
  projectPath: string;
  requirement: string;
  projectDocument?: Record<string, unknown> | null;
  targetFields?: CreativeFieldKey[];
  constraints?: Record<string, unknown>;
}) {
  const runId = `run_${Date.now().toString(36)}`;
  const fieldVersions = initFieldVersions();
  let projectDocumentStatus: 'missing' | 'loaded' | 'partial' = 'missing';

  if (request.projectDocument) {
    let _found = 0;
    for (const [key, val] of Object.entries(request.projectDocument)) {
      if (key === 'meta') continue;
      const mapped = FIELD_ALIAS[key];
      if (mapped && val != null) {
        fieldVersions[mapped] = 1;
        _found++;
      }
    }
    projectDocumentStatus = request.projectDocument.meta ? 'loaded' : 'partial';
  }

  return {
    runId,
    projectPath: request.projectPath,
    requirement: request.requirement,
    runIntent: 'create' as const,
    targetFields: request.targetFields ?? [...creativeFieldKeys],
    projectDocument: request.projectDocument ?? null,
    projectDocumentStatus,
    fieldVersions,
    dependencyGraph: getDefaultDependencyGraph(),
    staleFields: [] as CreativeFieldKey[],
    syncEvents: [],
    patternGuide: derivePatternGuide(request.projectDocument),
    // Story 1.9：叙事枚举词表（恒在，静态生成——零 projectDocument 依赖，非派生）。词表是通用先验，
    // 所有 creative run 都带；非 story-planner 的 agent 不引用 = 无害（同 patternGuide）。
    narrativeEnumGuide: formatNarrativeEnumGuide(),
    constraints: {
      language: 'zh-CN' as const,
      ...(request.constraints ?? {}),
    },
    agentPolicy: {
      outputJsonOnly: true,
      noOverwriteOtherFields: true,
      noDiscardUpstreamFacts: true,
      explicitDegradeOnMissing: true,
      traceableSourceRefs: true,
      defaultLanguage: 'zh-CN' as const,
      fieldNameCase: 'snake_case' as const,
    },
  };
}
