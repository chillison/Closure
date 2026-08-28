import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  YAML_AGENT_SLOT,
  resolveTaskModel,
  resolveTaskModelForAgent,
  setTaskSlotResolver,
} from '../src/runtime/taskModelRouting';
import { taskModelSlotSchema } from '@orison/shared-contracts';

// Module-level resolver state persists across tests in this file — reset so
// each test starts from the "nothing injected" default.
afterEach(() => {
  setTaskSlotResolver(undefined);
});

describe('runtime taskModelRouting resolver', () => {
  it('returns undefined for every slot when no resolver is injected (default = auto-pick)', () => {
    for (const slot of taskModelSlotSchema.options) {
      expect(resolveTaskModel(slot)).toBeUndefined();
    }
  });

  it('routes each configured slot through the injected resolver', () => {
    setTaskSlotResolver((slot) =>
      slot === 'writer-draft' ? { keyId: 'k1', modelId: 'heavy-model' } : undefined,
    );
    expect(resolveTaskModel('writer-draft')).toEqual({ keyId: 'k1', modelId: 'heavy-model' });
  });

  it('returns undefined when the resolver has no model configured for the slot', () => {
    setTaskSlotResolver(() => undefined);
    expect(resolveTaskModel('dialogue')).toBeUndefined();
  });

  it('setTaskSlotResolver(undefined) resets to the no-routing default', () => {
    setTaskSlotResolver(() => ({ keyId: 'k1', modelId: 'm' }));
    expect(resolveTaskModel('extraction')).toEqual({ keyId: 'k1', modelId: 'm' });
    setTaskSlotResolver(undefined);
    expect(resolveTaskModel('extraction')).toBeUndefined();
  });
});

describe('YAML_AGENT_SLOT dispatch table (design §5)', () => {
  it('maps the six dispatch-family agents to dispatch', () => {
    expect(YAML_AGENT_SLOT['story-planner-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['episode-planner-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['director-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['researcher-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['revision-optimizer-agent']).toBe('dispatch');
    expect(YAML_AGENT_SLOT['ripple-diagnosis-agent']).toBe('dispatch');
  });

  it('maps the semantic judges to review-judge', () => {
    expect(YAML_AGENT_SLOT['adjudicator-agent']).toBe('review-judge');
    expect(YAML_AGENT_SLOT['arc-audit-agent']).toBe('review-judge');
    expect(YAML_AGENT_SLOT['world-amender-agent']).toBe('review-judge');
    // 风格卡分析者（08-28 style-card-mvp A 路）——语义质量档：九遍扫描深分析，质量敏感。
    expect(YAML_AGENT_SLOT['style-analyzer-agent']).toBe('review-judge');
  });

  it('contains exactly the ten registered agents — every value is a legal slot', () => {
    const entries = Object.entries(YAML_AGENT_SLOT);
    expect(entries).toHaveLength(10);
    const legalSlots = new Set<string>(taskModelSlotSchema.options);
    for (const [name, slot] of entries) {
      expect(name.endsWith('-agent')).toBe(true);
      expect(legalSlots.has(slot)).toBe(true);
    }
  });

  it('leaves unknown agent names unmapped (undefined → no routing, auto-pick)', () => {
    // A yaml agent not in the table must not inherit a slot by accident —
    // the dispatch single point routes nothing for it.
    expect(YAML_AGENT_SLOT['retrieval-agent']).toBeUndefined();
    expect(YAML_AGENT_SLOT['inspiration-agent']).toBeUndefined();
  });

  it('unknown-name lookup yields undefined even with a resolver injected', () => {
    setTaskSlotResolver(() => ({ keyId: 'k1', modelId: 'm' }));
    // The wiring at workflow.ts dispatch single point guards on the lookup
    // before calling resolveTaskModel; an unmapped name therefore never
    // consults the resolver and the call routes nothing (auto-pick).
    expect(YAML_AGENT_SLOT['some-future-agent']).toBeUndefined();
  });

  it('resolveTaskModelForAgent: mapped name routes the slot, unknown name routes nothing', () => {
    setTaskSlotResolver((slot) => (slot === 'dispatch' ? { keyId: 'k1', modelId: 'd-model' } : undefined));
    expect(resolveTaskModelForAgent('director-agent')).toEqual({ keyId: 'k1', modelId: 'd-model' });
    // Unknown agent name never consults the resolver (spy stays uncalled).
    const spy = vi.fn(() => ({ keyId: 'k1', modelId: 'm' }));
    setTaskSlotResolver(spy);
    expect(resolveTaskModelForAgent('inspiration-agent')).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('CR-009: prototype-key names (toString/__proto__/constructor) hit "not registered", never an inherited property', () => {
    // YAML_AGENT_SLOT is a plain object — a naive `TABLE[name]` lookup would
    // resolve 'toString' to the inherited function and feed it to a slot cast.
    // Object.hasOwn must gate the lookup even with a resolver injected.
    setTaskSlotResolver((slot) => (slot === 'dispatch' ? { keyId: 'k1', modelId: 'd' } : undefined));
    expect(resolveTaskModelForAgent('toString')).toBeUndefined();
    expect(resolveTaskModelForAgent('__proto__')).toBeUndefined();
    expect(resolveTaskModelForAgent('constructor')).toBeUndefined();
  });

  it('AC4 / CR-012: a slot pointing at a disabled or deleted model passes through unchanged — transparency', () => {
    // The agent layer holds no key/enabled knowledge by design (ADR-2: config
    // lives in the shell). Whatever the resolver returns must reach generate
    // EXACTLY as-is — never silently rerouted — so the failure stays visible
    // where it belongs: shell resolveModel throws (pinned shell-side).
    const danglingRef = { keyId: 'key_gone', modelId: 'model-disabled' };
    setTaskSlotResolver(() => danglingRef);
    expect(resolveTaskModel('writer-draft')).toBe(danglingRef); // same reference, untouched
  });
});
