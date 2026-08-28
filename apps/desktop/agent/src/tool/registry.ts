import type { ToolDefinition } from '../types';

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  get(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  ids(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Test-only reset for this module singleton (mirror of the UI layer's
   * `__clearProjectResets` helper). Wiring tests call it in beforeEach so the
   * chain e2e "registry empty → draft-writer legacy direct-write" path and the
   * "registerBuiltinTools → two-phase" path are each assembled from an explicit
   * registry state instead of depending on describe execution order.
   */
  __clearForTest(): void {
    this.tools.clear();
  }
}

export const registry = new ToolRegistry();
