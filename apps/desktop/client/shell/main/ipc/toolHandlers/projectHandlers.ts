/**
 * Project tool handlers — project_meta, memory_query, memory_update, skill
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { assertWithinProject } from '../pathGuard';
import { notifyUI } from '../toolNotify';
import type { ToolHandler } from './types';
import { atomicWriteFileSync } from '@orison/shared-contracts/fs/atomicWrite';
import { creativeFieldKeys, clearStaleFields, creativeFieldKeySchema, type CreativeFieldKey } from '@orison/shared-contracts';
import { loadProject, saveProject } from '@orison/desktop-local-bff';

export const projectMetaHandler: ToolHandler = async ({ projectDir }) => {
  const metaPath = path.join(projectDir, 'project.yaml');
  if (!existsSync(metaPath)) return { title: 'project_meta', output: '未找到项目设定文件。' };

  const content = readFileSync(metaPath, 'utf-8');
  return { title: 'project_meta', output: content };
};

/**
 * Story 3.4（R1/C-A2）list_stale_fields handler——读 project.yaml field_metadata，
 * 返回 stale===true 的 CreativeFieldKey[]（涟漪诊断候选集）。
 *
 * 经 loadProject 拿 projectDocumentSchema-parsed doc（非裸 yaml parse，避 corrupt / 半态），
 * 遍历 field_metadata 找 stale===true。范式判据（ADR-3）：纯磁盘查询（读标记），无语义判断。
 * mirror worldStateHandlers「never throws」契约——project 缺/corrupt → 空候选 + friendly 文案，
 * 不让 agent runLoop turn 见到 reject。
 */
export const listStaleFieldsHandler: ToolHandler = async ({ projectDir }) => {
  let doc: ReturnType<typeof loadProject>;
  try {
    doc = loadProject(projectDir);
  } catch {
    // loadProject 抛（IO / parse 异常）→ friendly，非 throw（mirror worldStateHandlers never-throws）
    return {
      title: 'list_stale_fields',
      output: '无法读取项目设定文件，暂无 stale 字段候选。',
      metadata: { ok: false, reason: 'project_load_failed', staleFields: [] as CreativeFieldKey[] },
    };
  }
  if (!doc) {
    // project.yaml 缺/corrupt（loadProject 返 null = backupCorruptFile + 重建空项目的信号）
    return {
      title: 'list_stale_fields',
      output: '项目尚未初始化或项目设定文件损坏，暂无 stale 字段候选。',
      metadata: { ok: false, reason: 'project_missing', staleFields: [] as CreativeFieldKey[] },
    };
  }

  const meta = doc.field_metadata ?? {};
  // 遍历 creativeFieldKeys（source-of-truth enum）保字段集稳定 + 顺序稳定（非 Object.entries 依赖 yaml 写入序）。
  const staleFields: CreativeFieldKey[] = creativeFieldKeys.filter(
    (key) => meta[key]?.stale === true,
  );

  const output =
    staleFields.length > 0
      ? `stale 字段候选（${staleFields.length}）：${staleFields.join(', ')}`
      : '当前无 stale 字段（所有创作字段均为最新）。';
  return {
    title: 'list_stale_fields',
    output,
    metadata: { ok: true, staleFields },
  };
};

/**
 * Story 3.4 Phase 4.2：dismiss_stale_fields handler——清指定字段的 stale 标记（落盘 stale=false）。
 *
 * 作者 dismiss 涟漪报告（「这场实际不受影响」）时 leader 调此工具，shell handler 读 project.yaml →
 * clearStaleFields(currentStale, fields)（workflow-sync.ts 纯函数，markStaleFields 对偶）→
 * 写回 field_metadata[field].stale=false → saveProject 落盘。
 *
 * 🔑 范式判据（ADR-3）：stale 是机械元数据标记（true/false），非创作内容——dismiss 直接落盘
 * 元数据 = 纯代码（非语义判断），不走 PatchReview（创作数据 patch 才走人审）。
 *
 * 🔑 硬约束：
 * - 入参 fields 须全在 creativeFieldKeys enum 内（creativeFieldKeySchema 校验，畸形 reject）。
 * - locked 字段不 dismiss（作者锁定的字段 stale 是改动信号，需作者先解锁）——locked 字段从 dismiss
 *   集剔除 + 文案告知 leader。
 * - mirror listStaleFieldsHandler「never throws」契约：project 缺/corrupt / saveProject 抛 → friendly
 *   文案 + ok=false，不让 agent runLoop turn 见到 reject。
 *
 * 幂等：dismiss 已是 stale=false 的字段无效果（field_metadata[field].stale=false 重复写）。
 */
