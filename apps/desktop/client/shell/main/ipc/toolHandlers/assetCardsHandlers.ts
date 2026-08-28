/**
 * asset_cards_update tool handler (Story 3.6 WP9 / R5 策展, design D13).
 *
 * Mirrors sceneGraphHandlers.ts end-to-end: the LLM (leader / researcher after
 * research) curates researched material into typed asset cards via a BOUNDED
 * action enum (add_card / update_card / remove_card). The handler:
 *
 *   1. loads the current asset_cards from project.yaml (single source of truth,
 *      via local-bff loadProject) — distinguishing `absent` (legit empty, fresh
 *      base) from `corrupt` (refuse — never `action:'set'`-overwrite unreadable
 *      data, mirror readSceneGraph CR-008/CR-001);
 *   2. parses each action through assetCardActionSchema (trust-boundary: an
 *      invalid action shape is surfaced to the LLM, never silently dropped);
 *   3. rejects add_card with a duplicate id FRIENDLY (not a silent overwrite —
 *      two cards sharing an id is data pollution invisible in PatchReview);
 *   4. projects via applyAssetCardActions (pure code, shared-contracts) and
 *      re-validates the projection via assetCardsSchema.safeParse
 *      (belt-and-suspenders, mirror sceneGraphHandlers);
 *   5. dual landing (Story 2.2 WP-D, design §5.1 — mirror emotionCurveHandlers
 *      DW-4, 4th autoApply instance): autoApply=true → withProjectLock +
 *      onFieldEdited(source:'agent') DIRECT persist (assetCardsWatcher dir-watch
 *      reindexes; locked field throws → degrade to the envelope below, proposals
 *      never silently lost); autoApply absent/false → returns a `field_patch`
 *      envelope `{type:'field_patch', field:'asset_cards', action:'set', data:
 *      fullCards}` — SAME shape as scene_graph_update. The UI routes it through
 *      WRITE_TOOLS → PatchReviewPanel 人审 → syncField → fieldSyncBridge 落盘 +
 *      version bump → assetCardsWatcher auto-reindex → query_story 检回（落地
 *      公理闭环, AC4）.
 *
 * classify 'diff' (3.6 semantics unchanged — the auto gear is a leader
 * permissionMode==='auto' concern, KD1, not a tool-class change). 批量重建归同
 * 1.2/拆书 E10（互补不重叠）。
 */
import type { ToolHandler } from './types';
import {
  applyAssetCardActions,
  assetCardActionSchema,
  assetCardsSchema,
  type AssetCard,
  type AssetCardAction,
} from '@orison/shared-contracts';
import { withProjectLock } from '../../fs/projectWriteLock';
import { getLogger } from '../../logger';

type AssetCardsReadResult =
  | { status: 'absent'; cards: AssetCard[] }
  | { status: 'ok'; cards: AssetCard[] }
  | { status: 'corrupt'; reason: string };

/**
 * Read the current asset_cards (mirror readSceneGraph): `absent` = project
 * loads but has no asset_cards field (fresh [] is the correct base);
 * `corrupt` = field present but schema-invalid, OR loadProject returned null
 * (whole document corrupt/missing) — refuse incremental edits so a projection
 * + `action:'set'` can never overwrite real unreadable data.
 */
async function readAssetCards(projectDir: string): Promise<AssetCardsReadResult> {
  let doc: Record<string, unknown> | null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[asset_cards] loadProject threw');
    return { status: 'corrupt', reason: `项目设定文件加载失败：${reason}` };
  }

  if (doc === null) {
    return {
      status: 'corrupt',
      reason: '项目设定文件无法读取（可能损坏或缺失）；为安全起见拒绝暂存资产卡的增量编辑',
    };
  }

  const raw = doc.asset_cards;
  if (raw == null) {
    return { status: 'absent', cards: [] };
  }

  const validated = assetCardsSchema.safeParse(raw);
  if (!validated.success) {
    const reason = validated.error.message;
    getLogger().warn({ err: reason, projectDir }, '[asset_cards] field is schema-invalid');
    return { status: 'corrupt', reason: `资产卡字段数据校验失败：${reason}` };
  }
  return { status: 'ok', cards: validated.data };
}

/**
 * 投影 AssetCard actions 到当前 cards → schema-validated full cards（trust-boundary：
 * parse → project → re-validate）。read + duplicate-check + project + validate 单源 helper。
 *
 * - corrupt on-disk cards（或整文档 corrupt）→ 拒绝（不投影到 fresh [] 致 action:'set' overwrite）。
 * - add_card 重复 id → 友好报错（不静默覆盖——同 id 双卡在 PatchReview 面板不可辨，显式让 LLM
 *   换 id 或改走 update_card）。
 * - projected schema-invalid（坏 patch 合并出非法卡）→ 拒绝（belt-and-suspenders）。
 */
