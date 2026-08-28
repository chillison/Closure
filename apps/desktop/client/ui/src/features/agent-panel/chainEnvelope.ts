// ─────────────────────────────────────────────────────────────────────────────
// dogfood T1 CR-T1-047（decision 1A「UI 侧解信封」）：draft-writer 阶段二产物是 JSON
// 信封（{"title":"…","text":"…正文…","wordCount":…} + 尾部 <DRAFT_READY>，writer-node
// phase2Prompt / parseDraftOutput 契约）。S6 原样流上行时 UI 若原样累积渲染，用户全程看
// 裸 JSON 转义字面——本函数在**渲染层**把累积流解出 text 值增量（store 的 streamText 保持
// 原始累积，本函数幂等可重复调用）。
//
// 规则（CR 拍板 1A）：
// - 锚点：本轮第一个 `"text"\s*:\s*"`（容忍键后空格的 pretty-print 形态）；锚点前不渲。
// - 转义还原：JSON string 转义（\n \" \\ \t \r \b \f \/ \uXXXX）流前 unescape；增量边界
//   可能切在转义序列中间（如 `\` 与 `n` 分离）——尾部不完整转义等下一增量对齐，不渲半截。
// - 终止：text 值止于未转义 `"`（其后 `,` / `}` / wordCount / 停束标记一概不渲）。
// - 畸形容错：非信封形态（不以 `{` / ``` 围栏头开头）或转义畸形 → fallback 原样渲染
//  （不比现状差）；信封头在途但锚点未到 → 空（正文区让位「节点名 + 三点」占位）。
// ─────────────────────────────────────────────────────────────────────────────

export type ChainDraftView =
  /** 信封已识别，text 值仍在途（尚未闭合/尾部转义不完整）——渲已还原的部分。 */
  | { kind: 'pending'; text: string }
  /** text 值已闭合（其后 wordCount/停束标记不再进正文）——终稿形态。 */
  | { kind: 'closed'; text: string }
  /** 非信封形态（散文直出 / 契约变更）——原样透传（fallback，不比现状差）。 */
  | { kind: 'raw'; text: string };

/** 锚点：首个 `"text"` 键的取值开引号（容忍 `"text" : "` 空格变体；值内引号必被转义，
 * 转义形态 `\"text\"` 不含连续的 `"text"` 子串，不会误锚）。 */
const TEXT_ANCHOR_RE = /"text"\s*:\s*"/;

/** 累积流是否「像信封头」——首非空白字符是 `{` 或 markdown 围栏（extract-json 同款容错：
 * 模型违令加围栏时不至于整段落 fallback）。全空白视为在途（不判死）。 */
function looksLikeEnvelopeHead(accumulated: string): boolean {
  const t = accumulated.trimStart();
  if (t === '') return true;
  return t.startsWith('{') || t.startsWith('```');
}

/**
 * 解信封（纯函数，幂等）：输入链流累积原文，输出当前可渲正文。
 * 每次渲染 / 每 flush 调用一次，O(n) 扫描（n = 累积长度，250/500ms 节奏下无压力）。
 */
export function extractChainDraftView(accumulated: string): ChainDraftView {
  if (!looksLikeEnvelopeHead(accumulated)) {
    // 散文直出（契约变更 / 非 JSON 节点误配流）——原样渲染，绝不比现状差。
    return { kind: 'raw', text: accumulated };
  }

  const anchor = TEXT_ANCHOR_RE.exec(accumulated);
  if (!anchor) {
    // 信封头在途、锚点未到（title 段在流）——锚点前不渲（正文区让位占位）。
    return { kind: 'pending', text: '' };
  }

  let i = anchor.index + anchor[0].length;
  let out = '';
  while (i < accumulated.length) {
    const ch = accumulated[i];
    if (ch === '"') {
      // 未转义引号 = text 值闭合；其后的 , } wordCount / <DRAFT_READY> 一概不渲。
      return { kind: 'closed', text: out };
    }
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    // 转义序列。chunk 边界可能切在转义中间——尾部不完整（如只剩 `\` 或 `\u12`）时
    // 停在原地等下一增量对齐（pending），不渲半截转义。
    const next = accumulated[i + 1];
    if (next === undefined) return { kind: 'pending', text: out };
    switch (next) {
      case 'n': out += '\n'; i += 2; break;
      case 't': out += '\t'; i += 2; break;
      case 'r': out += '\r'; i += 2; break;
      case 'b': out += '\b'; i += 2; break;
      case 'f': out += '\f'; i += 2; break;
      case '"': out += '"'; i += 2; break;
      case '\\': out += '\\'; i += 2; break;
      case '/': out += '/'; i += 2; break;
      case 'u': {
        if (i + 6 > accumulated.length) return { kind: 'pending', text: out }; // \u 截半——等增量
        const hex = accumulated.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          // 非 4 位 hex = 畸形转义——整体 fallback 原样（不比现状差）。
          return { kind: 'raw', text: accumulated };
        }
        // 代理对（😀）：按码单元逐个还原，拼接自然成对（JS 字符串即 UTF-16）。
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        break;
      }
      default:
        // 未知转义 = 畸形——fallback 原样。
        return { kind: 'raw', text: accumulated };
    }
  }
  // 扫到累积末尾仍未闭合——值在途（含 abort 半 JSON：已还原部分照渲）。
  return { kind: 'pending', text: out };
}
