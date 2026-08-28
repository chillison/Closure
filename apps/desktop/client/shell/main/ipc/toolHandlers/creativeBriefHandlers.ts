/**
 * creative_brief_update tool handler (Story 8.6 R2, design D2 / §3.1).
 *
 * 冷启动第一问的灵感入档 + 创作基调（genre/theme/tone/audience/length/
 * structure_pattern/taboos/userConstraints/rawRequirement）写通道。此前这些字段无任何
 * leader 写通道（研究 B §3：genre_contract_update 只覆盖 genre_tags/commitments）。
 *
 * **partial merge bounded（单对象非数组——无数组 projector，字段级 set）**，merge 逻辑
 * mirror genreContractHandlers:140-151 + 补 autoApply 档（家族语义 mirror assetCardsHandlers
 * 三层 trust-boundary）：
 *
 *   1. fresh read：creative_brief 缺省 = 合法空（新项目尚未 seed），以 rawRequirement:''
 *      兜底起步 merge；loadProject 返 null / 字段整体非对象 = corrupt 拒（不向空基底
 *      merge 后 action:'set' 覆盖真实不可读数据，mirror readAssetCards）；
 *   2. updates 逐字段覆盖（allowlist 显式挑选，undefined 不覆盖）；**不含**
 *      genre_tags/commitments/world_constitution——那是 genre_contract_update 的领地
 *      （2.5 题材承诺域有专属协议，合并会丢语义，design §7 拒选）；updates 里混入时
 *      忽略 + 输出路由提示（防双写通道静默断）；
 *   3. creativeBriefSchema.safeParse 全量校验（merge 出的整对象）——fail 拒返错（belt-
 *      and-suspenders：既拦本次 updates 的坏值，也拦盘上既有坏数据——错误消息区分两者
 *      来源，前者改参数重发，后者须先手修 project.yaml）；
 *   4. autoApply 双档（mirror assetCardsHandlers DW-4）：true → withProjectLock 内 fresh
 *      read + merge + onFieldEdited('creative_brief', source:'agent') 直接落盘（version
 *      bump + stale 传播 + parse + save 全走既有链）；locked 拒 / 落盘失败 → **降级**
 *      field_patch envelope + 顶部说明（提议不丢，交人审）。缺省/false → 返
 *      `{type:'field_patch', field:'creative_brief', action:'set', data: merged}` envelope
 *      → UI PatchReview 人审 → syncField → onFieldEdited(source:'user')。
 *
 * autoApply 自审闸门（shouldGateAutoApply）在 agent runLoop 派发段（toolPolicy），本 handler
 * 不校验 selfReviewConfirmed（mirror 既有 autoApply handler 家族）。
 *
 * Handlers NEVER throw（never-throws 契约）：malformed param / corrupt project / onFieldEdited
 * throw 全部降级为友好输出。
 */
import type { ToolHandler } from './types';
import { creativeBriefSchema } from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

/** 本工具的 updates allowlist（字段级 set 语义；undefined 不覆盖）。genre-contract 三字段不在内（见文件头）。 */
const BRIEF_UPDATE_FIELDS = [
  'genre',
  'theme',
  'tone',
  'audience',
  'length',
  'structure_pattern',
  'rawRequirement',
  'taboos',
  'userConstraints',
] as const;

/** genre_contract_update 领地字段——updates 混入时忽略 + 路由提示（防双写通道）。 */
const GENRE_CONTRACT_FIELDS = ['genre_tags', 'commitments', 'world_constitution'] as const;

type BriefUpdates = Partial<Record<(typeof BRIEF_UPDATE_FIELDS)[number], unknown>>;

type BriefReadResult =
  | { status: 'absent'; brief: Record<string, unknown> }
  | { status: 'ok'; brief: Record<string, unknown> }
  | { status: 'corrupt'; reason: string };

