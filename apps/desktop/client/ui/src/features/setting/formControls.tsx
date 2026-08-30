/**
 * CardForm 控件族（task 08-30-asset-cards-visualization A2 波；CR patch 波语义修订）。
 *
 * 落盘时机（WorkingStyleSection 先例，design §5；CR-001 裁决 1 修订）：**键盘类连续输入
 * 一律 blur 存**（text/textarea/select 自由输入/number——防每键 undo 栈与中间脏值落盘）；
 * 离散控件（select 词表快选 / chips 增删 / boolean / kv 删行）change 即存。
 *
 * 外部回声抑制（CR-003 裁决 3 标准式）：**聚焦期间不回写外部传入 value**——本地草稿优先
 * （agent 写卡回声到达不清掉输入中的草稿）；blur 提交后自然同步，blur 时若用户未动而外部
 * 已翻新则收养外部值（防陈旧草稿反向覆盖）。
 *
 * 空值语义（CR P17/P18）：必填字段（卡名）空值 blur 拒绝并回显存量（optional prop
 * `rejectEmpty`）；可选字段清空 = 删键——非字符串存值（unknown seam 显影空串）同样落
 * 「无值」，不静默保留隐形原值。
 *
 * 所有标签经 fieldSpec 标签出口（labelFor 等）——组件不硬编码可见文案；无视觉 aria
 * （kv 行 / chips 删除钮）同样走出口键（AC7 中文化纪律同等适用）。
 */

import { useEffect, useId, useRef, useState } from 'react';
import {
  addChipPlaceholder,
  chipRemoveAriaLabel,
  kvAddRowLabel,
  kvDeleteAriaLabel,
  kvDuplicateKeyTitle,
  kvKeyAriaLabel,
  kvValueAriaLabel,
  type Translate,
} from './fieldSpec';
import { asChipValues, asDetailsRecord, clampNumber } from './formCardOps';

export interface VocabSuggestion {
  value: string;
  gloss: string;
}

// ── 文本 / 长文本：草稿 + blur 落盘 ─────────────────────────────────────────────
export interface FormTextControlProps {
  label: string;
  /** unknown seam——卡值可能是 undefined/null/非串（守卫到 ''）。 */
  value: unknown;
  onCommit: (raw: string) => void;
  multiline?: boolean;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /**
   * 必填字段空值策略（CR P17，卡名用）：空/纯空白 blur = 拒绝本次提交并回显存量。
   * 缺省 'clear'（可选字段）：清空提交空串（ops 层删键）。
   */
  rejectEmpty?: boolean;
}

export function FormTextControl({
  label,
  value,
  onCommit,
  multiline = false,
  rows = 2,
  disabled = false,
  className,
  rejectEmpty = false,
}: FormTextControlProps) {
  const stored = typeof value === 'string' ? value : '';
  const [draft, setDraft] = useState(stored);
  const lastSyncedRef = useRef(stored);
  const focusedRef = useRef(false);
  useEffect(() => {
    // 聚焦期间不回写（CR-003 裁决 3）：本地草稿优先；blur 后未动则由 blur 收养外部值。
    if (focusedRef.current) return;
    if (stored !== lastSyncedRef.current) {
      lastSyncedRef.current = stored;
      setDraft(stored);
    }
  }, [stored]);

  const commit = () => {
    const trimmedEmpty = draft.trim() === '';
    if (draft === lastSyncedRef.current) {
      if (trimmedEmpty && value !== undefined) {
        // CR P18：非字符串存值显影空串——清空提交 = 删键（ops 层落「无值」），非 no-op。
        onCommit('');
        return;
      }
      if (stored !== lastSyncedRef.current) {
        // 用户未动而聚焦期外部翻新——收养外部值（防陈旧草稿反向覆盖）。
        lastSyncedRef.current = stored;
        setDraft(stored);
      }
      return;
    }
    if (trimmedEmpty && rejectEmpty) {
      // CR P17：必填字段（卡名）空值拒绝——回显存量，不落盘不改头显。
      setDraft(stored);
      return;
    }
    lastSyncedRef.current = draft;
    onCommit(draft);
  };

  const cls = className ?? (multiline ? 'card-form-textarea' : 'card-form-input');
  if (multiline) {
    return (
      <textarea
        className={cls}
        aria-label={label}
        rows={rows}
        value={draft}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.value); }}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; commit(); }}
      />
    );
  }
  return (
    <input
      type="text"
      className={cls}
      aria-label={label}
      value={draft}
      disabled={disabled}
      onChange={(e) => { setDraft(e.target.value); }}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => { focusedRef.current = false; commit(); }}
    />
  );
}

