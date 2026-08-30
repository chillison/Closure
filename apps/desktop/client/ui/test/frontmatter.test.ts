/**
 * dogfood R2 #109：front-matter 剥离/回拼 util（shared/utils/frontmatter.ts）。
 *
 * 契约核心：
 * - 捕获的 block 是命中原文的逐字节子串（CRLF 变体、缩进、注释、BOM 原样保留），
 *   绝不 parse→re-stringify——MarkdownEditor 的回拼靠它保序（`order:` 丢一字即章序崩坏）。
 * - split→restore 对任意输入是恒等还原（双射）；strip 对 restore 的结果幂等
 *   （编辑器受控 content 的稳定性依赖这一点）。
 * - 形状与 chapterDiskDerivation 旧私有 FRONTMATTER_RE 语义一致（含闭合 `---` 后
 *   换行或 EOF、开头 `---` 后容忍尾随空白），另并入 markdown.ts 旧 hasFrontMatter
 *   的 BOM 容忍。
 */
import { describe, expect, it } from 'vitest';
import {
  getFrontmatterBlock,
  getFrontmatterInner,
  restoreFrontmatter,
  splitFrontmatter,
  stripFrontmatter,
} from '../src/shared/utils/frontmatter';

describe('splitFrontmatter', () => {
  it('splits an LF front-matter block byte-exact', () => {
    const md = '---\norder: 0\ntitle: 第一章\n---\n\n# 第一章\n\n正文。';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe('---\norder: 0\ntitle: 第一章\n---\n');
    expect(body).toBe('\n# 第一章\n\n正文。');
  });

  it('preserves CRLF variants byte-exact', () => {
    const md = '---\r\norder: 2\r\n---\r\n# 标题\r\n';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe('---\r\norder: 2\r\n---\r\n');
    expect(body).toBe('# 标题\r\n');
  });

  it('keeps indentation, comments and mixed newlines inside the block untouched', () => {
    const block = '---\n# 注册元数据\n  order: 7\nnote: "a\tb"\n---\n';
    const md = block + '\nBody.';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe(block);
    expect(body).toBe('\nBody.');
  });

  it('accepts a closing --- at EOF without trailing newline', () => {
    const md = '---\norder: 1\n---';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe('---\norder: 1\n---');
    expect(body).toBe('');
  });

  it('detects a BOM-prefixed front-matter block (old markdown.ts tolerance)', () => {
    const md = '\uFEFF---\norder: 0\n---\n\nBody.';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe('\uFEFF---\norder: 0\n---\n');
    expect(body).toBe('\nBody.');
  });

  it('returns a null block and passthrough body when there is no front-matter', () => {
    expect(splitFrontmatter('')).toEqual({ frontmatter: null, body: '' });
    expect(splitFrontmatter('# Title\n\nBody.')).toEqual({ frontmatter: null, body: '# Title\n\nBody.' });
  });

  it('does not treat mid-document --- separators as front-matter (anchored at start)', () => {
    const md = 'Part one\n\n---\n\nPart two';
    expect(splitFrontmatter(md).frontmatter).toBeNull();
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('matches an empty block where the opening delimiter absorbs a blank line', () => {
    // Shape parity with the old chapterDiskDerivation regex: `---\s*\r?\n` may
    // consume trailing blank lines, so the inner capture can legitimately be ''.
    const md = '---\n\n---\nbody';
    const { frontmatter, body } = splitFrontmatter(md);
    expect(frontmatter).toBe('---\n\n---\n');
    expect(getFrontmatterInner(md)).toBe('');
    expect(body).toBe('body');
  });
});

describe('front-matter round-trip', () => {
  const cases = [
    '---\norder: 0\n---\n\n# 标题\n\n正文。',
    '---\r\norder: 12\r\n# 注释\r\n  indent: keep\r\n---\r\n\r\n# 标题\r\n',
    '---\norder: 3\n---',
    '---\n\n---\nbody',
    '\uFEFF---\norder: 0\n---\nbody',
    '# No front-matter\n\nBody.',
    '',
  ];

  it('restoreFrontmatter(split(t)) === t for every variant', () => {
    for (const text of cases) {
      const { frontmatter, body } = splitFrontmatter(text);
      expect(restoreFrontmatter(frontmatter, body)).toBe(text);
    }
  });

  it('strip is idempotent on restored output (controlled-editor content stability)', () => {
    for (const text of cases) {
      const { frontmatter } = splitFrontmatter(text);
      const restored = restoreFrontmatter(frontmatter, 'edited body\n');
      expect(stripFrontmatter(restored)).toBe('edited body\n');
    }
  });

  it('restoreFrontmatter(null, body) passes the body through', () => {
    expect(restoreFrontmatter(null, 'plain body')).toBe('plain body');
  });
});

describe('block/inner accessors', () => {
  it('getFrontmatterBlock returns the exact block or null', () => {
    expect(getFrontmatterBlock('---\norder: 0\n---\nbody')).toBe('---\norder: 0\n---\n');
    expect(getFrontmatterBlock('no front-matter')).toBeNull();
  });

  it('getFrontmatterInner returns the YAML text between delimiters (order parsing source)', () => {
    expect(getFrontmatterInner('---\norder: 42\n---\nbody')).toBe('order: 42');
    expect(getFrontmatterInner('no front-matter')).toBeNull();
  });
});
