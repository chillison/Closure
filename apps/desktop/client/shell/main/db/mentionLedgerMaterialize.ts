import {
  buildCoarseScan,
  computeMentionSignals,
  mergeMentionChannels,
  type CastDeclaration,
  type MentionCardIndexEntry,
  type MentionChannelFacts,
  type MentionSignal,
} from '@orison/shared-contracts';
import { getLogger } from '../logger';
import { getDb } from './index';
import { upsertEpisodeMentions } from './mentionLedgerRepository';
import { listWorldSlices, listWorldSubjects } from './worldStateRepository';
import { worldSliceEpisodeId } from './worldStateMaterialize';

// ── Story 8.7 S8（design §2.2）：mention 共现账汇账核心（链上 mention-ledger-node 触发）──
//
// materialize_chapter_summary 的 mention 对位件（mirror worldStateMaterialize 归属层：本模块住 db 层，
// IPC 壳（mentionLedgerHandlers 的 recordEpisodeMentionsHandler）从本模块 import 组装核心）。汇账步骤
// 全纯代码（S3 shared-contracts 纯函数家族单源）：粗筛计数 / subject→卡桥查表 / 四通道合并取最高态 /
// 差异信号判定——「谁真登场了、梗概写什么」归写手 LLM（cast_declaration，已在链内产出）。
//
// 数据分工（design §2.2 输入清单）：
// - 链内 artifact 投影（调用方传）：episodeId / declaration（可缺 = 保守账）/ draftText（粗筛源）/
//   plannedAssetRefs（本章场 assetRefs 展开）。
// - db + project.yaml（本模块自取，mirror materializeChapterSummaryCore 单次全扫）：本章 patches
//   （episode 归属单源 worldSliceEpisodeId）/ subject→卡桥（closure_world_subject.source_card_id）/
//   卡索引（project.yaml asset_cards 的 id/name/basics.aliases，direct 抽取 + 逐条守性）。
//
// 🔑 已知限制诚实记录（design §1.1）：无卡主体不入账（subject 无 source_card_id 桥跳过）；建卡前的
// 在场记录不回溯（卡 id 桥在建卡时才产生）；粗筛通道可回溯（名字在正文里）。新面孔经信号走议题链
// （S9 leader 注入段消费，本步只产结构化 mention_signals artifact）。
//
// synopsis 回填（design §1.5/§2.2「回填」决断）：declaration 存在 → UPDATE closure_chapter_summary 的
// summary JSON `$.synopsis`。链序保证 chapter-summary-node 已物化（mention-ledger 挂 storytime-drift 后
// = chapter-summary 紧后第二位）；bypass/直调无行 → 记 degradedReason 不报错。两节点经 artifact 解耦
// 非时序耦合（implement.md 风险文件注记），redo 幂等（per-episode 全量替换 + json_set 覆盖）。
//
// 范式判据（ADR-3）：本核心 = 查询/汇编/计数（纯函数在 shared-contracts 单源，此处只取数组装 + 落表），
// 零语义判断——「实体该不该出场/是否被遗忘」归消费端 LLM。

/**
 * 读卡索引（project.yaml asset_cards → {entryId, name, aliases}，名字解析 + 粗筛共用输入面）。
 *
 * loader 选 local-bff `loadProject` 单源（mirror worldStateMaterialize readChapterProjectSources——含
 * 既有迁移 + 整档校验，shell 不自带第二套 yaml 读法）；本函数只做 direct 抽取 + 逐条守性（坏条目丢好
 * 条目留）。⚠️ 卡索引**不可用（loadProject 抛/null）→ 返 null**（区别于「项目无卡」的空数组）——名字
 * 解析与粗筛都以此为词表，缺词表的账会系统性失真，保守跳过整章记账（DERIVED 可下次重收）好过写错账。
 */
async function readCardIndex(projectDir: string): Promise<MentionCardIndexEntry[] | null> {
  let doc: Record<string, unknown> | null = null;
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    doc = loadProject(projectDir) as Record<string, unknown> | null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: msg, projectDir }, 'record_episode_mentions: loadProject threw');
  }
  if (doc === null) return null;

  const cardsRaw = doc.asset_cards;
  if (!Array.isArray(cardsRaw)) return []; // 项目无卡 = 合法空词表（首章前 / 纯环境章项目）
  const out: MentionCardIndexEntry[] = [];
  for (const card of cardsRaw) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) continue;
    const c = card as { id?: unknown; name?: unknown; basics?: unknown };
    if (typeof c.id !== 'string' || c.id.length === 0) continue;
    if (typeof c.name !== 'string' || c.name.length === 0) continue;
    const basics = c.basics;
    const aliasesRaw =
      basics && typeof basics === 'object' && !Array.isArray(basics)
        ? (basics as { aliases?: unknown }).aliases
        : undefined;
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw.filter((a): a is string => typeof a === 'string' && a.length > 0)
      : undefined;
    out.push({ entryId: c.id, name: c.name, ...(aliases !== undefined && aliases.length > 0 ? { aliases } : {}) });
  }
  return out;
}