/**
 * Read the current creative_brief（mirror readAssetCards 三态）：`absent` = project 可载但
 * 无 creative_brief 字段（合法空——{} + rawRequirement:'' 兜底起步是正确 merge 基底）；
 * `corrupt` = loadProject 返 null（整文档坏/缺）或字段整体非对象——拒绝增量 merge（否则
 * envelope accept 会 action:'set' 覆盖真实不可读数据）。
 */
async function readCreativeBriefBase(projectDir: string): Promise<BriefReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[creative_brief] loadProject threw');
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  if (doc === null) {
    return {
      status: 'corrupt',
      reason: '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存创作简报的增量编辑',
    };
  }

  const raw = doc.creative_brief;
  if (raw == null) return { status: 'absent', brief: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    getLogger().warn({ projectDir }, '[creative_brief] field is malformed (non-object)');
    return {
      status: 'corrupt',
      reason: 'creative_brief 字段形态坏（非对象）；请先在项目设定文件中修复，再提交创作简报编辑',
    };
  }
  return { status: 'ok', brief: raw as Record<string, unknown> };
}

/**
 * fresh read + partial merge + full-object safeParse（trust-boundary，单源 helper 双档共用）。
 * undefined 字段不覆盖；rawRequirement 必填兜底（既有 string 保真，非 string/缺省 → ''，
 * mirror genreContractHandlers:142）。
 */
async function computeMergedBrief(
  projectDir: string,
  updates: BriefUpdates,
): Promise<
  | { ok: true; brief: Record<string, unknown>; updatedFields: string[] }
  | { ok: false; message: string }
> {
  const readResult = await readCreativeBriefBase(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `创作简报更新被拒：${readResult.reason}。`,
    };
  }

  // rawRequirement 是 creativeBriefSchema 唯一 required 字段——保真 / 兜底空串。
  const existing = readResult.brief;
  const merged: Record<string, unknown> = {
    ...existing,
    rawRequirement: typeof existing.rawRequirement === 'string' ? existing.rawRequirement : '',
  };
  const updatedFields: string[] = [];
  for (const field of BRIEF_UPDATE_FIELDS) {
    const value = updates[field];
    // CR-005（8.6 BMad CR）：trim 后空串视为未提供跳过——防 LLM/宽松 provider 的空串静默清空既有
    // 字段（rawRequirement 等无 min(1) 门，灵感原文被 '' 覆盖即丢）。数组字段语义不变：显式 [] =
    // 合法的「清空列表」（taboos/userConstraints）。
    if (typeof value === 'string' && value.trim() === '') continue;
    if (value !== undefined) {
      merged[field] = value;
      updatedFields.push(field);
    }
  }

  // 全量校验（belt-and-suspenders）：拦本次坏值 + 盘上既有坏数据（错误消息区分来源）。
  const validated = creativeBriefSchema.safeParse(merged);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const where = issue?.path?.[0];
    const origin =
      typeof where === 'string' && updatedFields.includes(where)
        ? '本次更新传入的值'
        : '盘上既有的创作简报数据（非本次更新）——请先修复项目设定文件';
    return {
      ok: false,
      message:
        `创作简报更新被拒：合并后的简报数据校验失败（${where ?? '?'}：${issue?.message ?? '未知'}）。` +
        `出问题的部分是${origin}。`,
    };
  }
  return { ok: true, brief: validated.data as Record<string, unknown>, updatedFields };
}

/** 挑出 updates 里的 genre-contract 领地字段（忽略 + 路由提示用）。 */
function findGenreContractKeys(updates: Record<string, unknown>): string[] {
  return GENRE_CONTRACT_FIELDS.filter((k) => updates[k] !== undefined);
}

/**
 * creative_brief_update：partial merge bounded 字段级 set → autoApply 双档（见文件头）。
 * suggest 档输出说人话：默认修改先呈现给作者，由作者决定是否采纳。
 */
