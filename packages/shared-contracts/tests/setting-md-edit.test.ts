/**
 * Story 2.2 WP-B: applySettingMdActions + setting-md action schemas (design §3).
 *
 * Locks the bounded span-edit semantics on settings/*.md:
 * - sequential application (each action sees the previous action's output);
 * - all-or-nothing failure with failedIndex + offending action (never partial);
 * - span ops locate via the 7.1 primitives (unique-only, zero fuzzy fallback);
 * - create_file only on a non-existent doc; frontmatter source stamped 'agent'
 *   by the renderer (LLM cannot forge provenance);
 * - update_meta does surgical line-level frontmatter surgery (unknown keys and
 *   comments pass through verbatim — no re-serialize round-trip).
 */
import { describe, expect, it } from 'vitest';
import {
  applySettingMdActions,
  renderSettingMdDoc,
  settingMdActionSchema,
  settingMdUpdateRequestSchema,
  updateFrontmatter,
} from '../src/contracts/setting-md-edit';

const EXISTING_DOC = [
  '---',
  "id: 'magic-system'",
  "type: 'magic_system'",
  'tags:',
  '  - 魔法',
  '  - 代价',
  "# a user comment that must survive 'tags' surgery",
  "linked_entities: ['char-protag']",
  "custom_key: 'kept-verbatim'",
  '---',
  '# 魔法体系',
  '',
  '## 力量等级',
  '',
  '施法消耗精神力。',
  '',
  '## 禁忌',
  '',
  '复活死者会招致诅咒。',
].join('\n');

describe('settingMdActionSchema / settingMdUpdateRequestSchema', () => {
  it('empty actions rejected at the zod surface (P16 mirror)', () => {
    expect(settingMdUpdateRequestSchema.safeParse({ actions: [] }).success).toBe(false);
    expect(settingMdUpdateRequestSchema.safeParse({ settingId: 'x' }).success).toBe(false);
  });

  it('update_meta with none of type/tags/linked_entities rejected (top-level refine)', () => {
    expect(settingMdActionSchema.safeParse({ op: 'update_meta' }).success).toBe(false);
    expect(settingMdActionSchema.safeParse({ op: 'update_meta', tags: ['a'] }).success).toBe(true);
  });

  it('anchor quote min(1) (CR F8 mirror) + empty replacement is legal (pure deletion via replace)', () => {
    expect(settingMdActionSchema.safeParse({ op: 'remove_span', anchor: { quote: '' } }).success).toBe(false);
    expect(
      settingMdActionSchema.safeParse({ op: 'replace_span', anchor: { quote: 'q' }, replacement: '' }).success,
    ).toBe(true);
  });
});

