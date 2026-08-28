/**
 *「知识库索引」settings page (Story 2.7 B段). Mirrors the settings-page shell
 * (settings-page / settings-page-header / form-field-* classes) used by the
 * other SettingsDialog pages. Surfaces derived-index status (craft global +
 * current-project story) + manual rebuild buttons:
 *
 * - craft rebuild → orphan 2.1 `closure:rebuild-craft-kb` finally wired to UI.
 * - story rebuild → Story 2.7 `closure:rebuild-story-index` (reindexAll +
 *   reindexAssetCards).
 *
 * Reads kb-index state + actions from the kb-index slice directly (self-
 * contained feature); receives `t` from SettingsDialog per the i18n convention.
 * The watcher's fire-and-forget backfill toast is handled centrally in
 * useToolEvents (C段); this page handles only its own manual-rebuild result
 * toasts (via the slice).
 */
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../../shared/store/appStore';
import type { IndexStatus } from '@orison/shared-contracts';

type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

function ModelCell({
  t,
  model,
  pending,
}: {
  t: Props['t'];
  model: string | null | undefined;
  pending?: number;
}) {
  // dogfood #39：这格显示的是「已落向量的模型」（closure_entry.model 的 provenance），
  // 不是「配置的模型」。向量一条没落（dim 降级 / 重建前）时 model 为 null——直译
  // 「未配置」会误导已配置的用户（实录：配了 Qwen3-Embedding-8B 却显示未配置）。
  // pending>0 时改口「待补向量」把注意力引向真实欠账；pending 也为 0 才是真空。
  if (!model) {
    return (
      <span className="kb-index-meta-empty">
        {pending && pending > 0 ? t('kbIndex.modelPending', { n: pending }) : t('kbIndex.modelNone')}
      </span>
    );
  }
  return (
    <span className="kb-index-meta-value" title={model}>
      {model}
    </span>
  );
}

/** dogfood #42：数字统计瓦片——大数字 + 小标签 + 待补徽标，替代裸文本行。 */
function CountTile({
  t,
  labelKey,
  value,
  pending,
}: {
  t: Props['t'];
  labelKey: string;
  value: number;
  pending?: number;
}) {
  return (
    <div className="kb-index-tile">
      <span className="kb-index-tile-value">{value}</span>
      <span className="kb-index-tile-label">{t(labelKey)}</span>
      {pending !== undefined && pending > 0 ? (
        <span className="kb-index-tile-pending">{t('kbIndex.pendingHint', { n: pending })}</span>
      ) : null}
    </div>
  );
}

/** dogfood #39（T2 C2）：向量臂降级横幅。degraded 由 shell 判定（isVectorArmDegraded
 * 单源——与启动自动重建同一谓词），本页只渲染不推导；重建进行中不显示（计数在实时
 * 下降，横幅只会闪）。
 *
 * CR-T2-006（2026-08-25）：mismatch 明细改**纯渲染** shell 的 `storedModels`（DISTINCT
 * 全量）——旧写法用五源 LIMIT 1 回退链 model 本地重算，混合态（某源已迁新模型、某源仍旧
 * 模型）零 pending 时横幅只剩标题+指引无因可陈。现在：单一旧模型 → 单模型不符行；多个
 * 存量模型 → 「存量含多模型版本」行。storedModels 缺席（旧 shell/fixture）→ 无 mismatch 行
 * （degraded 可能由 pending 单独触发，语义仍完整）。 */
function DegradedBanner({
  t,
  pending,
  storedModels,
  configuredModelId,
}: {
  t: Props['t'];
  pending: number;
  storedModels: string[] | undefined;
  configuredModelId: string | null | undefined;
}) {
  const models = storedModels ?? [];
  const others = configuredModelId ? models.filter((m) => m !== configuredModelId) : [];
  const mixed = models.length > 1 && others.length > 0;
  return (
    <div className="kb-index-degraded" role="status">
      <span className="material-symbols-outlined" aria-hidden="true">warning</span>
      <div className="kb-index-degraded-body">
        <span className="kb-index-degraded-title">{t('kbIndex.degradedTitle')}</span>
        {mixed ? (
          <span className="kb-index-degraded-line">{t('kbIndex.degradedMixed', { n: models.length })}</span>
        ) : others.length === 1 ? (
          <span className="kb-index-degraded-line">
            {t('kbIndex.degradedModel', { stored: others[0], configured: configuredModelId ?? '' })}
          </span>
        ) : null}
        {pending > 0 ? (
          <span className="kb-index-degraded-line">{t('kbIndex.degradedPending', { n: pending })}</span>
        ) : null}
        <span className="kb-index-degraded-line">{t('kbIndex.degradedAction')}</span>
      </div>
    </div>
  );
}

function CraftSection({
  t,
  status,
  configuredModelId,
  rebuilding,
  onRebuild,
}: {
  t: Props['t'];
  status: IndexStatus['craft'] | undefined;
  configuredModelId: string | null | undefined;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  return (
    <section className="kb-index-section">
      <header className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('kbIndex.craftTitle')}</h3>
          <p className="settings-page-subtitle">{t('kbIndex.craftSubtitle')}</p>
        </div>
        <button
          type="button"
          className="settings-save-button"
          onClick={onRebuild}
          disabled={rebuilding}
        >
          <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          {rebuilding ? t('kbIndex.rebuilding') : t('kbIndex.rebuildCraft')}
        </button>
      </header>
      {status?.degraded && !rebuilding ? (
        <DegradedBanner
          t={t}
          pending={status.pending}
          storedModels={status.storedModels}
          configuredModelId={configuredModelId}
        />
      ) : null}
      <div className="kb-index-meta-grid">
        <CountTile t={t} labelKey="kbIndex.count" value={status?.count ?? 0} pending={status?.pending} />
      </div>
      <div className="kb-index-model-row">
        <span className="form-field-label">{t('kbIndex.model')}</span>
        <ModelCell t={t} model={status?.model} pending={status?.pending} />
      </div>
    </section>
  );
}

