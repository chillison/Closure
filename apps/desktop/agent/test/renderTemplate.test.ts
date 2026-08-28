import { describe, expect, it, vi } from 'vitest';
import { renderTemplate } from '../src/prompt/template';
import { logger } from '../src/logger';

// ─────────────────────────────────────────────────────────────────────────────
// Story 4.0 §4.5 / implement.md 1.2：renderTemplate（yaml user 段 {{var}} 渲染）。
// 纯函数 -> plain vitest。覆盖：替换 / missing var→空串+warn / 多 var / 嵌套 {{a}}{{b}} /
// {{key}} 无空格 / 显式空串值不 warn。
// ─────────────────────────────────────────────────────────────────────────────

describe('renderTemplate（yaml user 段 {{var}} 替换）', () => {
  it('替换命中的 var', () => {
    expect(renderTemplate('Hello {{name}}!', { name: 'Closure' })).toBe('Hello Closure!');
  });

  it('多 var 同模板替换', () => {
    const out = renderTemplate('{{pov}} / {{tone}} / {{pacing}}', {
      pov: '主角第三人称限知',
      tone: '冷峻',
      pacing: '推进',
    });
    expect(out).toBe('主角第三人称限知 / 冷峻 / 推进');
  });

  it('嵌套相邻 {{a}}{{b}} 都替换（无分隔）', () => {
    expect(renderTemplate('{{a}}{{b}}', { a: 'X', b: 'Y' })).toBe('XY');
  });

  it('同一 var 多次出现都替换', () => {
    expect(renderTemplate('{{x}}-{{x}}-{{x}}', { x: 'A' })).toBe('A-A-A');
  });

  it('无占位符的模板原样返回', () => {
    expect(renderTemplate('no vars here', {})).toBe('no vars here');
  });

  it('missing var → 空串 + logger.warn（不抛、不残留字面 {{...}}）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const out = renderTemplate('Hello {{missing}}!', { name: 'x' });
    expect(out).toBe('Hello !');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('{{');
    warnSpy.mockRestore();
  });

  it('多个 missing var 各 warn 一次', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    renderTemplate('{{a}}{{b}}{{c}}', {});
    expect(warnSpy).toHaveBeenCalledTimes(3);
    warnSpy.mockRestore();
  });

  it('显式空串值替换为空（provided 不 warn）', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(renderTemplate('[{{x}}]', { x: '' })).toBe('[]');
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('{{ key }}（带空格）不替换——yaml 约定无空格 {{var}}（design §4.5 信实）', () => {
    // \w+ 不匹配空格 -> 带空格的 {{ key }} 保持字面（不残留为部分替换）
    expect(renderTemplate('{{ key }}', { key: 'V' })).toBe('{{ key }}');
  });

  it('纯函数确定性：同输入两次调用结果相同', () => {
    const tpl = '{{a}} and {{b}}';
    const vars = { a: '1', b: '2' };
    expect(renderTemplate(tpl, vars)).toBe(renderTemplate(tpl, vars));
  });
});