export const dismissStaleFieldsHandler: ToolHandler = async ({ params, projectDir }) => {
  // ── 1. 入参 fields 校验（每条 creativeFieldKeySchema，畸形 reject 不崩）──
  const rawFields = (params as { fields?: unknown }).fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return {
      title: 'dismiss_stale_fields',
      output: '入参 fields 须为非空 CreativeFieldKey[] 数组。',
      metadata: { ok: false, reason: 'invalid_fields_param', dismissed: [] as CreativeFieldKey[], skipped: [] as CreativeFieldKey[] },
    };
  }
  const parsedFields: CreativeFieldKey[] = [];
  for (const f of rawFields) {
    const parse = creativeFieldKeySchema.safeParse(f);
    if (parse.success) {
      parsedFields.push(parse.data);
    }
  }
  if (parsedFields.length === 0) {
    return {
      title: 'dismiss_stale_fields',
      output: '入参 fields 无合法 CreativeFieldKey（全部畸形）。',
      metadata: { ok: false, reason: 'invalid_fields_param', dismissed: [] as CreativeFieldKey[], skipped: [] as CreativeFieldKey[] },
    };
  }

  // ── 2. 读 project（mirror listStaleFieldsHandler graceful 套路）──
  let doc: ReturnType<typeof loadProject>;
  try {
    doc = loadProject(projectDir);
  } catch {
    return {
      title: 'dismiss_stale_fields',
      output: '无法读取项目设定文件，dismiss 失败。',
      metadata: { ok: false, reason: 'project_load_failed', dismissed: [] as CreativeFieldKey[], skipped: [] as CreativeFieldKey[] },
    };
  }
  if (!doc) {
    return {
      title: 'dismiss_stale_fields',
      output: '项目尚未初始化或项目设定文件损坏，dismiss 失败。',
      metadata: { ok: false, reason: 'project_missing', dismissed: [] as CreativeFieldKey[], skipped: [] as CreativeFieldKey[] },
    };
  }

  // ── 3. 剔除 locked 字段（作者锁定字段 stale 不清，需作者先解锁）──
  const meta = doc.field_metadata ?? {};
  const lockedSkipped: CreativeFieldKey[] = [];
  const dismissible = parsedFields.filter((f) => {
    if (meta[f]?.locked === true) {
      lockedSkipped.push(f);
      return false;
    }
    return true;
  });

  // ── 4. 调 clearStaleFields 纯函数算剩余 stale 集（mirror workflow-sync markStaleFields/clearStaleFields）──
  const currentStale = creativeFieldKeys.filter((key) => meta[key]?.stale === true);
  const dismissibleSet = new Set(dismissible);
  // dismissed = currentStale ∩ dismissible（按 enum 序，mirror listStaleFields enum-序 convention）。
  const dismissedActual = currentStale.filter((f) => dismissibleSet.has(f));
  const remainingStale = clearStaleFields(currentStale, dismissible);

  // ── 5. 写回 field_metadata[field].stale=false for dismissedActual + 落盘 ──
  // BMad CR Fix 4（MINOR4+E2）：写循环从 `dismissible`（含非 stale 字段）改为 `dismissedActual`（只含
  // 真被 dismiss 的 stale 字段）——不给非 stale 字段伪造 metadata（非 stale 字段写 stale=false 是冗余，
  // 且 field_metadata 缺省时会新建 `{version:0,...}` 默认条目污染 field_metadata）。
  // dismissedActual 空（无可 dismiss）→ **不落盘**（doc 未变，免无意义 version bump + field_metadata 创建）。
  if (dismissedActual.length === 0) {
    // 无真 dismiss（入参字段均非 stale 或全被锁定）→ 不落盘，直接出文案。
    const outputLines: string[] = [];
    // BMad CR Fix 4（E2 自相矛盾文案）：dismissedActual 空时区分两因——lockedSkipped 非空 = 入参全被锁定；
    // 否则 = 入参均非 stale（幂等）。消旧文案「均非 stale」与「被锁定」同现的自相矛盾。
    if (lockedSkipped.length > 0) {
      outputLines.push(`入参字段全被作者锁定，未 dismiss（需作者先解锁）：${lockedSkipped.join(', ')}。`);
    } else {
      outputLines.push('入参字段均非 stale（无需 dismiss，幂等无效果）。');
    }
    if (remainingStale.length > 0) {
      outputLines.push(`剩余 stale 字段（${remainingStale.length}）：${remainingStale.join(', ')}。`);
    } else {
      outputLines.push('现在所有字段均为最新（无 stale）。');
    }
    return {
      title: 'dismiss_stale_fields',
      output: outputLines.join('\n'),
      metadata: {
        ok: true,
        dismissed: [] as CreativeFieldKey[],
        skipped: lockedSkipped,
        remainingStale,
      },
    };
  }

  const metaNext = { ...meta };
  for (const f of dismissedActual) {
    const existing = metaNext[f] ?? { version: 0, source: 'user' as const, locked: false, stale: false, dependsOn: [] };
    metaNext[f] = { ...existing, stale: false };
  }
  doc.field_metadata = metaNext;

  try {
    saveProject(projectDir, doc);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'dismiss_stale_fields',
      output: `落盘失败（saveProject 抛错：${reason}），dismiss 未生效。`,
      metadata: { ok: false, reason: 'save_failed', dismissed: [] as CreativeFieldKey[], skipped: lockedSkipped, remainingStale },
    };
  }

  // ── 6. 通知 UI（project.yaml 落盘 → file:changed 让 UI 侧打开的 project.yaml tab 同步 +
  // 触发 store 重读 project.yaml 拿新 field_metadata.stale；mirror memoryUpdateHandler 通知模式）──
  notifyUI({ type: 'file:changed', projectPath: projectDir, path: 'project.yaml' });

  const outputLines: string[] = [];
  outputLines.push(`已清除 ${dismissedActual.length} 个字段的 stale 标记：${dismissedActual.join(', ')}。`);
  if (lockedSkipped.length > 0) {
    outputLines.push(`⚠️ ${lockedSkipped.length} 个字段被作者锁定，未清除 stale（需作者先解锁）：${lockedSkipped.join(', ')}。`);
  }
  if (remainingStale.length > 0) {
    outputLines.push(`剩余 stale 字段（${remainingStale.length}）：${remainingStale.join(', ')}。`);
  } else {
    outputLines.push('现在所有字段均为最新（无 stale）。');
  }

  return {
    title: 'dismiss_stale_fields',
    output: outputLines.join('\n'),
    metadata: {
      ok: true,
      dismissed: dismissedActual,
      skipped: lockedSkipped,
      remainingStale,
    },
  };
};