/** record_episode_mentions 组装输入（链段 artifact 投影，recordEpisodeMentionsRequestSchema 同形）。 */
export interface RecordEpisodeMentionsInput {
  declaration?: CastDeclaration;
  draftText: string;
  plannedAssetRefs?: readonly string[];
}

/** synopsis 回填四态（'skipped' = BMad CR-009：summary 行在但列为 NULL——json_set(NULL) 恒 NULL，如实报告非假 applied）。 */
export type MentionSynopsisOutcome = 'applied' | 'no_declaration' | 'no_summary_row' | 'skipped';

/** record_episode_mentions 核心结果（handler 返回 + mention-ledger-node artifact 原料）。 */
export interface RecordEpisodeMentionsResult {
  /** 落库行数（(章, 实体) 一行；0 = 本章零命中零申报——合法空账，per-episode 全量替换已清空旧账）。 */
  rowCount: number;
  /** 对拍差异信号（五类，computeMentionSignals 单源；S9 leader 注入段消费）。 */
  signals: MentionSignal[];
  synopsis: MentionSynopsisOutcome;
  /** 输入面降级注记（summary 行缺 / synopsis 回填失败等；空 = 无）。 */
  degradedReasons: string[];
}

/**
 * 汇账核心（handler 主体）：取数（db 单次全扫 + project.yaml 卡索引）→ S3 纯函数家族（粗筛 /
 * 桥接 / 合并 / 信号）→ upsertEpisodeMentions（per-episode 全量替换单 WAL 事务）→ synopsis 回填。
 *
 * 全扫选择（vs 按 episode 收窄查询）：subject 卡桥（listWorldSubjects）本就全量；slices 全扫 +
 * worldSliceEpisodeId 过滤与 materializeChapterSummaryCore 同源（同一归类器两处漂移 = 错归属）。
 *
 * graceful（design §2.2 / mirror chapter-summary「增强非硬约束」）：任一通道输入缺失 → 该通道全零
 * （无 patches = 在场/状态通道零；无 plannedAssetRefs = 计划通道零；无 declaration = 保守账），
 * 不抛不阻断。唯一整章跳过态 = 卡索引不可用（readCardIndex null——写错账不如不写）。
 */