// ── number：blur 存（CR-001 裁决 1——键盘类连续输入，change 即存会逐键三 commit +
//    中途停手盘上停中间值）；清空 blur 删键；越界 blur 钳制 ───────────────────────
export interface FormNumberControlProps {
  label: string;
  value: unknown;
  min?: number;
  max?: number;
  onCommit: (value: number | undefined) => void;
  disabled?: boolean;
}

export function FormNumberControl({ label, value, min, max, onCommit, disabled = false }: FormNumberControlProps) {
  const stored = typeof value === 'number' ? value : undefined;
  const [draft, setDraft] = useState(stored === undefined ? '' : String(stored));
  const lastSyncedRef = useRef(stored);
  const focusedRef = useRef(false);
  useEffect(() => {
    // 聚焦期间不回写（CR-003 裁决 3，number 同理）。
    if (focusedRef.current) return;
    if (stored !== lastSyncedRef.current) {
      lastSyncedRef.current = stored;
      setDraft(stored === undefined ? '' : String(stored));
    }
  }, [stored]);

  const handleBlur = () => {
    if (draft === '') {
      // 清空 = 删键（原值非 undefined 时；含非数存值显影空串的 P18 同族清理）。
      if (value !== undefined) {
        lastSyncedRef.current = undefined;
        onCommit(undefined);
      }
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      // 脏输入不落盘——回到存量显示
      setDraft(stored === undefined ? '' : String(stored));
      return;
    }
    const clamped = clampNumber(parsed, min, max);
    if (clamped === lastSyncedRef.current && stored !== lastSyncedRef.current) {
      // 用户未动而聚焦期外部翻新——收养外部值（防陈旧草稿 blur 反向覆盖回写）。
      lastSyncedRef.current = stored;
      setDraft(stored === undefined ? '' : String(stored));
      return;
    }
    if (clamped !== stored) {
      lastSyncedRef.current = clamped;
      onCommit(clamped);
    }
    setDraft(String(clamped));
  };

  return (
    <input
      type="number"
      className="card-form-input card-form-number"
      aria-label={label}
      value={draft}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(e) => { setDraft(e.target.value); }}
      onBlur={handleBlur}
      onFocus={() => { focusedRef.current = true; }}
    />
  );
}

// ── string[] chips：增删即存（mirror 总览 genre_tags 交互）+ 词表快选 ───────────
export interface FormChipsControlProps {
  label: string;
  value: unknown;
  onAdd: (item: string) => void;
  onRemove: (item: string) => void;
  suggestions?: ReadonlyArray<VocabSuggestion>;
  disabled?: boolean;
  /** 添加占位文案的译者（缺省回落开发期占位——生产路径 CardForm 恒传）。 */
  t?: Translate;
}