function StorySection({
  t,
  status,
  configuredModelId,
  hasProject,
  rebuilding,
  onRebuild,
}: {
  t: Props['t'];
  status: IndexStatus['story'] | undefined;
  configuredModelId: string | null | undefined;
  hasProject: boolean;
  rebuilding: boolean;
  onRebuild: () => void;
}) {
  return (
    <section className="kb-index-section">
      <header className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('kbIndex.storyTitle')}</h3>
          <p className="settings-page-subtitle">{t('kbIndex.storySubtitle')}</p>
        </div>
        <button
          type="button"
          className="settings-save-button"
          onClick={onRebuild}
          disabled={rebuilding || !hasProject}
        >
          <span className="material-symbols-outlined" aria-hidden="true">refresh</span>
          {rebuilding ? t('kbIndex.rebuilding') : t('kbIndex.rebuildStory')}
        </button>
      </header>
      {!hasProject ? (
        <p className="kb-index-empty-hint">{t('kbIndex.noProjectHint')}</p>
      ) : (
        <>
          {status?.degraded && !rebuilding ? (
            <DegradedBanner
              t={t}
              pending={status.pending}
              storedModels={status.storedModels}
              configuredModelId={configuredModelId}
            />
          ) : null}
          <div className="kb-index-meta-grid">
            <CountTile t={t} labelKey="kbIndex.projectAssets" value={status?.projectAssets ?? 0} />
            <CountTile t={t} labelKey="kbIndex.assetCards" value={status?.assetCards ?? 0} />
            <CountTile t={t} labelKey="kbIndex.settingMd" value={status?.settingMd ?? 0} />
            <CountTile t={t} labelKey="kbIndex.chapterChunks" value={status?.chapterChunks ?? 0} />
            <CountTile t={t} labelKey="kbIndex.chapterSummaries" value={status?.chapterSummaries ?? 0} />
            <CountTile t={t} labelKey="kbIndex.pending" value={status?.pending ?? 0} />
          </div>
          <div className="kb-index-model-row">
            <span className="form-field-label">{t('kbIndex.model')}</span>
            <ModelCell t={t} model={status?.model} pending={status?.pending} />
          </div>
        </>
      )}
    </section>
  );
}

export function KbIndexSettingsPage({ t }: Props) {
  const {
    indexStatus,
    indexLoading,
    indexRebuilding,
    fetchIndexStatus,
    rebuildCraftIndex,
    rebuildStoryIndex,
    hasProject,
  } = useAppStore(
    useShallow((s) => ({
      indexStatus: s.indexStatus,
      indexLoading: s.indexLoading,
      indexRebuilding: s.indexRebuilding,
      fetchIndexStatus: s.fetchIndexStatus,
      rebuildCraftIndex: s.rebuildCraftIndex,
      rebuildStoryIndex: s.rebuildStoryIndex,
      hasProject: !!s.currentProject,
    })),
  );

  // Fetch on mount so the counts reflect the current state when the page opens.
  // The slice's project-reset clears `indexStatus` on switch, so navigating away
  // and back always refetches (no stale cross-project counts).
  useEffect(() => {
    void fetchIndexStatus();
  }, [fetchIndexStatus]);

  // dogfood #42：重建进行中每 2s 轮询——「待补向量」等计数实时下降，而非等整段
  // 重建（可能数分钟）结束才一次性刷新。rebuilding 归 null（完成/失败）停表；
  // slice 的 rebuild 收尾自身还会 fetch 一次终态。
  //
  // CR-T2-014（2026-08-25）：后台扫在途（status.sweepInflight——启动 reconcile /
  // save-model 迁移扫，与 CR-T2-005 扫闸同源）并入「重建中」面。否则 indexRebuilding 为
  // null（非本页发起），降级横幅随 2s 轮询闪进闪出 + role=status 每次播报；并入后横幅
  // 抑制 + 轮询照跑 + 按钮置「重建中…」（此时点击会被 shell 闸以 sweep-in-progress 拒）。
  const sweepInflight = indexStatus?.sweepInflight === true;
  const rebuilding = indexRebuilding !== null || sweepInflight;
  useEffect(() => {
    if (!rebuilding) return;
    const timer = setInterval(() => {
      void fetchIndexStatus();
    }, 2000);
    return () => clearInterval(timer);
  }, [rebuilding, fetchIndexStatus]);

  return (
    <div className="settings-page kb-index-page">
      <header className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.kbIndex')}</h3>
          <p className="settings-page-subtitle">{t('kbIndex.pageSubtitle')}</p>
        </div>
      </header>

      {indexLoading && !indexStatus ? (
        <p className="kb-index-empty-hint">{t('kbIndex.loading')}</p>
      ) : null}

      <CraftSection
        t={t}
        status={indexStatus?.craft}
        configuredModelId={indexStatus?.embeddingConfiguredModelId}
        rebuilding={indexRebuilding === 'craft' || sweepInflight}
        onRebuild={() => void rebuildCraftIndex()}
      />

      <StorySection
        t={t}
        status={indexStatus?.story}
        configuredModelId={indexStatus?.embeddingConfiguredModelId}
        hasProject={hasProject}
        rebuilding={indexRebuilding === 'story' || sweepInflight}
        onRebuild={() => void rebuildStoryIndex()}
      />
    </div>
  );
}