export async function recordEpisodeMentionsCore(
  projectId: string,
  projectDir: string,
  episodeId: string,
  input: RecordEpisodeMentionsInput,
): Promise<RecordEpisodeMentionsResult> {
  // ── 卡索引（名字解析 + 粗筛词表）──
  const cardIndex = await readCardIndex(projectDir);
  if (cardIndex === null) {
    getLogger().warn(
      { projectId, episodeId },
      'record_episode_mentions: asset_cards unavailable → skip ledger write this episode (DERIVED, re-collectable)',
    );
    return { rowCount: 0, signals: [], synopsis: 'no_declaration', degradedReasons: ['asset_cards_unavailable'] };
  }
  const cardIdSet = new Set(cardIndex.map((c) => c.entryId));

  // ── 本章 patches（episode 归属单源：episode_id 列优先 + 存量 slice.id 前缀解析）──
  const chapterPatches = listWorldSlices(projectId, { withPatches: true })
    .filter((s) => worldSliceEpisodeId(s) === episodeId)
    .flatMap((s) => s.patches ?? []);

  // ── subject → 卡桥（closure_world_subject.source_card_id；无桥跳过 + 桥指已删卡过滤）──
  const bridgeBySubject = new Map<string, string>();
  for (const subject of listWorldSubjects(projectId)) {
    if (subject.sourceCardId !== undefined && cardIdSet.has(subject.sourceCardId)) {
      bridgeBySubject.set(subject.id, subject.sourceCardId);
    }
  }

  // ── 步骤 2 粗筛：卡名+别名不重叠子串计数（纯函数单源）──
  const coarse = buildCoarseScan(input.draftText, cardIndex);

  // ── 步骤 3 在场升格 + 状态对拍：本章 /presence_scene patches 的 subject 升格；全部 patches 触及
  //    subject 记 state_changed（恒 present；经卡桥，无桥跳过）──
  const presenceSubjects = new Set<string>();
  const touchedSubjects = new Set<string>();
  for (const patch of chapterPatches) {
    touchedSubjects.add(patch.subjectId);
    if (patch.path === '/presence_scene') presenceSubjects.add(patch.subjectId);
  }
  const bridgedPresence = new Set<string>();
  for (const s of presenceSubjects) {
    const bridged = bridgeBySubject.get(s);
    if (bridged !== undefined) bridgedPresence.add(bridged);
  }
  const bridgedTouched = new Set<string>();
  for (const s of touchedSubjects) {
    const bridged = bridgeBySubject.get(s);
    if (bridged !== undefined) bridgedTouched.add(bridged);
  }

  // ── 步骤 4 计划对拍：本章场 assetRefs（链段已展开传入；词表外的 id 过滤——锚卡不存在不造行）──
  const planned = new Set((input.plannedAssetRefs ?? []).filter((id) => cardIdSet.has(id)));

  // ── per-entry 通道事实（步骤 2-4 汇聚；行集 = 通道命中实体 ∪ 申报解析实体——mergeMentionChannels 内并）──
  const factEntryIds = new Set<string>(coarse.keys());
  for (const id of bridgedPresence) factEntryIds.add(id);
  for (const id of bridgedTouched) factEntryIds.add(id);
  for (const id of planned) factEntryIds.add(id);
  const channelFacts: MentionChannelFacts[] = [...factEntryIds].sort().map((entryId) => ({
    entryId,
    coarseCount: coarse.get(entryId) ?? 0,
    presenceShot: bridgedPresence.has(entryId),
    planLinked: planned.has(entryId),
    stateChanged: bridgedTouched.has(entryId),
  }));

  // ── 步骤 5 合并 + 步骤 6 信号（纯函数单源；同形输入一次组装两处喂，S3 契约）──
  const rows = mergeMentionChannels({
    cardIndex,
    ...(input.declaration !== undefined ? { declaration: input.declaration } : {}),
    channelFacts,
  });
  const signals = computeMentionSignals({
    episodeId,
    cardIndex,
    ...(input.declaration !== undefined ? { declaration: input.declaration } : {}),
    channelFacts,
  });

  // ── 步骤 7 写表（单 WAL 事务 per-episode 全量替换，S3 repository；S9 起携 signals 同事务写
  //    closure_mention_signals——信号重算输入〔申报〕不持久，落表是 leader 注入段/查询面唯一持久面）──
  upsertEpisodeMentions(projectId, episodeId, rows, signals);

  // ── synopsis 回填（declaration 存在 + synopsis 非空——castDeclarationSchema 已钉 trim.min(1)）──
  // BMad CR-009：**UPDATE 前置 NULL 预筛**——SQLite `json_set(NULL, ...)` 恒 NULL 但 UPDATE 的 changes=1
  // （行被匹配），若列可为 NULL 会把「没写成」误报 applied。mirror 同文件 degradeEpisodeMentions 的
  // NULL 守卫（`row.summary == null → 跳过标注`）对称：先 SELECT 预检——行不存在 → no_summary_row；
  // 行在但 summary NULL → 'skipped' 如实报告（不 UPDATE 白跑）。⚠️ 当前 schema `summary TEXT NOT NULL`
  // （db/index.ts）使 NULL 行不可达——本预检是防御 belt（约束将来放宽/异构库时诚实），测试经宽松克隆表
  // 构造 NULL 行真跑守卫分支。WAL 单进程下 SELECT→UPDATE 无竞态窗口。
  const degradedReasons: string[] = [];
  let synopsis: MentionSynopsisOutcome = 'no_declaration';
  if (input.declaration !== undefined) {
    synopsis = 'applied';
    try {
      const db = getDb();
      const row = db
        .prepare('SELECT summary FROM closure_chapter_summary WHERE project_id = ? AND episode_id = ?')
        .get(projectId, episodeId) as { summary?: string | null } | undefined;
      if (row === undefined) {
        // 无 summary 行（bypass/直调/物化失败章）——mention 账照常，梗概缺位记降级不报错。
        synopsis = 'no_summary_row';
        degradedReasons.push('summary_row_missing');
      } else if (row.summary == null) {
        // 行在但列为 NULL（手改库/半写入态）——json_set 写不进，如实 skipped（非假 applied）。
        synopsis = 'skipped';
        degradedReasons.push('summary_row_null');
      } else {
        const updated = db
          .prepare(
            "UPDATE closure_chapter_summary SET summary = json_set(summary, '$.synopsis', ?) " +
              'WHERE project_id = ? AND episode_id = ?',
          )
          .run(input.declaration.synopsis, projectId, episodeId);
        if (updated.changes === 0) {
          // 防御分支：预检命中与 UPDATE 之间行被并发删除（理论上不可达，belt）。
          synopsis = 'no_summary_row';
          degradedReasons.push('summary_row_missing');
        }
      }
    } catch (err) {
      // 坏 summary JSON（手动改库等）→ json_set 抛；mention 账已落（独立关注点），梗概缺位记降级。
      const msg = err instanceof Error ? err.message : String(err);
      synopsis = 'no_summary_row';
      degradedReasons.push(`synopsis_backfill_failed: ${msg}`);
      getLogger().warn({ projectId, episodeId, err: msg }, 'record_episode_mentions: synopsis backfill failed');
    }
  }

  return { rowCount: rows.length, signals, synopsis, degradedReasons };
}
