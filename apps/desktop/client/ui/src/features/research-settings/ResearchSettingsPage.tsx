/**
 *「研究与视觉」settings page (Story 3.6 WP10, design D14). Mirrors the
 * settings-page shell (settings-page / settings-page-header / form-field-*
 * classes) used by the other SettingsDialog pages. Five sections:
 *
 * - 搜索（search）: engine chain order as TEXT (v1 — no drag; spec'd as
 *   text order + a restore-default button), SearXNG instance URLs, three
 *   upgrade-layer API keys (password inputs; placeholders show「已配置」via the
 *   `*Set` flags — the renderer NEVER receives key material, mirror of
 *   ModelSettings' redact convention; '' on save = keep the stored key).
 * - 代理（proxy）: three tiers (system default / custom + bypass / off) with the
 *   known-limitation note (session proxy AUTH is unsupported, Electron #21269).
 * - 文档解析（doc parser）: endpoint type + baseUrl +「测试连接」health lamp
 *   (green = reachable / red = not) + MinerU ≥3.1 license note.
 * - 视觉模型（vision）: modelRef picker over the existing key/model library
 *   (same data source + save path as the embedding picker — `setModelConfig`,
 *   redacted apiKey '' = keep) +「测试视觉探针」canary button (green = model
 *   read the embedded character; red = silent-strip warning) + the manual-mode
 *   explanation shown when no vision model is designated (R9b: never blind-try
 *   the main text model).
 * - wiki 站点: the two presets read-only + a custom-site list (add/remove rows).
 *
 * The research aggregate (net + search + docParser) loads on mount and saves
 * through ONE「保存」button (`research:save-config`); the vision designation
 * persists immediately via setModelConfig (mirror of the embedding picker).
 */
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  DocParserKind,
  ModelRef,
  ResearchConfigView,
  ResearchConfigSave,
  WikiSiteOverride,
} from '@orison/shared-contracts';
import { DEFAULT_SEARCH_ENGINE_ORDER } from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useToastStore } from '../../shared/store/toastStore';
import {
  canaryProbeVisionModel,
  fetchResearchConfig,
  probeDocParserEndpoint,
  saveResearchConfig,
} from '../../shared/api/researchConfig';

type Props = { t: (key: string, vars?: Record<string, string | number>) => string };

type KeyInputRowProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  configured: boolean;
  clearPending: boolean;
  onToggleClear: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

/**
 * API-key input row with the P6 explicit-CLEAR affordance: a configured key
 * (or a pending clear) shows a toggle button — clicking it marks the key for
 * deletion (`null` rides the save payload); typing a new value un-marks it.
 */
function KeyInputRow({ label, value, onChange, configured, clearPending, onToggleClear, t }: KeyInputRowProps) {
  const placeholder = clearPending
    ? t('researchSettings.keyClearPending')
    : configured
      ? t('researchSettings.keyConfigured')
      : t('researchSettings.keyPlaceholder');
  return (
    <label className="form-field-input-row">
      <span className="form-field-input-label">{label}</span>
      <input
        type="password"
        className="form-field-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        aria-label={label}
      />
      {configured || clearPending ? (
        <button
          type="button"
          className={`settings-danger-button${clearPending ? ' is-active' : ''}`}
          onClick={onToggleClear}
          aria-label={clearPending ? t('researchSettings.keyClearUndo') : t('researchSettings.keyClear')}
          title={clearPending ? t('researchSettings.keyClearUndo') : t('researchSettings.keyClearHint')}
        >
          <span className="material-symbols-outlined" aria-hidden="true">
            {clearPending ? 'undo' : 'delete'}
          </span>
        </button>
      ) : null}
    </label>
  );
}


type ProxyMode = 'system' | 'custom' | 'off';
type WikiSearchKind = 'opensearch' | 'fulltext';

/** Editable custom-site row (strings while editing; validated at save time). */
interface WikiSiteDraft {
  id: string;
  name: string;
  apiBaseUrl: string;
  searchKind: WikiSearchKind;
}

type DocProbeState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok' }
  | { status: 'fail'; detail?: string };

