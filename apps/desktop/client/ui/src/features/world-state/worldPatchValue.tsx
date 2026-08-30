/**
 * 变更值渲染三分支（dogfood R2 #92，task 08-29-world-state-panel S5）。
 *
 * value 形态事实（research/world-event-system-reality.md §1.5）：主力是中文自然语言长句、
 * `{objective, reader_perceived, vad}` 分层对象（信息差一等数据）、数值 scalar（increment）、
 * list（append）；`subject://<id>` ref 可嵌在长句中间（如 /location 的值）。渲染三分支：
 * 1. 字符串（含长句）→ 直接显；句中 `subject://` 引用切出可点 chip（跨层级直达 L3）。
 * 2. 分层对象 → 逐层显（层名小标；objective/reader_perceived/vad 已知键走 i18n，开放字典
 *    未知键回落原键——认知 topic 是中文自由短语，属数据非文案）。
 * 3. 数值 / 布尔 / 数组 → 机械格式化（数组逐项）。
 *
 * 快照键（此刻快照 kv）按 **patch path** 投影（见 buildSnapshotEntries 注释——键与真实
 * 变更 path 一一对应，点键钻取按 path 精确命中；value 分层对象原样交给本组件渲染）。
 */
import type { ReactNode } from 'react';

// ── subject:// 引用切分（纯函数，导出供测试）──

// subject:// 引用形态：id 段按 canonical `<type>:<slug>`（#91 后含冒号）与旧裸 slug 双兼容
// —— mockup valHtml 同款 `[\w:-]+`（契约 worldSubjectRefSchema 的 [\w-]+ 先于 #91，落后于
// canonical 形态；渲染侧取宽，未知形态按文本原样显示）。
const SUBJECT_REF_PATTERN = /subject:\/\/[\w:-]+/g;
const SUBJECT_REF_PREFIX = 'subject://';

export type WorldValueSegment =
  | { kind: 'text'; text: string }
  | { kind: 'ref'; ref: string; subjectId: string };

/**
 * 把字符串切成文本段与 `subject://<id>` 引用段（ref 正则对齐 worldSubjectRefSchema 的
 * `[\w-]+` id 契约）。纯函数：不改输入、无副作用。
 */
export function splitSubjectRefs(text: string): WorldValueSegment[] {
  const out: WorldValueSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(SUBJECT_REF_PATTERN)) {
    const idx = match.index ?? 0;
    if (idx > last) out.push({ kind: 'text', text: text.slice(last, idx) });
    out.push({ kind: 'ref', ref: match[0], subjectId: match[0].slice(SUBJECT_REF_PREFIX.length) });
    last = idx + match[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}

// ── 此刻快照 kv 行（按 patch path 寻址）──

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** JSON Pointer（RFC 6901）段反转义：'~1' → '/'、'~0' → '~'。 */
export function unescapePointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * 按 JSON Pointer 读嵌套值（plain object 键 / 数组数字下标）；任一段缺失/类型不合 →
 * undefined（不抛——快照投影对畸形 state 静默降级）。
 */
export function getValueAtPointer(state: unknown, pointer: string): unknown {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return undefined;
  let current: unknown = state;
  for (const raw of pointer.slice(1).split('/')) {
    const segment = unescapePointerSegment(raw);
    if (isPlainObject(current)) {
      if (!(segment in current)) return undefined;
      current = current[segment];
    } else if (Array.isArray(current) && /^\d+$/.test(segment)) {
      const idx = Number(segment);
      if (idx >= current.length) return undefined;
      current = current[idx];
    } else {
      return undefined;
    }
  }
  return current;
}

export interface WorldSnapshotEntry {
  /** 展平显示键（patch path 去首 '/'、段反转义——mockup「suspects/舱体来源异常」形态）。 */
  displayKey: string;
  /** 钻取用 JSON Pointer（= patch.path 原样——钻取过滤按精确 path/子 path 命中）。 */
  pointer: string;
  /** 该 path 当前折叠值（分层对象原样交给 WorldPatchValue 渲染）。 */
  value: unknown;
}

/**
 * 快照 kv 行投影（纯函数）。**键 = 折叠窗内出现过的 patch path**（首写序）而非把嵌套
 * state 深展平——两口径的差别是可钻取性：mockup 快照键（mood / suspects/舱体来源异常）
 * 逐一对应真实 patch path，点键钻取按 path 精确命中；深展平会造出 /mood/objective 这类
 * 无 patch 对应的叶路径（value 分层是 patch 的载荷形态，非独立寻址单元）。
 * remove 后无值（undefined）的 path 不出行。
 */
export function buildSnapshotEntries(
  patches: readonly { path: string; storyTime: number }[],
  asOfT: number | null,
  state: unknown,
): WorldSnapshotEntry[] {
  const entries: WorldSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const p of patches) {
    if (asOfT !== null && p.storyTime > asOfT) continue;
    if (seen.has(p.path)) continue;
    seen.add(p.path);
    const value = getValueAtPointer(state, p.path);
    if (value === undefined) continue;
    const segments = p.path.slice(1).split('/').map(unescapePointerSegment);
    entries.push({ displayKey: segments.join('/'), pointer: p.path, value });
  }
  return entries;
}

