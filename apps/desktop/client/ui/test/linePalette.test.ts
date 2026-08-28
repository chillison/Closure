/**
 * 08-26 结构页重构 批 1（implement 1.1）：线身份色板 12 hue 纯函数测试。
 *
 * linePalette.ts 是「线 id → 色板下标」的单源（djb2 hash % 12）——锁定三件事：
 *   1. 稳定绑定：同 id 恒同 hue（跨渲染/跨会话/换机不漂移，design §4）。
 *   2. 循环契约：下标恒在 [0, 12)，LINE_PALETTE_SIZE 与 structure.css
 *      --viz-line-0..11 互为镜像。
 *   3. 分布 sanity：不同 id 不塌缩到单一 hue（djb2 对短 id 族足够散）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run linePalette`
 */
import { describe, expect, it } from 'vitest';
import {
  LINE_PALETTE_SIZE,
  hashLineId,
  lineHueIndex,
} from '../src/features/structure/linePalette';

describe('linePalette（08-26 批 1.1：12 hue 等响度线色板）', () => {
  it('色板大小 = 12（镜像 structure.css --viz-line-0..11——改一处须同步另一处）', () => {
    expect(LINE_PALETTE_SIZE).toBe(12);
  });

  it('同线 id 恒同 hue 下标，且恒在 [0, 12) 内（稳定绑定 + 无越界类名）', () => {
    const ids = ['l1', 'l2', '主线', '感情线·同桌', 'line-000', 'x'.repeat(80), ''];
    for (const id of ids) {
      const idx = lineHueIndex(id);
      expect(lineHueIndex(id)).toBe(idx); // 稳定：重复调用同值
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LINE_PALETTE_SIZE); // 越界 = --viz-line-N 不存在 → 块透明
    }
  });

  it('djb2 hash 非负（|0 位溢出的长/高位字符串不产生负下标）', () => {
    const adversarial = ['氷'.repeat(40), String.fromCharCode(0xffff).repeat(16), 'z'.repeat(1000)];
    for (const id of adversarial) {
      expect(hashLineId(id)).toBeGreaterThanOrEqual(0);
      expect(lineHueIndex(id)).toBeGreaterThanOrEqual(0);
    }
  });

  it('CR 组1 #124a：确定性属性 battery——任意 id 下标恒为 [0,12) 内整数（符号泄漏归一护栏）', () => {
    // 伪随机（LCG 固定种子，套件确定性）生成含 BMP 外字符 / 长串 / 全数字的
    // 病态 id 语料。当前 djb2+Math.abs 对 double 恒非负；本锁守卫的是未来 hash
    // 重调（如位运算 abs 变体——INT32_MIN 在其中保持负值）时 lineHueIndex 的
    // 对称归一化取模仍把下标收敛回板内（永不产出 `lane-hue--c-3` 式不存在类名）。
    let seed = 0x9e3779b9;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) | 0;
      return seed >>> 0;
    };
    const sample = (len: number, base: number) =>
      Array.from({ length: len }, () => String.fromCodePoint(base + (next() % 200))).join('');
    const corpus = [
      ...Array.from({ length: 400 }, () => sample(1 + (next() % 60), 0x4e00)),
      ...Array.from({ length: 100 }, () => sample(120, 0xd800 - 512)),   // 代理区附近
      ...Array.from({ length: 50 }, () => `${next()}`.repeat(1 + (next() % 40))),
    ];
    for (const id of corpus) {
      const idx = lineHueIndex(id);
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(LINE_PALETTE_SIZE);
      expect(lineHueIndex(id)).toBe(idx); // 同语料内重复调用恒同值（稳定绑定）
    }
  });

  it('下标 = hash % 12（循环契约：>12 线色相循环，位次为主识别）', () => {
    for (const id of ['l1', 'l2', 'l3', '主线', 'a']) {
      expect(lineHueIndex(id)).toBe(hashLineId(id) % LINE_PALETTE_SIZE);
    }
  });

  it('不同线 id 分散到多个 hue（分布 sanity：不塌缩单色）', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 64; i++) seen.add(lineHueIndex(`line-${i}`));
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});
