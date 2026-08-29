import { describe, expect, it } from 'vitest';
import { extractJson } from '../src/nodes/extract-json';

// ─────────────────────────────────────────────────────────────────────────────
// CR-5/CR-1：extractJson helper 单测（dogfood-readiness）。
//
// 真实 LLM（尤 Qwen/DashScope）常返非裸 JSON：```json 围栏 / 前导文字 / 双对象前缀。
// 裸 JSON.parse 在这些形态抛 → 4 节点 parseOutput 重试同败 → 链断。extractJson 抽合法 JSON 子串。
// ─────────────────────────────────────────────────────────────────────────────

describe('extractJson — 裸 JSON 透传', () => {
  it('合法 JSON 对象直返（无修改）', () => {
    const content = '{"title":"第二章","text":"正文","wordCount":2800}';
    expect(extractJson(content)).toBe(content);
  });

  it('嵌套对象完整保留（first-{ to last-} 正确处理嵌套）', () => {
    const content = '{"a":{"b":1},"c":2}';
    expect(JSON.parse(extractJson(content))).toEqual({ a: { b: 1 }, c: 2 });
  });
});

describe('extractJson — ```json 围栏剥离', () => {
  it('```json\\n...\\n``` 围栏 → 剥离返内容', () => {
    const content = '```json\n{"verdict":"pass","summary":"ok"}\n```';
    expect(JSON.parse(extractJson(content))).toEqual({ verdict: 'pass', summary: 'ok' });
  });

  it('``` （无 json 标签）围栏 → 剥离返内容', () => {
    const content = '```\n{"decision":"auto_revise","reason":"r"}\n```';
    expect(JSON.parse(extractJson(content))).toEqual({ decision: 'auto_revise', reason: 'r' });
  });
});

describe('extractJson — 前导/尾随文字剥离', () => {
  it('前导自然语言（"这是初稿：" + JSON）→ 取首个 { 到末个 }', () => {
    const content = '好的，这是本章初稿：\n{"title":"第二章","text":"正文"}\n希望你喜欢。';
    expect(JSON.parse(extractJson(content))).toEqual({ title: '第二章', text: '正文' });
  });

  it('前导文字 + ```json 围栏（组合形态）→ 剥围栏后再取 brace 子串', () => {
    const content = 'Sure, here is the JSON:\n```json\n{"a":1}\n```\nLet me know.';
    expect(JSON.parse(extractJson(content))).toEqual({ a: 1 });
  });
});

describe('extractJson — DashScope 双对象前缀（runLoop lastIndexOf 思路）', () => {
  it('"{}{...}" 双对象 → 取末个 { 起（runLoop agent/loop.ts:210-229 同思路）', () => {
    // DashScope 偶返 "{}{real object}" —— first-{ to last-} 得 "{}{...}" invalid，
    // fallback 用 last-{ to last-} 得 "{...}" valid。
    const content = '{}{"title":"第二章","text":"正文","wordCount":2800}';
    expect(JSON.parse(extractJson(content))).toEqual({ title: '第二章', text: '正文', wordCount: 2800 });
  });
});

describe('extractJson — 无 brace / 无法 parse → 返回候选让调用方报错', () => {
  it('无 brace（纯文字）→ 返回原文（调用方 JSON.parse 抛真实错）', () => {
    const content = '我无法生成 JSON。';
    expect(extractJson(content)).toBe('我无法生成 JSON。');
  });

  it('所有候选都 parse 失败 → 返回首个候选（first-{ to last-}，调用方 JSON.parse 报错）', () => {
    const content = '{a:1}'; // 合法 JS 对象字面量但非法 JSON（key 未引号）
    const result = extractJson(content);
    expect(result).toBe('{a:1}');
    expect(() => JSON.parse(result)).toThrow();
  });
});
