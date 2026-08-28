import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type {
  ArcTimingAxis,
  CharacterDepthAxis,
  CreativePreferences,
  OutlineDepthAxis,
  WorldDepthAxis,
} from '@orison/shared-contracts';
import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';

/**
 * dogfood R2 #22（用户拍板 A）：工作方式卡——creative_preferences 的总览页显示与直改面。
 *
 * 背景（暗数据问题）：冷启动对话问的四轴偏好落盘后，UI 全库无显示无编辑（消费面只有
 * patch 审核卡的字段名标签）——作者忘了无法查、想改只能再跟 AI 说。
 *
 * 边界（prd R3 用户钉板沿用）：**四轴逐域独立，不搞总档**——推荐套餐（轻装上阵/骨架先行/
 * 深谋远虑）只是对话问询的起手组合，映射未在系统钉死，UI 不做一键切档（避免第三真相源）。
 * absent = 未问 = 标准档（radar 段缺省回退），显示为无高亮 + 行尾提示。
 *
 * 写通道：轴选择离散点击直写 updateField（作者主权直写，mirror 字段锁先例——source:user
 * + undo/版本白拿）；note 是连续文本，blur 落盘（防每键入 undo 栈——updateField 与
 * OverviewPage meta 输入的 updateProjectMeta 不同，进 fieldUndoStack）。
 */
type AxisKey = 'outline_depth' | 'arc_timing' | 'world_depth' | 'character_depth';

const AXES: Array<{
  key: AxisKey;
  labelKey: string;
  values: ReadonlyArray<string>;
  valueLabelKey: (value: string) => string;
  valueTitleKey: (value: string) => string;
}> = [
  {
    key: 'outline_depth',
    labelKey: 'overview.workingStyleOutlineDepth',
    values: ['skeleton', 'volume', 'chapter'] as const,
    valueLabelKey: (v) => `overview.workingStyleOutlineDepth_${v}`,
    valueTitleKey: (v) => `overview.workingStyleOutlineDepth_${v}_desc`,
  },
  {
    key: 'arc_timing',
    labelKey: 'overview.workingStyleArcTiming',
    values: ['upfront', 'as_you_go'] as const,
    valueLabelKey: (v) => `overview.workingStyleArcTiming_${v}`,
    valueTitleKey: (v) => `overview.workingStyleArcTiming_${v}_desc`,
  },
  {
    key: 'world_depth',
    labelKey: 'overview.workingStyleWorldDepth',
    values: ['shell', 'upfront'] as const,
    valueLabelKey: (v) => `overview.workingStyleWorldDepth_${v}`,
    valueTitleKey: (v) => `overview.workingStyleWorldDepth_${v}_desc`,
  },
  {
    key: 'character_depth',
    labelKey: 'overview.workingStyleCharacterDepth',
    values: ['framework', 'full'] as const,
    valueLabelKey: (v) => `overview.workingStyleCharacterDepth_${v}`,
    valueTitleKey: (v) => `overview.workingStyleCharacterDepth_${v}_desc`,
  },
];

export function WorkingStyleSection() {
  const { prefs, updateField, projectDocumentHydrated } = useAppStore(useShallow((s) => ({
    prefs: s.creativeFields.creative_preferences as CreativePreferences | undefined,
    updateField: s.updateField,
    projectDocumentHydrated: s.projectDocumentHydrated,
  })));
  const { t } = useI18n(useAppStore((s) => s.resolvedLocale));

  const setAxis = (axis: AxisKey, value: string) => {
    if (!projectDocumentHydrated) return;
    updateField('creative_preferences', { ...(prefs ?? {}), [axis]: value });
  };

  // note：本地缓冲 + blur 落盘（外部落盘回声对齐后覆盖本地态）。
  const [noteDraft, setNoteDraft] = useState(prefs?.note ?? '');
  const lastSyncedNoteRef = useRef(prefs?.note ?? '');
  useEffect(() => {
    if ((prefs?.note ?? '') !== lastSyncedNoteRef.current) {
      lastSyncedNoteRef.current = prefs?.note ?? '';
      setNoteDraft(prefs?.note ?? '');
    }
  }, [prefs?.note]);
  const commitNote = () => {
    if (!projectDocumentHydrated) return;
    const trimmed = noteDraft.trim();
    if (trimmed === (prefs?.note ?? '')) return;
    const next: CreativePreferences = { ...(prefs ?? {}) };
    if (trimmed) next.note = noteDraft;
    else delete next.note;
    updateField('creative_preferences', next);
    lastSyncedNoteRef.current = trimmed ? noteDraft : '';
  };

  return (
    <section className="overview-working-style">
      <h3 className="overview-section-title">{t('overview.workingStyleSection')}</h3>

      {AXES.map(({ key, labelKey, values, valueLabelKey, valueTitleKey }) => {
        const current = prefs?.[key] as string | undefined;
        return (
          <div key={key} className="overview-contract-group overview-working-style-axis">
            <span className="overview-contract-label">{t(labelKey)}</span>
            <div className="overview-working-style-seg" role="radiogroup" aria-label={t(labelKey)}>
              {values.map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={current === v}
                  className={`overview-working-style-seg-btn${current === v ? ' is-active' : ''}`}
                  onClick={() => { setAxis(key, v); }}
                  title={t(valueTitleKey(v))}
                >
                  {t(valueLabelKey(v))}
                </button>
              ))}
              {current === undefined && (
                <span className="overview-working-style-unset">{t('overview.workingStyleUnset')}</span>
              )}
            </div>
          </div>
        );
      })}

      <div className="overview-contract-group">
        <span className="overview-contract-label">{t('overview.workingStyleNote')}</span>
        <textarea
          className="overview-working-style-note"
          placeholder={t('overview.workingStyleNotePlaceholder')}
          value={noteDraft}
          onChange={(e) => { setNoteDraft(e.target.value); }}
          onBlur={commitNote}
          rows={2}
        />
      </div>
    </section>
  );
}
