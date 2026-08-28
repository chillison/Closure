/**
 * 08-26 结构页重构 批 1（implement 1.1 / design §4）：线身份色板——12 hue 等响度循环。
 *
 * 色相稳定绑定线 id（hash(id) % 12）：换机、换线序、泳道重排都不漂移。线身份识别
 * 「泳道位次为主、色相为辅」（mockup v1.5 拍板）；超 12 线色相循环。
 *
 * 色值单源在 structure.css `--viz-line-0..11`（:root 亮主题 + [data-theme='dark']
 * 暗主题分支，同 S 只转 H 的等响度族——本文件不持有色值，只做「线 id → 色板下标」
 * 的确定性映射）。LINE_PALETTE_SIZE 与 CSS 变量数量互为镜像，改一处须同步另一处。
 *
 * 纯函数（无 React/IO）——jsdom 可精确断言稳定性 / 循环 / 分布。
 */

/** 色板大小。镜像 structure.css `--viz-line-0..11`（12 个）。 */
export const LINE_PALETTE_SIZE = 12;

/**
 * djb2 字符串 hash——稳定入口（同 id 恒同值，跨渲染/跨会话）。自 TimelineMinimap
 * 迁入（08-26 批 1 色板扩容时上移为线色板单源；Math.abs 吞掉 |0 溢出的负值）。
 */
export function hashLineId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * 线 id → 色板下标（hue 索引）。类消费位以 `--c{n}` 后缀映射到 `--viz-line-n`
 * （minimap 块 `minimap-block--c{n}`；批 2+ 的泳道左条/卡左条/chip 边框同款接入）。
 *
 * CR 组1 #124a（数值边界护栏）：对称归一化取模——即使未来 hash 实现改动让返回值
 * 滑进负 int32 域（Math.abs 对 double 其实恒非负，真正的符号泄漏类是
 * `(h ^ (h>>31)) - (h>>31)` 式位运算 abs 变体——INT32_MIN 在其中保持负值），下标
 * 仍收敛回 [0, SIZE)，不会产出 `lane-hue--c-3` 这类不存在的类名。对现有 abs 实现
 * 零行为差异（恒走第一分支）。
 */
export function lineHueIndex(lineId: string): number {
  const idx = hashLineId(lineId) % LINE_PALETTE_SIZE;
  return idx < 0 ? idx + LINE_PALETTE_SIZE : idx;
}
