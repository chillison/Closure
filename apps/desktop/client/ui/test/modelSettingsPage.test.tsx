import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyEntry, ModelConfig } from '@orison/shared-contracts';
import { ModelSettingsPage } from '../src/features/model-settings/ModelSettingsPage';
import { useAppStore } from '../src/shared/store/appStore';

const baseKey: ApiKeyEntry = {
  id: 'key_001',
  name: 'GPT-4o',
  protocol: 'openai-compatible',
  baseUrl: 'https://api.openai.com',
  apiKey: 'sk-test',
  models: [
    {
      id: 'gpt-4o',
      alias: 'GPT-4o Omni',
      capability: 'text',
      enabled: true,
    },
  ],
};

function buildConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { keys: overrides.keys ?? [baseKey], ...overrides };
}

const tFake = (key: string) => key;

// dogfood #43（2026-08-21）：任务模型/向量/重排三段已迁往 Agent 页
// （test/agentSettingsPage.test.tsx）——本页回归纯「供应商管理」。

describe('ModelSettingsPage', () => {
  beforeEach(() => {
    useAppStore.setState({ outputEntries: [], appendOutputEntry: vi.fn() } as any);
    (window as any).orisonDesktop = {
      listRemoteModels: vi.fn().mockResolvedValue([
        { id: 'gpt-4o', capability: 'text', alias: 'GPT-4o Omni' },
        { id: 'gpt-image-1', capability: 'image', alias: 'GPT Image 1' },
      ]),
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders empty state when no keys exist', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );
    expect(screen.getByText('settings.emptyTitle')).toBeTruthy();
    expect(screen.getByText('settings.emptyHint')).toBeTruthy();
  });

  it('opens the profile editor from the empty state add action', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));

    expect(screen.getByLabelText('settings.profileName')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.modelProtocol')).toBeInTheDocument();
    expect(screen.getByLabelText('settings.baseUrl')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-...')).toBeInTheDocument();
  });

  it('shows the no-selection state when keys exist but none is being edited', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);

    expect(screen.getByText('settings.selectProfileHint')).toBeInTheDocument();
  });

  it('shows enabled-model summary and count on key rows', () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    const row = screen.getByRole('button', { pressed: false, name: /GPT-4o/ });
    expect(row.textContent).toContain('GPT-4o Omni');
    expect(row.textContent).toContain('1');
  });

  it('selecting a key and applying a name change persists via setModelConfig', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    const row = screen.getByRole('button', { pressed: false, name: /GPT-4o/ });
    await userEvent.click(row);

    const nameInput = screen.getByLabelText('settings.profileName');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Renamed');

    const applyButton = screen.getByRole('button', { name: 'settings.applyChanges' });
    expect(applyButton.hasAttribute('disabled')).toBe(false);
    await userEvent.click(applyButton);

    await waitFor(() => expect(setModelConfig).toHaveBeenCalled());
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect(arg.keys[0].name).toBe('Renamed');
  });

  it('opens delete confirm dialog and persists deletion on confirm', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.deleteModel' }));

    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText('settings.deleteConfirmTitle')).toBeTruthy();

    await userEvent.click(within(dialog).getByRole('button', { name: 'settings.deleteConfirmAction' }));

    await waitFor(() => expect(setModelConfig).toHaveBeenCalled());
    const arg = setModelConfig.mock.calls[0][0] as ModelConfig;
    expect(arg.keys).toHaveLength(0);
  });

  it('refreshing models merges discovered entries into the draft', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      expect((window as any).orisonDesktop.listRemoteModels).toHaveBeenCalled();
      // The newly discovered image model is added to the editor's model list.
      expect(screen.getByText('gpt-image-1')).toBeInTheDocument();
    });
  });

  it('refreshing a new anthropic-compatible key forwards the selected protocol', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSettingsPage t={tFake} modelConfig={{ keys: [] }} setModelConfig={setModelConfig} />
    );

    await userEvent.click(screen.getByRole('button', { name: 'settings.emptyAction' }));
    await userEvent.selectOptions(screen.getByLabelText('settings.modelProtocol'), 'anthropic-compatible');
    await userEvent.type(screen.getByLabelText('settings.baseUrl'), 'https://api.anthropic.com');
    await userEvent.type(screen.getByLabelText('settings.apiKey'), 'sk-ant-test');

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      expect((window as any).orisonDesktop.listRemoteModels).toHaveBeenCalledWith({
        protocol: 'anthropic-compatible',
        apiKey: 'sk-ant-test',
        baseUrl: 'https://api.anthropic.com',
      });
    });
  });

  it('refresh failure surfaces banner with error message', async () => {
    (window as any).orisonDesktop.listRemoteModels = vi
      .fn()
      .mockRejectedValue(new Error('Network down'));
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));

    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    await waitFor(() => {
      const banner = screen.getByRole('alert');
      expect(banner.textContent).toContain('Network down');
    });
  });

  it('cancelling delete dialog leaves config unchanged', async () => {
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={setModelConfig} />);
    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));
    await userEvent.click(screen.getByRole('button', { name: 'settings.deleteModel' }));

    const dialog = screen.getByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'projects.cancel' }));

    expect(setModelConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  // dogfood #43：迁走后的模型配置页不再渲染任务模型/向量/重排三段（在 Agent 页）。
  it('dogfood #43：模型分工三段已迁走——本页不再渲染任务模型/向量/重排选择器', () => {
    render(<ModelSettingsPage t={tFake} modelConfig={buildConfig()} setModelConfig={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.queryByLabelText('settings.embeddingModel')).toBeNull();
    expect(screen.queryByLabelText('settings.rerankModel')).toBeNull();
    expect(screen.queryByLabelText('settings.taskSlotDialogue')).toBeNull();
    expect(screen.queryByText('settings.taskModels')).toBeNull();
  });

  // dogfood #41：重新拉取刷新既有条目的派生字段（alias/capability），保留 enabled。
  it('refreshing models heals stale derived fields of existing entries (alias/capability), keeps enabled', async () => {
    (window as any).orisonDesktop.listRemoteModels = vi.fn().mockResolvedValue([
      { id: 'gpt-4o', capability: 'embedding', alias: 'GPT-4o Omni v2' },
      { id: 'gpt-image-1', capability: 'image', alias: 'GPT Image 1' },
    ]);
    const staleConfig = buildConfig({
      keys: [
        {
          ...baseKey,
          // 旧 registry 时代的脏数据形态：截断 alias + 错标 capability（盘上实录）。
          models: [{ id: 'gpt-4o', alias: 'Embedding gpt-4', capability: 'text', enabled: true }],
        },
      ],
    });
    const setModelConfig = vi.fn().mockResolvedValue(undefined);
    render(<ModelSettingsPage t={tFake} modelConfig={staleConfig} setModelConfig={setModelConfig} />);

    await userEvent.click(screen.getByRole('button', { pressed: false, name: /GPT-4o/ }));
    await userEvent.click(screen.getByRole('button', { name: 'settings.refreshModels' }));

    // 既有条目的 alias 换新（截断形态消失），capability 修正为 embedding。
    // 断言圈定编辑器列表（.model-entry-list 是本页刷新后的草稿面）。
    await waitFor(() => expect(screen.getByText('GPT-4o Omni v2')).toBeInTheDocument());
    const entryList = document.querySelector('.model-entry-list') as HTMLElement;
    expect(entryList).toBeTruthy();
    expect(within(entryList).queryByText('Embedding gpt-4')).toBeNull();
    expect(within(entryList).getByText('embedding')).toBeInTheDocument();
    // enabled 保留：gpt-4o 行的勾选态不被重置（新发现的 gpt-image-1 默认不勾）。
    const row = screen.getByText('GPT-4o Omni v2').closest('.model-entry-row') as HTMLElement | null;
    expect(row).toBeTruthy();
    expect((row!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    const newRow = screen.getByText('gpt-image-1').closest('.model-entry-row') as HTMLElement | null;
    expect((newRow!.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  });
});
