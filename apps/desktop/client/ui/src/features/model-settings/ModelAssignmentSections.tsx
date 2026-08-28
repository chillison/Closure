import { useState } from 'react';
import type { ChangeEvent } from 'react';
import type {
  ModelConfig,
  ModelLimits,
  ModelProtocol,
  ModelRef,
  SlotAssignment,
  TaskModelSlot,
  ThinkingKind,
  UnifiedLevel,
} from '@orison/shared-contracts';
import { resolveModelInfo, THINKING_PROFILES, validateCustom } from '@orison/shared-contracts';
import { listNovelTextModelRefs } from '../../shared/model/novelModel';

/**
 * 模型分工三段（dogfood 2026-08-21 拍板：从模型配置页迁入 Agent 页）——模型配置页
 * 回归纯「供应商管理」（连接与模型启用面），Agent 页管「哪个环节用哪个模型」：
 *
 * - 任务模型（C3.2 任务型 6 档路由：写手自查/正文/审核裁判/提取汇编/规划派发/对话引导）
 * - 向量模型 + 重排模型（KB 索引与检索 sidecar 指派，VS1 / Story 2.1）
 *
 * 自包含：props 只需 t + modelConfig + setModelConfig（SettingsDialog 处已有全部接线）。
 */
type Props = {
  t: (key: string, vars?: Record<string, string | number>) => string;
  modelConfig: ModelConfig;
  setModelConfig: (config: ModelConfig) => Promise<void>;
};

type EnabledModelOption = {
  value: string; // `${keyId}::${modelId}`
  keyId: string;
  keyName: string;
  modelId: string;
  alias: string;
};

function buildEnabledModelOptions(config: ModelConfig): EnabledModelOption[] {
  return config.keys.flatMap((key) =>
    key.models
      .filter((m) => m.enabled !== false)
      .map((m) => ({
        value: `${key.id}::${m.id}`,
        keyId: key.id,
        keyName: key.name,
        modelId: m.id,
        alias: m.alias,
      })),
  );
}

// Task-oriented routing slots (C3.2): which writing stage each select assigns a
// model to. Table-driven — a future slot is one enum member (shared-contracts)
// plus one row here; labels/descriptions live in i18n settings.yaml.
const TASK_MODEL_SLOT_DEFS: ReadonlyArray<{
  slot: TaskModelSlot;
  labelKey: string;
  descKey: string;
}> = [
  { slot: 'writer-selfcheck', labelKey: 'settings.taskSlotWriterSelfcheck', descKey: 'settings.taskSlotWriterSelfcheckDesc' },
  { slot: 'writer-draft', labelKey: 'settings.taskSlotWriterDraft', descKey: 'settings.taskSlotWriterDraftDesc' },
  { slot: 'review-judge', labelKey: 'settings.taskSlotReviewJudge', descKey: 'settings.taskSlotReviewJudgeDesc' },
  { slot: 'extraction', labelKey: 'settings.taskSlotExtraction', descKey: 'settings.taskSlotExtractionDesc' },
  { slot: 'dispatch', labelKey: 'settings.taskSlotDispatch', descKey: 'settings.taskSlotDispatchDesc' },
  { slot: 'dialogue', labelKey: 'settings.taskSlotDialogue', descKey: 'settings.taskSlotDialogueDesc' },
];

function buildTaskModelOptions(config: ModelConfig): Array<{ value: string; label: string }> {
  // Enabled TEXT models only — these slots steer writing-pipeline generation.
  return listNovelTextModelRefs(config.keys).map((opt) => ({
    value: `${opt.ref.keyId}::${opt.ref.modelId}`,
    label: opt.label,
  }));
}

// ── thinking adapters task（2026-08-25，design §3.1）────────────────────────────
// 档位思考策略：能力轴（可不可关/档位集/外显形态/上限）按 modelId 从 registry 直读
// （renderer import，无新 IPC）；策略轴（这档开/关/多强）存 slotAssignment 的
// thinking/thinkingCustom 字段，走既有 setModelConfig 面（S1/S3 契约已通）。

