import type { StateCreator } from 'zustand';
import type { ThemeSetting, LocaleSetting } from './types';
import { detectSystemLocale, availableLocales } from '../i18n/useI18n';
import type { UserPreferencesConfig } from '@orison/shared-contracts';
import type { ModelConfig } from '@orison/shared-contracts';
import { DEFAULT_USER_PREFERENCES, clampInterfaceScale } from '@orison/shared-contracts';
import { injectImportedFonts } from '../components/settings/fonts';

const DEFAULT_MODEL_CONFIG: ModelConfig = { keys: [] };

/** Empty string = follow the built-in default (--font-display). */
const DEFAULT_READING_FONT_FAMILY = '';
const DEFAULT_READING_FONT_WEIGHT = 400;
const DEFAULT_READING_FONT_SCALE = 1;

/** 压缩红线默认 95（≈「顶满即压」，给回复留余量）——契约单源 DEFAULT_USER_PREFERENCES。 */
const DEFAULT_REDLINE_PERCENT = DEFAULT_USER_PREFERENCES.contextCompaction?.redlinePercent ?? 95;

/** 50–100 之外的值（手改盘文件等）钳回界内；非法值回默认。 */
function clampRedlinePercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_REDLINE_PERCENT;
  return Math.min(100, Math.max(50, Math.round(value)));
}

/** 全窗口壁纸：空串 = 无壁纸（契约单源缺省 1）。 */
const DEFAULT_WALLPAPER_URL = '';
const DEFAULT_WALLPAPER_OPACITY = DEFAULT_USER_PREFERENCES.wallpaperOpacity ?? 1;
const DEFAULT_WALLPAPER_FROST = DEFAULT_USER_PREFERENCES.wallpaperFrost ?? false;

/**
 * R8 全局界面缩放（structure-rebuild）：本 slice 只负责「持久化 + 展示当前档」，
 * 实际施加在 shell——webContents.setZoomFactor（Chromium 页面级缩放；机制选型注释
 * 在 shared-contracts clampInterfaceScale 处）。渲染层零 DOM 施加 → 无坐标分裂面，
 * 非法值经契约钳制回默认 1，不存在白屏向量。
 */
const DEFAULT_INTERFACE_SCALE = DEFAULT_USER_PREFERENCES.interfaceScale ?? 1;

/** 0.1–1 之外的值（手改盘文件等）钳回界内；非法值回默认。 */
function clampWallpaperOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WALLPAPER_OPACITY;
  return Math.min(1, Math.max(0.1, value));
}

export type SettingsSlice = {
  theme: ThemeSetting;
  setTheme: (theme: ThemeSetting) => void;
  locale: LocaleSetting;
  resolvedLocale: string;
  setLocale: (locale: LocaleSetting) => void;
  loadUserPreferences: () => Promise<void>;
  /** Persist the current preference snapshot. Use after mutating a preference
   *  owned by another slice (e.g. autoSaveEnabled in autoSaveSlice). */
  persistPreferences: () => void;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => Promise<void>;
  loadModelConfig: () => Promise<void>;
  /** Reading font family for editor + agent panel body. '' = built-in default. */
  readingFontFamily: string;
  setReadingFontFamily: (value: string) => void;
  /** Reading font weight for editor + agent panel body. */
  readingFontWeight: number;
  setReadingFontWeight: (value: number) => void;
  /** Reading font scale multiplier for editor + agent panel body. */
  readingFontScale: number;
  setReadingFontScale: (value: number) => void;
  /** Application version, populated at bootstrap via preload. Empty until loaded. */
  appVersion: string;
  loadAppVersion: () => Promise<void>;
  /** Whether to silently check for updates on startup. */
  autoCheckUpdates: boolean;
  setAutoCheckUpdates: (value: boolean) => void;

  // ── Writing settings ──
  paragraphIndent: boolean;
  setParagraphIndent: (value: boolean) => void;
  showWordCount: boolean;
  setShowWordCount: (value: boolean) => void;
  /** Auto-save debounce interval in ms. Consumed by useAutoSave. */
  autoSaveInterval: number;
  setAutoSaveInterval: (value: number) => void;
  /** Native browser spellcheck in the manuscript/code editors. */
  spellCheck: boolean;
  setSpellCheck: (value: boolean) => void;
  /** Target character count for the active document. 0 = no goal. */
  wordCountGoal: number;
  setWordCountGoal: (value: number) => void;

  // ── Appearance settings ──
  editorLineHeight: number;
  setEditorLineHeight: (value: number) => void;

  // ── App wallpaper（08-25 全窗口背景，壁纸式不分区）──
  /** Full-window wallpaper URL. '' = no wallpaper (layer not rendered). */
  wallpaperUrl: string;
  setWallpaperUrl: (value: string) => void;
  /** Wallpaper image opacity 0.1–1. */
  wallpaperOpacity: number;
  setWallpaperOpacity: (value: number) => void;
  /** Optional frosted-glass blur on the wallpaper layer (08-26 dogfood 拍板). */
  wallpaperFrost: boolean;
  setWallpaperFrost: (value: boolean) => void;

  // ── Global interface scale（08-26 structure-rebuild R8）──
  /**
   * Whole-app UI zoom (0.85–1.3 band; four presets in the settings UI). The
   * shell applies it via webContents.setZoomFactor — see DEFAULT_INTERFACE_SCALE
   * above for the split of duties.
   */
  interfaceScale: number;
  setInterfaceScale: (value: number) => void;

  // ── Context compaction (thinking adapters task, design §3.2) ──
  /** 压缩红线（上下文窗口用量百分比，50–100）。未到红线不压缩（思考历史完整保留）。 */
  contextRedlinePercent: number;
  setContextRedlinePercent: (value: number) => void;
};

