/**
 * dogfood T1 CR-T1-047（decision 1A「UI 侧解信封」）：链流 JSON 信封剥离纯函数。
 *
 * draft-writer 阶段二产物契约 = JSON（{"title":…,"text":…正文…,"wordCount":…} + 尾部
 * <DRAFT_READY>）。extractChainDraftView 在渲染层解出 text 值增量：
 * - 锚点：本轮第一个 `"text"\s*:\s*"`（容忍 pretty-print 空格）；锚点前不渲。
 * - 转义：JSON string 转义流前 unescape；chunk 边界切在转义中间（`\`+`n` 分离）时尾部
 *   不完整转义等下一增量对齐。
 * - 终止：text 值止于未转义 `"`；其后 wordCount / 停束标记不渲。
 * - 容错：非信封形态 / 畸形转义 → fallback 原样（不比现状差）；围栏头（```json）容忍。
 */
import { describe, expect, it } from 'vitest';
import { extractChainDraftView } from '../src/features/agent-panel/chainEnvelope';

describe('extractChainDraftView — 锚点与终值', () => {
  it('完整信封：只出 text 值；title/信封语法/wordCount/<DRAFT_READY> 一概不渲', () => {
    const raw = '{"title":"第3章 黄昏","text":"黄昏的荒野上，主角深吸一口气。","wordCount":1832,"chapterId":"ch-3"}\n<DRAFT_READY>';
    const view = extractChainDraftView(raw);
    expect(view).toEqual({ kind: 'closed', text: '黄昏的荒野上，主角深吸一口气。' });
  });

  it('锚点前不渲：信封头在途（title 段在流）→ pending 空串', () => {
    expect(extractChainDraftView('')).toEqual({ kind: 'pending', text: '' });
    expect(extractChainDraftView('  {')).toEqual({ kind: 'pending', text: '' });
    expect(extractChainDraftView('{"title":"第3章 黄昏')).toEqual({ kind: 'pending', text: '' });
  });

  it('锚点容忍 pretty-print 空格变体（"text" : "）', () => {
    const raw = '{\n  "title": "第3章",\n  "text": "正文第一段。",\n  "wordCount": 5\n}';
    expect(extractChainDraftView(raw)).toEqual({ kind: 'closed', text: '正文第一段。' });
  });

  it('text 键在前（字段序不保证）同样命中锚点', () => {
    const raw = '{"text":"先正文","title":"后标题"}';
    expect(extractChainDraftView(raw)).toEqual({ kind: 'closed', text: '先正文' });
  });

  it('text 值未闭合（abort 半 JSON / 仍在途）→ pending + 已还原部分', () => {
    const view = extractChainDraftView('{"title":"t","text":"写到一半的正文');
    expect(view).toEqual({ kind: 'pending', text: '写到一半的正文' });
  });
});

describe('extractChainDraftView — 转义还原', () => {
  it('标准 JSON 转义流前 unescape（\\n \\" \\\\ \\t \\r \\/ \\b \\f）', () => {
    const raw = '{"text":"第一段\\n第二段\\"引号\\"\\\\路径\\t缩进\\r\\u6d4b\\u8bd5\\/斜杠"}';
    expect(extractChainDraftView(raw)).toEqual({
      kind: 'closed',
      text: '第一段\n第二段"引号"\\路径\t缩进\r测试/斜杠',
    });
  });

  it('\\uXXXX 含代理对（emoji）逐码单元还原自然成对', () => {
    const raw = '{"text":"\\ud83d\\ude00表情"}';
    expect(extractChainDraftView(raw)).toEqual({ kind: 'closed', text: '😀表情' });
  });

  it('text 值内的转义引号不误判终值（\\" 是内容不是闭合）', () => {
    const raw = '{"text":"他说\\"停\\"然后离开","wordCount":7}';
    expect(extractChainDraftView(raw)).toEqual({ kind: 'closed', text: '他说"停"然后离开' });
  });
});

describe('extractChainDraftView — chunk 边界切在转义中间', () => {
  it('按任意 chunk 边界增量喂入：单调追加、半截转义不渲、终值等于完整还原', () => {
    const full = '{"title":"第3章","text":"第一行\\n第二行\\t缩进 \\ud83d\\ude00 结束\\n","wordCount":9}\n<DRAFT_READY>';
    // 逐字符喂入 = 最严酷的 chunk 切分（每个转义序列必被切散）。
    let acc = '';
    const seen: string[] = [];
    for (const ch of full) {
      acc += ch;
      const view = extractChainDraftView(acc);
      expect(view.kind === 'pending' || view.kind === 'closed').toBe(true);
      seen.push(view.text);
    }
    // 单调不减（只追加，绝不回退/闪断）。
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].startsWith(seen[i - 1])).toBe(true);
    }
    // 半截转义期间不渲错字符：任一前缀产物都是完整还原的真前缀。
    const expected = '第一行\n第二行\t缩进 😀 结束\n';
    for (const text of seen) {
      expect(expected.startsWith(text)).toBe(true);
    }
    expect(seen[seen.length - 1]).toBe(expected);
    expect(extractChainDraftView(acc).kind).toBe('closed');
  });

  it('半截 \\uXXXX（不足 4 位 hex）等下一增量对齐', () => {
    expect(extractChainDraftView('{"text":"\\u6d4')).toEqual({ kind: 'pending', text: '' });
    expect(extractChainDraftView('{"text":"\\u6d4b"}')).toEqual({ kind: 'closed', text: '测' });
  });
});

describe('extractChainDraftView — fallback（不比现状差）', () => {
  it('散文直出（非信封形态）→ raw 原样', () => {
    const prose = '黄昏的荒野上，主角深吸一口气。';
    expect(extractChainDraftView(prose)).toEqual({ kind: 'raw', text: prose });
  });

  it('围栏头（```json，extract-json 同款容错）不判死——围栏内信封照剥', () => {
    const raw = '```json\n{"text":"围栏内正文"}\n```';
    expect(extractChainDraftView(raw)).toEqual({ kind: 'closed', text: '围栏内正文' });
  });

  it('畸形转义（\\x 非法 / \\u 后非 hex）→ raw 原样', () => {
    const bad = '{"text":"前半\\x后half"}';
    expect(extractChainDraftView(bad)).toEqual({ kind: 'raw', text: bad });
    const badHex = '{"text":"\\u00zz"}';
    expect(extractChainDraftView(badHex)).toEqual({ kind: 'raw', text: badHex });
  });
});
