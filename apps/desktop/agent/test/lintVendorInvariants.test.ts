import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRules } from '../src/lint/vendor/llmlint/src/rules';
import { HANDLER_REGISTRY } from '../src/lint/vendor/llmlint/src/handler-rules';
import { defaultLintConfig } from '../src/lint/lintEngine';
import type { ActiveRuleRecord } from '../src/lint/vendor/llmlint/src/types';

// ── vendored llmlint 不变量守门（上游 tests/rule-titles.test.ts + rule-model-doc.test.ts 移植）──
//
// 移植目的：re-vendor 防漂移。断言语义与上游一致，仅改造为 Closure 可跑形态：
//  - import 路径 skill/src/* → ../src/lint/vendor/llmlint/src/*；
//  - 活契约文档 skill/references/rule-model.md → vendor README.md（references/ 未 vendored，
//    契约要点摘录在 README，见 vendor README「references 契约要点摘录」段）。
// 上游测试源：https://github.com/notnotype/llmlint commit 7b0e5a0 tests/ 目录。
//
// defaultConfig 单源（CR-020）：本文件此前的手写 literal 收敛为 lintEngine 导出的
// defaultLintConfig()（与 lintEngine 内部/引擎测试同一份，三处漂移面归一）。

const VENDOR_ROOT = fileURLToPath(new URL('../src/lint/vendor/llmlint/', import.meta.url));
const DOC_PATH = `${VENDOR_ROOT}README.md`;
const TYPES_PATH = `${VENDOR_ROOT}src/types.ts`;

async function activeRules(): Promise<ActiveRuleRecord[]> {
  const loaded = await loadRules(defaultLintConfig());
  return [...loaded.regexRules, ...loaded.densityRules, ...loaded.handlerRules, ...loaded.semanticRules];
}

// ── rule-titles 移植（断言逐字保留）──

/** title 里出现即视为泄漏的正则作者术语：这些词描述规则怎么写，不描述读者看到了什么问题。 */
const AUTHORING_JARGON = /防误伤|收窄|canonical|overlap|dataset|半截|\[可选\]|\[选开\]/i;

/** title 上限（码点）。紧凑 JSON 的体积收益要保住，也迫使 title 是标题而不是句子。 */
const MAX_TITLE_CHARS = 20;

describe('规则 title 结构性守卫（上游 rule-titles.test.ts 移植）', () => {
  it('title 全局唯一：同名标题让报告无法说明发现了什么', async () => {
    const rules = await activeRules();
    const byTitle = new Map<string, string[]>();
    for (const rule of rules) {
      byTitle.set(rule.title, [...(byTitle.get(rule.title) ?? []), rule.id]);
    }
    const duplicates = [...byTitle.entries()]
      .filter(([, ids]) => ids.length > 1)
      .sort((left, right) => right[1].length - left[1].length)
      .map(([title, ids]) => `「${title}」×${ids.length} → ${ids.join(', ')}`);

    expect(duplicates, `以下 title 被多条规则共用：\n${duplicates.join('\n')}`).toEqual([]);
  });

  it('title 不含正则作者术语：作者笔记不能漏进用户可见字段', async () => {
    const rules = await activeRules();
    const leaked = rules
      .filter((rule) => AUTHORING_JARGON.test(rule.title))
      .map((rule) => `${rule.id}「${rule.title}」`);

    expect(leaked, `以下 title 含正则作者术语：\n${leaked.join('\n')}`).toEqual([]);
  });

  it(`title 不超过 ${MAX_TITLE_CHARS} 码点：标题不是句子，也别吃掉紧凑 JSON 的体积收益`, async () => {
    const rules = await activeRules();
    const overlong = rules
      .filter((rule) => [...rule.title].length > MAX_TITLE_CHARS)
      .map((rule) => `${rule.id}「${rule.title}」(${[...rule.title].length} 字)`);

    expect(overlong, `以下 title 过长：\n${overlong.join('\n')}`).toEqual([]);
  });
});

// ── rule-model-doc 移植（活契约文档 = vendor README；断言语义保留）──

/** 从 types.ts 抽出 detector 联合的成员名，避免在测试里手写一份清单而各自漂移。 */
function detectorTypes(): string[] {
  const types = readFileSync(TYPES_PATH, 'utf-8');
  const names = new Set<string>();
  for (const match of types.matchAll(/type\s+(\w+Detector)\s*=\s*\{\s*\n\s*type:\s*"(\w+)"/g)) {
    names.add(match[2]!);
  }
  return [...names];
}

describe('规则模型活契约文档（上游 rule-model-doc.test.ts 移植，doc = vendor README）', () => {
  it('覆盖全部 detector 类型', () => {
    const doc = readFileSync(DOC_PATH, 'utf-8');
    const found = detectorTypes();
    expect(found.length, '未能从 vendored types.ts 解析出 detector 类型，正则可能已失效').toBeGreaterThanOrEqual(3);

    const missing = found.filter((name) => !doc.includes(`"${name}"`));
    expect(missing, `vendor README 未提及这些 detector 类型：${missing.join(', ')}`).toEqual([]);
  });

  it('handler 名单与注册表双向一致', () => {
    const doc = readFileSync(DOC_PATH, 'utf-8');
    const registered = Object.keys(HANDLER_REGISTRY).sort();

    const missing = registered.filter((name) => !doc.includes(name));
    expect(missing, `vendor README 未提及这些已注册 handler：${missing.join(', ')}`).toEqual([]);

    // 反向也要查：文档表格里编出一个不存在的 handler 同样是错的。只看 handler 那张表，
    // 别把基座字段表也算进来。
    const sectionStart = doc.indexOf('当前已注册的 handler：');
    expect(sectionStart, '文档缺少 handler 名单小节').toBeGreaterThan(-1);
    const section = doc.slice(sectionStart, doc.indexOf('\n\n', doc.indexOf('|', sectionStart)) + 1);
    const listed = [...section.matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gmu)].map((match) => match[1]!).sort();
    expect(listed.length, '未能从文档解析出 handler 表格，表格格式可能已变').toBeGreaterThanOrEqual(registered.length);

    const phantom = listed.filter((name) => !(name in HANDLER_REGISTRY));
    expect(phantom, `vendor README 列出了未注册的 handler：${phantom.join(', ')}`).toEqual([]);
  });
});