describe('applySettingMdActions — create_file', () => {
  it('renders frontmatter (id/type/tags/linked_entities/source:agent) + ensured H1', () => {
    const result = applySettingMdActions(undefined, [
      {
        op: 'create_file',
        title: '幽冥秘境地理',
        content: '## 入口\n位于北境冰原之下。',
        type: 'location',
        tags: ['地理', '北境'],
      },
    ], { settingId: 'nether-realm' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.startsWith('---\n')).toBe(true);
    expect(result.content).toContain("id: 'nether-realm'");
    expect(result.content).toContain("type: 'location'");
    expect(result.content).toContain("tags: ['地理', '北境']");
    expect(result.content).toContain("source: 'agent'");
    expect(result.content).toContain('---\n# 幽冥秘境地理\n\n## 入口');
    expect(result.appliedCount).toBe(1);
  });

  it('create_file without opts.settingId omits frontmatter id (filename fallback)', () => {
    const result = applySettingMdActions(undefined, [{ op: 'create_file', title: 'T', content: '正文' }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain('id:');
    expect(result.content).toContain("source: 'agent'");
  });

  it('content already carrying an H1 passes through untouched', () => {
    const result = applySettingMdActions(undefined, [
      { op: 'create_file', title: 'ignored', content: '# 已有标题\n正文' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('---\n# 已有标题\n正文');
    expect(result.content).not.toContain('# ignored');
  });

  it('create_file on an existing doc → whole failure (never whole-file replace)', () => {
    const result = applySettingMdActions(EXISTING_DOC, [{ op: 'create_file', title: 'T', content: 'c' }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('requires the doc to NOT exist');
    expect(result.failedIndex).toBe(0);
    expect(result.action.op).toBe('create_file');
  });

  it('create_file on a BLANK existing doc (empty / whitespace-only) succeeds — nothing to clobber (CR-016, 08-28-style-card-mvp)', () => {
    for (const blank of ['', '\n\n', '   \n\t']) {
      const result = applySettingMdActions(blank, [
        { op: 'create_file', title: '风格卡片', content: '# 风格卡片\n\n卡体。' },
      ], { settingId: 'style' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("id: 'style'");
      expect(result.content).toContain('# 风格卡片\n\n卡体。');
      expect(result.appliedCount).toBe(1);
    }
  });
});

describe('applySettingMdActions — span ops (7.1 primitives reuse)', () => {
  it('replace_span with a unique heading-line anchor splices exactly that span', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'replace_span', anchor: { quote: '施法消耗精神力。' }, replacement: '施法消耗精神力与生命力。' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('施法消耗精神力与生命力。');
    expect(result.content).not.toContain('施法消耗精神力。');
    // everything else untouched
    expect(result.content).toContain('## 禁忌');
    expect(result.content).toContain("custom_key: 'kept-verbatim'");
  });

  it('duplicate quote without prefix/suffix → ambiguous rejection (zero fuzzy fallback)', () => {
    const doc = '重复句。\n中间。\n重复句。';
    const result = applySettingMdActions(doc, [
      { op: 'replace_span', anchor: { quote: '重复句。' }, replacement: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ambiguous');
  });

  it('duplicate quote disambiguated by prefix/suffix context', () => {
    const doc = '前文甲。\n重复句。\n中间。\n前文乙。\n重复句。';
    const result = applySettingMdActions(doc, [
      { op: 'replace_span', anchor: { quote: '重复句。', prefix: '前文乙。\n' }, replacement: '换过的。' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toBe('前文甲。\n重复句。\n中间。\n前文乙。\n换过的。');
  });

  it('CRLF doc + LF multi-line quote → anchors match (boundary normalization, CR-08-16-104)', () => {
    // Windows 手编文档（CRLF）+ LLM 复述多行段（自然产 LF）——旧行为系统性 not-found。
    const crlfDoc = '# 法术体系\r\n\r\n施法消耗精神力。\r\n后续段落。\r\n';
    const lfQuote = '施法消耗精神力。\n后续段落。';
    const result = applySettingMdActions(crlfDoc, [
      { op: 'replace_span', anchor: { quote: lfQuote, prefix: '# 法术体系\n\n' }, replacement: '整段替换后的文本。' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('整段替换后的文本。');
    // 归一化后全文统一 LF（atomicWrite 写 plain utf-8；首次 agent 编辑统一行尾，diff 卡可见）。
    expect(result.content).not.toContain('\r\n');
    expect(result.content).toContain('# 法术体系\n\n');
  });

  it('BOM-stripped on apply (mirror updateFrontmatter reserialize behavior)', () => {
    const bomDoc = '﻿# 标题\n\n正文。';
    const result = applySettingMdActions(bomDoc, [
      { op: 'replace_span', anchor: { quote: '正文。' }, replacement: '新正文。' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content.startsWith('﻿')).toBe(false);
    expect(result.content).toContain('新正文。');
  });

  it('quote not found (drifted / misquoted) → not-found rejection with actionable message', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'replace_span', anchor: { quote: '施法消耗魔力。' }, replacement: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('not found');
  });

  it('insert_after anchors the heading line and inserts after the located span', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'insert_after', anchor: { quote: '## 禁忌' }, insertion: '\n\n## 新节\n\n新内容。' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain('## 禁忌\n\n## 新节\n\n新内容。\n\n复活死者会招致诅咒。');
  });

  it('remove_span deletes exactly the located span', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'remove_span', anchor: { quote: '复活死者会招致诅咒。' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).not.toContain('复活死者');
    expect(result.content).toContain('## 禁忌');
  });

  it('span op on a non-existent doc → friendly rejection', () => {
    const result = applySettingMdActions(undefined, [
      { op: 'replace_span', anchor: { quote: 'q' }, replacement: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('requires an existing doc');
  });
});

describe('applySettingMdActions — multi-action order + all-or-nothing', () => {
  it('actions apply sequentially (create → insert → replace chain over the evolving doc)', () => {
    const result = applySettingMdActions(undefined, [
      { op: 'create_file', title: '规则', content: '第一条规则。' },
      { op: 'insert_after', anchor: { quote: '第一条规则。' }, insertion: '\n\n第二条规则。' },
      { op: 'replace_span', anchor: { quote: '第二条规则。' }, replacement: '第二条规则（修订）。' },
    ], { settingId: 'rules' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appliedCount).toBe(3);
    expect(result.content).toContain('第一条规则。');
    expect(result.content).toContain('第二条规则（修订）。');
    expect(result.content).not.toContain('第二条规则。\n');
  });

  it('a failing middle action aborts the batch with failedIndex + action (no partial content)', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'replace_span', anchor: { quote: '施法消耗精神力。' }, replacement: '先改这段。' },
      { op: 'replace_span', anchor: { quote: '不存在的原文。' }, replacement: 'x' },
      { op: 'remove_span', anchor: { quote: '## 禁忌' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedIndex).toBe(1);
    expect(result.action.op).toBe('replace_span');
  });
});

describe('updateFrontmatter (surgical) + update_meta apply path', () => {
  it('replaces the provided key (block-sequence tags) and preserves unknown keys / comments verbatim', () => {
    const next = updateFrontmatter(EXISTING_DOC, { op: 'update_meta', tags: ['魔法'] });
    expect(next).toContain('tags: [\'魔法\']');
    expect(next).not.toContain('  - 魔法');
    expect(next).toContain("# a user comment that must survive 'tags' surgery");
    expect(next).toContain("custom_key: 'kept-verbatim'");
    expect(next).toContain("id: 'magic-system'");
    // body untouched
    expect(next).toContain('施法消耗精神力。');
  });

  it('appends a missing key at the end of the frontmatter block', () => {
    const doc = '---\n' + "id: 'x'\n" + '---\n' + '# 正文';
    const next = updateFrontmatter(doc, { op: 'update_meta', type: 'faction' });
    expect(next).toContain("type: 'faction'");
    expect(next.indexOf("type: 'faction'")).toBeGreaterThan(doc.indexOf("id: 'x'") >= 0 ? 0 : 0);
    expect(next).toContain('# 正文');
  });

  it('doc with no frontmatter gets one prepended (body untouched)', () => {
    const next = updateFrontmatter('# 无 frontmatter\n\n正文', { op: 'update_meta', tags: ['新标签'] });
    expect(next.startsWith("---\ntags: ['新标签']\n---\n")).toBe(true);
    expect(next).toContain('# 无 frontmatter');
  });

  it('CRLF frontmatter keeps its line endings', () => {
    const doc = "---\r\nid: 'x'\r\ntags: ['旧']\r\n---\r\n# 正文";
    const next = updateFrontmatter(doc, { op: 'update_meta', tags: ['新'] });
    expect(next).toContain("tags: ['新']\r\n");
    expect(next).not.toContain("tags: ['旧']");
  });

  it('update_meta via applySettingMdActions round-trips (frontmatter-only edit leaves body)', () => {
    const result = applySettingMdActions(EXISTING_DOC, [
      { op: 'update_meta', linked_entities: ['char-protag', 'char-mentor'] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("linked_entities: ['char-protag', 'char-mentor']");
    expect(result.content).toContain('复活死者会招致诅咒。');
  });

  it('scalar quoting survives yaml-hostile content (colons / quotes / CJK)', () => {
    const doc = renderSettingMdDoc({ id: "it's: a #trap", source: 'agent' }, 'body');
    expect(doc).toContain("id: 'it''s: a #trap'");
  });
});