export const creativeBriefUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008 mirror：宽松 provider / 畸形 arguments 可送达 null/undefined params——头部归一守卫。
  const p = (params ?? {}) as { updates?: unknown; autoApply?: unknown };
  const autoApply = p.autoApply === true;
  const rawUpdates = p.updates;
  const updatesObj =
    rawUpdates && typeof rawUpdates === 'object' && !Array.isArray(rawUpdates)
      ? (rawUpdates as Record<string, unknown>)
      : {};
  const updates: BriefUpdates = updatesObj;

  const genreContractKeys = findGenreContractKeys(updatesObj);
  const routingNote =
    genreContractKeys.length > 0
      ? ` 注意：${genreContractKeys.join(' / ')} 属于 genre_contract_update 工具的领地（题材承诺域），本次已忽略——请改用该工具提交。`
      : '';

  // P16 mirror：allowlist 内无任何字段 = caller bug——友好 no-op 不产零变更 patch。
  const hasAnyField = BRIEF_UPDATE_FIELDS.some((f) => updates[f] !== undefined);
  if (!hasAnyField) {
    return {
      title: 'creative_brief_update',
      output:
        '创作简报更新已跳过：没有提供可更新字段。请在 updates 中至少提供 ' +
        `${BRIEF_UPDATE_FIELDS.join(' / ')} 之一。${routingNote}`,
    };
  }

  // ── autoApply 路径：直接落盘（mirror assetCardsUpdateHandler，withProjectLock 串行化 read-modify-write）──
  // mergedForDegrade 在 onFieldEdited 前捕获，供 catch 降级产 envelope——locked 拒自动落盘时提议不静默丢。
  if (autoApply) {
    let mergedForDegrade: Record<string, unknown> | null = null;
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeMergedBrief(projectDir, updates);
        if (!result.ok) {
          return { title: 'creative_brief_update', output: result.message };
        }
        const merged = result.brief;
        mergedForDegrade = merged;
        // dynamic import local-bff（mirror assetCardsUpdateHandler，避 shell 静态依赖）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'creative_brief', merged, {
          source: 'agent',
          reason: '创作简报更新（auto 档）',
        });
        return {
          title: 'creative_brief_update',
          output:
            `创作简报已直接生效（本次更新字段：${result.updatedFields.join(', ')}；版本号随之更新）。` +
            `${routingNote}`,
          metadata: {
            ok: true,
            applied: true,
            updatedFields: result.updatedFields,
            summary: `creative_brief · ${result.updatedFields.join(', ')} 已更新（自动应用）`,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on locked field / save failure → graceful，永不破 tool。
      // 提议不丢：整体降级为 field_patch envelope + 顶部说明（人审裁决；mirror assetCardsHandlers:243-271）。
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[creative_brief] autoApply landing failed');
      if (mergedForDegrade !== null) {
        return {
          title: 'creative_brief_update',
          output:
            `自动生效被拒（${reason}）。提议没有丢失——已转为呈给作者审阅，由作者决定是否采纳` +
            '（被锁定的字段拒绝自动生效是设计行为）。' + routingNote,
          metadata: {
            type: 'field_patch',
            field: 'creative_brief',
            action: 'set',
            data: mergedForDegrade,
          },
        };
      }
      return {
        title: 'creative_brief_update',
        output: `创作简报自动生效失败：${reason}。更新已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── suggest 路径（默认）：只投影不落盘，返 field_patch envelope 人审 ──
  const result = await computeMergedBrief(projectDir, updates);
  if (!result.ok) {
    return { title: 'creative_brief_update', output: result.message };
  }

  return {
    title: 'creative_brief_update',
    output:
      `创作简报更新已备好（本次更新字段：${result.updatedFields.join(', ')}）——默认会先呈现给作者，由作者决定是否采纳。` +
      routingNote,
    metadata: {
      type: 'field_patch',
      field: 'creative_brief',
      action: 'set',
      data: result.brief,
    },
  };
};
