/**
 * 「研究与视觉」settings page tests (Story 3.6 WP10). Mirrors
 * modelSettingsPage.test.tsx — render with the identity `t` (assert on i18n
 * KEYS), mock `window.orisonDesktop` (injection seam, spec/ui/testing), and
 * seed the appStore's modelConfig/setModelConfig for the vision picker.
 *
 * Locks: section rendering + preset display, the redacted-key feedback
 * (password placeholders from the `*Set` flags, never echoed key material),
 * the ''-sentinel save path (blank key inputs send undefined = keep), the
 * client-side guards (custom proxy without URL / half doc-parser config /
 * partial wiki row block the save), probe + canary result state matrix, and
 * the vision-designation save through setModelConfig (redacted keys preserved).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelConfig, ResearchConfigSave, ResearchConfigView } from '@orison/shared-contracts';
import { ResearchSettingsPage } from '../src/features/research-settings/ResearchSettingsPage';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';

const baseView: ResearchConfigView = {
  net: { proxyMode: 'system' },
  search: {
    engineOrder: ['searxng-local', 'bing', 'baidu', 'ddg'],
    searxngLocalhostProbe: true,
    tavilyApiKey: '',
    bochaApiKey: '',
    anysearchApiKey: '',
    tavilyApiKeySet: true,
    bochaApiKeySet: false,
    anysearchApiKeySet: false,
  },
  docParser: {},
  wikiPresets: [
    { id: 'moegirl-cn', name: '萌娘百科（官方站）', apiBaseUrl: 'https://zh.moegirl.org.cn', searchKind: 'opensearch' },
    { id: 'moegirl-uk', name: '萌娘百科（镜像站）', apiBaseUrl: 'https://moegirl.uk', searchKind: 'fulltext', fulltextOnMirror: true },
  ],
};

const modelConfig: ModelConfig = {
  keys: [
    {
      id: 'key_001',
      name: 'Relay',
      protocol: 'openai-compatible',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: '',
      models: [
        { id: 'qwen-vl-max', alias: 'Qwen VL Max', capability: 'text', enabled: true },
        { id: 'gpt-4o-mini', alias: 'GPT 4o mini', capability: 'text', enabled: true },
      ],
    },
  ],
};

const tFake = (key: string) => key;

function lastToast(): string | undefined {
  return useToastStore.getState().toasts.at(-1)?.message;
}

describe('ResearchSettingsPage', () => {
  let loadResearchConfig: ReturnType<typeof vi.fn>;
  let saveResearchConfig: ReturnType<typeof vi.fn>;
  let probeResearchDocParser: ReturnType<typeof vi.fn>;
  let canaryProbeVision: ReturnType<typeof vi.fn>;
  let setModelConfig: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    loadResearchConfig = vi.fn().mockResolvedValue(baseView);
    saveResearchConfig = vi.fn().mockResolvedValue(undefined);
    probeResearchDocParser = vi.fn();
    canaryProbeVision = vi.fn();
    setModelConfig = vi.fn().mockResolvedValue(undefined);
    (window as any).orisonDesktop = {
      loadResearchConfig,
      saveResearchConfig,
      probeResearchDocParser,
      canaryProbeVision,
    };
    useAppStore.setState({ modelConfig, setModelConfig } as any);
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders all five sections with the read-only wiki presets and the seeded chain order', async () => {
    render(<ResearchSettingsPage t={tFake} />);

    // Presets visible once the async load lands.
    expect(await screen.findByText('萌娘百科（官方站）')).toBeInTheDocument();
    expect(screen.getByText('萌娘百科（镜像站）')).toBeInTheDocument();
    // All five section headers.
    expect(screen.getByText('researchSettings.searchTitle')).toBeInTheDocument();
    expect(screen.getByText('researchSettings.proxyTitle')).toBeInTheDocument();
    expect(screen.getByText('researchSettings.docTitle')).toBeInTheDocument();
    expect(screen.getByText('researchSettings.visionTitle')).toBeInTheDocument();
    expect(screen.getByText('researchSettings.wikiTitle')).toBeInTheDocument();
    // Chain order seeded from the loaded config.
    expect((screen.getByLabelText('researchSettings.engineOrder') as HTMLInputElement).value).toBe(
      'searxng-local, bing, baidu, ddg',
    );
  });

  it('shows the load failure hint when the IPC read fails', async () => {
    loadResearchConfig.mockResolvedValue(null);
    render(<ResearchSettingsPage t={tFake} />);
    expect(await screen.findByText('researchSettings.loadFailed')).toBeInTheDocument();
  });

  it('redact feedback: configured keys show the「已配置」placeholder, unconfigured show the input hint', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    expect(screen.getByPlaceholderText('researchSettings.keyConfigured')).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText('researchSettings.keyPlaceholder')).toHaveLength(2);
  });

  it('blank key inputs send undefined (keep sentinel); a typed key is sent through', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    // Two unconfigured keys (bocha + anysearch) share the hint placeholder —
    // type into the first (bocha, DOM order: tavily / bocha / anysearch).
    await userEvent.type(screen.getAllByPlaceholderText('researchSettings.keyPlaceholder')[0], 'tvly-new');
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));

    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalledTimes(1));
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    // The TYPED field targets bocha (the first unconfigured placeholder).
    expect(payload.search.bochaApiKey).toBe('tvly-new');
    // Blank/untouched fields ride the keep sentinel — never '' strings.
    expect(payload.search.tavilyApiKey).toBeUndefined();
    expect(payload.search.anysearchApiKey).toBeUndefined();
    // Post-save refetch refreshes the「已配置」placeholders.
    expect(loadResearchConfig).toHaveBeenCalledTimes(2);
  });

  it('custom proxy without a URL is blocked client-side (no IPC call, toast shown)', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.proxy_custom' }));
    // Custom tier reveals the URL + bypass inputs.
    expect(screen.getByLabelText('researchSettings.proxyUrlLabel')).toBeInTheDocument();
    expect(screen.getByLabelText('researchSettings.proxyBypassLabel')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    expect(saveResearchConfig).not.toHaveBeenCalled();
    expect(lastToast()).toBe('researchSettings.validationProxyUrl');
  });

  it('custom proxy with URL + bypass saves the full net tier', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.proxy_custom' }));
    await userEvent.type(screen.getByLabelText('researchSettings.proxyUrlLabel'), 'http://127.0.0.1:7890');
    await userEvent.type(screen.getByLabelText('researchSettings.proxyBypassLabel'), '*.internal.example.com');
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));

    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.net).toEqual({
      proxyMode: 'custom',
      proxyUrl: 'http://127.0.0.1:7890',
      proxyBypass: '*.internal.example.com',
    });
  });

  it('doc parser: half config blocked; full config saved; probe lamp shows ok then fail states', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.selectOptions(screen.getByLabelText('researchSettings.docType'), 'mineru');
    // baseUrl input appears with the endpoint type.
    expect(screen.getByLabelText('researchSettings.docBaseUrlLabel')).toBeInTheDocument();
    // Half config → blocked.
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    expect(saveResearchConfig).not.toHaveBeenCalled();
    expect(lastToast()).toBe('researchSettings.validationDocBaseUrl');

    await userEvent.type(screen.getByLabelText('researchSettings.docBaseUrlLabel'), 'http://127.0.0.1:8000');
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.docParser).toEqual({ type: 'mineru', baseUrl: 'http://127.0.0.1:8000' });

    // Probe lamp: green on ok, red with the detail on failure.
    probeResearchDocParser.mockResolvedValueOnce({ ok: true, kind: 'mineru' });
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.docTest' }));
    expect(await screen.findByText('researchSettings.docProbeOk')).toBeInTheDocument();

    probeResearchDocParser.mockResolvedValueOnce({ ok: false, kind: 'mineru', detail: 'HTTP 500' });
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.docTest' }));
    expect(await screen.findByText('researchSettings.docProbeFailWith')).toBeInTheDocument();
  });

  it('vision picker saves the designation through setModelConfig and preserves the redacted keys', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    // Manual-mode note while unconfigured; the canary button is disabled.
    expect(screen.getByText('researchSettings.visionManualNote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'researchSettings.visionTest' })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText('researchSettings.visionModel'), 'key_001::qwen-vl-max');
    await waitFor(() => expect(setModelConfig).toHaveBeenCalledTimes(1));
    const saved = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect(saved.visionModel).toEqual({ keyId: 'key_001', modelId: 'qwen-vl-max' });
    // Redacted apiKey ('') rides along — the keep sentinel on the shell side.
    expect(saved.keys[0].apiKey).toBe('');
  });

  it('canary matrix: pass shows the model answer; silent-strip and failures show their messages', async () => {
    useAppStore.setState({
      modelConfig: { ...modelConfig, visionModel: { keyId: 'key_001', modelId: 'qwen-vl-max' } },
    } as any);
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    canaryProbeVision.mockResolvedValueOnce({ ok: true, answer: '闭' });
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.visionTest' }));
    expect(await screen.findByText('researchSettings.visionProbeOk')).toBeInTheDocument();

    canaryProbeVision.mockResolvedValueOnce({
      ok: false,
      reason: 'silent-strip',
      message: 'SILENT-STRIP-WARNING',
    });
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.visionTest' }));
    expect(await screen.findByText('SILENT-STRIP-WARNING')).toBeInTheDocument();

    canaryProbeVision.mockResolvedValueOnce({
      ok: false,
      reason: 'generate-failed',
      message: 'GEN-FAILED',
    });
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.visionTest' }));
    expect(await screen.findByText('GEN-FAILED')).toBeInTheDocument();
  });

  it('wiki custom sites: full rows save as overrides; a partial row blocks the save', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.wikiAdd' }));
    const idInputs = screen.getAllByLabelText('researchSettings.wikiId');
    expect(idInputs).toHaveLength(1);

    // Partial row (id only) → blocked.
    await userEvent.type(idInputs[0], 'prts');
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    expect(saveResearchConfig).not.toHaveBeenCalled();
    expect(lastToast()).toBe('researchSettings.validationWikiRow');

    // Complete the row → saves as an override.
    await userEvent.type(screen.getByLabelText('researchSettings.wikiName'), 'PRTS');
    await userEvent.type(screen.getByLabelText('researchSettings.wikiUrl'), 'https://prts.wiki');
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.search.wikiSitesOverrides).toEqual([
      { id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'opensearch' },
    ]);
  });

  it('removing a custom-site row drops it from the save payload', async () => {
    loadResearchConfig.mockResolvedValue({
      ...baseView,
      search: {
        ...baseView.search,
        wikiSitesOverrides: [{ id: 'prts', name: 'PRTS', apiBaseUrl: 'https://prts.wiki', searchKind: 'fulltext' }],
      },
    });
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByDisplayValue('prts');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.wikiDelete' }));
    expect(screen.queryByDisplayValue('prts')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.search.wikiSitesOverrides).toBeUndefined();
  });

  it('save failure surfaces the error message via toast', async () => {
    saveResearchConfig.mockRejectedValue(new Error('disk full'));
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(lastToast()).toBe('researchSettings.saveFailed'));
  });

  it('P6: the clear toggle submits null for the marked key (explicit delete), undefined for the others', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');
    // tavily is configured in baseView → its clear button is present.
    const clearTavily = screen.getByRole('button', { name: 'researchSettings.keyClear' });
    await userEvent.click(clearTavily);
    // Pending-clear placeholder swap + undo affordance.
    expect(screen.getByPlaceholderText("researchSettings.keyClearPending")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'researchSettings.keyClearUndo' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.search.tavilyApiKey).toBeNull(); // explicit CLEAR
    expect(payload.search.bochaApiKey).toBeUndefined(); // keep sentinel
    expect(payload.search.anysearchApiKey).toBeUndefined();
  });

  it('P6: undo cancels the clear and typing a new key un-marks it', async () => {
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.keyClear' }));
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.keyClearUndo' }));
    // Back to the configured placeholder, no pending clear.
    expect(screen.getByPlaceholderText("researchSettings.keyConfigured")).toBeInTheDocument();

    // Mark clear again, then TYPE into the input → the clear un-marks.
    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.keyClear' }));
    const input = screen.getByPlaceholderText('researchSettings.keyClearPending');
    await userEvent.type(input, 'tvly-replacement');
    expect(screen.queryByRole('button', { name: 'researchSettings.keyClearUndo' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'researchSettings.save' }));
    await waitFor(() => expect(saveResearchConfig).toHaveBeenCalled());
    const payload = saveResearchConfig.mock.calls[0][0] as ResearchConfigSave;
    expect(payload.search.tavilyApiKey).toBe('tvly-replacement');
  });

  it('P23: changing the vision designation AUTO-fires the canary and toasts the verdict', async () => {
    canaryProbeVision.mockResolvedValue({ ok: true, answer: '闭' });
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.selectOptions(screen.getByLabelText('researchSettings.visionModel'), 'key_001::qwen-vl-max');
    await waitFor(() => expect(setModelConfig).toHaveBeenCalledTimes(1));
    // The canary fired WITHOUT pressing the test button…
    await waitFor(() => expect(canaryProbeVision).toHaveBeenCalledWith({ keyId: 'key_001', modelId: 'qwen-vl-max' }));
    // …and the verdict landed both inline and as a toast.
    expect(await screen.findByText('researchSettings.visionProbeOk')).toBeInTheDocument();
    await waitFor(() => expect(lastToast()).toBe('researchSettings.visionProbeAutoOk'));
  });

  it('P23: a silent-strip auto-canary verdict surfaces as an error toast', async () => {
    canaryProbeVision.mockResolvedValue({ ok: false, reason: 'silent-strip', message: 'AUTO-STRIP-WARNING' });
    render(<ResearchSettingsPage t={tFake} />);
    await screen.findByText('萌娘百科（官方站）');

    await userEvent.selectOptions(screen.getByLabelText('researchSettings.visionModel'), 'key_001::qwen-vl-max');
    await waitFor(() => expect(lastToast()).toBe('AUTO-STRIP-WARNING'));
    expect(await screen.findByText('AUTO-STRIP-WARNING')).toBeInTheDocument();
  });
});
