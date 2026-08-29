/**
 * Story 3.6 WP7/WP8 builtin registration test — verifies the analyze_image +
 * dispatch_researcher tools register with correct ids + param schemas (mirror
 * builtin-fetch.test.ts).
 *
 * Tool IDs MUST match the shell handler registration (toolExecution.ts:
 * register('analyze_image', ...)) — remoteToolProxy routes by id.
 * dispatch_researcher is a LOCAL tool (mirror diagnose_impacts) whose allowed
 * whitelist alignment is covered in dispatch-researcher.test.ts. This test
 * asserts the agent-side ids + zod surface + the LLM-facing semantics in the
 * descriptions (dual input / prompt guidance / manual-mode relay protocol /
 * 深研究 vs 快查判据 / 策展提醒).
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool } from '../src/runtime/toolPolicy';

registerBuiltinTools();

describe('registerBuiltinTools — Story 3.6 WP7 analyze_image builtin', () => {
  it('registers analyze_image with prompt required + imagePath/imageUrl either-or', () => {
    const tool = registry.get('analyze_image');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('analyze_image');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;

    // imagePath branch parses
    const local = parse.parse({ imagePath: '.orison/research-media/1.png', prompt: '识别图中文字' });
    expect(local.imagePath).toBe('.orison/research-media/1.png');

    // imageUrl branch parses
    expect(() => parse.parse({ imageUrl: 'https://example.com/a.png', prompt: '描述画面' })).not.toThrow();

    // neither source → rejected (refine either-or)
    expect(() => parse.parse({ prompt: '描述画面' })).toThrow();

    // prompt required → missing rejects
    expect(() => parse.parse({ imagePath: 'a.png' })).toThrow();
  });

  it('description carries the dual-input + prompt guidance + manual-mode semantics (LLM-facing)', () => {
    const tool = registry.get('analyze_image')!;
    expect(tool.description).toContain('imagePath');
    expect(tool.description).toContain('imageUrl');
    expect(tool.description).toContain('OCR 图中文字');
    expect(tool.description).toContain('手动模式');
    expect(tool.description).toContain('贴回对话');
  });

  it('classifies as read (readonly/suggest/auto all可用 — pure analysis, no side effects)', () => {
    expect(classifyTool('analyze_image')).toBe('read');
  });
});

describe('registerBuiltinTools — Story 3.6 WP8 dispatch_researcher builtin', () => {
  it('registers dispatch_researcher with researchQuestion required + four optional brief segments', () => {
    const tool = registry.get('dispatch_researcher');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('dispatch_researcher');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const brief = parse.parse({
      researchQuestion: '阿米娅的能力设定在不同版本有什么差异',
      creativeContext: '主角金手指选型',
      knownAndHypotheses: '已知罗德岛时期矿石病',
      constraints: '只认官方设定集',
      expectedOutput: '能力对照表',
    });
    expect(brief.researchQuestion).toContain('阿米娅');

    // optional segments omitted — bare question parses
    expect(() => parse.parse({ researchQuestion: 'X 与 Y 的区别' })).not.toThrow();

    // researchQuestion required
    expect(() => parse.parse({ creativeContext: 'x' })).toThrow();
  });

  it('description carries the 深研究 vs 快查判据 + 需要澄清 + 策展 semantics (LLM-facing)', () => {
    const tool = registry.get('dispatch_researcher')!;
    expect(tool.description).toContain('researcher');
    expect(tool.description).toContain('多源');
    expect(tool.description).toContain('需要澄清');
    expect(tool.description).toContain('save_craft_doc');
    expect(tool.description).toContain('asset_cards_update');
  });

  it('classifies as read (dispatch itself has no side effects; researcher whitelist is read-only)', () => {
    expect(classifyTool('dispatch_researcher')).toBe('read');
  });
});