type CanaryState =
  | { status: 'idle' }
  | { status: 'probing' }
  | { status: 'ok'; answer: string }
  | { status: 'strip'; message: string }
  | { status: 'fail'; message: string };

/** Comma/、/space-separated engine ids → ordered list (undefined = default). */
function parseEngineOrder(text: string): string[] | undefined {
  const parts = text.split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** One-URL-per-line textarea → list (undefined = none configured). */
function parseUrlLines(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return lines.length > 0 ? lines : undefined;
}

function seedDraft(view: ResearchConfigView) {
  return {
    engineOrderText: (view.search.engineOrder ?? DEFAULT_SEARCH_ENGINE_ORDER).join(', '),
    searxngUrlsText: view.search.searxngUrls?.join('\n') ?? '',
    localhostProbe: view.search.searxngLocalhostProbe,
    keySet: {
      tavily: view.search.tavilyApiKeySet,
      bocha: view.search.bochaApiKeySet,
      anysearch: view.search.anysearchApiKeySet,
    },
    wikiSites: (view.search.wikiSitesOverrides ?? []).map((s) => ({ ...s })),
    proxyMode: view.net.proxyMode,
    proxyUrl: view.net.proxyUrl ?? '',
    proxyBypass: view.net.proxyBypass ?? '',
    docType: view.docParser.type ?? '',
    docBaseUrl: view.docParser.baseUrl ?? '',
  };
}

export function ResearchSettingsPage({ t }: Props) {
  const showToast = useToastStore((s) => s.showToast);
  const { modelConfig, setModelConfig } = useAppStore(
    useShallow((s) => ({
      modelConfig: s.modelConfig,
      setModelConfig: s.setModelConfig,
    })),
  );

  const [loaded, setLoaded] = useState<ResearchConfigView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Search draft
  const [engineOrderText, setEngineOrderText] = useState('');
  const [searxngUrlsText, setSearxngUrlsText] = useState('');
  const [localhostProbe, setLocalhostProbe] = useState(true);
  const [tavilyKey, setTavilyKey] = useState('');
  const [bochaKey, setBochaKey] = useState('');
  const [anysearchKey, setAnysearchKey] = useState('');
  const [keySet, setKeySet] = useState({ tavily: false, bocha: false, anysearch: false });
  // P6 (CR 2026-08-15): per-key explicit-CLEAR marks — a checked key submits
  // `null` (delete) instead of the keep-sentinel. Typing a new key un-marks.
  const [clearKeys, setClearKeys] = useState({ tavily: false, bocha: false, anysearch: false });
  const [wikiSites, setWikiSites] = useState<WikiSiteDraft[]>([]);

  // Net draft
  const [proxyMode, setProxyMode] = useState<ProxyMode>('system');
  const [proxyUrl, setProxyUrl] = useState('');
  const [proxyBypass, setProxyBypass] = useState('');

  // Doc-parser draft
  const [docType, setDocType] = useState('');
  const [docBaseUrl, setDocBaseUrl] = useState('');

  const [saving, setSaving] = useState(false);
  const [docProbe, setDocProbe] = useState<DocProbeState>({ status: 'idle' });
  const [canary, setCanary] = useState<CanaryState>({ status: 'idle' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const view = await fetchResearchConfig();
      if (cancelled) return;
      if (!view) {
        setLoadFailed(true);
        return;
      }
      setLoaded(view);
      const draft = seedDraft(view);
      setEngineOrderText(draft.engineOrderText);
      setSearxngUrlsText(draft.searxngUrlsText);
      setLocalhostProbe(draft.localhostProbe);
      setKeySet(draft.keySet);
      setWikiSites(draft.wikiSites);
      setProxyMode(draft.proxyMode);
      setProxyUrl(draft.proxyUrl);
      setProxyBypass(draft.proxyBypass);
      setDocType(draft.docType);
      setDocBaseUrl(draft.docBaseUrl);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Vision picker (mirror of the ModelSettingsPage embedding picker) ──

  const enabledModelOptions = useMemo(
    () =>
      modelConfig.keys.flatMap((key) =>
        key.models
          .filter((m) => m.enabled !== false)
          .map((m) => ({ keyId: key.id, keyName: key.name, modelId: m.id, alias: m.alias })),
      ),
    [modelConfig],
  );
  const currentVisionValue = modelConfig.visionModel
    ? `${modelConfig.visionModel.keyId}::${modelConfig.visionModel.modelId}`
    : '';

  /**
   * One canary run (P23): updates the inline verdict lamp AND toasts the
   * outcome — shared by the manual「测试视觉探针」button and the AUTO run that
   * fires when the designation changes (D4「保存时发」: a freshly designated
   * model is probed immediately so a silent-stripping middleman surfaces at
   * designation time, not at the first hallucinated analysis).
   */
  async function runCanaryProbe(ref: ModelRef): Promise<void> {
    setCanary({ status: 'probing' });
    const result = await canaryProbeVisionModel(ref);
    if (!result) {
      setCanary({ status: 'fail', message: t('researchSettings.visionProbeUnavailable') });
      showToast(t('researchSettings.visionProbeUnavailable'), 'error');
      return;
    }
    if (result.ok) {
      setCanary({ status: 'ok', answer: result.answer });
      showToast(t('researchSettings.visionProbeAutoOk', { answer: result.answer }), 'success');
    } else if (result.reason === 'silent-strip') {
      setCanary({ status: 'strip', message: result.message });
      showToast(result.message, 'error');
    } else {
      setCanary({ status: 'fail', message: result.message });
      showToast(result.message, 'error');
    }
  }

  function onVisionModelChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    if (!next || !next.includes('::')) {
      void setModelConfig({ ...modelConfig, visionModel: undefined });
      setCanary({ status: 'idle' });
      return;
    }
    const sepIdx = next.indexOf('::');
    const ref = { keyId: next.slice(0, sepIdx), modelId: next.slice(sepIdx + 2) };
    void setModelConfig({ ...modelConfig, visionModel: ref }).then(() => {
      // P23 (CR 2026-08-15): designation change → canary fires automatically.
      void runCanaryProbe(ref);
    });
  }

  async function onCanaryTest() {
    const ref = modelConfig.visionModel;
    if (!ref) return;
    await runCanaryProbe(ref);
  }

  // ── Doc-parser probe ──

  async function onDocProbe() {
    setDocProbe({ status: 'probing' });
    const result = await probeDocParserEndpoint();
    if (!result) {
      setDocProbe({ status: 'fail', detail: t('researchSettings.docProbeUnavailable') });
      return;
    }
    if (result.ok) setDocProbe({ status: 'ok' });
    else setDocProbe({ status: 'fail', detail: result.detail });
  }

  // ── Wiki custom-site rows ──

  function updateWikiSite(index: number, patch: Partial<WikiSiteDraft>) {
    setWikiSites((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }
  function addWikiSite() {
    setWikiSites((rows) => [...rows, { id: '', name: '', apiBaseUrl: '', searchKind: 'opensearch' }]);
  }
  function removeWikiSite(index: number) {
    setWikiSites((rows) => rows.filter((_, i) => i !== index));
  }

  // ── Save ──

  async function onSave() {
    // Client-side guards for the schema refines — toast the friendly message
    // instead of surfacing a raw Zod rejection (same semantics either way).
    if (proxyMode === 'custom' && !proxyUrl.trim()) {
      showToast(t('researchSettings.validationProxyUrl'), 'error');
      return;
    }
    if (docType && !docBaseUrl.trim()) {
      showToast(t('researchSettings.validationDocBaseUrl'), 'error');
      return;
    }
    // Wiki rows: silently drop fully-empty rows, but a PARTIALLY filled row is
    // user input about to be lost — block the save (never silent data loss).
    const wikiRows = wikiSites.map((row) => ({
      id: row.id.trim(),
      name: row.name.trim(),
      apiBaseUrl: row.apiBaseUrl.trim(),
      searchKind: row.searchKind,
    }));
    const hasPartialRow = wikiRows.some((row) => [row.id, row.name, row.apiBaseUrl].some(Boolean)
      && !(row.id && row.name && row.apiBaseUrl));
    if (hasPartialRow) {
      showToast(t('researchSettings.validationWikiRow'), 'error');
      return;
    }
    const wikiOverrides: WikiSiteOverride[] | undefined = wikiRows
      .filter((row) => row.id && row.name && row.apiBaseUrl)
      .map((row) => ({ ...row }));

    const payload: ResearchConfigSave = {
      net: {
        proxyMode,
        ...(proxyMode === 'custom' && proxyUrl.trim()
          ? {
              proxyUrl: proxyUrl.trim(),
              ...(proxyBypass.trim() ? { proxyBypass: proxyBypass.trim() } : {}),
            }
          : {}),
      },
      search: {
        engineOrder: parseEngineOrder(engineOrderText),
        searxngUrls: parseUrlLines(searxngUrlsText),
        searxngLocalhostProbe: localhostProbe,
        wikiSitesOverrides: wikiOverrides && wikiOverrides.length > 0 ? wikiOverrides : undefined,
        // Three-state key sentinel (P6): null = explicit CLEAR, '' / undefined
        // = keep the persisted key (writeModelConfig redact sentinel).
        tavilyApiKey: clearKeys.tavily ? null : tavilyKey.trim() || undefined,
        bochaApiKey: clearKeys.bocha ? null : bochaKey.trim() || undefined,
        anysearchApiKey: clearKeys.anysearch ? null : anysearchKey.trim() || undefined,
      },
      docParser: docType && docBaseUrl.trim()
        ? { type: docType as DocParserKind, baseUrl: docBaseUrl.trim() }
        : {},
    };

    setSaving(true);
    try {
      await saveResearchConfig(payload);
      // Clear the typed key drafts (never echoed back) + refresh the「已配置」
      // placeholders from the just-persisted state.
      setTavilyKey('');
      setBochaKey('');
      setAnysearchKey('');
      setClearKeys({ tavily: false, bocha: false, anysearch: false });
      const fresh = await fetchResearchConfig();
      if (fresh) {
        setLoaded(fresh);
        setKeySet({
          tavily: fresh.search.tavilyApiKeySet,
          bocha: fresh.search.bochaApiKeySet,
          anysearch: fresh.search.anysearchApiKeySet,
        });
      }
      setDocProbe({ status: 'idle' });
      showToast(t('researchSettings.saved'), 'success');
    } catch (err) {
      showToast(
        t('researchSettings.saveFailed', { reason: err instanceof Error ? err.message : String(err) }),
        'error',
      );
    } finally {
      setSaving(false);
    }
  }

  if (loadFailed) {
    return (
      <div className="settings-page research-settings-page">
        <p className="research-hint">{t('researchSettings.loadFailed')}</p>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="settings-page research-settings-page">
        <p className="research-hint">{t('researchSettings.loading')}</p>
      </div>
    );
  }

  return (
    <div className="settings-page research-settings-page">
      <header className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.research')}</h3>
          <p className="settings-page-subtitle">{t('researchSettings.pageSubtitle')}</p>
        </div>
        <button type="button" className="settings-save-button" onClick={() => void onSave()} disabled={saving}>
          <span className="material-symbols-outlined" aria-hidden="true">save</span>
          {saving ? t('researchSettings.saving') : t('researchSettings.save')}
        </button>
      </header>

      {/* ── 搜索 ── */}
      <section className="research-section" aria-label={t('researchSettings.searchTitle')}>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('researchSettings.searchTitle')}</h3>
            <p className="settings-page-subtitle">{t('researchSettings.searchSubtitle')}</p>
          </div>
          <button
            type="button"
            className="settings-save-button"
            onClick={() => setEngineOrderText(DEFAULT_SEARCH_ENGINE_ORDER.join(', '))}
          >
            <span className="material-symbols-outlined" aria-hidden="true">restart_alt</span>
            {t('researchSettings.engineOrderRestore')}
          </button>
        </header>

        <div className="form-field-row">
          <span className="form-field-label">{t('researchSettings.engineOrder')}</span>
          <input
            className="form-field-input"
            value={engineOrderText}
            onChange={(e) => setEngineOrderText(e.target.value)}
            aria-label={t('researchSettings.engineOrder')}
          />
          <span className="form-field-hint">{t('researchSettings.engineOrderHint')}</span>
          <span className="form-field-hint">{t('researchSettings.engineOrderDefaultChain')}</span>
        </div>

        <div className="form-field-row">
          <label className="form-field-toggle-row">
            <input
              type="checkbox"
              className="form-field-checkbox"
              checked={localhostProbe}
              onChange={(e) => setLocalhostProbe(e.target.checked)}
            />
            <span className="form-field-label">{t('researchSettings.localhostProbe')}</span>
          </label>
          <span className="form-field-hint">{t('researchSettings.localhostProbeHint')}</span>
        </div>

        <div className="form-field-row">
          <span className="form-field-label">{t('researchSettings.searxngUrls')}</span>
          <textarea
            className="form-field-input research-textarea"
            rows={2}
            value={searxngUrlsText}
            onChange={(e) => setSearxngUrlsText(e.target.value)}
            placeholder="http://127.0.0.1:8888"
            aria-label={t('researchSettings.searxngUrls')}
          />
          <span className="form-field-hint">{t('researchSettings.searxngUrlsHint')}</span>
        </div>

        <div className="form-field-row">
          <KeyInputRow
            label={t('researchSettings.tavilyKey')}
            value={tavilyKey}
            onChange={(v) => {
              setTavilyKey(v);
              if (v) setClearKeys((s) => ({ ...s, tavily: false }));
            }}
            configured={keySet.tavily}
            clearPending={clearKeys.tavily}
            onToggleClear={() => {
              setTavilyKey('');
              setClearKeys((s) => ({ ...s, tavily: !s.tavily }));
            }}
            t={t}
          />
          <KeyInputRow
            label={t('researchSettings.bochaKey')}
            value={bochaKey}
            onChange={(v) => {
              setBochaKey(v);
              if (v) setClearKeys((s) => ({ ...s, bocha: false }));
            }}
            configured={keySet.bocha}
            clearPending={clearKeys.bocha}
            onToggleClear={() => {
              setBochaKey('');
              setClearKeys((s) => ({ ...s, bocha: !s.bocha }));
            }}
            t={t}
          />
          <KeyInputRow
            label={t('researchSettings.anysearchKey')}
            value={anysearchKey}
            onChange={(v) => {
              setAnysearchKey(v);
              if (v) setClearKeys((s) => ({ ...s, anysearch: false }));
            }}
            configured={keySet.anysearch}
            clearPending={clearKeys.anysearch}
            onToggleClear={() => {
              setAnysearchKey('');
              setClearKeys((s) => ({ ...s, anysearch: !s.anysearch }));
            }}
            t={t}
          />
          <span className="form-field-hint">{t('researchSettings.keyHint')}</span>
          <span className="form-field-hint">{t('researchSettings.anysearchCloudNote')}</span>
        </div>
      </section>

      {/* ── 代理 ── */}
      <section className="research-section" aria-label={t('researchSettings.proxyTitle')}>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('researchSettings.proxyTitle')}</h3>
            <p className="settings-page-subtitle">{t('researchSettings.proxySubtitle')}</p>
          </div>
        </header>

        <div className="form-field-row">
          <span className="form-field-label">{t('researchSettings.proxyMode')}</span>
          <div className="form-field-options">
            {(['system', 'custom', 'off'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`form-field-option${proxyMode === mode ? ' is-active' : ''}`}
                onClick={() => setProxyMode(mode)}
              >
                {t(`researchSettings.proxy_${mode}`)}
              </button>
            ))}
          </div>
          {proxyMode === 'custom' ? (
            <>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('researchSettings.proxyUrlLabel')}</span>
                <input
                  className="form-field-input"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  aria-label={t('researchSettings.proxyUrlLabel')}
                />
              </label>
              <label className="form-field-input-row">
                <span className="form-field-input-label">{t('researchSettings.proxyBypassLabel')}</span>
                <input
                  className="form-field-input"
                  value={proxyBypass}
                  onChange={(e) => setProxyBypass(e.target.value)}
                  placeholder="*.internal.example.com"
                  aria-label={t('researchSettings.proxyBypassLabel')}
                />
              </label>
            </>
          ) : null}
          <span className="form-field-hint">{t('researchSettings.proxyAuthNote')}</span>
        </div>
      </section>

      {/* ── 文档解析 ── */}
      <section className="research-section" aria-label={t('researchSettings.docTitle')}>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('researchSettings.docTitle')}</h3>
            <p className="settings-page-subtitle">{t('researchSettings.docSubtitle')}</p>
          </div>
          <button
            type="button"
            className="settings-save-button"
            onClick={() => void onDocProbe()}
            disabled={!docType || docProbe.status === 'probing'}
            title={docType ? undefined : t('researchSettings.docProbeNeedsSaveHint')}
          >
            <span className="material-symbols-outlined" aria-hidden="true">link</span>
            {docProbe.status === 'probing' ? t('researchSettings.docTesting') : t('researchSettings.docTest')}
          </button>
        </header>

        <div className="form-field-row">
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('researchSettings.docType')}</span>
            <select
              className="form-field-input"
              value={docType}
              onChange={(e) => {
                setDocType(e.target.value);
                setDocProbe({ status: 'idle' });
              }}
              aria-label={t('researchSettings.docType')}
            >
              <option value="">{t('researchSettings.docTypeNone')}</option>
              <option value="mineru">{t('researchSettings.docTypeMineru')}</option>
              <option value="docling">{t('researchSettings.docTypeDocling')}</option>
              <option value="custom">{t('researchSettings.docTypeCustom')}</option>
            </select>
          </label>
          {docType ? (
            <label className="form-field-input-row">
              <span className="form-field-input-label">{t('researchSettings.docBaseUrlLabel')}</span>
              <input
                className="form-field-input"
                value={docBaseUrl}
                onChange={(e) => {
                  setDocBaseUrl(e.target.value);
                  setDocProbe({ status: 'idle' });
                }}
                placeholder="http://127.0.0.1:8000"
                aria-label={t('researchSettings.docBaseUrlLabel')}
              />
            </label>
          ) : null}
          {docProbe.status === 'ok' ? (
            <span className="research-status is-ok" role="status">
              <span className="research-status-dot is-ok" aria-hidden="true" />
              {t('researchSettings.docProbeOk')}
            </span>
          ) : null}
          {docProbe.status === 'fail' ? (
            <span className="research-status is-fail" role="alert">
              <span className="research-status-dot is-fail" aria-hidden="true" />
              {docProbe.detail ? t('researchSettings.docProbeFailWith', { reason: docProbe.detail }) : t('researchSettings.docProbeFail')}
            </span>
          ) : null}
          <span className="form-field-hint">{t('researchSettings.docMineruNote')}</span>
        </div>
      </section>

      {/* ── 视觉模型 ── */}
      <section className="research-section" aria-label={t('researchSettings.visionTitle')}>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('researchSettings.visionTitle')}</h3>
            <p className="settings-page-subtitle">{t('researchSettings.visionSubtitle')}</p>
          </div>
          <button
            type="button"
            className="settings-save-button"
            onClick={() => void onCanaryTest()}
            disabled={!modelConfig.visionModel || canary.status === 'probing'}
          >
            <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
            {canary.status === 'probing' ? t('researchSettings.visionTesting') : t('researchSettings.visionTest')}
          </button>
        </header>

        <div className="form-field-row">
          <label className="form-field-input-row">
            <span className="form-field-input-label">{t('researchSettings.visionModel')}</span>
            {enabledModelOptions.length > 0 ? (
              <select
                className="form-field-input"
                value={currentVisionValue}
                onChange={onVisionModelChange}
                aria-label={t('researchSettings.visionModel')}
              >
                <option value="">{t('researchSettings.visionNone')}</option>
                {modelConfig.keys.map((key) => {
                  const enabled = key.models.filter((m) => m.enabled !== false);
                  if (enabled.length === 0) return null;
                  return (
                    <optgroup key={key.id} label={key.name}>
                      {enabled.map((m) => (
                        <option key={`${key.id}::${m.id}`} value={`${key.id}::${m.id}`}>
                          {m.alias}
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
              </select>
            ) : (
              <span className="form-field-hint">{t('researchSettings.visionHint')}</span>
            )}
          </label>
          {canary.status === 'ok' ? (
            <span className="research-status is-ok" role="status">
              <span className="research-status-dot is-ok" aria-hidden="true" />
              {t('researchSettings.visionProbeOk', { answer: canary.answer })}
            </span>
          ) : null}
          {canary.status === 'strip' ? (
            <span className="research-status is-fail" role="alert">
              <span className="research-status-dot is-fail" aria-hidden="true" />
              {canary.message}
            </span>
          ) : null}
          {canary.status === 'fail' ? (
            <span className="research-status is-fail" role="alert">
              <span className="research-status-dot is-fail" aria-hidden="true" />
              {canary.message}
            </span>
          ) : null}
          <span className="form-field-hint">
            {modelConfig.visionModel
              ? t('researchSettings.visionProbeNote')
              : t('researchSettings.visionManualNote')}
          </span>
        </div>
      </section>

      {/* ── wiki 站点 ── */}
      <section className="research-section" aria-label={t('researchSettings.wikiTitle')}>
        <header className="settings-page-header">
          <div>
            <h3 className="settings-page-title">{t('researchSettings.wikiTitle')}</h3>
            <p className="settings-page-subtitle">{t('researchSettings.wikiSubtitle')}</p>
          </div>
          <button type="button" className="settings-save-button" onClick={addWikiSite}>
            <span className="material-symbols-outlined" aria-hidden="true">add</span>
            {t('researchSettings.wikiAdd')}
          </button>
        </header>

        <div className="form-field-row">
          <span className="form-field-label">{t('researchSettings.wikiPresetsTitle')}</span>
          <ul className="research-wiki-presets">
            {loaded.wikiPresets.map((preset) => (
              <li key={preset.id}>
                <span className="research-wiki-presets-name">{preset.name}</span>
                <span className="research-wiki-presets-url">{preset.apiBaseUrl}</span>
                <span className="research-wiki-presets-kind">{t(`researchSettings.wikiKind_${preset.searchKind}`)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="form-field-row">
          <span className="form-field-label">{t('researchSettings.wikiCustomTitle')}</span>
          {wikiSites.length === 0 ? (
            <span className="form-field-hint">{t('researchSettings.wikiEmpty')}</span>
          ) : (
            wikiSites.map((row, index) => (
              <div className="research-wiki-row" key={index}>
                <input
                  className="form-field-input"
                  value={row.id}
                  onChange={(e) => updateWikiSite(index, { id: e.target.value })}
                  placeholder={t('researchSettings.wikiId')}
                  aria-label={t('researchSettings.wikiId')}
                />
                <input
                  className="form-field-input"
                  value={row.name}
                  onChange={(e) => updateWikiSite(index, { name: e.target.value })}
                  placeholder={t('researchSettings.wikiName')}
                  aria-label={t('researchSettings.wikiName')}
                />
                <input
                  className="form-field-input"
                  value={row.apiBaseUrl}
                  onChange={(e) => updateWikiSite(index, { apiBaseUrl: e.target.value })}
                  placeholder="https://prts.wiki"
                  aria-label={t('researchSettings.wikiUrl')}
                />
                <select
                  className="form-field-input"
                  value={row.searchKind}
                  onChange={(e) => updateWikiSite(index, { searchKind: e.target.value as WikiSearchKind })}
                  aria-label={t('researchSettings.wikiSearchKind')}
                >
                  <option value="opensearch">{t('researchSettings.wikiKind_opensearch')}</option>
                  <option value="fulltext">{t('researchSettings.wikiKind_fulltext')}</option>
                </select>
                <button
                  type="button"
                  className="research-wiki-remove"
                  onClick={() => removeWikiSite(index)}
                  aria-label={t('researchSettings.wikiDelete')}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">delete</span>
                </button>
              </div>
            ))
          )}
          <span className="form-field-hint">{t('researchSettings.wikiHint')}</span>
        </div>
      </section>
    </div>
  );
}
