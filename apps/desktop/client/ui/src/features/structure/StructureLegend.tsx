import { useAppStore } from '../../shared/store/appStore';
import { useI18n } from '../../shared/i18n/useI18n';
import { lineHueIndex } from './linePalette';

/**
 * 08-26 结构页重构 批 2（implement 2.3 / prd R2 / design §5）：结构页图例。
 *
 * **完备是验收线**（mockup 五轮教训：漏两种角标用户即起疑）：任何视觉记号不入
 * 图例不许上线——线色 / 角色四形状 / 外环选中 / ✦ AI 新增 / 校验三族（error/
 * warning/info）/ 情绪底条 / 位移虚线 / 钢蓝阅读序 / **可见性=透明度 / 节奏热度=
 * 格顶细条**（批 B 补齐 R2 六维矩阵最后两族）+ 两套线连线说明。每项带
 * `data-legend-key`，完备性由 structureLegend.test 断言锁定（新增视觉记号必须
 * 同步补图例项，否则测试爆红）。
 *
 * 挂载：StructurePage 页级、缩放组（zoombar）之下、canvas 之外——图例是 chrome
 * 不随画布缩放（design §3.4 同款边界）。线色示例数据驱动（传入线列表，逐线一枚
 * hue 色块 + 线名），超上限折叠为「+N」；全套记号静态渲染。
 *
 * 08-26 批 5（#43）：**默认折叠一行摘要**（全量记号常驻展开被用户判「异常庞大」）
 * ——折叠态只渲染 toggle 钮 + 摘要行；点开全展开（完备性断言在展开态）。开合态入
 * structureSlice.legendExpanded（会话记忆，切项目不重置）。
 *
 * Paradigm guard：纯只读 + 一个 UI 偏好翻转（store 只取 locale/开合态）；无数据写入。
 */

/** 线色示例上限（超出的线折叠为「+N」——图例是记号说明不是线清单）。 */
const LEGEND_MAX_LINE_SWATCHES = 6;

type StructureLegendProps = {
  /** 线列表（StructurePage 传 sceneGraph.lines——示例色块数据源）。 */
  lines: { id: string; name: string }[];
};