function resolveLocale(locale: LocaleSetting): string {
  if (locale === 'system') return detectSystemLocale();
  if (availableLocales.includes(locale)) return locale;
  return 'en-US';
}

function applyTheme(theme: ThemeSetting) {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

/**
 * Reading typography only affects editor + agent panel body text. These CSS vars
 * are consumed by `.tiptap-content .tiptap`, `.agent-msg-md`, `.agent-message-content`.
 * Defaults leave the built-in look untouched (zero visual shift).
 */
function applyReadingFont(family: string, weight: number, scale: number) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  if (family && family.trim()) {
    root.setProperty('--reading-font-family', family.trim());
  } else {
    root.removeProperty('--reading-font-family');
  }
  root.setProperty('--reading-font-weight', String(weight || DEFAULT_READING_FONT_WEIGHT));
  root.setProperty('--reading-font-scale', String(scale || DEFAULT_READING_FONT_SCALE));
}

// Apply theme on load
applyTheme(DEFAULT_USER_PREFERENCES.theme as ThemeSetting);

function applyEditorLineHeight(lineHeight: number) {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty('--editor-line-height', String(lineHeight));
}

function applyParagraphIndent(indent: boolean) {
  if (typeof document === 'undefined') return;
  // Consumed by the editor paragraph rule (tiptap.css / file.css) as a text-indent.
  document.documentElement.style.setProperty('--editor-paragraph-indent', indent ? '2em' : '0');
}

/**
 * Wallpaper on/off flag on <html> (same dataset pattern as applyTheme's
 * data-theme): CSS uses `html[data-wallpaper]` to drop the opaque page-base
 * backgrounds so the fixed bottom layer shows through. The URL/opacity itself
 * lives on the App-root layer's inline style, not here.
 */
function applyWallpaper(url: string) {
  if (typeof document === 'undefined') return;
  if (url) document.documentElement.dataset.wallpaper = 'on';
  else delete document.documentElement.dataset.wallpaper;
}

function saveUserPreferencesSnapshot(config: UserPreferencesConfig): void {
  window.orisonDesktop?.saveUserPreferences?.(config).catch(() => {});
}

function buildPrefs(get: () => SettingsSlice, overrides: Partial<UserPreferencesConfig> = {}): UserPreferencesConfig {
  // get() returns the full merged store at runtime; autoSaveEnabled lives in autoSaveSlice.
  const s = get() as SettingsSlice & { autoSaveEnabled: boolean };
  const base: UserPreferencesConfig = {
    theme: s.theme,
    locale: s.locale,
    autoCheckUpdates: s.autoCheckUpdates,
    readingFontWeight: s.readingFontWeight,
    readingFontScale: s.readingFontScale,
    paragraphIndent: s.paragraphIndent,
    showWordCount: s.showWordCount,
    autoSaveEnabled: s.autoSaveEnabled,
    autoSaveInterval: s.autoSaveInterval,
    spellCheck: s.spellCheck,
    wordCountGoal: s.wordCountGoal,
    editorLineHeight: s.editorLineHeight,
    // thinking adapters task：红线进 base 快照——**任何**偏好 setter 触发的整文件
    // 覆盖写都必须携带它，漏了会把他处保存把红线静默抹掉（sidecar 四处同步面同款坑）。
    contextCompaction: { redlinePercent: s.contextRedlinePercent },
    wallpaperOpacity: s.wallpaperOpacity,
    wallpaperFrost: s.wallpaperFrost,
    interfaceScale: s.interfaceScale,
  };
  if (s.readingFontFamily) base.readingFontFamily = s.readingFontFamily;
  if (s.wallpaperUrl) base.wallpaperUrl = s.wallpaperUrl;
  return { ...base, ...overrides };
}