async function computeProjectedCards(
  projectDir: string,
  actions: AssetCardAction[],
): Promise<{ ok: true; cards: AssetCard[] } | { ok: false; message: string }> {
  const readResult = await readAssetCards(projectDir);
  if (readResult.status === 'corrupt') {
    return {
      ok: false,
      message: `资产卡更新被拒：${readResult.reason}。请先在项目设定文件中修复或移除损坏的 asset_cards，再重新提交增量编辑。`,
    };
  }
  const current = readResult.cards; // 'absent' -> fresh empty; 'ok' -> loaded cards

  // add_card 重复 id 友好报错（projector 有跳过 backstop，但 LLM 应显式得知冲突而非静默无效果）。
  for (const action of actions) {
    if (action.op === 'add_card' && current.some((c) => c.id === action.card.id)) {
      return {
        ok: false,
        message: `资产卡更新被拒：add_card 的 id "${action.card.id}" 已存在。请改用 update_card（cardId + patch）修改它，或另选一个新 id。`,
      };
    }
  }

  const projected = applyAssetCardActions(current, actions);

  // Trust-boundary defense: a patch can merge into a schema-INVALID card (e.g.
  // name: '' or a malformed typed sub-object). Surface the rejection to the LLM
  // rather than letting an invalid card enter the patch flow (UI parse would
  // swallow it → persist invalid data → loadProject corrupt-backup trap).
  const validated = assetCardsSchema.safeParse(projected);
  if (!validated.success) {
    return {
      ok: false,
      message: `资产卡更新被拒：投影后的卡数据校验失败（${validated.error.message}）。add_card 须携带完整卡（id + type + name 必填），update_card 的 patch 须可合并进合法卡。`,
    };
  }
  return { ok: true, cards: validated.data };
}

/** One line per action for the autoApply landing summary (机械汇编，不判语义；op 与 id 保留原样). */
function summarizeCardActions(actions: readonly AssetCardAction[]): string {
  return actions
    .map((a) => {
      if (a.op === 'add_card') return `+ 新增 ${a.card.type}「${a.card.name}」（${a.card.id}）`;
      if (a.op === 'update_card') {
        const fields = Object.keys(a.patch).join(', ') || '无字段';
        return `~ 更新 ${a.cardId}（${fields}）`;
      }
      return `- 移除 ${a.cardId}`;
    })
    .join('\n');
}

/**
 * asset_cards_update：bounded action enum（add_card / update_card / remove_card）→ 纯代码投影
 * full cards → **双档落盘**（Story 2.2 WP-D，design §5.1，第 4 例 mirror emotionCurveHandlers /
 * settingMdHandlers DW-4）：
 *
 * 1. **autoApply=true（leader 自动落盘，仅 permissionMode 'auto' 才传——KD1 复用档位不加旋钮）**：
 *    withProjectLock 内 fresh read + project + `onFieldEdited(source:'agent', reason:'设定深化提议
 *    （auto 档）')` 直接写盘（version bump + markStaleFields + parse + saveProject 全走既有
 *    onFieldEdited 作用链）→ assetCardsWatcher dir-watch 自动 reindex（勿手动调，mirror 用户编辑流）。
 *    返 `{ok, applied:true, actionCount, cardCount}` metadata + 每卡一行的落盘摘要。onFieldEdited
 *    throw（locked field / save fail）→ **降级**：该次调用整体转 field_patch envelope + 顶部说明
 *    （提议不丢，交人审；mirror Director「locked 持久化失败不阻断」graceful），catch 永不破 tool
 *    （mirror emotionCurveHandlers :238-247）。
 *
 * 2. **autoApply 缺省/false（leader PatchReview 路径，默认）**：返 `field_patch` envelope
 *    （field:'asset_cards', action:'set', data: fullCards）——Story 3.6 行为逐字不变（backward
 *    compat）。UI 路由 WRITE_TOOLS → PatchReviewPanel 人审 → syncField → fieldSyncBridge 落盘 →
 *    assetCardsWatcher reindex。update_card 的 patch 浅合并（未提供字段 + customFields(details)
 *    保留）；remove_card 不存在 id 幂等跳过（mirror promise beat 语义）。
 */
