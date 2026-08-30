import { useEffect, useMemo, useState } from 'react';
import type { ImportedFont } from '@orison/shared-contracts';
import { INTERFACE_SCALE_PRESETS } from '@orison/shared-contracts';
import { FontPicker, type FontOption } from './FontPicker';
import { CHINESE_FONT_PRESETS, injectImportedFonts, isFontInstalled } from './fonts';
type Props = {
  t: (key: string, params?: Record<string, string | number>) => string;
  editorLineHeight: number;
  setEditorLineHeight: (value: number) => void;
  readingFontFamily: string;
  setReadingFontFamily: (value: string) => void;
  readingFontWeight: number;
  setReadingFontWeight: (value: number) => void;
  readingFontScale: number;
  setReadingFontScale: (value: number) => void;
  wallpaperUrl: string;
  setWallpaperUrl: (value: string) => void;
  wallpaperOpacity: number;
  setWallpaperOpacity: (value: number) => void;
  /** 08-29 滑杆化：磨砂强度（blur 壁纸整层 0–50px；0 = 关）。 */
  wallpaperFrostBlur: number;
  setWallpaperFrostBlur: (value: number) => void;
  /** R8 全局界面缩放（0.85–1.3；shell 经 webContents.setZoomFactor 施加）。 */
  interfaceScale: number;
  setInterfaceScale: (value: number) => void;
};

const LINE_HEIGHT_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 1.5, label: '1.5' },
  { value: 1.75, label: '1.75' },
  { value: 2.0, label: '2.0' },
];

const WEIGHT_OPTIONS: { value: number; key: string }[] = [
  { value: 400, key: 'settings.fontWeightNormal' },
  { value: 500, key: 'settings.fontWeightMedium' },
  { value: 600, key: 'settings.fontWeightSemibold' },
  { value: 700, key: 'settings.fontWeightBold' },
];

const SCALE_OPTIONS: { value: number; key: string }[] = [
  { value: 0.9, key: 'settings.fontSizeSmall' },
  { value: 1, key: 'settings.fontSizeDefault' },
  { value: 1.15, key: 'settings.fontSizeLarge' },
  { value: 1.3, key: 'settings.fontSizeXLarge' },
];