export const memoryQueryHandler: ToolHandler = async ({ params, projectDir }) => {
  const { query } = params as { query?: string };
  const memPath = path.join(projectDir, 'story-memory.yaml');
  assertWithinProject(projectDir, memPath);
  if (!existsSync(memPath)) return { title: 'memory_query', output: '未找到故事记忆文件（story-memory.yaml）。' };

  const content = readFileSync(memPath, 'utf-8');
  if (!query) return { title: 'memory_query', output: content };

  // Simple keyword filter on sections
  const lines = content.split('\n');
  const matched = lines.filter((l) => l.toLowerCase().includes(query.toLowerCase()));
  return {
    title: `memory_query: ${query}`,
    output: matched.length > 0 ? matched.join('\n') : `未找到与「${query}」相关的记忆条目。`,
    metadata: { count: matched.length },
  };
};

export const memoryUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const { content } = params as { content: string };
  const memPath = path.join(projectDir, 'story-memory.yaml');
  assertWithinProject(projectDir, memPath);
  atomicWriteFileSync(memPath, content, 'utf-8');

  // Notify memory listeners (recall) and file-level listeners (open-tab reload).
  // Without file:changed, an editor showing story-memory.yaml won't refresh
  // until manually closed and reopened. Path is project-relative, matching
  // writeFileHandler's convention.
  notifyUI({ type: 'memory:changed', projectPath: projectDir });
  notifyUI({ type: 'file:changed', projectPath: projectDir, path: 'story-memory.yaml' });
  return { title: 'memory_update', output: `故事记忆已更新（${content.length} 字符）。` };
};

export const skillHandler: ToolHandler = async ({ params, projectDir }) => {
  const { name } = params as { name: string };
  const skillsDir = path.join(projectDir, '.orison', 'skills');
  assertWithinProject(projectDir, skillsDir);

  if (!existsSync(skillsDir)) return { title: 'skill', output: `未找到技能「${name}」。当前没有可用技能。` };

  const files = readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
  const match = files.find((f) => f.replace('.md', '') === name);
  if (!match) {
    const available = files.map((f) => f.replace('.md', '')).join(', ');
    return { title: 'skill', output: `未找到技能「${name}」。可用技能：${available || '无'}` };
  }

  const content = readFileSync(path.join(skillsDir, match), 'utf-8');
  return { title: `skill: ${name}`, output: content };
};
