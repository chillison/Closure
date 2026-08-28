/**
 * Story 6.5 builtin registration test — verifies the 2 new tools (query_promise,
 * promise_ledger_update) register with correct ids + param schemas (mirror 6.1
 * builtin-cognition.test.ts precedent).
 *
 * Tool IDs MUST match the Phase C shell handler registration (toolExecution.ts:
 * register('query_promise', ...) + register('promise_ledger_update', ...)) —
 * remoteToolProxy routes by id. This test asserts the agent-side ids.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';

registerBuiltinTools();

describe('registerBuiltinTools — Story 6.5 promise_ledger builtins', () => {
  it('registers query_promise with optional sceneId/episodeId', () => {
    const tool = registry.get('query_promise');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('query_promise');

    const params = (tool!.parameters as z.ZodType<Record<string, unknown>>).parse({
      sceneId: 's_court',
      episodeId: 'ep1',
    });
    expect(params.sceneId).toBe('s_court');
    expect(params.episodeId).toBe('ep1');

    // both optional — empty object parses
    expect(() => (tool!.parameters as z.ZodType<unknown>).parse({})).not.toThrow();
  });

  it('registers promise_ledger_update with bounded actions array (add_promise)', () => {
    const tool = registry.get('promise_ledger_update');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('promise_ledger_update');

    // add_promise carrying full promise (id + title + summary required) + firstBeat
    const params = (tool!.parameters as z.ZodType<{ actions: unknown[] }>).parse({
      actions: [
        {
          type: 'add_promise',
          promise: {
            id: 'promise-king-tyranny',
            title: '国王暴君真相',
            summary: '读者误信国王是明君',
            category: 'setup_payoff',
          },
          firstBeat: {
            promiseId: 'promise-king-tyranny',
            sceneRef: 's_court',
            kind: 'plant',
            grounding: '国王露出慈祥微笑',
          },
        },
        {
          type: 'add_beat',
          beat: { promiseId: 'promise-existing', sceneRef: 's_tavern', kind: 'advance' },
        },
        { type: 'remove_promise', promiseId: 'promise-stale' },
        { type: 'remove_beat', beatId: 'beat-x' },
      ],
    });
    expect(params.actions).toHaveLength(4);

    // bogus type → throws (discriminated union rejects)
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({ actions: [{ type: 'bogus' }] }),
    ).toThrow();

    // add_promise missing required summary → throws
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({
        actions: [{ type: 'add_promise', promise: { id: 'x', title: '无 summary' } }],
      }),
    ).toThrow();

    // add_beat missing sceneRef → throws
    expect(() =>
      (tool!.parameters as z.ZodType<unknown>).parse({
        actions: [{ type: 'add_beat', beat: { promiseId: 'p', kind: 'plant' } }],
      }),
    ).toThrow();
  });

  it('promise_ledger_update accepts add_promise with defaulted fields (status/importance/source_type)', () => {
    const tool = registry.get('promise_ledger_update');
    // add_promise with minimal required fields — defaulted fields (status/importance/source_type/tags) optional.
    const params = (tool!.parameters as z.ZodType<{ actions: unknown[] }>).parse({
      actions: [
        {
          type: 'add_promise',
          promise: { id: 'p1', title: '测试 Promise', summary: '最小必填' },
        },
      ],
    });
    expect(params.actions).toHaveLength(1);
  });

  it('does NOT register stray alias (id must match shell handler)', () => {
    // The shell handler is registered as 'query_promise' / 'promise_ledger_update'.
    // Ensure no stray alias diverges from the handler ids.
    expect(registry.get('list_promise')).toBeUndefined();
    expect(registry.get('promise_read')).toBeUndefined();
    expect(registry.get('query_promise')).toBeDefined();
    expect(registry.get('promise_ledger_update')).toBeDefined();
  });
});