export function FormChipsControl({ label, value, onAdd, onRemove, suggestions, disabled = false, t }: FormChipsControlProps) {
  const items = asChipValues(value);
  const [input, setInput] = useState('');
  const add = () => {
    if (!input.trim()) return;
    onAdd(input);
    setInput('');
  };
  const quickPicks = (suggestions ?? []).filter((s) => !items.includes(s.value));
  return (
    <div className="card-form-chips">
      {items.map((item) => (
        <span key={item} className="card-form-chip">
          {item}
          <button
            type="button"
            className="card-form-chip-remove"
            aria-label={chipRemoveAriaLabel(t, item)}
            title={chipRemoveAriaLabel(t, item)}
            disabled={disabled}
            onClick={() => { onRemove(item); }}
          >×</button>
        </span>
      ))}
      <input
        type="text"
        className="card-form-chip-input"
        aria-label={label}
        placeholder={addChipPlaceholder(t)}
        value={input}
        disabled={disabled}
        onChange={(e) => { setInput(e.target.value); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
      />
      {quickPicks.length > 0 && (
        <details className="card-form-quickpick">
          <summary className="card-form-quickpick-summary">{addChipPlaceholder(t)}</summary>
          <div className="card-form-quickpick-list">
            {quickPicks.map((s) => (
              <button
                key={s.value}
                type="button"
                className="card-form-quickpick-item"
                title={s.gloss}
                disabled={disabled}
                onClick={() => { onAdd(s.value); }}
              >{s.value}</button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── select：词表快选即存 + datalist 自由输入 blur 存（词表只是建议，非门禁）──────
export interface FormSelectControlProps {
  label: string;
  value: unknown;
  suggestions: ReadonlyArray<VocabSuggestion>;
  onCommit: (raw: string) => void;
  disabled?: boolean;
  /** 快选区标题的译者（缺省回落——生产路径 CardForm 恒传）。 */
  t?: Translate;
}

export function FormSelectControl({ label, value, suggestions, onCommit, disabled = false, t }: FormSelectControlProps) {
  const stored = typeof value === 'string' ? value : '';
  const [draft, setDraft] = useState(stored);
  const lastSyncedRef = useRef(stored);
  const focusedRef = useRef(false);
  useEffect(() => {
    // 聚焦期间不回写（CR-003 裁决 3 同标准式）。
    if (focusedRef.current) return;
    if (stored !== lastSyncedRef.current) {
      lastSyncedRef.current = stored;
      setDraft(stored);
    }
  }, [stored]);

  const listId = useId();
  const commit = () => {
    if (draft === lastSyncedRef.current) {
      if (draft.trim() === '' && value !== undefined) {
        // CR P18 同族：非字符串存值显影空串——清空提交 = 删键，非 no-op。
        onCommit('');
        return;
      }
      if (stored !== lastSyncedRef.current) {
        lastSyncedRef.current = stored;
        setDraft(stored);
      }
      return;
    }
    lastSyncedRef.current = draft;
    onCommit(draft);
  };
  const quickPicks = suggestions.filter((s) => s.value !== stored);

  return (
    <div className="card-form-select">
      <input
        type="text"
        className="card-form-input card-form-select-input"
        aria-label={label}
        list={listId}
        value={draft}
        disabled={disabled}
        onChange={(e) => { setDraft(e.target.value); }}
        onFocus={() => { focusedRef.current = true; }}
        onBlur={() => { focusedRef.current = false; commit(); }}
      />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s.value} value={s.value}>{s.gloss}</option>
        ))}
      </datalist>
      {quickPicks.length > 0 && (
        <details className="card-form-quickpick">
          <summary className="card-form-quickpick-summary">{addChipPlaceholder(t)}</summary>
          <div className="card-form-quickpick-list">
            {quickPicks.map((s) => (
              <button
                key={s.value}
                type="button"
                className="card-form-quickpick-item"
                title={s.gloss}
                disabled={disabled}
                onClick={() => {
                  setDraft(s.value);
                  lastSyncedRef.current = s.value;
                  onCommit(s.value);
                }}
              >{s.value}</button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── boolean：checkbox 即存 ─────────────────────────────────────────────────────
export interface FormBooleanControlProps {
  label: string;
  value: unknown;
  onCommit: (value: boolean) => void;
  disabled?: boolean;
}

export function FormBooleanControl({ label, value, onCommit, disabled = false }: FormBooleanControlProps) {
  return (
    <input
      type="checkbox"
      className="card-form-checkbox"
      aria-label={label}
      checked={value === true}
      disabled={disabled}
      onChange={(e) => { onCommit(e.target.checked); }}
    />
  );
}

// ── details 自由键值表：行 blur 存、删行即存、加行本地 ─────────────────────────
interface KvRow {
  key: string;
  valText: string;
  /** 原键（null = 新行；清键瞬态回落锚点——CR P9③，rename 落定后随提交对齐生效键）。 */
  origKey: string | null;
  /** 原值文本（「值未动」判定——值未动保留原值对象类型，CR P9①）。 */
  origValText: string | null;
  origValue: unknown;
}

function valueToText(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  const s = JSON.stringify(v);
  return s === undefined ? '' : s;
}

function initKvRows(details: Record<string, unknown> | undefined): KvRow[] {
  if (!details) return [];
  return Object.entries(details).map(([k, v]) => {
    const text = valueToText(v);
    return { key: k, valText: text, origKey: k, origValText: text, origValue: v };
  });
}

export interface FormKvTableProps {
  details: unknown;
  onCommit: (next: Record<string, unknown> | undefined) => void;
  disabled?: boolean;
  /** 添加行按钮文案的译者（缺省回落——生产路径 CardForm 恒传）。 */
  t?: Translate;
}

export function FormKvTable({ details, onCommit, disabled = false, t }: FormKvTableProps) {
  const detailsRec = asDetailsRecord(details);
  const [rows, setRows] = useState<KvRow[]>(() => initKvRows(detailsRec));
  const lastSyncedRef = useRef(detailsRec);
  useEffect(() => {
    if (detailsRec !== lastSyncedRef.current) {
      lastSyncedRef.current = detailsRec;
      setRows(initKvRows(detailsRec));
    }
  }, [detailsRec]);

  const buildRecord = (source: readonly KvRow[]): Record<string, unknown> | undefined => {
    const out: Record<string, unknown> = {};
    for (const r of source) {
      // 行内有效值（CR P9①）：值文本未动 → 保留原值对象（数字/嵌套结构不改写字符串）；
      // 与键是否被改无关——键改值未动的行（rename）原值原样迁移到新键。
      const effectiveValue = r.valText === r.origValText ? r.origValue : r.valText;
      const key = r.key.trim();
      if (!key) {
        // CR P9③ 清键瞬态：改键中途（清空键后）blur 不丢原条目——沿 origKey 保留行内
        // 有效值，待用户补完新键；删条目走 × 删行钮，不走清键。
        if (r.origKey !== null && !(r.origKey in out)) out[r.origKey] = effectiveValue;
        continue;
      }
      // CR P9② 重复键（trim 后同键）保序去重——首行生效，后行由 is-dup 标记可见。
      if (key in out) continue;
      out[key] = effectiveValue;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };

  const commitRows = (source: readonly KvRow[]) => {
    const next = buildRecord(source);
    // 无变化不提交（防止 blur 连发噪音）——基线用 lastSyncedRef 而非 props：本组件已提交
    // 的值即「store 应有态」（props 回灌滞后/被拒时同样成立），重复 blur 不重复落盘。
    if (JSON.stringify(next ?? {}) === JSON.stringify(lastSyncedRef.current ?? {})) return;
    lastSyncedRef.current = next;
    onCommit(next);
    // 行内 origKey 对齐已提交记录（CR P9③ 配套）：rename 落定后 origKey 跟到生效键——
    // 后续再清键回落的是生效键，不会复活 rename 前旧键。origValText/origValue 不动
    //（P9① 的「值未动保类型」判定继续以最初存值为参照）。
    setRows(source.map((r) => ({ ...r, origKey: r.key.trim() || r.origKey })));
  };

  const updateRow = (i: number, patch: Partial<KvRow>) => {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  // 侧 effect（onCommit）必须在 setState updater 外调用——StrictMode 下 updater 可双调。
  const deleteRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    setRows(next);
    commitRows(next);
  };
  const addRow = () => {
    setRows((prev) => [...prev, { key: '', valText: '', origKey: null, origValText: null, origValue: undefined }]);
  };

  // 重复键首行索引（CR P9②）：trim 后同键的后行标记 is-dup（首行生效，视觉提示冲突）。
  const firstKeyIndex = new Map<string, number>();
  rows.forEach((r, i) => {
    const k = r.key.trim();
    if (k && !firstKeyIndex.has(k)) firstKeyIndex.set(k, i);
  });

  return (
    <div className="card-form-kv">
      {rows.map((r, i) => {
        const k = r.key.trim();
        const isDup = k !== '' && firstKeyIndex.get(k) !== i;
        return (
          <div key={`${r.origKey ?? 'new'}-${i}`} className="card-form-kv-row">
          <input
            type="text"
            className={`card-form-kv-key${isDup ? ' is-dup' : ''}`}
            aria-label={kvKeyAriaLabel(t, i + 1)}
            title={isDup ? kvDuplicateKeyTitle(t) : undefined}
            value={r.key}
            disabled={disabled}
            onChange={(e) => { updateRow(i, { key: e.target.value }); }}
            onBlur={() => { commitRows(rows); }}
          />
          <input
            type="text"
            className="card-form-kv-value"
            aria-label={kvValueAriaLabel(t, i + 1)}
            value={r.valText}
            disabled={disabled}
            onChange={(e) => { updateRow(i, { valText: e.target.value }); }}
            onBlur={() => { commitRows(rows); }}
          />
          <button
            type="button"
            className="card-form-kv-delete"
            aria-label={kvDeleteAriaLabel(t, i + 1)}
            title="×"
            disabled={disabled}
            onClick={() => { deleteRow(i); }}
          >×</button>
          </div>
        );
      })}
      <button
        type="button"
        className="card-form-kv-add"
        disabled={disabled}
        onClick={addRow}
      >{kvAddRowLabel(t)}</button>
    </div>
  );
}
