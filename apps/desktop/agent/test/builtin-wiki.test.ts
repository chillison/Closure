/**
 * Story 3.6 WP3 builtin registration test — verifies the 2 wiki research tools
 * (wiki_search, wiki_read) register with correct ids + param schemas (mirror
 * 6.5 builtin-promise.test.ts precedent).
 *
 * Tool IDs MUST match the shell handler registration (toolExecution.ts:
 * register('wiki_search', ...) + register('wiki_read', ...)) — remoteToolProxy
 * routes by id. This test asserts the agent-side ids + zod surface.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';

registerBuiltinTools();

describe('registerBuiltinTools — Story 3.6 WP3 wiki builtins', () => {
  it('registers wiki_search with required query + optional site/limit', () => {
    const tool = registry.get('wiki_search');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('wiki_search');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ query: '阿米娅', site: 'moegirl-uk', limit: 5 });
    expect(params.query).toBe('阿米娅');
    expect(params.site).toBe('moegirl-uk');

    // site/limit optional — bare query parses
    expect(() => parse.parse({ query: '阿米娅' })).not.toThrow();

    // query required — missing it rejects (LLM sees a schema error, not a silent default)
    expect(() => parse.parse({})).toThrow();
  });

  it('registers wiki_read with required title + optional site', () => {
    const tool = registry.get('wiki_read');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('wiki_read');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ title: '阿米娅（明日方舟）', site: 'moegirl-cn' });
    expect(params.title).toBe('阿米娅（明日方舟）');

    expect(() => parse.parse({ title: '阿米娅' })).not.toThrow();
    expect(() => parse.parse({})).toThrow();
  });

  it('descriptions carry the site semantics + full-width-bracket guidance (LLM-facing)', () => {
    const search = registry.get('wiki_search')!;
    expect(search.description).toContain('前缀');
    expect(search.description).toContain('全文');
    expect(search.description).toContain('全角括号');

    const read = registry.get('wiki_read')!;
    expect(read.description).toContain('降级');
    expect(read.description).toContain('全角括号');
  });
});
