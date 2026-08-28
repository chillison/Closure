/**
 * creative_preferences_update tool handler (Story 8.6 R3, design D3/D4 / §3.1).
 *
 * 创作深度偏好（分项目的作者工作方式，四轴 + note）写通道——冷启动问偏好（R3）的落盘端。
 * 逐字段 mirror creativeBriefHandlers（partial merge bounded 字段级 set + autoApply 双档）：
 *
 *   1. fresh read：creative_preferences 缺省 = 合法空（absent = 未问 = 标准档，fresh 项目
 *      不产假偏好）；corrupt（loadProject null / 字段非对象）拒；
 *   2. updates 逐字段覆盖（allowlist：outline_depth / arc_timing / world_depth /
 *      character_depth / note；undefined 不覆盖——只改问到的轴）；
 *   3. creativePreferencesSchema.safeParse 全量校验（四轴 enum 拦非法档位值 + 盘上坏数据）；
 *   4. autoApply 双档（mirror assetCardsHandlers DW-4）：true → withProjectLock +
 *      onFieldEdited('creative_preferences', source:'agent') 直接落盘；locked 拒 → 降级
 *      envelope + 说明。缺省 → `{type:'field_patch', field:'creative_preferences',
 *      action:'set', data: merged}` envelope——creative_preferences 已进 creativeFieldKeys
 *      （Step 1），走既有 generic PatchReview 链零 UI 改动。
 *
 * autoApply 自审闸门在 agent runLoop（toolPolicy），本 handler 不校验 selfReviewConfirmed
 * （mirror 既有家族）。Handlers NEVER throw。
 */
import type { ToolHandler } from './types';
import { creativePreferencesSchema } from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

/** updates allowlist（四轴 + 自由备注；字段级 set，undefined 不覆盖）。 */
const PREFERENCES_UPDATE_FIELDS = [
  'outline_depth',
  'arc_timing',
  'world_depth',
  'character_depth',
  'note',
] as const;

type PreferencesUpdates = Partial<Record<(typeof PREFERENCES_UPDATE_FIELDS)[number], unknown>>;

type PreferencesReadResult =
  | { status: 'absent'; prefs: Record<string, unknown> }
  | { status: 'ok'; prefs: Record<string, unknown> }
  | { status: 'corrupt'; reason: string };

/** Read the current creative_preferences（mirror readCreativeBriefBase 三态）。 */
async function readCreativePreferencesBase(projectDir: string): Promise<PreferencesReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[creative_preferences] loadProject threw');
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  if (doc === null) {
    return {
      status: 'corrupt',
      reason: '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存创作偏好的增量编辑',
    };
  }

  const raw = doc.creative_preferences;
  if (raw == null) return { status: 'absent', prefs: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    getLogger().warn({ projectDir }, '[creative_preferences] field is malformed (non-object)');
    return {
      status: 'corrupt',
      reason: 'creative_preferences 字段形态坏（非对象）；请先在项目设定文件中修复，再提交创作偏好编辑',
    };
  }
  return { status: 'ok', prefs: raw as Record<string, unknown> };
}

/**
 * fresh read + partial merge + full-object safeParse（trust-boundary 单源 helper，双档共用，
 * mirror computeMergedBrief）。
 */
async function computeMergedPreferences(
  projectDir: string,
  updates: PreferencesUpdates,
): Promise<
  | { ok: true; prefs: Record<string, unknown>; updatedFields: string[] }
  | { ok: false; message: string }
> {
  const readResult = await readCreativePreferencesBase(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `创作偏好更新被拒：${readResult.reason}。`,
    };
  }

  const merged: Record<string, unknown> = { ...readResult.prefs };
  const updatedFields: string[] = [];
  for (const field of PREFERENCES_UPDATE_FIELDS) {
    const value = updates[field];
    // CR-005（8.6 BMad CR）：trim 后空串视为未提供跳过——防空串静默清空既有 note（mirror
    // creativeBriefHandlers 同修；轴值是 enum 非空串，此守卫实际只触 note）。
    if (typeof value === 'string' && value.trim() === '') continue;
    if (value !== undefined) {
      merged[field] = value;
      updatedFields.push(field);
    }
  }

  const validated = creativePreferencesSchema.safeParse(merged);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const where = issue?.path?.[0];
    const origin =
      typeof where === 'string' && updatedFields.includes(where)
        ? '本次更新传入的值（四轴取值须为各自档位枚举之一）'
        : '盘上既有的创作偏好数据（非本次更新）——请先修复项目设定文件';
    return {
      ok: false,
      message:
        `创作偏好更新被拒：合并后的偏好数据校验失败（${where ?? '?'}：${issue?.message ?? '未知'}）。` +
        `出问题的部分是${origin}。`,
    };
  }
  return { ok: true, prefs: validated.data as Record<string, unknown>, updatedFields };
}

