import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('agent session mode API', () => {
  beforeEach(() => {
    (window as any).orisonDesktop = {
      createAgentSession: vi.fn(async (input) => ({
        id: 's1',
        agentName: input.agentName,
        projectPath: input.projectPath,
        status: 'idle',
        messages: [],
      })),
    };
    vi.resetModules();
  });

  it('sends permission mode separately from agentName', async () => {
    const { createAgentSession } = await import('../src/shared/api/agent');
    // CR-009: no stale null placeholder — the retired modelRef parameter left
    // no slot to fill; later params (behaviorMode/participationGear) default.
    await createAgentSession('I:/project', 'readonly');

    expect((window as any).orisonDesktop.createAgentSession).toHaveBeenCalledWith({
      agentName: 'writer',
      projectPath: 'I:/project',
      mode: 'readonly',
      // Story 3.1: behaviorMode defaults to 'normal' when omitted.
      behaviorMode: 'normal',
    });
  });
});
