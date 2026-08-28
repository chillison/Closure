/**
 * Story 2.5 GenreContract tool handler — genre_contract_update.
 *
 * Mirror overviewHandlers.ts / outlineHandlers.ts (the creative-field write
 * pattern). Does NOT write to disk — returns a `field_patch` metadata envelope
 * so the UI surfaces the change in the patch-review flow. On accept, the UI
 * persists via syncField (fieldSyncBridge → project.yaml + version bump).
 *
 * Handles three GenreContract fields across two creative fields:
 * - creative_brief.genre_tags (optional) → replaces full creative_brief on accept
 * - creative_brief.commitments (optional) → replaces full creative_brief on accept
 * - world_setting.world_constitution (optional) → replaces full world_setting on accept
 *
 * If creative_brief fields (genre_tags / commitments) are provided, the main
 * metadata envelope is `{type:'field_patch', field:'creative_brief', ...}`.
 * If world_constitution is ALSO provided, it rides as a `worldConstitutionPatch`
 * sub-field in the same metadata (mirror infoReleasePatch / emotionCurvePatch
 * pattern in write-chapter.ts — agentSessionSlice routes both).
 * If ONLY world_constitution is provided (no creative_brief fields), the main
 * metadata envelope is `{type:'field_patch', field:'world_setting', ...}`.
 *
 * 范式判据（creative-vs-mechanical.md）：承诺建议 = LLM（leader 提议，经此工具 surfacing）；
 * 字段路由 / patch 落盘 = 纯代码（此 handler + syncField）。design §2.1 / implement.md step 7。
 *
 * Trust-boundary defense: corrupt on-disk creative_brief/world_setting → refuse
 * to stage (don't overwrite unreadable data). Missing fields (new project) →
 * seed from defaults (creative_brief needs rawRequirement fallback).
 */
import type { ToolHandler } from './types';

type CommitmentEntry = { type: string; content: string };

interface GenreContractParams {
  genre_tags?: unknown;
  commitments?: unknown;
  world_constitution?: unknown;
}

/**
 * Coerce an unknown value to a string[] (filtering non-strings + empties).
 * Returns `undefined` when the input is not an array OR when the array is non-empty
 * but every element is garbage (non-string / empty) — the latter is treated as
 * "LLM intended to propose values but emitted junk", NOT "clear the field", so the
 * caller skips staging (avoids silently wiping existing tags on all-garbage input,
 * BMad CR-003). Only an explicit empty array `[]` returns `[]` (= intentional clear).
 */
function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (v.length > 0 && out.length === 0) return undefined; // all-garbage → don't stage
  return out;
}

/**
 * Coerce an unknown value to a CommitmentEntry[], or undefined.
 * Same all-garbage rule as coerceStringArray (BMad CR-003): non-empty input that
 * yields zero valid entries → undefined (don't stage, avoid wiping existing
 * commitments); explicit `[]` → `[]` (intentional clear).
 */
function coerceCommitments(v: unknown): CommitmentEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CommitmentEntry[] = [];
  for (const entry of v) {
    if (typeof entry !== 'object' || entry === null) continue;
    const type = (entry as Record<string, unknown>).type;
    const content = (entry as Record<string, unknown>).content;
    if (typeof type === 'string' && type.length > 0 && typeof content === 'string' && content.length > 0) {
      out.push({ type, content });
    }
  }
  if (v.length > 0 && out.length === 0) return undefined; // all-garbage → don't stage
  return out;
}

/**
 * Read creative_brief + world_setting from project.yaml (single source of
 * truth — loadProject via local-bff). Returns null on corrupt/missing project
 * so the handler can refuse to stage (don't overwrite unreadable data).
 */
async function readCreativeFields(
  projectDir: string,
): Promise<{ creativeBrief: Record<string, unknown> | null; worldSetting: Record<string, unknown> | null }> {
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectDir) as Record<string, unknown> | null;
    if (doc === null) return { creativeBrief: null, worldSetting: null };
    return {
      creativeBrief: (doc.creative_brief as Record<string, unknown> | undefined) ?? {},
      worldSetting: (doc.world_setting as Record<string, unknown> | undefined) ?? {},
    };
  } catch {
    return { creativeBrief: null, worldSetting: null };
  }
}