/** Unified 档位 → i18n label key（统一词表：自动/关/低/中/高/顶格）。 */
const THINKING_LEVEL_KEYS: Record<UnifiedLevel, string> = {
  off: 'settings.thinkingOff',
  low: 'settings.thinkingLow',
  medium: 'settings.thinkingMedium',
  high: 'settings.thinkingHigh',
  max: 'settings.thinkingMax',
};

const UNIFIED_LEVELS: readonly UnifiedLevel[] = ['off', 'low', 'medium', 'high', 'max'];

/**
 * 输出上限缩写（档行元信息展示）：binary K/M 值（131,072→128K、1,048,576→1M）用
 * 1024 基缩写；十进制整千（100,000→100K）用 1000 基；其余千分位。
 */
function formatTokenCount(n: number): string {
  if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}M`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024}K`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  return n.toLocaleString('en-US');
}

/** 档位的当前思考 select 显示值：custom 编辑态 > 已存 custom > 统一档 > auto。 */
function thinkingSelectValue(assignment: SlotAssignment, editingCustom: string | undefined): string {
  if (editingCustom !== undefined) return 'custom';
  if (assignment.thinkingCustom) return 'custom';
  return assignment.thinking ?? 'auto';
}

type SlotThinkingInfo = {
  kind: ThinkingKind;
  limits?: ModelLimits;
  levels: readonly UnifiedLevel[];
  offLegal: boolean;
  customHint: 'enum' | 'numeric' | 'none';
  customEnumValues?: string[];
  numericRange?: [number, number];
  /** 外显形态归并为三态展示：none=不返回 / reasoning-field|thinking-blocks=返回 / unknown=不标。 */
  externalBadge: 'returns' | 'none' | null;
  /**
   * CR-006（UI 半）：所指 key 的协议能否承载该 kind 的思考参数。key 失联
   * （stale 指派）时宽容为 true——协议不可知时不假拦，模型 select 已标「已失效」。
   */
  protocolSupported: boolean;
};

/**
 * CR-006（UI 半）：kind × protocol 注入合法性，mirror model-protocols
 * applyThinkingControls 的协议分派表——claude 族只在 Anthropic 路径有字段面
 * （thinking 块 / output_config），glm/kimi/openai 系只在 OpenAI 路径
 * （thinking 对象 / reasoning_effort），deepseek-v4 双路径（官方 Anthropic
 * 格式端点），gemini v1 两路径均不注入。按族规则而非 kind 全枚举——
 * shared-contracts 扩新 kind（kimi-k2-7 等 OpenAI 路径族）默认可注入，本表
 * 不随 kind 枚举扩容而漂移。
 */
function protocolSupportsThinking(kind: ThinkingKind, protocol: ModelProtocol): boolean {
  if (kind === 'gemini') return false;
  const claudeFamily = kind.startsWith('claude-');
  if (protocol === 'anthropic-compatible') return claudeFamily || kind === 'deepseek-v4';
  return !claudeFamily;
}

/**
 * 按档所指模型解析思考能力（registry 直读）+ 所指 key 的协议匹配；无档案/无指派
 * → null（控件整行隐藏）。
 */
function slotThinkingInfo(
  assignment: SlotAssignment | undefined,
  keyProtocol: ModelProtocol | undefined,
): SlotThinkingInfo | null {
  if (!assignment) return null;
  const info = resolveModelInfo(assignment.modelId);
  if (!info.thinking) return null;
  const profile = THINKING_PROFILES[info.thinking];
  if (!profile) return null;
  return {
    kind: info.thinking,
    limits: info.limits,
    levels: profile.levels,
    offLegal: profile.offLegal,
    customHint: profile.customHint,
    customEnumValues: profile.customEnumValues,
    numericRange: profile.numericRange,
    externalBadge:
      profile.externalForm === 'none'
        ? 'none'
        : profile.externalForm === 'reasoning-field' || profile.externalForm === 'thinking-blocks'
          ? 'returns'
          : null,
    protocolSupported:
      keyProtocol === undefined || protocolSupportsThinking(info.thinking, keyProtocol),
  };
}

