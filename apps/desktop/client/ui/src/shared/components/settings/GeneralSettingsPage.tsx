import type { LocaleSetting, ThemeSetting } from '../../store/types';

type Props = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  theme: ThemeSetting;
  setTheme: (theme: ThemeSetting) => void;
  locale: LocaleSetting;
  setLocale: (locale: LocaleSetting) => void;
  autoCheckUpdates: boolean;
  setAutoCheckUpdates: (value: boolean) => void;
  appVersion: string;
  onCheckForUpdate: () => void;
  /** 压缩红线（50–100，默认 95）——thinking adapters task design §3.2。 */
  contextRedlinePercent: number;
  setContextRedlinePercent: (value: number) => void;
};

/** 红线滑杆界（含两端）；setter（slice 内）负责钳制。 */
const REDLINE_MIN = 50;
const REDLINE_MAX = 100;

export function GeneralSettingsPage({
  t,
  theme,
  setTheme,
  locale,
  setLocale,
  autoCheckUpdates,
  setAutoCheckUpdates,
  appVersion,
  onCheckForUpdate,
  contextRedlinePercent,
  setContextRedlinePercent,
}: Props) {
  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h3 className="settings-page-title">{t('settings.general')}</h3>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.theme')}</span>
        <div className="form-field-options">
          {(['system', 'light', 'dark'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              className={`form-field-option${theme === opt ? ' is-active' : ''}`}
              onClick={() => setTheme(opt)}
            >
              {t(`settings.theme${opt[0].toUpperCase()}${opt.slice(1)}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.language')}</span>
        <div className="form-field-options">
          {(['system', 'en-US', 'zh-CN'] as const).map((opt) => (
            <button
              key={opt}
              type="button"
              className={`form-field-option${locale === opt ? ' is-active' : ''}`}
              onClick={() => setLocale(opt)}
            >
              {opt === 'system' ? t('settings.languageSystem') : opt}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.updates')}</h3>
          <p className="settings-page-subtitle">{t('settings.updatesDesc')}</p>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.autoCheckUpdates')}</span>
        <div className="form-field-options">
          <button
            type="button"
            className={`form-field-option${autoCheckUpdates ? ' is-active' : ''}`}
            onClick={() => setAutoCheckUpdates(true)}
          >
            {t('settings.on')}
          </button>
          <button
            type="button"
            className={`form-field-option${!autoCheckUpdates ? ' is-active' : ''}`}
            onClick={() => setAutoCheckUpdates(false)}
          >
            {t('settings.off')}
          </button>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">
          {t('settings.currentVersion')}
          {appVersion && <span className="form-field-version"> v{appVersion}</span>}
        </span>
        <div className="form-field-options">
          <button type="button" className="form-field-option" onClick={onCheckForUpdate}>
            {t('topbar.checkForUpdate')}
          </button>
        </div>
      </div>

      {/* thinking adapters task（design §3.2）：对话上下文压缩三触发之「红线」设置。 */}
      <div className="settings-page-header">
        <div>
          <h3 className="settings-page-title">{t('settings.contextTitle')}</h3>
          <p className="settings-page-subtitle">{t('settings.contextCompactionDesc')}</p>
        </div>
      </div>

      <div className="form-field-row">
        <span className="form-field-label">{t('settings.contextRedline')}</span>
        <div className="form-field-range-row">
          <input
            type="range"
            className="form-field-range"
            min={REDLINE_MIN}
            max={REDLINE_MAX}
            step={1}
            role="slider"
            aria-label={t('settings.contextRedline')}
            aria-valuemin={REDLINE_MIN}
            aria-valuemax={REDLINE_MAX}
            aria-valuenow={contextRedlinePercent}
            value={contextRedlinePercent}
            onChange={(e) => setContextRedlinePercent(Number(e.target.value))}
          />
          <span className="form-field-range-value">{contextRedlinePercent}%</span>
        </div>
        <span className="form-field-hint">{t('settings.contextRedlineHint')}</span>
      </div>
    </div>
  );
}