export const genreContractUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const src = params as GenreContractParams;
  const genreTags = coerceStringArray(src.genre_tags);
  const commitments = coerceCommitments(src.commitments);
  const worldConstitution = coerceStringArray(src.world_constitution);

  const hasCreativeBriefFields = genreTags !== undefined || commitments !== undefined;
  const hasWorldSettingFields = worldConstitution !== undefined;

  if (!hasCreativeBriefFields && !hasWorldSettingFields) {
    return {
      title: 'genre_contract_update',
      output: '未提供任何题材承诺字段（genre_tags / commitments / world_constitution），没有可更新的内容。',
    };
  }

  const { creativeBrief, worldSetting } = await readCreativeFields(projectDir);

  // Refuse to stage when the project is corrupt — merging onto a fresh empty
  // object would `action:'set'`-overwrite real (unreadable) data on accept.
  if (hasCreativeBriefFields && creativeBrief === null) {
    return {
      title: 'genre_contract_update',
      output: '题材承诺更新被拒：项目设定文件无法读取（可能损坏或缺失）。请先修复项目文件，再提交创作简报（creative_brief）相关编辑。',
    };
  }
  if (hasWorldSettingFields && worldSetting === null) {
    return {
      title: 'genre_contract_update',
      output: '题材承诺更新被拒：项目设定文件无法读取（可能损坏或缺失）。请先修复项目文件，再提交世界设定（world_setting）相关编辑。',
    };
  }

  // ── Build merged data + metadata ──
  // Primary field_patch goes into metadata.type/field/action/data.
  // If world_constitution is co-provided with creative_brief fields, it rides
  // as worldConstitutionPatch sub-field (mirror infoReleasePatch pattern).
  // If only world_constitution → primary envelope is world_setting.
  let metadata: Record<string, unknown>;
  const summaryParts: string[] = [];

  if (hasCreativeBriefFields) {
    // Merge GenreContract fields into the current creative_brief. rawRequirement
    // is required by creativeBriefSchema — preserve existing or fallback to ''.
    const mergedCreativeBrief: Record<string, unknown> = {
      ...creativeBrief,
      rawRequirement: typeof creativeBrief!.rawRequirement === 'string' ? creativeBrief!.rawRequirement : '',
    };
    if (genreTags !== undefined) {
      mergedCreativeBrief.genre_tags = genreTags;
      summaryParts.push(`genre_tags (${genreTags.length})`);
    }
    if (commitments !== undefined) {
      mergedCreativeBrief.commitments = commitments;
      summaryParts.push(`commitments (${commitments.length})`);
    }

    metadata = {
      type: 'field_patch',
      field: 'creative_brief',
      action: 'set',
      data: mergedCreativeBrief,
    };

    // Ride world_constitution as a sub-field patch (mirror infoReleasePatch).
    if (hasWorldSettingFields) {
      const mergedWorldSetting = { ...worldSetting, world_constitution: worldConstitution };
      metadata.worldConstitutionPatch = {
        type: 'field_patch',
        field: 'world_setting',
        action: 'set',
        data: mergedWorldSetting,
      };
      summaryParts.push(`world_constitution (${worldConstitution!.length})`);
    }
  } else {
    // Only world_constitution → primary envelope is world_setting.
    const mergedWorldSetting = { ...worldSetting, world_constitution: worldConstitution };
    metadata = {
      type: 'field_patch',
      field: 'world_setting',
      action: 'set',
      data: mergedWorldSetting,
    };
    summaryParts.push(`world_constitution (${worldConstitution!.length})`);
  }

  return {
    title: 'genre_contract_update',
    output: `题材承诺更新已备好（${summaryParts.join('、')}）。请在补丁面板审阅——确认后写入项目设定。`,
    metadata,
  };
};
