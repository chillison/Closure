/**
 * Outline tool handlers — outline_read, outline_update.
 *
 * outline_read returns the structured outline (outline_v2) from project.yaml,
 * parsed via local-bff's loadProject (single source of truth — the shell has
 * no direct yaml dependency).
 *
 * outline_update does NOT write to disk — it returns a `field_patch` metadata
 * envelope so the UI can surface the change in the patch-review flow (mirrors
 * rewrite_passage). The user accepts/rejects; acceptance persists via syncField.
 */
import type { ToolHandler } from './types';

async function readOutlineV2(projectDir: string): Promise<unknown> {
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectDir) as Record<string, unknown> | null;
    return doc?.outline_v2 ?? null;
  } catch {
    return null;
  }
}

export const outlineReadHandler: ToolHandler = async ({ projectDir }) => {
  const outline = await readOutlineV2(projectDir);
  if (outline == null) {
    return { title: 'outline_read', output: '项目尚未建立大纲（outline 为空）。' };
  }
  return { title: 'outline_read', output: JSON.stringify(outline, null, 2) };
};

export const outlineUpdateHandler: ToolHandler = async ({ params }) => {
  const { outline } = params as { outline: unknown };
  const phaseCount = Array.isArray((outline as { phases?: unknown[] })?.phases)
    ? (outline as { phases: unknown[] }).phases.length
    : 0;
  return {
    title: 'outline_update',
    output: `大纲更新已备好（共 ${phaseCount} 个阶段）。请在大纲面板审阅——确认后写入项目设定。`,
    metadata: {
      type: 'field_patch',
      field: 'outline',
      action: 'set',
      data: outline,
    },
  };
};