function removeTaskSlot(
  record: Partial<Record<TaskModelSlot, SlotAssignment>>,
  slot: TaskModelSlot,
): Partial<Record<TaskModelSlot, SlotAssignment>> {
  const next: Partial<Record<TaskModelSlot, SlotAssignment>> = { ...record };
  delete next[slot];
  return next;
}

function omitSlotDraft(drafts: Partial<Record<TaskModelSlot, string>>, slot: TaskModelSlot) {
  const next = { ...drafts };
  delete next[slot];
  return next;
}

/**
 * One KB sidecar designation picker (向量模型 / 重排模型 — mirror shapes). "Auto"
 * clears the field so the shell resolver falls back to capability auto-detection.
 *
 * dogfood #40（2026-08-21）：重排模型选择器——shell 契约（modelConfigSaveSchema.
 * rerankModel）/ sidecar 持久化 / resolveRerankModel / rerank 阶段消费链自 Story 2.1
 * 就在，设置页选择器一直没建；无指派时靠能力自动检测，而发现默认不勾（#22）基本
 * 永远落空 → rerank 阶段静默关闭。
 *
 * CR-006（C3.2 教训，本组件出生即带）：指派比 key/模型存活得久——模型被停用/删除后
 * 脏 ref 仍在路由。失效指派必须保持可选且明示「已失效」，绝不让 select 看起来是
 * 「自动」；整段在 key 全删后仍保留（可清除），不静默消失。
 */
