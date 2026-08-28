/**
 * #75/W3 收口：因果边层的异线渐变着色（EdgeLayer 直测）。
 *
 * 规则三条（对齐 AssocLayer resolveAssocPaint 语义）：
 *   - 两端同 hue → 实色（类名承载 stroke，零 defs、零内联 style）；
 *   - 两端异 hue → 一枚 userSpaceOnUse linearGradient（轴=两端锚点，stop 挂
 *     `.lane-hue--c{n} .assoc-stop`）+ path 内联 stroke=url(#id)；
 *   - toHueIndex 缺省（旧构造点兼容）→ 回退 from hue = 纯色。
 *
 * 08-27 三轮 CR 追加：toHueIndex 消费前校验（edge V-9，非法值回退纯色防
 * `lane-hue--c{n}` 不存在的黑端）+ gradient id 真实碰撞构造（blind V-F5 +
 * edge V-7：旧转义非单射，"a.b" 与字面 "a_2e_b" 曾同码）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run edgeLayerGradient`
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EdgeLayer, buildEdgeArrowhead, type ResolvedEdge } from '../src/features/structure/EdgeLayer';
import { assocGradientId } from '../src/features/structure/AssocLayer';
import { LINE_PALETTE_SIZE } from '../src/features/structure/linePalette';

const pt = (x: number, y: number) => ({ x, y });

const edge = (id: string, fromHue: number, toHue?: number): ResolvedEdge => ({
  edgeId: id,
  type: 'CAUSAL',
  from: pt(10, 20),
  to: pt(210, 120),
  lineId: 'l-from',
  hueIndex: fromHue,
  ...(toHue !== undefined ? { toHueIndex: toHue } : {}),
});

afterEach(() => cleanup());

describe('EdgeLayer #75 gradient paint', () => {
  it('mixed-hue edge renders exactly one defs gradient with per-end stops and url stroke', () => {
    const { container } = render(
      <EdgeLayer edges={[edge('e1', 0, 5)]} width={400} height={300} />
    );
    const svg = container.querySelector('svg')!;
    const grads = svg.querySelectorAll('linearGradient');
    expect(grads).toHaveLength(1);
    const g = grads[0]!;
    // 渐变轴 = 两端实测锚点（userSpaceOnUse）。
    expect(g.getAttribute('gradientUnits')).toBe('userSpaceOnUse');
    expect(g.getAttribute('x1')).toBe('10');
    expect(g.getAttribute('y1')).toBe('20');
    expect(g.getAttribute('x2')).toBe('210');
    expect(g.getAttribute('y2')).toBe('120');
    const stops = g.querySelectorAll('stop');
    expect([...stops].map((s) => s.getAttribute('class'))).toEqual([
      'lane-hue--c0 assoc-stop',
      'lane-hue--c5 assoc-stop',
    ]);
    const path = svg.querySelector('path.narrative-edge')!;
    expect(path.getAttribute('style')).toContain('url(#');
    // data 锚（lineHover 聚焦面）不受渐变影响。
    expect(path.getAttribute('data-line-id')).toBe('l-from');
  });

  it('same-hue edge stays solid: no defs, no inline stroke', () => {
    const { container } = render(
      <EdgeLayer edges={[edge('e2', 3)]} width={400} height={300} />
    );
    const svg = container.querySelector('svg')!;
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(0);
    const path = svg.querySelector('path.narrative-edge')!;
    expect(path.getAttribute('style')).toBeNull();
    expect(path.className.baseVal).toContain('lane-hue--c3');
  });

  it('missing toHueIndex falls back to from hue (solid) and explicit null-ish pairs do not collide ids', () => {
    const { container } = render(
      <EdgeLayer
        edges={[edge('e3/a?x', 2), edge('e4', 4, 4)]}
        width={400}
        height={300}
      />
    );
    const svg = container.querySelector('svg')!;
    // 旧构造点缺 toHueIndex → 回退纯色；显式同 hue → 纯色。全程零 defs。
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(0);
    for (const p of svg.querySelectorAll('path.narrative-edge')) {
      expect(p.getAttribute('style')).toBeNull();
    }
  });

  it('edge V-9: invalid toHueIndex (out-of-range / negative / fractional) falls back to from hue (solid)', () => {
    // toHueIndex 是跨包契约上的自由 number——越界/小数会产出 lane-hue--c{n}
    // 不存在的 stop 类（该端黑掉）。回退 from hue = 纯色（与缺省路径同形态）。
    const { container } = render(
      <EdgeLayer
        edges={[
          edge('x1', 2, LINE_PALETTE_SIZE),      // 恰越上界
          edge('x2', 2, LINE_PALETTE_SIZE * 99), // 远越上界
          edge('x3', 2, -1),                     // 负值
          edge('x4', 2, 2.5),                    // 小数
        ]}
        width={400}
        height={300}
      />
    );
    const svg = container.querySelector('svg')!;
    expect(svg.querySelectorAll('linearGradient')).toHaveLength(0);
    for (const p of svg.querySelectorAll('path.narrative-edge')) {
      expect(p.getAttribute('style')).toBeNull();
    }
    // 合法界内值（0..SIZE-1）不受影响：恰上界-1 仍走渐变。
    const ok = render(
      <EdgeLayer edges={[edge('x5', 2, LINE_PALETTE_SIZE - 1)]} width={400} height={300} />
    );
    expect(ok.container.querySelector('linearGradient')).not.toBeNull();
  });

  it('blind V-F5 + edge V-7: real collision constructions get distinct ids and 1:1 url references', () => {
    // 旧转义非单射：`.`(0x2e) → "_2e_" 恰与字面 "a_2e_b" 同码 → 两条异色边共用
    // 一个 gradientId（React key 重复 + url(#…) 全局解析取首个 def，第二条边
    // 错画首色）。单射转义 + owner 域 + 渲染序后各引各自。
    const { container } = render(
      <EdgeLayer edges={[edge('a.b', 0, 5), edge('a_2e_b', 1, 6)]} width={400} height={300} />
    );
    const svg = container.querySelector('svg')!;
    const grads = [...svg.querySelectorAll('linearGradient')];
    expect(grads).toHaveLength(2);
    const ids = grads.map((g) => g.getAttribute('id'));
    expect(new Set(ids).size).toBe(2);
    // path 的 url 引用与 def id 一一对应（每个 def 恰被一条边引用——无双引错画）。
    const styles = [...svg.querySelectorAll('path.narrative-edge')].map((p) => p.getAttribute('style') ?? '');
    for (const id of ids) {
      expect(styles.filter((s) => s.includes(`url(#${id})`))).toHaveLength(1);
    }
    // 跨层域前缀：本层 id 恒以 assoc-grad-edge- 起头，与 AssocLayer 的 node 域
    // （assoc-grad-node-…）互斥——nodeId="edge-e1" 不再与本层种子撞名。
    expect(ids.every((id) => id.startsWith('assoc-grad-edge-'))).toBe(true);
    expect(assocGradientId('edge', 'e1', 0)).not.toBe(assocGradientId('node', 'edge-e1', 0));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T19（发现批9·因果方向可读）：判读者「谁导致谁」诉求的真正归属面——CAUSAL 实线
// 族终点箭头（手绘 path 形态；非 SVG marker——marker 内容不继承引用路径的 CSS
// 自定义属性，线色/渐变会断）。冻结契约：
//  - 仅 CAUSAL 加箭头；SUSPENSE 虚线族不加（悬念未揭示，方向语义弱）；自环略过
//    （弧形到达切线非 +x，箭头方向失义）。
//  - 箭头 fill 走线色 token（元素自带 lane-hue 类）；异线渐变边与线共用同一枚
//    userSpaceOnUse def（内联 fill=url(#id)，零第二 def——id 单射纪律不破）。
//  - 对照锚弧（AssocLayer）刻意不加箭头——配对语义 vs 因果语义的分工是用户拍板。
// ─────────────────────────────────────────────────────────────────────────────

describe('EdgeLayer T19 causal arrowheads', () => {
  it('CAUSAL edge gets a filled arrowhead path at the to endpoint (tip lands on to)', () => {
    const { container } = render(
      <EdgeLayer edges={[edge('a1', 0)]} width={400} height={300} />
    );
    const svg = container.querySelector('svg')!;
    const arrows = svg.querySelectorAll('.narrative-edge-arrowhead');
    expect(arrows).toHaveLength(1);
    const a = arrows[0]!;
    expect(a.getAttribute('d')).toBe(buildEdgeArrowhead(pt(210, 120)));
    // 身份挂 data-arrow-edge-id（data-edge-id 是「每渲染边恰一 path」契约锚，
    // 装饰路径不混入）。
    expect(a.getAttribute('data-arrow-edge-id')).toBe('a1');
    expect(a.getAttribute('data-edge-id')).toBeNull();
    // lane-hue 类自带（fill token 的局部变量解析面在元素自身）。
    expect(a.classList.contains('lane-hue--c0')).toBe(true);
    // 不挂 narrative-edge 类（其 fill:none 会杀三角填充）。
    expect(a.classList.contains('narrative-edge')).toBe(false);
    // marker 形态零使用（手绘 path 是定案载体）。
    expect(svg.querySelectorAll('marker')).toHaveLength(0);
  });

  it('SUSPENSE edges stay arrow-less (suspense direction semantics weak)', () => {
    const { container } = render(
      <EdgeLayer edges={[{ ...edge('s1', 1), type: 'SUSPENSE' }]} width={400} height={300} />
    );
    expect(container.querySelector('.narrative-edge-arrowhead')).toBeNull();
  });

  it('self-loop causal edge renders no arrowhead (arc arrival tangent breaks the +x convention)', () => {
    const loop: ResolvedEdge = { ...edge('l1', 0), to: pt(10, 20) }; // from === to
    const { container } = render(<EdgeLayer edges={[loop]} width={400} height={300} />);
    expect(container.querySelector('.narrative-edge-arrowhead')).toBeNull();
  });

  it('gradient CAUSAL edge: arrowhead rides the SAME url(#id) fill — no second def', () => {
    const { container } = render(
      <EdgeLayer edges={[edge('g1', 0, 5)]} width={400} height={300} />
    );
    const a = container.querySelector('.narrative-edge-arrowhead') as SVGElement;
    expect(a.getAttribute('style')).toContain('url(#');
    // 箭头与线共用同一枚渐变 def（userSpaceOnUse 在箭头坐标处即取终端色）。
    expect(container.querySelectorAll('linearGradient')).toHaveLength(1);
    const urlOf = (style: string | null) => style?.match(/url\(#([^)]+)\)/)?.[1];
    const lineId = urlOf((container.querySelector('path.narrative-edge') as SVGElement).getAttribute('style'));
    const arrowId = urlOf(a.getAttribute('style'));
    expect(arrowId).toBe(lineId);
  });

  it('arrow count tracks CAUSAL edges only (mixed batch)', () => {
    const { container } = render(
      <EdgeLayer
        edges={[edge('c1', 0), { ...edge('s2', 1), type: 'SUSPENSE' }, edge('c3', 2)]}
        width={400}
        height={300}
      />
    );
    expect(container.querySelectorAll('.narrative-edge-arrowhead')).toHaveLength(2);
  });

  it('buildEdgeArrowhead is a pure rightward triangle anchored at the endpoint', () => {
    expect(buildEdgeArrowhead(pt(100, 50))).toBe('M 92 46.5 L 100 50 L 92 53.5 Z');
    // 确定性：同输入同串。
    expect(buildEdgeArrowhead(pt(100, 50))).toBe(buildEdgeArrowhead(pt(100, 50)));
  });
});