export function StructureLegend({ lines }: StructureLegendProps) {
  const resolvedLocale = useAppStore((s) => s.resolvedLocale);
  const legendExpanded = useAppStore((s) => s.legendExpanded);
  const toggleLegendExpanded = useAppStore((s) => s.toggleLegendExpanded);
  const { t } = useI18n(resolvedLocale);
  const shown = lines.slice(0, LEGEND_MAX_LINE_SWATCHES);
  const overflow = lines.length - shown.length;

  return (
    <div
      className="structure-legend"
      data-structure-legend
      data-legend-state={legendExpanded ? 'expanded' : 'collapsed'}
      role="group"
      aria-label={t('structure.legend.label')}
    >
      <button
        type="button"
        className="structure-legend-toggle"
        data-legend-toggle
        aria-expanded={legendExpanded}
        aria-controls="structure-legend-items"
        onClick={toggleLegendExpanded}
      >
        {legendExpanded ? '▾' : '▸'}
        {legendExpanded ? t('structure.legend.collapse') : t('structure.legend.expand')}
      </button>
      {legendExpanded ? (
        <span id="structure-legend-items" className="structure-legend-items" style={{ display: 'contents' }}>
          {/* 线身份 = 色相（数据驱动示例；12 hue 循环绑定线 id）。 */}
          <span className="structure-legend-item" data-legend-key="line-hue">
            <span className="structure-legend-caption">{t('structure.legend.lineHue')}</span>
            {shown.map((l, i) => (
              <span
                // key 拼 index：脏数据里重复 line id 不再撞 React key（edge 组 finding）。
                key={`${l.id}|${i}`}
                className={`structure-legend-swatch structure-legend-hue lane-hue--c${lineHueIndex(l.id)}`}
                title={l.name}
              />
            ))}
            {overflow > 0 && <span className="structure-legend-note">+{overflow}</span>}
          </span>
          {/* 角色 = 形状（★◆●◇，去色相——labels 自带 glyph）。 */}
          <span className="structure-legend-item" data-legend-key="role-glyph">
            {['coreAnchor', 'forkPoint', 'normal', 'secondaryAnchor'].map((key) => (
              <span key={key} className="structure-legend-glyph">
                {t(`structure.role.${key}`)}
              </span>
            ))}
          </span>
          {/* 选中 = 外环（不改底色）。 */}
          <span className="structure-legend-item" data-legend-key="selected-ring">
            <span className="structure-legend-swatch structure-legend-demo-ring" aria-hidden="true" />
            {t('structure.legend.selectedRing')}
          </span>
          {/* AI 新增 = 左上 ✦ 角标 + 脉冲。 */}
          <span className="structure-legend-item" data-legend-key="ai-new">
            <span className="structure-legend-demo-new" aria-hidden="true">
              ✦
            </span>
            {t('structure.legend.aiNew')}
          </span>
          {/* 校验 = 右上角标计数（三族 severity 色）。 */}
          <span className="structure-legend-item" data-legend-key="validation">
            {(['error', 'warning', 'info'] as const).map((sev) => (
              <span key={sev} className={`structure-legend-demo-badge structure-legend-demo-badge--${sev}`} aria-hidden="true">
                {sev === 'info' ? 'i' : '2'}
              </span>
            ))}
            {t('structure.legend.validation')}
          </span>
          {/* 情绪 = 卡底色条（绿正 · 琥珀中 · 红负）。 */}
          <span className="structure-legend-item" data-legend-key="emotion-bar">
            {(['pos', 'mid', 'neg'] as const).map((tier) => (
              <span key={tier} className={`structure-legend-demo-emo structure-legend-demo-emo--${tier}`} aria-hidden="true" />
            ))}
            {t('structure.legend.emotionBar')}
          </span>
          {/* 位移 = 边框样式（线级虚线/点线）。 */}
          <span className="structure-legend-item" data-legend-key="displacement">
            <span className="structure-legend-demo-disp" aria-hidden="true" />
            {t('structure.legend.displacement')}
          </span>
          {/* 钢蓝序号 = 阅读序跳变（章节工作台 chip——批 3 落地，先入图例钉语义）。 */}
          <span className="structure-legend-item" data-legend-key="reorder-ordinal">
            <span className="structure-legend-demo-ord" aria-hidden="true">
              7
            </span>
            {t('structure.legend.reorderOrdinal')}
          </span>
          {/* 可见性 = 透明度（R2 六维矩阵补项，批 B：visibility 开关联动的弱化呈现）。 */}
          <span className="structure-legend-item" data-legend-key="visibility-opacity">
            <span className="structure-legend-demo-hidden" aria-hidden="true" />
            {t('structure.legend.visibilityDim')}
          </span>
          {/* 节奏热度 = 格顶细条（批 B 图例完备性补项：叠层默认关；开启后载体为格顶
              细条——R5 拍板「不做 slot 级底色」）。 */}
          <span className="structure-legend-item" data-legend-key="pacing-heat">
            <span className="structure-legend-demo-pacing" aria-hidden="true" />
            {t('structure.legend.pacingHeat')}
          </span>
          {/* 色板说明：12 色循环，超 12 线泳道位次为主。 */}
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="palette-note">
            {t('structure.legend.paletteNote')}
          </span>
          {/* 批 8（8.5 用户拍板）：「两套线」连线说明段——①竖弧 = 同场景跨视图对照
              锚（T17 起默认不画：悬停场景任一端或选中才显示）；②区内实/虚线 =
              因果边/悬念边；③跨线连接 = 跨线引用。图例完备验收线的延伸：ASSOC 层
              与 EdgeLayer 的视觉语义未入图例被用户点名，补齐后 structureLegend.test
              同步锁三 key。 */}
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="assoc-anchor">
            <span className="structure-legend-caption">{t('structure.legend.linkAnchorCaption')}</span>
            {t('structure.legend.linkAnchor')}
          </span>
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="causal-edge">
            <span className="structure-legend-caption">{t('structure.legend.linkCausalCaption')}</span>
            {t('structure.legend.linkCausal')}
          </span>
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="cross-line">
            <span className="structure-legend-caption">{t('structure.legend.linkCrossLineCaption')}</span>
            {t('structure.legend.linkCrossLine')}
          </span>
          {/* ── 08-27 追加批3（R12 教育）：三种合法章格形态「何时发生」说明位 ──
              背景：数据层场↔章 M:N 本就合法（写作单位=情节弧非章），但三种形态
              （宽卡/格内堆叠/空章）此前零教育 + 宽卡曾被 ± 静默捏造，共同造成
              「全乱掉了」的感知——按 prd 追加批3 增补三条款。双语键已录
              structure.yaml（spanWide / stackOrder / emptySlot 及 caption 族），
              zh/en 文本抽查在 structureLegend.test。 */}
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="span-wide">
            <span className="structure-legend-caption">{t('structure.legend.spanWideCaption')}</span>
            {t('structure.legend.spanWide')}
          </span>
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="stack-order">
            <span className="structure-legend-caption">{t('structure.legend.stackOrderCaption')}</span>
            {t('structure.legend.stackOrder')}
          </span>
          <span className="structure-legend-item structure-legend-item--note" data-legend-key="empty-slot">
            <span className="structure-legend-caption">{t('structure.legend.emptySlotCaption')}</span>
            {t('structure.legend.emptySlot')}
          </span>
        </span>
      ) : (
        <span className="structure-legend-summary" data-legend-summary>
          {t('structure.legend.summary')}
        </span>
      )}
    </div>
  );
}
