/**
 * worldState i18n 齐平守卫（dogfood R2 #92，task 08-29-world-state-panel S6）。
 *
 * 1. **zh/en 键齐平**：两 locale 的 worldState.yaml 展平键集完全相等（结构性 diff——加键
 *    漏一侧即红，不用维护手写键清单；mirror creativeTabsI18n「穷尽守卫」精神但更严：
 *    整 namespace 键集相等，含嵌套 typeLabels/axisLabels/issueLabels/valueLayers）。
 * 2. **zh 零英文术语**（prd 验收 7，用户点名）：zh 侧全部文案值不得含 as-of / patch /
 *    slice / subject / reduce 术语（违例 = 文案退化成实现词露出）。
 *
 * 直读 yaml 原文（?raw + js-yaml）而非经 translate —— 结构比较需要完整键树，translate
 * 只能按点路径探测缺键（probe 式），结构性守卫用源头数据。
 */
import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';
import zhRaw from '../src/shared/i18n/zh-CN/worldState.yaml?raw';
import enRaw from '../src/shared/i18n/en-US/worldState.yaml?raw';

function flattenKeys(node: unknown, prefix: string, out: Set<string>): void {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === 'object') flattenKeys(value, path, out);
      else out.add(path);
    }
  }
}

function collectValues(node: unknown, out: string[]): void {
  if (node && typeof node === 'object') {
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (value && typeof value === 'object') collectValues(value, out);
      else if (typeof value === 'string') out.push(value);
    }
  }
}

const zhDoc = yaml.load(zhRaw) as Record<string, unknown>;
const enDoc = yaml.load(enRaw) as Record<string, unknown>;

describe('worldState i18n 齐平（zh/en）', () => {
  it('两 locale 键集完全相等（加键漏一侧即红）', () => {
    const zhKeys = new Set<string>();
    const enKeys = new Set<string>();
    flattenKeys(zhDoc.worldState, '', zhKeys);
    flattenKeys(enDoc.worldState, '', enKeys);
    expect(zhKeys.size).toBeGreaterThan(30); // 键树非空（防 yaml 解析失败静默过）
    expect([...zhKeys].sort()).toEqual([...enKeys].sort());
  });

  it('所有键两侧均为非空字符串值', () => {
    for (const [locale, doc] of [['zh-CN', zhDoc], ['en-US', enDoc]] as const) {
      const values: string[] = [];
      collectValues(doc.worldState, values);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        expect(value.trim().length, `${locale} 存在空文案值`).toBeGreaterThan(0);
      }
    }
  });

  it('zh 文案零英文术语（as-of/patch/slice/subject/reduce 不得露出）', () => {
    const values: string[] = [];
    collectValues(zhDoc.worldState, values);
    const banned = /\b(as-of|patch(es)?|slice(s)?|subject(s)?|reduce(d)?)\b/i;
    for (const value of values) {
      // 剥掉插值占位 {subjects}/{patches}——变量名非文案，渲染后被实参替换。
      const copy = value.replace(/\{[^}]+\}/g, '');
      expect(copy, `zh 文案含禁用英文术语：${value}`).not.toMatch(banned);
    }
  });
});
