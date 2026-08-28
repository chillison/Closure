import { describe, expect, it } from 'vitest';
import { parseCraftMd, extractCraftName, deriveCraftId } from '../main/db/craftMd';

describe('parseCraftMd (Story 2.1)', () => {
  it('parses frontmatter + body (markdown content after the closing ---)', () => {
    const doc = `---
id: shuangdian-catalog
craft_type: shuangdian
tags: [网文, 爽点, 先抑后扬]
source: wj-stup+本地笔记
---
# 爽点目录
正文内容 line 1
正文内容 line 2`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter.id).toBe('shuangdian-catalog');
    expect(frontmatter.craft_type).toBe('shuangdian');
    expect(frontmatter.tags).toEqual(['网文', '爽点', '先抑后扬']);
    expect(frontmatter.source).toBe('wj-stup+本地笔记');
    expect(body).toContain('# 爽点目录');
    expect(body).toContain('正文内容 line 1');
  });

  it('returns empty frontmatter + full body when no frontmatter block', () => {
    const doc = `# Just a title\nbody text`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter).toEqual({});
    expect(body).toBe('# Just a title\nbody text');
  });

  it('degrades (not drops) on malformed YAML frontmatter - body still indexed', () => {
    const doc = `---
id: broken
  bad: : :
---
# Body`;
    const { frontmatter, body } = parseCraftMd(doc);
    // Malformed YAML -> frontmatter empty (no throw), body preserved.
    expect(frontmatter.id).toBeUndefined();
    expect(body).toContain('# Body');
  });

  it('tolerates a comma-separated tags string (not just a flow sequence)', () => {
    const doc = `---
craft_type: playbook
tags: 都市, 玄幻, 科幻
---
# body`;
    const { frontmatter } = parseCraftMd(doc);
    expect(frontmatter.tags).toEqual(['都市', '玄幻', '科幻']);
  });

  it('handles CRLF line endings in the frontmatter delimiter', () => {
    const doc = `---\r\ncraft_type: qiaoduan\r\n---\r\n# body`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter.craft_type).toBe('qiaoduan');
    expect(body).toContain('# body');
  });

  it('omits tags when the field is absent (undefined, not empty array)', () => {
    const { frontmatter } = parseCraftMd(`---\ncraft_type: x\n---\n# b`);
    expect(frontmatter.tags).toBeUndefined();
  });

  // ── Story 8.7 R2：frontmatter summary 透传解析（策展简述通道）──
  it('parses a curated one-line summary from frontmatter (trims surrounding whitespace)', () => {
    const { frontmatter } = parseCraftMd(`---\ncraft_type: shuangdian\nsummary: 爽点先抑后扬的节奏手册  \n---\n# b`);
    expect(frontmatter.summary).toBe('爽点先抑后扬的节奏手册');
  });

  it('omits summary when absent or whitespace-only (undefined, not empty string)', () => {
    const absent = parseCraftMd(`---\ncraft_type: x\n---\n# b`).frontmatter;
    expect(absent.summary).toBeUndefined();
    const blank = parseCraftMd(`---\ncraft_type: x\nsummary:   \n---\n# b`).frontmatter;
    expect(blank.summary).toBeUndefined();
  });

  it('CR-craft-kb-004: strips a UTF-8 BOM before the frontmatter fence', () => {
    // Build with String.fromCodePoint so the source has no literal BOM (which
    // eslint's no-irregular-whitespace would flag).
    const BOM = String.fromCodePoint(0xfeff);
    const doc = `${BOM}---\ncraft_type: shuangdian\n---\n# 爽点目录\n正文`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter.craft_type).toBe('shuangdian');
    expect(body).toContain('# 爽点目录');
    expect(body).not.toContain(BOM);
  });

  it('CR-craft-kb-004: tolerates leading blank lines / whitespace before the --- fence', () => {
    const doc = `\n\n   ---\ncraft_type: qiaoduan\n---\n# 桥段\nbody`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter.craft_type).toBe('qiaoduan');
    expect(body).toContain('# 桥段');
  });

  it('CR-craft-kb-004: BOM + leading blank line before fence still detects frontmatter', () => {
    const BOM = String.fromCodePoint(0xfeff);
    const doc = `${BOM}\n---\ncraft_type: jiezou\n---\n# 节奏\n黄金300字`;
    const { frontmatter, body } = parseCraftMd(doc);
    expect(frontmatter.craft_type).toBe('jiezou');
    expect(body).toContain('黄金300字');
  });
});

describe('extractCraftName (Story 2.1)', () => {
  it('returns the first H1 heading text', () => {
    expect(extractCraftName('intro\n# 爽点目录\nbody')).toBe('爽点目录');
    expect(extractCraftName('# Title\nbody')).toBe('Title');
  });

  it('returns null when no H1 is present', () => {
    expect(extractCraftName('body without heading')).toBeNull();
    expect(extractCraftName('## h2 only')).toBeNull();
  });
});

describe('deriveCraftId (Story 2.1)', () => {
  it('prefers frontmatter id when present', () => {
    expect(deriveCraftId('anything.md', { id: 'stable-id' })).toBe('stable-id');
  });

  it('falls back to filename without .md extension when no frontmatter id', () => {
    expect(deriveCraftId('爽点目录.md', {})).toBe('爽点目录');
    expect(deriveCraftId('craft-pattern.md', {})).toBe('craft-pattern');
  });

  it('trims frontmatter id whitespace', () => {
    expect(deriveCraftId('x.md', { id: '  spaced  ' })).toBe('spaced');
  });

  it('CR-craft-kb-007: a `.md` filename with no frontmatter id derives to empty string', () => {
    expect(deriveCraftId('.md', {})).toBe('');
    expect(deriveCraftId('   .md', {})).toBe('');
  });

  it('CR-craft-kb-007: whitespace-only frontmatter id falls back to (empty) filename slug', () => {
    // frontmatter id is whitespace -> fm.id.trim() is falsy -> filename path.
    // A `.md` filename then derives to ''.
    expect(deriveCraftId('.md', { id: '   ' })).toBe('');
  });
});
