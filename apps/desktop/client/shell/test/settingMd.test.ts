import { describe, expect, it } from 'vitest';
import { parseSettingMd, extractSettingName, deriveSettingId } from '../main/db/settingMd';

describe('parseSettingMd (Story 2.3)', () => {
  it('parses frontmatter + body (markdown content after the closing ---)', () => {
    const doc = `---
id: magic-system
type: magic_system
tags: [魔法, 代价, 禁忌]
linked_entities: [char-protag, item-staff]
source: 用户笔记
---
# 魔法体系
正文内容 line 1
正文内容 line 2`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter.id).toBe('magic-system');
    expect(frontmatter.type).toBe('magic_system');
    expect(frontmatter.tags).toEqual(['魔法', '代价', '禁忌']);
    expect(frontmatter.linked_entities).toEqual(['char-protag', 'item-staff']);
    expect(frontmatter.source).toBe('用户笔记');
    expect(body).toContain('# 魔法体系');
    expect(body).toContain('正文内容 line 1');
  });

  it('returns empty frontmatter + full body when no frontmatter block', () => {
    const doc = `# Just a title\nbody text`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a title\nbody text');
  });

  it('degrades (not drops) on malformed YAML frontmatter - body still indexed', () => {
    const doc = `---
id: broken
  bad: : :
---
# Body`;
    const { frontmatter, body } = parseSettingMd(doc);
    // Malformed YAML -> frontmatter empty (no throw), body preserved.
    expect(frontmatter.id).toBeUndefined();
    expect(body).toContain('# Body');
  });

  it('tolerates a comma-separated tags string (not just a flow sequence)', () => {
    const doc = `---
type: faction
tags: 都市, 玄幻, 科幻
---
# body`;
    const { frontmatter } = parseSettingMd(doc);
    expect(frontmatter.tags).toEqual(['都市', '玄幻', '科幻']);
  });

  it('tolerates a comma-separated linked_entities string', () => {
    const doc = `---
type: location_lore
linked_entities: char-a, char-b
---
# body`;
    const { frontmatter } = parseSettingMd(doc);
    expect(frontmatter.linked_entities).toEqual(['char-a', 'char-b']);
  });

  it('handles CRLF line endings in the frontmatter delimiter', () => {
    const doc = `---\r\ntype: magic_system\r\n---\r\n# body`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter.type).toBe('magic_system');
    expect(body).toContain('# body');
  });

  it('omits tags / linked_entities when absent (undefined, not empty array)', () => {
    const { frontmatter } = parseSettingMd(`---\ntype: x\n---\n# b`);
    expect(frontmatter.tags).toBeUndefined();
    expect(frontmatter.linked_entities).toBeUndefined();
  });

  // ── Story 8.7 R2：frontmatter summary 透传解析（策展简述通道）──
  it('parses a curated one-line summary from frontmatter (trims surrounding whitespace)', () => {
    const { frontmatter } = parseSettingMd(`---\ntype: magic_system\nsummary: 以代价驱动的硬魔法体系  \n---\n# b`);
    expect(frontmatter.summary).toBe('以代价驱动的硬魔法体系');
  });

  it('omits summary when absent or whitespace-only (undefined, not empty string)', () => {
    const absent = parseSettingMd(`---\ntype: x\n---\n# b`).frontmatter;
    expect(absent.summary).toBeUndefined();
    const blank = parseSettingMd(`---\ntype: x\nsummary:   \n---\n# b`).frontmatter;
    expect(blank.summary).toBeUndefined();
  });

  it('CR-craft-kb-004 (mirrored): strips a UTF-8 BOM before the frontmatter fence', () => {
    // Build with String.fromCodePoint so the source has no literal BOM (which
    // eslint's no-irregular-whitespace would flag).
    const BOM = String.fromCodePoint(0xfeff);
    const doc = `${BOM}---\ntype: magic_system\n---\n# 魔法体系\n正文`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter.type).toBe('magic_system');
    expect(body).toContain('# 魔法体系');
    expect(body).not.toContain(BOM);
  });

  it('CR-craft-kb-004 (mirrored): tolerates leading blank lines / whitespace before the --- fence', () => {
    const doc = `\n\n   ---\ntype: faction\n---\n# 势力\nbody`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter.type).toBe('faction');
    expect(body).toContain('# 势力');
  });

  it('CR-craft-kb-004 (mirrored): BOM + leading blank line before fence still detects frontmatter', () => {
    const BOM = String.fromCodePoint(0xfeff);
    const doc = `${BOM}\n---\ntype: world_rule\n---\n# 世界规则\n正文`;
    const { frontmatter, body } = parseSettingMd(doc);
    expect(frontmatter.type).toBe('world_rule');
    expect(body).toContain('世界规则');
  });

  it('filters non-string entries out of tags / linked_entities', () => {
    const doc = `---
type: x
tags: [valid, 123, null]
linked_entities: [char-a, true]
---
# b`;
    const { frontmatter } = parseSettingMd(doc);
    expect(frontmatter.tags).toEqual(['valid']);
    expect(frontmatter.linked_entities).toEqual(['char-a']);
  });
});

describe('extractSettingName (Story 2.3)', () => {
  it('returns the first H1 heading text', () => {
    expect(extractSettingName('intro\n# 魔法体系\nbody')).toBe('魔法体系');
    expect(extractSettingName('# Title\nbody')).toBe('Title');
  });

  it('returns null when no H1 is present', () => {
    expect(extractSettingName('body without heading')).toBeNull();
    expect(extractSettingName('## h2 only')).toBeNull();
  });
});

describe('deriveSettingId (Story 2.3)', () => {
  it('prefers frontmatter id when present', () => {
    expect(deriveSettingId('anything.md', { id: 'stable-id' })).toBe('stable-id');
  });

  it('falls back to filename without .md extension when no frontmatter id', () => {
    expect(deriveSettingId('魔法体系.md', {})).toBe('魔法体系');
    expect(deriveSettingId('magic-system.md', {})).toBe('magic-system');
  });

  it('trims frontmatter id whitespace', () => {
    expect(deriveSettingId('x.md', { id: '  spaced  ' })).toBe('spaced');
  });

  it('CR-craft-kb-007 (mirrored): a `.md` filename with no frontmatter id derives to empty string', () => {
    expect(deriveSettingId('.md', {})).toBe('');
    expect(deriveSettingId('   .md', {})).toBe('');
  });

  it('CR-craft-kb-007 (mirrored): whitespace-only frontmatter id falls back to (empty) filename slug', () => {
    // frontmatter id is whitespace -> fm.id.trim() is falsy -> filename path.
    // A `.md` filename then derives to ''.
    expect(deriveSettingId('.md', { id: '   ' })).toBe('');
  });
});