/**
 * creative_preferences_update：partial merge bounded 字段级 set → autoApply 双档（见文件头）。
 * suggest 档输出说人话：默认修改先呈现给作者，由作者决定是否采纳。
 */
export const creativePreferencesUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008 mirror：params null/undefined 头部归一守卫（never-throws 契约）。
  const p = (params ?? {}) as { updates?: unknown; autoApply?: unknown };
  const autoApply = p.autoApply === true;
  const rawUpdates = p.updates;
  const updates: PreferencesUpdates =
    rawUpdates && typeof rawUpdates === 'object' && !Array.isArray(rawUpdates)
      ? (rawUpdates as PreferencesUpdates)
      : {};

  // P16 mirror：allowlist 内无任何字段 = caller bug——友好 no-op 不产零变更 patch。
  const hasAnyField = PREFERENCES_UPDATE_FIELDS.some((f) => updates[f] !== undefined);
  if (!hasAnyField) {
    return {
      title: 'creative_preferences_update',
      output:
        '创作偏好更新已跳过：没有提供可更新字段。请在 updates 中至少提供 ' +
        `${PREFERENCES_UPDATE_FIELDS.join(' / ')} 之一。`,
    };
  }

  // ── autoApply 路径：直接落盘（mirror creativeBriefUpdateHandler）──
  if (autoApply) {
    let mergedForDegrade: Record<string, unknown> | null = null;
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeMergedPreferences(projectDir, updates);
        if (!result.ok) {
          return { title: 'creative_preferences_update', output: result.message };
        }
        const merged = result.prefs;
        mergedForDegrade = merged;
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'creative_preferences', merged, {
          source: 'agent',
          reason: '创作偏好更新（auto 档）',
        });
        return {
          title: 'creative_preferences_update',
          output:
            `创作偏好已直接生效（本次更新：${result.updatedFields.join(', ')}；版本号随之更新）。`,
          metadata: {
            ok: true,
            applied: true,
            updatedFields: result.updatedFields,
            summary: `creative_preferences · ${result.updatedFields.join(', ')} 已更新（自动应用）`,
          },
        };
      });
    } catch (err) {
      // locked 拒 / save 失败 → graceful；提议不丢——降级 envelope 人审（mirror assetCardsHandlers:243-271）。
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[creative_preferences] autoApply landing failed');
      if (mergedForDegrade !== null) {
        return {
          title: 'creative_preferences_update',
          output:
            `自动生效被拒（${reason}）。提议没有丢失——已转为呈给作者审阅，由作者决定是否采纳` +
            '（被锁定的字段拒绝自动生效是设计行为）。',
          metadata: {
            type: 'field_patch',
            field: 'creative_preferences',
            action: 'set',
            data: mergedForDegrade,
          },
        };
      }
      return {
        title: 'creative_preferences_update',
        output: `创作偏好自动生效失败：${reason}。更新已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── suggest 路径（默认）：只投影不落盘，返 field_patch envelope 人审（generic PatchReview 链）──
  const result = await computeMergedPreferences(projectDir, updates);
  if (!result.ok) {
    return { title: 'creative_preferences_update', output: result.message };
  }

  return {
    title: 'creative_preferences_update',
    output:
      `创作偏好更新已备好（本次更新：${result.updatedFields.join(', ')}）——默认会先呈现给作者，由作者决定是否采纳。`,
    metadata: {
      type: 'field_patch',
      field: 'creative_preferences',
      action: 'set',
      data: result.prefs,
    },
  };
};