export function AppearanceSettingsPage({
  t,
  editorLineHeight,
  setEditorLineHeight,
  readingFontFamily,
  setReadingFontFamily,
  readingFontWeight,
  setReadingFontWeight,
  readingFontScale,
  setReadingFontScale,
  wallpaperUrl,
  setWallpaperUrl,
  wallpaperOpacity,
  setWallpaperOpacity,
  wallpaperFrostBlur,
  setWallpaperFrostBlur,
  interfaceScale,
  setInterfaceScale,
}: Props) {
  const [importedFonts, setImportedFonts] = useState<ImportedFont[]>([]);

  useEffect(() => {
    let alive = true;
    window.orisonDesktop
      ?.listImportedFonts?.()
      .then((fonts) => {
        if (!alive) return;
        injectImportedFonts(fonts);
        setImportedFonts(fonts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const handleImport = async () => {
    const fonts = await window.orisonDesktop?.importFonts?.();
    if (!fonts) return;
    injectImportedFonts(fonts);
    setImportedFonts(fonts);
  };

  // 08-25 全窗口背景：选图后存 orison-file URL（userData/wallpaper 拷贝件）。
  const handleChooseWallpaper = async () => {
    const result = await window.orisonDesktop?.importWallpaper?.();
    if (!result?.url) return;
    setWallpaperUrl(result.url);
  };

  // R8 高亮口径（BMad CR 组4）：非预设值（盘面手改 / 钳制后浮点，如 0.92/1.2）也
  // 必有一枚亮灯——取与当前值最近的预设；精确命中预设时原样。旧实现精确 `===` 比
  // 较，非预设值四钮全灭（读作「坏了」）。
  const activeInterfacePreset = useMemo<number>(() => {
    if ((INTERFACE_SCALE_PRESETS as readonly number[]).includes(interfaceScale)) {
      return interfaceScale;
    }
    let nearest: number = INTERFACE_SCALE_PRESETS[0];
    for (const preset of INTERFACE_SCALE_PRESETS) {
      if (Math.abs(preset - interfaceScale) < Math.abs(nearest - interfaceScale)) nearest = preset;
    }
    return nearest;
  }, [interfaceScale]);

  // 恢复默认：清主进程拷贝目录（best-effort）+ 置空本地状态；清不掉也照常回无背景。
  const handleResetWallpaper = async () => {
    try {
      await window.orisonDesktop?.clearWallpaper?.();
    } catch { /* best-effort: local state clears regardless */ }
    setWallpaperUrl('');
  };

  const fontOptions = useMemo<FontOption[]>(() => {
    const presets = CHINESE_FONT_PRESETS.filter((p) => isFontInstalled(p.family)).map((p) => ({
      value: p.value,
      label: p.label,
    }));
    const imported = importedFonts.map((f) => ({ value: f.family, label: f.family }));
    return [...presets, ...imported];
  }, [importedFonts]);

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h3 className="settings-page-title">{t('settings.appearance')}</h3>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.editorLineHeight')}</span>
        <div className="form-field-options">
          {LINE_HEIGHT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`form-field-option${editorLineHeight === opt.value ? ' is-active' : ''}`}
              onClick={() => setEditorLineHeight(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* R8 全局界面缩放：四档单选（当前档高亮——精确命中或就近预设，见上方
          activeInterfacePreset 注；档位值面走 % 内联渲染——壁纸透明度滑杆同款范式，
          i18n 键只做纯标签）。实际缩放由 shell 施加。 */}
      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.interfaceScale')}</h3>
          <p className="settings-page-subtitle">{t('settings.interfaceScaleDesc')}</p>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.interfaceScale')}</span>
        <div className="form-field-options">
          {INTERFACE_SCALE_PRESETS.map((value) => (
            <button
              key={value}
              type="button"
              className={`form-field-option${activeInterfacePreset === value ? ' is-active' : ''}`}
              onClick={() => setInterfaceScale(value)}
            >
              {Math.round(value * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.readingFont')}</h3>
          <p className="settings-page-subtitle">{t('settings.readingFontDesc')}</p>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.fontFamily')}</span>
        <FontPicker
          value={readingFontFamily}
          onChange={setReadingFontFamily}
          options={fontOptions}
          defaultLabel={t('settings.fontFamilyDefault')}
          sampleText={t('settings.fontSample')}
          importLabel={t('settings.fontImport')}
          onImport={handleImport}
        />
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.fontWeight')}</span>
        <div className="form-field-options">
          {WEIGHT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`form-field-option${readingFontWeight === opt.value ? ' is-active' : ''}`}
              style={{ fontWeight: opt.value }}
              onClick={() => setReadingFontWeight(opt.value)}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.fontSize')}</span>
        <div className="form-field-options">
          {SCALE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`form-field-option${readingFontScale === opt.value ? ' is-active' : ''}`}
              onClick={() => setReadingFontScale(opt.value)}
            >
              {t(opt.key)}
            </button>
          ))}
        </div>
      </div>

      {/* 08-25 全窗口背景（壁纸式，不分区）：当前状态 + 选图/恢复 + 透明度滑杆。 */}
      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.background')}</h3>
          <p className="settings-page-subtitle">{t('settings.backgroundDesc')}</p>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.background')}</span>
        <div className="wallpaper-field">
          {wallpaperUrl ? (
            <img
              src={wallpaperUrl}
              alt=""
              className="wallpaper-preview"
              // 容忍加载失败（文件被手删等）：藏缩略图即可，不崩、不清设置。
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          ) : (
            <span className="wallpaper-none">{t('settings.backgroundNone')}</span>
          )}
          <div className="form-field-options">
            <button type="button" className="form-field-option" onClick={() => void handleChooseWallpaper()}>
              {t('settings.backgroundChoose')}
            </button>
            {wallpaperUrl && (
              <button type="button" className="form-field-option" onClick={() => void handleResetWallpaper()}>
                {t('settings.backgroundReset')}
              </button>
            )}
          </div>
        </div>
      </div>

      {wallpaperUrl && (
        <div className="form-field-row">
          <span className="form-field-label">{t('settings.backgroundOpacity')}</span>
          <div className="form-field-range-row">
            <input
              type="range"
              className="form-field-range"
              min={10}
              max={100}
              step={1}
              role="slider"
              aria-label={t('settings.backgroundOpacity')}
              aria-valuemin={10}
              aria-valuemax={100}
              aria-valuenow={Math.round(wallpaperOpacity * 100)}
              value={Math.round(wallpaperOpacity * 100)}
              onChange={(e) => setWallpaperOpacity(Number(e.target.value) / 100)}
            />
            {/* 值面走既有滑杆范式（GeneralSettingsPage 红线）：{n}% 内联渲染，i18n 键只做纯标签。 */}
            <span className="form-field-range-value">{Math.round(wallpaperOpacity * 100)}%</span>
          </div>
        </div>
      )}

      {/* 08-29 磨砂滑杆化（0 = 关，checkbox 退役）：行形态照不透明度滑杆。 */}
      {wallpaperUrl && (
        <div className="form-field-row">
          <span className="form-field-label">{t('settings.backgroundFrost')}</span>
          <div className="form-field-range-row">
            <input
              type="range"
              className="form-field-range"
              min={0}
              max={50}
              step={1}
              role="slider"
              aria-label={t('settings.backgroundFrost')}
              aria-valuemin={0}
              aria-valuemax={50}
              aria-valuenow={wallpaperFrostBlur}
              value={wallpaperFrostBlur}
              onChange={(e) => setWallpaperFrostBlur(Number(e.target.value))}
            />
            {/* 值面照 opacity {n}% 形态：内联渲染 {n}px，i18n 键只做纯标签。 */}
            <span className="form-field-range-value">{wallpaperFrostBlur}px</span>
          </div>
        </div>
      )}
    </div>
  );
}
