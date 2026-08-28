/**
 * Story 3.6 WP5 builtin registration test — verifies the web_fetch +
 * render_page tools register with correct ids + param schemas (mirror
 * builtin-web-search.test.ts).
 *
 * Tool IDs MUST match the shell handler registration (toolExecution.ts:
 * register('web_fetch', ...) + register('render_page', ...)) — remoteToolProxy
 * routes by id. This test asserts the agent-side ids + zod surface + the
 * LLM-facing semantics in the descriptions (content-type dispatch / hand-off
 * hints; dual-channel render capture + the "web_fetch 更省" guidance).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool } from '../src/runtime/toolPolicy';

registerBuiltinTools();

describe('registerBuiltinTools — Story 3.6 WP5 web_fetch builtin', () => {
  it('registers web_fetch with required url + optional maxChars', () => {
    const tool = registry.get('web_fetch');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('web_fetch');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ url: 'https://example.com/a', maxChars: 8000 });
    expect(params.url).toBe('https://example.com/a');
    expect(params.maxChars).toBe(8000);

    // maxChars optional — bare url parses
    expect(() => parse.parse({ url: 'https://example.com/a' })).not.toThrow();

    // url required — missing it rejects (LLM sees a schema error, not a silent default)
    expect(() => parse.parse({})).toThrow();
  });

  it('description carries the content-type dispatch + hand-off semantics (LLM-facing)', () => {
    const tool = registry.get('web_fetch')!;
    expect(tool.description).toContain('Markdown');
    expect(tool.description).toContain('parse_document');
    expect(tool.description).toContain('analyze_image');
    expect(tool.description).toContain('来源 URL');
  });

  it('classifies as read (readonly/suggest/auto all可用 — pure fetch, no side effects)', () => {
    expect(classifyTool('web_fetch')).toBe('read');
  });
});

describe('registerBuiltinTools — Story 3.6 WP5 render_page builtin', () => {
  it('registers render_page with required url + optional expandCollapsibles/includeText', () => {
    const tool = registry.get('render_page');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('render_page');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ url: 'https://scp-wiki-cn.wikidot.com/scp-173', expandCollapsibles: true, includeText: false });
    expect(params.url).toBe('https://scp-wiki-cn.wikidot.com/scp-173');
    expect(params.expandCollapsibles).toBe(true);
    expect(params.includeText).toBe(false);

    // both flags optional — bare url parses
    expect(() => parse.parse({ url: 'https://example.com/' })).not.toThrow();

    // url required — missing it rejects
    expect(() => parse.parse({})).toThrow();
  });

  it('description carries the dual-channel + when-to-use semantics (LLM-facing)', () => {
    const tool = registry.get('render_page')!;
    expect(tool.description).toContain('截图');
    expect(tool.description).toContain('analyze_image');
    expect(tool.description).toContain('web_fetch');
    expect(tool.description).toContain('折叠块');
  });

  it('classifies as read (readonly/suggest/auto all可用)', () => {
    expect(classifyTool('render_page')).toBe('read');
  });
});
