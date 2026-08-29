/**
 * Story 6.1 builtin registration test — verifies the 4 new tools (query_cognition,
 * query_cognition_graph, info_release_map_read, info_release_map_update) register
 * with correct ids + param schemas (mirror world-state tool precedent).
 *
 * Uses the real registry singleton (vitest isolates module graph per test file,
 * so no cross-test pollution). registerBuiltinTools() registers tool definitions
 * (id/description/parameters/execute); registration is pure data — executeToolFn
 * is lazy (called at execute time, not registration).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';

// registerBuiltinTools is idempotent on the singleton (Map.set overwrites); call
// once at module load so all tests see the registered tools.
registerBuiltinTools();

describe('registerBuiltinTools — Story 6.1 cognition + info_release_map builtins', () => {
  it('registers query_cognition with characterSubjectId + optional at', () => {
    const tool = registry.get('query_cognition');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('query_cognition');

    const params = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({
      characterSubjectId: 'erina',
      at: 10,
    });
    expect(params.characterSubjectId).toBe('erina');
    expect(params.at).toBe(10);

    // at optional
    const noAt = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({
      characterSubjectId: 'erina',
    });
    expect(noAt.at).toBeUndefined();

    // missing characterSubjectId → throws (required)
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({ at: 10 }),
    ).toThrow();
  });

  it('registers query_cognition_graph with optional at', () => {
    const tool = registry.get('query_cognition_graph');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('query_cognition_graph');

    // at optional — empty object parses
    const params = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({});
    expect(params.at).toBeUndefined();

    const withAt = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({ at: 50 });
    expect(withAt.at).toBe(50);
  });

  it('registers info_release_map_read with optional sceneId/episodeId', () => {
    const tool = registry.get('info_release_map_read');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('info_release_map_read');

    const params = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({
      sceneId: 's_court',
      episodeId: 'ep1',
    });
    expect(params.sceneId).toBe('s_court');
    expect(params.episodeId).toBe('ep1');

    // both optional
    expect(() => (tool!.parameters as z.ZodType<unknown>).parse({})).not.toThrow();
  });

  it('registers info_release_map_update with bounded actions array (add_entry)', () => {
    const tool = registry.get('info_release_map_update');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('info_release_map_update');

    // add_entry carrying full entry (id + sceneRef required)
    const params = (tool!.parameters as z.ZodType<{ actions: unknown[] }>).parse({
      actions: [
        { op: 'add_entry', entry: { id: 'irm1', sceneRef: 's1', reveal: ['秘密'] } },
        { op: 'remove_entry', entryId: 'irm2' },
      ],
    });
    expect(params.actions).toHaveLength(2);

    // bogus op → throws (discriminated union rejects)
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({ actions: [{ op: 'bogus' }] }),
    ).toThrow();

    // add_entry missing sceneRef → throws
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({
        actions: [{ op: 'add_entry', entry: { id: 'x' } }],
      }),
    ).toThrow();
  });

  it('does NOT register any list_info_release_map alias (id must match shell handler)', () => {
    // The shell handler is registered as 'info_release_map_read' (mirror scene_graph_read).
    // The agent builtin id MUST equal the shell handler id (remoteToolProxy routes by id).
    // Ensure no stray 'list_info_release_map' registration diverges from the handler.
    expect(registry.get('list_info_release_map')).toBeUndefined();
    expect(registry.get('info_release_map_read')).toBeDefined();
  });
});