export const createSettingsSlice: StateCreator<SettingsSlice, [], [], SettingsSlice> = (set, get) => ({
  theme: DEFAULT_USER_PREFERENCES.theme as ThemeSetting,
  setTheme(theme) {
    applyTheme(theme);
    set({ theme });
    saveUserPreferencesSnapshot(buildPrefs(get, { theme }));
  },

  locale: DEFAULT_USER_PREFERENCES.locale as LocaleSetting,
  resolvedLocale: resolveLocale(DEFAULT_USER_PREFERENCES.locale),
  setLocale(locale) {
    set({ locale, resolvedLocale: resolveLocale(locale) });
    saveUserPreferencesSnapshot(buildPrefs(get, { locale }));
  },
  async loadUserPreferences() {
    if (!window.orisonDesktop?.loadUserPreferences) return;
    try {
      const config = await window.orisonDesktop.loadUserPreferences();
      const theme = config.theme as ThemeSetting;
      const locale = config.locale as LocaleSetting;
      const readingFontFamily = config.readingFontFamily ?? DEFAULT_READING_FONT_FAMILY;
      const readingFontWeight = config.readingFontWeight ?? DEFAULT_READING_FONT_WEIGHT;
      const readingFontScale = config.readingFontScale ?? DEFAULT_READING_FONT_SCALE;
      const editorLineHeight = config.editorLineHeight ?? 1.75;
      const paragraphIndent = config.paragraphIndent ?? true;
      const wallpaperUrl = config.wallpaperUrl ?? DEFAULT_WALLPAPER_URL;
      const wallpaperOpacity = clampWallpaperOpacity(
        config.wallpaperOpacity ?? DEFAULT_WALLPAPER_OPACITY,
      );
      const wallpaperFrost =
        typeof config.wallpaperFrost === 'boolean' ? config.wallpaperFrost : DEFAULT_WALLPAPER_FROST;
      // R8：水合时防御性再钳（盘文件可被手改；shell 读路径已钳一次，双保险与红线同款）。
      const interfaceScale = clampInterfaceScale(config.interfaceScale ?? DEFAULT_INTERFACE_SCALE);
      applyTheme(theme);
      applyReadingFont(readingFontFamily, readingFontWeight, readingFontScale);
      applyEditorLineHeight(editorLineHeight);
      applyParagraphIndent(paragraphIndent);
      applyWallpaper(wallpaperUrl);
      window.orisonDesktop
        ?.listImportedFonts?.()
        .then((fonts) => injectImportedFonts(fonts))
        .catch(() => {});
      set({
        theme,
        locale,
        resolvedLocale: resolveLocale(locale),
        autoCheckUpdates: config.autoCheckUpdates ?? true,
        readingFontFamily,
        readingFontWeight,
        readingFontScale,
        paragraphIndent: config.paragraphIndent ?? true,
        showWordCount: config.showWordCount ?? true,
        autoSaveEnabled: config.autoSaveEnabled ?? true,
        autoSaveInterval: config.autoSaveInterval ?? DEFAULT_USER_PREFERENCES.autoSaveInterval,
        spellCheck: config.spellCheck ?? false,
        wordCountGoal: config.wordCountGoal ?? 0,
        editorLineHeight,
        // shell 读路径已钳 50–100；渲染层防御性再钳（盘文件可被手改）。
        contextRedlinePercent: clampRedlinePercent(
          config.contextCompaction?.redlinePercent ?? DEFAULT_REDLINE_PERCENT,
        ),
        wallpaperUrl,
        wallpaperOpacity,
        wallpaperFrost,
        interfaceScale,
      } as Partial<SettingsSlice> & { autoSaveEnabled: boolean });
    } catch {
      // Keep defaults when preferences cannot be read.
    }
  },

  persistPreferences() {
    saveUserPreferencesSnapshot(buildPrefs(get));
  },

  modelConfig: { ...DEFAULT_MODEL_CONFIG },
  async setModelConfig(config) {
    set({ modelConfig: config });
    if (window.orisonDesktop?.saveModelConfig) {
      await window.orisonDesktop.saveModelConfig(config);
    }
  },
  async loadModelConfig() {
    if (window.orisonDesktop?.loadModelConfig) {
      try {
        const config = await window.orisonDesktop.loadModelConfig();
        set({ modelConfig: config });
      } catch { /* 读取失败保持默认值 */ }
    }
  },

  readingFontFamily: DEFAULT_READING_FONT_FAMILY,
  setReadingFontFamily(value) {
    const next = value.trim();
    applyReadingFont(next, get().readingFontWeight, get().readingFontScale);
    set({ readingFontFamily: next });
    saveUserPreferencesSnapshot(buildPrefs(get, { readingFontFamily: next || undefined }));
  },

  readingFontWeight: DEFAULT_READING_FONT_WEIGHT,
  setReadingFontWeight(value) {
    applyReadingFont(get().readingFontFamily, value, get().readingFontScale);
    set({ readingFontWeight: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { readingFontWeight: value }));
  },

  readingFontScale: DEFAULT_READING_FONT_SCALE,
  setReadingFontScale(value) {
    applyReadingFont(get().readingFontFamily, get().readingFontWeight, value);
    set({ readingFontScale: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { readingFontScale: value }));
  },

  appVersion: '',
  async loadAppVersion() {
    if (!window.orisonDesktop?.getAppVersion) return;
    try {
      const version = await window.orisonDesktop.getAppVersion();
      set({ appVersion: version });
    } catch {
      // Keep empty version.
    }
  },

  autoCheckUpdates: true,
  setAutoCheckUpdates(value) {
    set({ autoCheckUpdates: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { autoCheckUpdates: value }));
  },

  // ── Writing settings ──
  paragraphIndent: true,
  setParagraphIndent(value) {
    applyParagraphIndent(value);
    set({ paragraphIndent: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { paragraphIndent: value }));
  },
  showWordCount: true,
  setShowWordCount(value) {
    set({ showWordCount: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { showWordCount: value }));
  },
  autoSaveInterval: DEFAULT_USER_PREFERENCES.autoSaveInterval as number,
  setAutoSaveInterval(value) {
    set({ autoSaveInterval: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { autoSaveInterval: value }));
  },
  spellCheck: false,
  setSpellCheck(value) {
    set({ spellCheck: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { spellCheck: value }));
  },
  wordCountGoal: 0,
  setWordCountGoal(value) {
    set({ wordCountGoal: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { wordCountGoal: value }));
  },

  // ── Appearance settings ──
  editorLineHeight: 1.75,
  setEditorLineHeight(value) {
    applyEditorLineHeight(value);
    set({ editorLineHeight: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { editorLineHeight: value }));
  },

  // ── App wallpaper（08-25 全窗口背景）：setter 即存快照（本 slice 既有模式）。 ──
  wallpaperUrl: DEFAULT_WALLPAPER_URL,
  setWallpaperUrl(value) {
    applyWallpaper(value);
    set({ wallpaperUrl: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { wallpaperUrl: value || undefined }));
  },
  wallpaperOpacity: DEFAULT_WALLPAPER_OPACITY,
  setWallpaperOpacity(value) {
    const next = clampWallpaperOpacity(value);
    set({ wallpaperOpacity: next });
    saveUserPreferencesSnapshot(buildPrefs(get, { wallpaperOpacity: next }));
  },
  wallpaperFrost: DEFAULT_WALLPAPER_FROST,
  setWallpaperFrost(value) {
    set({ wallpaperFrost: value });
    saveUserPreferencesSnapshot(buildPrefs(get, { wallpaperFrost: value }));
  },

  // ── Global interface scale（R8）：setter 即存快照（本 slice 既有模式）。施加在 shell
  //（config:save-user-preferences 落盘后对 sender 施加 zoom），此处不再重复任何 DOM 操作。 ──
  interfaceScale: DEFAULT_INTERFACE_SCALE,
  setInterfaceScale(value) {
    const next = clampInterfaceScale(value);
    set({ interfaceScale: next });
    saveUserPreferencesSnapshot(buildPrefs(get, { interfaceScale: next }));
  },

  // ── Context compaction (thinking adapters task)：setter 即存快照（本 slice 既有模式）。 ──
  contextRedlinePercent: DEFAULT_REDLINE_PERCENT,
  setContextRedlinePercent(value) {
    const next = clampRedlinePercent(value);
    set({ contextRedlinePercent: next });
    saveUserPreferencesSnapshot(buildPrefs(get, { contextCompaction: { redlinePercent: next } }));
  },
});