function SidecarModelPicker({
  t,
  config,
  labelKey,
  autoKey,
  hintKey,
  designation,
  onChange,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  config: ModelConfig;
  labelKey: string;
  autoKey: string;
  hintKey: string;
  designation: ModelRef | undefined;
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  const value = designation ? `${designation.keyId}::${designation.modelId}` : '';
  const enabledOptions = buildEnabledModelOptions(config);
  const stale =
    designation && !enabledOptions.some((opt) => opt.value === value)
      ? { value, label: `${t('settings.taskModelStale')}: ${designation.keyId} / ${designation.modelId}` }
      : null;
  if (config.keys.length === 0 && !designation) return null;
  // section 不设 aria-label：控件自身的 label 已提供可访问名，section 再挂同串会与
  // getByLabelText 撞两个元素（原 embedding 段的潜伏碰撞，一并消除）。
  return (
    <section className="model-embedding-preset">
      <div className="model-embedding-preset-row">
        <label className="form-field-input-row">
          <span className="form-field-input-label">{t(labelKey)}</span>
          {enabledOptions.length > 0 || stale ? (
            <select className="form-field-input" value={value} onChange={onChange}>
              <option value="">{t(autoKey)}</option>
              {stale ? <option value={stale.value}>{stale.label}</option> : null}
              {config.keys.map((key) => {
                const enabled = key.models.filter((m) => m.enabled !== false);
                if (enabled.length === 0) return null;
                return (
                  <optgroup key={key.id} label={key.name}>
                    {enabled.map((m) => {
                      const optValue = `${key.id}::${m.id}`;
                      return (
                        <option key={optValue} value={optValue}>
                          {m.alias}
                        </option>
                      );
                    })}
                  </optgroup>
                );
              })}
            </select>
          ) : (
            <span className="model-embedding-preset-hint">{t(hintKey)}</span>
          )}
        </label>
      </div>
    </section>
  );
}

export function ModelAssignmentSections({ t, modelConfig, setModelConfig }: Props) {
  // Task-model routing (C3.2): per-stage model designation. Options are the
  // enabled text models; "Auto" empties the slot so the generation gateway
  // auto-picks (the pre-routing behavior, identical to an unset config).
  const taskModelOptions = buildTaskModelOptions(modelConfig);

  // thinking adapters task：custom 档的**草稿**态（per-slot）。选中「自定义…」时先入
  // 草稿、select 停在 custom，直到 validateCustom 通过才落配置（非法值不发，PRD 验收 3）。
  // 换模型/Auto 清档时一并清草稿（草稿属于旧模型）。
  const [customDrafts, setCustomDrafts] = useState<Partial<Record<TaskModelSlot, string>>>({});

  // CR-006: a designation outlives the key/model disappearing from the enabled
  // options (key deleted / model disabled). The section must stay rendered with
  // the dangling state explicit and clearable — never a select that LOOKS empty
  // like "Auto" while the stale ref still routes (resolveModel throws).
  const hasTaskDesignations =
    modelConfig.taskModels !== undefined && Object.keys(modelConfig.taskModels).length > 0;

  function taskSlotValue(slot: TaskModelSlot): string {
    const ref = modelConfig.taskModels?.[slot];
    return ref ? `${ref.keyId}::${ref.modelId}` : '';
  }

  /** CR-006: explicit option for a designation whose model is no longer selectable. */
  function staleTaskOption(slot: TaskModelSlot): { value: string; label: string } | null {
    const ref = modelConfig.taskModels?.[slot];
    if (!ref) return null;
    const value = `${ref.keyId}::${ref.modelId}`;
    if (taskModelOptions.some((opt) => opt.value === value)) return null;
    return { value, label: `${t('settings.taskModelStale')}: ${ref.keyId} / ${ref.modelId}` };
  }

  function onTaskSlotChange(slot: TaskModelSlot, event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    const current: Partial<Record<TaskModelSlot, SlotAssignment>> = modelConfig.taskModels ?? {};
    // 草稿随模型切换作废（草稿的校验域是旧模型的档位集）。
    setCustomDrafts((drafts) => omitSlotDraft(drafts, slot));
    if (!next) {
      // Only the empty option is the "Auto" clear action — no empty-value
      // entries in the record; skipping the write when the key is already
      // absent keeps a no-op re-select from clobbering the config.
      if (!(slot in current)) return;
      void setModelConfig({ ...modelConfig, taskModels: removeTaskSlot(current, slot) });
      return;
    }
    // CR-007: a non-empty value without the `::` separator is malformed (never
    // produced by real options) — ignore it entirely rather than treating it
    // as "Auto" and deleting the designation.
    const sepIdx = next.indexOf('::');
    if (sepIdx < 0) return;
    const keyId = next.slice(0, sepIdx);
    const modelId = next.slice(sepIdx + 2);
    // thinking adapters task：换模型时思考策略**重置为 auto**（fresh 对象天然丢弃
    // thinking/thinkingCustom）——策略合法性按模型（offLegal/档位集/自定义形态各异），
    // 携旧策略到新模型可能落非法组合；auto（不注入）是零意外落点。
    void setModelConfig({
      ...modelConfig,
      taskModels: { ...current, [slot]: { keyId, modelId } },
    });
  }

  /** 思考档 select 变更：auto=清策略位 / 统一档=落 thinking / custom=入草稿态。 */
  function onThinkingChange(slot: TaskModelSlot, event: ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value;
    const current: Partial<Record<TaskModelSlot, SlotAssignment>> = modelConfig.taskModels ?? {};
    const assignment = current[slot];
    if (!assignment) return;
    const base: ModelRef = { keyId: assignment.keyId, modelId: assignment.modelId };
    if (next === 'custom') {
      // 只入草稿不落配置——空值/非法值都不该进 schema（thinkingCustom min(1) +
      // PRD 验收 3「不认识界面拦截不发」）；select 靠草稿态停在 custom。
      setCustomDrafts((drafts) => ({ ...drafts, [slot]: assignment.thinkingCustom ?? '' }));
      return;
    }
    setCustomDrafts((drafts) => omitSlotDraft(drafts, slot));
    if (next === 'auto') {
      if (!assignment.thinking && !assignment.thinkingCustom) return; // no-op 重选
      void setModelConfig({ ...modelConfig, taskModels: { ...current, [slot]: base } });
      return;
    }
    const level = UNIFIED_LEVELS.find((l) => l === next);
    if (!level) return; // 合成畸形值（CR-007 纪律）——整条忽略
    if (level === assignment.thinking && !assignment.thinkingCustom) return; // no-op 重选
    void setModelConfig({
      ...modelConfig,
      taskModels: { ...current, [slot]: { ...base, thinking: level } },
    });
  }

  /** 自定义值输入：草稿即时更新；合法值（validateCustom 过）才落配置，非法只标红不发。 */
  function onThinkingCustomChange(
    slot: TaskModelSlot,
    event: ChangeEvent<HTMLInputElement>,
    kind: ThinkingKind,
  ) {
    const draft = event.target.value;
    setCustomDrafts((drafts) => ({ ...drafts, [slot]: draft }));
    const current: Partial<Record<TaskModelSlot, SlotAssignment>> = modelConfig.taskModels ?? {};
    const assignment = current[slot];
    if (!assignment) return;
    const base: ModelRef = { keyId: assignment.keyId, modelId: assignment.modelId };
    const trimmed = draft.trim();
    if (!trimmed) {
      // 清空回零：丢掉已存 custom（生效策略回 auto；select 由草稿态停在 custom 等输入）。
      if (!assignment.thinkingCustom && !assignment.thinking) return;
      void setModelConfig({ ...modelConfig, taskModels: { ...current, [slot]: base } });
      return;
    }
    const result = validateCustom(kind, trimmed);
    if (!result.ok) return; // 非法 → 不落盘不发送（UI 拦截）
    void setModelConfig({
      ...modelConfig,
      taskModels: { ...current, [slot]: { ...base, thinkingCustom: result.value } },
    });
  }

  /**
   * 档行思考控件（design §3.1）：select（auto + levels + custom…）+ 自定义输入 +
   * 能力元信息（外显形态徽标 + 输出上限）。无思考档案的模型/Auto 档返回 null 整行隐藏。
   */
  function renderThinkingControl(slot: TaskModelSlot, assignment: SlotAssignment | undefined) {
    // CR-006：合法性还看所指 key 的协议（key entry 自带）——挂错协议（claude 模型
    // 走 openai 兼容中转等）时该模型族的思考参数无字段面可注入，档位整组不出。
    const keyProtocol = assignment
      ? modelConfig.keys.find((key) => key.id === assignment.keyId)?.protocol
      : undefined;
    const info = slotThinkingInfo(assignment, keyProtocol);
    if (!info || !assignment) return null;
    // CR-016 回显兜底：存量策略值过该模型合法性——offLegal=false 的 'off'、profile
    // 不含的档、customHint:'none' 的 custom 都回显 auto + 一行提示（读侧
    // readTaskModelSlots 已在磁盘面丢这类键；此处兜未经洗涤直给组件的配置，防御
    // 纵深）。用户改选/清除后提示随值消失；协议拦截（下）另有一份原因说明。
    const storedLevelIllegal =
      assignment.thinking !== undefined &&
      assignment.thinking !== 'auto' &&
      !(info.levels.includes(assignment.thinking) && (assignment.thinking !== 'off' || info.offLegal));
    const storedCustomIllegal = !!assignment.thinkingCustom && info.customHint === 'none';
    // 有档位的模型挂错协议 → 全档不可注入。gemini（levels 恒空）不进此判定——它的
    // 「不可注入」原因是透传未确证，走下方专属说明分支。
    const protocolBlocked = info.levels.length > 0 && !info.protocolSupported;
    const editingCustom = customDrafts[slot];
    const selectValue = protocolBlocked
      ? 'auto'
      : storedLevelIllegal || storedCustomIllegal
        ? 'auto'
        : thinkingSelectValue(assignment, editingCustom);
    const inCustom = selectValue === 'custom' && info.customHint !== 'none';
    const customDraftRaw = editingCustom ?? assignment.thinkingCustom;
    const customInvalid =
      selectValue === 'custom' &&
      customDraftRaw !== undefined &&
      customDraftRaw.trim() !== '' &&
      !validateCustom(info.kind, customDraftRaw.trim()).ok;
    const metaParts: string[] = [];
    if (info.externalBadge === 'none') metaParts.push(t('settings.thinkingExternalNone'));
    else if (info.externalBadge === 'returns') metaParts.push(t('settings.thinkingExternalReturns'));
    if (info.limits) {
      metaParts.push(
        t('settings.thinkingOutputLimit', { limit: formatTokenCount(info.limits.maxOutputTokens) }),
      );
    }
    return (
      <>
        <label className="form-field-input-row">
          <span className="form-field-input-label">{t('settings.thinkingLevel')}</span>
          <select
            className="form-field-input"
            value={selectValue}
            onChange={(event) => onThinkingChange(slot, event)}
          >
            <option value="auto">{t('settings.thinkingAuto')}</option>
            {/* CR-006：协议不支持的组合整组不渲染档位（含自定义）——非法组合不可选。 */}
            {protocolBlocked ? null : (
              <>
                {/* offLegal=false（强制思考模型）灰置「关」并带原因 title——非法组合不可选。 */}
                {info.levels.map((level) => (
                  <option
                    key={level}
                    value={level}
                    disabled={level === 'off' && !info.offLegal}
                    title={
                      level === 'off' && !info.offLegal ? t('settings.thinkingForcedReason') : undefined
                    }
                  >
                    {t(THINKING_LEVEL_KEYS[level])}
                  </option>
                ))}
                {info.customHint !== 'none' ? (
                  <option value="custom">{t('settings.thinkingCustom')}</option>
                ) : null}
              </>
            )}
          </select>
        </label>
        {/* 空 levels（gemini）＝兼容端点透传未确证——只显 auto + 预期管理说明，不注入。 */}
        {info.levels.length === 0 ? (
          <p className="model-task-slot-meta">{t('settings.thinkingPassthroughUnverified')}</p>
        ) : null}
        {/* CR-006：kind×协议不匹配——该模型族的思考参数在此协议路径不可注入。 */}
        {protocolBlocked ? (
          <p className="model-task-slot-meta">
            {t('settings.thinkingProtocolUnsupported', {
              protocol: t(
                keyProtocol === 'anthropic-compatible'
                  ? 'settings.protocolAnthropicCompatible'
                  : 'settings.protocolOpenAICompatible',
              ),
            })}
          </p>
        ) : null}
        {/* CR-016：存量策略对该模型非法——按「自动」回显并提示（不擅自改写存量值）。 */}
        {!protocolBlocked && (storedLevelIllegal || storedCustomIllegal) ? (
          <p className="model-task-slot-meta">{t('settings.thinkingStoredPolicyDropped')}</p>
        ) : null}
        {inCustom ? (
          <>
            {/* 提示放 label 外——label 内多 span 会污染 getByLabelText 的整标签精确匹配。 */}
            <label className="form-field-input-row">
              <span className="form-field-input-label">{t('settings.thinkingCustomLabel')}</span>
              {info.customHint === 'numeric' ? (
                <input
                  type="number"
                  className="form-field-input form-field-input-narrow"
                  min={info.numericRange?.[0]}
                  max={info.numericRange?.[1]}
                  step={1}
                  value={customDraftRaw ?? ''}
                  onChange={(event) => onThinkingCustomChange(slot, event, info.kind)}
                />
              ) : (
                <>
                  <input
                    type="text"
                    className="form-field-input"
                    list={`thinking-custom-options-${slot}`}
                    value={customDraftRaw ?? ''}
                    onChange={(event) => onThinkingCustomChange(slot, event, info.kind)}
                  />
                  <datalist id={`thinking-custom-options-${slot}`}>
                    {(info.customEnumValues ?? []).map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </>
              )}
            </label>
            <p className={`model-task-slot-meta${customInvalid ? ' is-invalid' : ''}`}>
              {customInvalid
                ? t('settings.thinkingCustomInvalid')
                : info.customHint === 'numeric'
                  ? t('settings.thinkingCustomNumericHint', {
                      min: info.numericRange?.[0] ?? 0,
                      max: info.numericRange?.[1] ?? 0,
                    })
                  : t('settings.thinkingCustomEnumHint')}
            </p>
          </>
        ) : null}
        {metaParts.length > 0 ? (
          <p className="model-task-slot-meta">{metaParts.join(' · ')}</p>
        ) : null}
      </>
    );
  }

  /** Shared by the 向量/重排 sidecar pickers: "Auto" (or a malformed value)
   * clears the designation → resolver capability auto-detect; a `keyId::modelId`
   * value parses into the ref. */
  function onSidecarModelChange(
    field: 'embeddingModel' | 'rerankModel',
    event: ChangeEvent<HTMLSelectElement>,
  ) {
    const next = event.target.value;
    const sepIdx = next.indexOf('::');
    const ref: ModelRef | undefined =
      sepIdx > 0 ? { keyId: next.slice(0, sepIdx), modelId: next.slice(sepIdx + 2) } : undefined;
    const nextConfig: ModelConfig =
      field === 'embeddingModel'
        ? { ...modelConfig, embeddingModel: ref }
        : { ...modelConfig, rerankModel: ref };
    void setModelConfig(nextConfig);
  }

  // dogfood #43：Agent 页无 key 时给一行指路（区别于模型配置页的完整空态）。
  const hasAnyKey = modelConfig.keys.length > 0;

  return (
    <>
      <section className="model-editor-section model-task-routing" aria-label={t('settings.taskModels')}>
        <span className="form-field-label">{t('settings.taskModels')}</span>
        {/* CR-011: what "Auto" means for the un-configured surface (incl. the
            generic sub-agents dispatched by the workbench, which take no slot). */}
        <p className="model-embedding-preset-hint">{t('settings.taskModelsAutoHint')}</p>
        {taskModelOptions.length > 0 || hasTaskDesignations ? (
          TASK_MODEL_SLOT_DEFS.map(({ slot, labelKey, descKey }) => {
            const stale = staleTaskOption(slot);
            const assignment = modelConfig.taskModels?.[slot];
            return (
              <div className="model-task-slot" key={slot}>
                <label className="form-field-input-row">
                  <span className="form-field-input-label">{t(labelKey)}</span>
                  <select
                    className="form-field-input"
                    value={taskSlotValue(slot)}
                    onChange={(event) => onTaskSlotChange(slot, event)}
                  >
                    <option value="">{t('settings.taskModelAuto')}</option>
                    {/* CR-006: keep the configured ref selectable (and visibly
                        stale) instead of displaying a misleading empty "Auto". */}
                    {stale ? (
                      <option value={stale.value}>{stale.label}</option>
                    ) : null}
                    {taskModelOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                {/* thinking adapters task：档行内联思考策略（模型有 registry 档案才出）。 */}
                {renderThinkingControl(slot, assignment)}
                <p className="model-task-slot-desc">{t(descKey)}</p>
              </div>
            );
          })
        ) : (
          <span className="model-embedding-preset-hint">{t('settings.taskModelsHint')}</span>
        )}
      </section>

      <SidecarModelPicker
        t={t}
        config={modelConfig}
        labelKey="settings.embeddingModel"
        autoKey="settings.embeddingModelAuto"
        hintKey="settings.embeddingModelHint"
        designation={modelConfig.embeddingModel}
        onChange={(event) => onSidecarModelChange('embeddingModel', event)}
      />
      <SidecarModelPicker
        t={t}
        config={modelConfig}
        labelKey="settings.rerankModel"
        autoKey="settings.rerankModelAuto"
        hintKey="settings.rerankModelHint"
        designation={modelConfig.rerankModel}
        onChange={(event) => onSidecarModelChange('rerankModel', event)}
      />

      {/* dogfood #43：Agent 页无供应商时的指路空态（key 全删但悬空指派仍由上方各段展示）。 */}
      {!hasAnyKey ? <p className="kb-index-empty-hint">{t('settings.agentNoKeyHint')}</p> : null}
    </>
  );
}