export const assetCardsUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  // CR-008（8.5 BMad CR 顺手同病）：宽松 provider / 畸形 arguments 可送达 null/undefined params——
  // 裸 (params as …).actions 会以 TypeError 击穿 never-throws 契约，头部归一守卫友好降级。
  const p = (params ?? {}) as { actions?: unknown; autoApply?: unknown };
  const rawActions = p.actions;
  const actionList = Array.isArray(rawActions) ? rawActions : [];
  // Story 2.2 WP-D：leader 在 auto 档传 autoApply:true → 直接落盘（见上）。缺省 false →
  // field_patch envelope 走 PatchReview（3.6 行为不变）。
  const autoApply = p.autoApply === true;

  // P16 (CR 2026-08-15): an EMPTY action list is a caller bug — return a
  // friendly no-op WITHOUT staging a patch (a zero-change patch would land in
  // the human-review panel as noise). The agent-side zod (.min(1)) rejects it
  // first; this guard covers lenient providers that bypass the schema.
  if (actionList.length === 0) {
    return {
      title: 'asset_cards_update',
      output:
        '资产卡更新已跳过：操作列表为空。请至少提供一条操作——add_card（card：完整分型卡，id+type+name 必填）/ update_card（cardId + patch）/ remove_card（cardId）。',
    };
  }

  // Trust-boundary: parse each action through the discriminated-union schema.
  // An invalid action shape is surfaced to the LLM via the tool output rather
  // than silently dropping or persisting a malformed card set.
  let actions: AssetCardAction[];
  try {
    actions = actionList.map((a) => assetCardActionSchema.parse(a));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      title: 'asset_cards_update',
      output: `资产卡更新被拒：操作格式无效（${reason}）。可用操作为 add_card（card：完整分型卡，id+type+name 必填）/ update_card（cardId + patch）/ remove_card（cardId）。`,
    };
  }

  // ── autoApply 路径：直接落盘（mirror emotionCurveUpdateHandler autoApply / settingMdHandlers）──
  // withProjectLock 串行化 read-modify-write（fresh read + project + onFieldEdited 一原子单元，
  // 防并发编辑丢更新）。projectedForDegrade 在 onFieldEdited 前捕获，供 catch 降级产 envelope——
  // locked field 拒自动落盘时提议不静默丢（R5：locked 卡拒→降级 patch + 说明）。
  if (autoApply) {
    let projectedForDegrade: AssetCard[] | null = null;
    try {
      return await withProjectLock(projectDir, async () => {
        const result = await computeProjectedCards(projectDir, actions);
        if (!result.ok) {
          return { title: 'asset_cards_update', output: result.message };
        }
        const projectedCards = result.cards;
        projectedForDegrade = projectedCards;
        // dynamic import local-bff（mirror readAssetCards / emotionCurveUpdateHandler，避 shell 静态依赖）。
        const { onFieldEdited } = await import('@orison/desktop-local-bff');
        onFieldEdited(projectDir, 'asset_cards', projectedCards, {
          source: 'agent',
          reason: '设定深化提议（auto 档）',
        });
        return {
          title: 'asset_cards_update',
          output:
            `资产卡已生效（${actions.length} 项操作 → 调整后共 ${projectedCards.length} 张卡，已写入项目设定并同步更新检索）。\n` +
            summarizeCardActions(actions),
          metadata: {
            ok: true,
            applied: true,
            actionCount: actions.length,
            cardCount: projectedCards.length,
            // Batch rows (BatchReportCard L1, Story 3.5) read a one-line summary.
            summary: `资产卡 · ${actions.length} 项操作已生效（自动应用）`,
          },
        };
      });
    } catch (err) {
      // onFieldEdited throws on a locked field / save failure → graceful, never
      // breaks the tool (mirror emotionCurveHandlers autoApply catch). The
      // proposals are NOT lost: degrade the whole call to the field_patch
      // envelope with a header note so the author reviews what the automatic
      // landing was denied for (R5 locked 拒→降级 patch，mirror Director locked
      // graceful——「持久化失败不阻断」）。
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[asset_cards] autoApply landing failed');
      if (projectedForDegrade !== null) {
        return {
          title: 'asset_cards_update',
          output:
            `自动生效被拒（${reason}）。提议没有丢失——已转为呈给作者审阅，请在补丁面板确认` +
            '（被锁定的字段拒绝自动生效是设计行为，由作者决定）。',
          metadata: {
            type: 'field_patch',
            field: 'asset_cards',
            action: 'set',
            data: projectedForDegrade,
          },
        };
      }
      return {
        title: 'asset_cards_update',
        output: `资产卡自动生效失败：${reason}。操作已通过校验，但未做任何改动。`,
      };
    }
  }

  // ── leader PatchReview 路径（默认）：field_patch envelope → UI patch-review → syncField ──
  const result = await computeProjectedCards(projectDir, actions);
  if (!result.ok) {
    return { title: 'asset_cards_update', output: result.message };
  }
  const projectedCards = result.cards;

  return {
    title: 'asset_cards_update',
    output: `资产卡更新已备好：调整后共 ${projectedCards.length} 张卡。请在补丁面板审阅——确认后写入项目设定，并同步更新检索。`,
    metadata: {
      type: 'field_patch',
      field: 'asset_cards',
      action: 'set',
      data: projectedCards,
    },
  };
};
