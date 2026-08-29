/**
 * Story 3.6 WP4 builtin registration test — verifies the web_search tool
 * registers with the correct id + param schema (mirror builtin-wiki.test.ts).
 *
 * Tool ID MUST match the shell handler registration (toolExecution.ts:
 * register('web_search', ...)) — remoteToolProxy routes by id. This test
 * asserts the agent-side id + zod surface + the LLM-facing chain semantics in
 * the description (engine chain / zero-config / degrade).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool } from '../src/runtime/toolPolicy';

registerBuiltinTools();

describe('registerBuiltinTools — Story 3.6 WP4 web_search builtin', () => {
  it('registers web_search with required query + optional limit', () => {
    const tool = registry.get('web_search');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('web_search');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ query: '明日方舟 世界观', limit: 5 });
    expect(params.query).toBe('明日方舟 世界观');
    expect(params.limit).toBe(5);

    // limit optional — bare query parses
    expect(() => parse.parse({ query: 'x' })).not.toThrow();

    // query required — missing it rejects (LLM sees a schema error, not a silent default)
    expect(() => parse.parse({})).toThrow();
  });

  it('description carries the engine-chain / zero-config / degrade semantics (LLM-facing)', () => {
    const tool = registry.get('web_search')!;
    expect(tool.description).toContain('引擎');
    expect(tool.description).toContain('自动回退');
    expect(tool.description).toContain('零配置');
    expect(tool.description).toContain('标注来源引擎');
  });

  it('classifies as read (readonly/suggest/auto all可用 — pure query, no side effects)', () => {
    expect(classifyTool('web_search')).toBe('read');
  });
});
