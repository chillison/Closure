/**
 * Story 3.6 WP6 builtin registration test — verifies the parse_document tool
 * registers with correct id + param schema (mirror builtin-fetch.test.ts).
 *
 * Tool IDs MUST match the shell handler registration (toolExecution.ts:
 * register('parse_document', parseDocumentHandlers.parseDocumentHandler)) —
 * remoteToolProxy routes by id. This test asserts the agent-side ids + zod
 * surface + the LLM-facing semantics in the description (supported formats /
 * endpoint-first + builtin fallback / scanned → analyze_image steering /
 * project-relative filePath constraint) + the read classification.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { classifyTool } from '../src/runtime/toolPolicy';

registerBuiltinTools();

describe('registerBuiltinTools — Story 3.6 WP6 parse_document builtin', () => {
  it('registers parse_document with required filePath + optional maxChars', () => {
    const tool = registry.get('parse_document');
    expect(tool).toBeDefined();
    expect(tool!.id).toBe('parse_document');

    const parse = tool!.parameters as z.ZodType<Record<string, unknown>>;
    const params = parse.parse({ filePath: 'research/设定集.pdf', maxChars: 8000 });
    expect(params.filePath).toBe('research/设定集.pdf');
    expect(params.maxChars).toBe(8000);

    // maxChars optional — bare filePath parses
    expect(() => parse.parse({ filePath: 'a.docx' })).not.toThrow();

    // filePath required — missing it rejects (LLM sees a schema error, not a silent default)
    expect(() => parse.parse({})).toThrow();
    expect(() => parse.parse({ maxChars: 1000 })).toThrow();
  });

  it('description carries the LLM-facing semantics (formats / fallback / scanned / 截断)', () => {
    const tool = registry.get('parse_document')!;
    expect(tool.description).toContain('PDF');
    expect(tool.description).toContain('DOCX');
    expect(tool.description).toContain('TXT');
    expect(tool.description).toContain('MD');
    expect(tool.description).toContain('端点');
    expect(tool.description).toContain('降级');
    expect(tool.description).toContain('扫描件');
    expect(tool.description).toContain('analyze_image');
    expect(tool.description).toContain('项目内相对路径');
    expect(tool.description).toContain('32000');
  });

  it('classifies as read (readonly/suggest/auto all可用 — pure parse, no side effects)', () => {
    expect(classifyTool('parse_document')).toBe('read');
  });
});