// ── 值渲染组件（三分支）──

/** vad 投影紧凑形（v -0.5 · a 0.7 · d -0.3）；三键任一缺失/非有限数 → null 走通用分层。 */
function formatVad(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const parts: string[] = [];
  for (const key of ['v', 'a', 'd'] as const) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    parts.push(`${key} ${n}`);
  }
  return parts.join(' · ');
}

function formatScalar(value: unknown): string {
  return String(value);
}

export interface WorldPatchValueProps {
  value: unknown;
  /** 已知分层键（objective/reader_perceived/vad）→ 本地化层名；未知键回落原键（开放字典）。 */
  layerLabel: (key: string) => string;
  /** `subject://` 引用的主体显示名（主体列表在手时解析；未登记主体回落原始引用串）。 */
  resolveSubjectName: (subjectId: string) => string | undefined;
  /** 引用 chip 点击（跨层级直达 L3）。缺省时引用退静态样式不可点。 */
  onSubjectClick?: (subjectId: string) => void;
}

/** 变更值 / 快照值通用渲染（三分支，见文件头）。纯展示组件——零 store / 零 IPC。 */
export function WorldPatchValue({
  value,
  layerLabel,
  resolveSubjectName,
  onSubjectClick,
}: WorldPatchValueProps): ReactNode {
  const renderRef = (subjectId: string, ref: string, key: string): ReactNode => {
    const label = resolveSubjectName(subjectId) ?? ref;
    if (!onSubjectClick) {
      return <span key={key} className="world-ref-chip is-static">{label}</span>;
    }
    return (
      <button
        key={key}
        type="button"
        className="world-ref-chip"
        onClick={() => onSubjectClick(subjectId)}
        title={ref}
      >
        {label}
      </button>
    );
  };

  const renderNode = (v: unknown, keyPrefix: string): ReactNode => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'string') {
      return splitSubjectRefs(v).map((seg, i) =>
        seg.kind === 'text'
          ? <span key={`${keyPrefix}-t${i}`}>{seg.text}</span>
          : renderRef(seg.subjectId, seg.ref, `${keyPrefix}-r${i}`));
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      return <>{formatScalar(v)}</>;
    }
    if (Array.isArray(v)) {
      return v.map((item, i) => (
        <span key={`${keyPrefix}-i${i}`} className="world-value-item">
          {renderNode(item, `${keyPrefix}-i${i}`)}
        </span>
      ));
    }
    if (isPlainObject(v)) {
      const vad = formatVad(v);
      if (vad !== null) return <>{vad}</>;
      return (
        <span key={`${keyPrefix}-layers`} className="world-value-layers">
          {Object.entries(v).map(([k, inner]) => (
            <span key={`${keyPrefix}-l${k}`} className="world-value-layer">
              <span className="world-value-label">{layerLabel(k)}</span>
              {renderNode(inner, `${keyPrefix}-l${k}`)}
            </span>
          ))}
        </span>
      );
    }
    return <>{formatScalar(v)}</>;
  };

  return <>{renderNode(value, 'v')}</>;
}
