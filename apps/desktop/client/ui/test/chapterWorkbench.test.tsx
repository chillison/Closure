/**
 * 08-26 结构页重构 批 3（implement 3.1-3.3）：ChapterWorkbench 渲染测试
 * （weavingPanel.test 的承接）。jsdom 量不出 max-content 列宽——本文件断言几何
 * 纯函数与渲染类/结构（坐标留批 4 AssocLayer 的 DOM 实测）。
 *
 * 覆盖：章列头（第 N 章）/ chip 圆号（readIndex+1）/ 倒叙钢蓝类 / span 类锚
 * + T10 续至徽记退役 / selected 外环（selectedNodeId 单源——与因果卡同公式同显）/
 * 待编排列灰态收纳 / 列模板 minmax(108px, max-content)（禁 min() 嵌套）/
 * ± 章编辑手势迁移（写通道 useWeavingEdit 不变）/ 无章时仅待编排列。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run chapterWorkbench`
 * (never repo-root npx vitest — jsdom env lost — testing-discipline)
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sceneGraphSchema, episodeOutlinesSchema, type SceneGraph } from '@orison/shared-contracts';
import { ChapterWorkbench } from '../src/features/structure/ChapterWorkbench';
import { StructurePage } from '../src/features/structure/StructurePage';
import { sharedColumnTracks, TIMELINE_GEOMETRY } from '../src/features/structure/timelineGeometry';
import { episodeTrackCountOf, PENDING_CHAPTER_SENTINEL, WORKBENCH_GEOMETRY } from '../src/features/structure/workbenchLayout';
import { MAX_SETTLE_ROUNDS } from '../src/features/structure/workbenchPacking';
import { useAppStore } from '../src/shared/store/appStore';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}
function parseEpisodes(raw: unknown) {
  return episodeOutlinesSchema.parse(raw);
}

const EPISODES = () =>
  parseEpisodes([
    { id: 'e0', index: 0, title: '被包围的转学生' },
    { id: 'e1', index: 1, title: '共犯约定' },
    { id: 'e2', index: 2, title: '突围' },
  ]);

/**
 * Fixture（4 线缩影）：主线 s1(倒叙) + s_cross(跨章 0-2) + s_plain；副线 s_side。
 * s1 storyTime 3 但阅读序 0（ch0/pos0）→ 倒叙；s_cross spans e0..e2 → 跨章。
 */
function workbenchGraph(): SceneGraph {
  return parseGraph({
    lines: [
      { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
      { id: 'l_side', name: '副线', topology_role: 'side' },
    ],
    nodes: [
      {
        id: 's1', lineTags: ['l_main'], storyTime: 3, role: 'fork-point',
        presentationOrder: { chapter: 0, pos: 0 }, title: '真相的边缘',
      },
      {
        id: 's_cross', lineTags: ['l_main'], storyTime: 1, role: 'core-anchor',
        presentationOrder: { chapter: 0, pos: 1 }, title: '放学路',
        presentationSpans: [{ episodeId: 'e0', pos: 1 }, { episodeId: 'e2', pos: 0 }],
      },
      {
        id: 's_plain', lineTags: ['l_main'], storyTime: 2, role: 'normal',
        presentationOrder: { chapter: 1, pos: 0 }, title: '共犯约定',
      },
      {
        id: 's_side', lineTags: ['l_side'], storyTime: 1, role: 'normal',
        presentationOrder: { chapter: 2, pos: 0 }, title: '副线场景',
      },
    ],
    edges: [],
  });
}

describe('ChapterWorkbench', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });
  afterEach(() => cleanup());

  it('renders chapter headers 第 N 章 (1-based ordinal) + the pending virtual column header', () => {
    const { container } = render(<ChapterWorkbench />);
    const headers = container.querySelectorAll('.workbench-col-header:not(.workbench-col-header--pending)');
    expect(headers).toHaveLength(3);
    expect(headers[0]?.getAttribute('data-col-index')).toBe('0');
    // en locale fixture → "Chapter 1"（1-based ordinal；raw index 落 data attr）。
    expect(headers[0]?.querySelector('.workbench-col-label')?.textContent).toContain('1');
    // 待编排虚拟列头常驻（design §2「常设」）。
    const pendingHeader = container.querySelector('.workbench-col-header--pending') as HTMLElement;
    expect(pendingHeader).not.toBeNull();
    expect(pendingHeader.getAttribute('data-col-index')).toBe('pending');
  });

  it('batch 7: grid rides the HOST tracks via subgrid — no self template; rows stay self-owned', () => {
    const { container } = render(<ChapterWorkbench />);
    const grid = container.querySelector('.workbench-grid') as HTMLElement;
    // 列模板 = subgrid 接轨（design §11 定案 2）——「同 template 字符串喂两个独立
    // grid」不成立（max-content 按各自内容解析），必须宿主唯一解。
    expect(grid.style.gridTemplateColumns).toBe('subgrid');
    // 行模板仍本组件自理（批 5 #42 / 批 6 #52 的 minmax 折行面）。
    // 批 5（#42）：卷带行轨道 minmax(22px, auto)；批 6（#52）：章列头行同改 minmax。
    expect(grid.style.gridTemplateRows).toBe('minmax(22px, auto) minmax(32px, auto) repeat(2, auto)');
    // 共享模板的逐列构成锁在单源函数上（timelineGeometry.test 锁字符串本体；
    // 此处只锁常量沿袭：待编排定宽 #46）。
    expect(WORKBENCH_GEOMETRY.pendingColumnWidth).toBe(220);
    expect(WORKBENCH_GEOMETRY.chapterMinWidth).toBe(108);
  });

  it('chip ordinal badge = readIndex+1; 倒叙 chip carries the steel-blue ordinal class', () => {
    const { container } = render(<ChapterWorkbench />);
    const s1 = container.querySelector('.workbench-chip[data-node-id="s1"]') as HTMLElement;
    expect(s1).not.toBeNull();
    // s1 reads first → 圆号 1；storyTime 3 ≠ 故事位次 → 倒叙（钢蓝类 + data-reordered）。
    expect(s1.querySelector('.workbench-chip-ord')?.textContent).toBe('1');
    expect(s1.getAttribute('data-read-index')).toBe('0');
    expect(s1.getAttribute('data-reordered')).toBe('true');
    expect(s1.querySelector('.workbench-chip-ord')?.classList.contains('workbench-chip-ord--reorder')).toBe(true);
    // 顺叙 chip：s_plain storyTime 2 / readIndex 2。08-27 组1-E 并列豁免语义下
    // 改判 true：它与同层 t1 的 s_side 构成跨层逆序（s_plain 读在前、因果更早的
    // s_side 读在后，反之亦然）——旧「稠密位次巧合一致→false」是位次碰撞假象，
    // 非无位移。（并列豁免本身：同 storyTime 成员互相不再误判。）
    const sPlain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(sPlain.getAttribute('data-reordered')).toBe('true');
    expect(sPlain.querySelector('.workbench-chip-ord')?.classList.contains('workbench-chip-ord--reorder')).toBe(true);
  });

  it('cross-chapter chip: span 类锚保留；T10 续至徽记退役（宽卡形态本身即表达）', () => {
    const { container } = render(<ChapterWorkbench />);
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    expect(cross.classList.contains('workbench-chip--span')).toBe(true);
    // T10（发现批5）：「续至第 N 章」徽记删除——跨章跨度不再文字复述。
    expect(cross.querySelector('.workbench-chip-cont')).toBeNull();
    // 单章 chip 无 span 类（对照）。
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.classList.contains('workbench-chip--span')).toBe(false);
    expect(plain.querySelector('.workbench-chip-cont')).toBeNull();
  });

  it('selected chip gets the outline class from the shared selectedNodeId (SceneCard same formula)', () => {
    useAppStore.setState({ selectedNodeId: 's_cross' } as any);
    const { container } = render(<ChapterWorkbench />);
    const chip = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    expect(chip.classList.contains('workbench-chip--selected')).toBe(true);
    expect(chip.getAttribute('data-selected')).toBe('true');
    // 其他 chip 不带。
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.classList.contains('workbench-chip--selected')).toBe(false);
  });

  it('clicking a chip selects the scene（共享抽屉接线，SP-3 承接）', () => {
    const { container } = render(<ChapterWorkbench />);
    fireEvent.click(container.querySelector('.workbench-chip[data-node-id="s_plain"]')!);
    expect(useAppStore.getState().selectedNodeId).toBe('s_plain');
  });

  it('dangling scene lands in the pending virtual column (grey chip, no chapter slot)', () => {
    // fixture + 一个无章可归属的场景（chapter 42 无对应 episode）。
    const g = sceneGraphSchema.parse({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        {
          id: 's_dangling', lineTags: ['l_side'], storyTime: 9, role: 'normal',
          presentationOrder: { chapter: 42, pos: 0 }, title: '深夜的访客',
        },
      ],
      edges: [],
    });
    useAppStore.setState({ creativeFields: { scene_graph: g, episode_outlines: EPISODES() } } as any);
    const { container } = render(<ChapterWorkbench />);
    const pendingChip = container.querySelector('.workbench-chip[data-node-id="s_dangling"]') as HTMLElement;
    expect(pendingChip).not.toBeNull();
    expect(pendingChip.classList.contains('workbench-chip--pending')).toBe(true);
    // 收纳在待编排虚拟列（末列，grid column = chapterTrackCount + 2 = 5）。
    const slot = pendingChip.closest('.workbench-slot') as HTMLElement;
    expect(slot.getAttribute('data-chapter')).toBe('pending');
    expect(slot.style.gridColumn).toBe('5');
  });

  it('± 按钮退役（R6 方案 D）＋T11 把手恒渲染：不可用置灰 + title，宽卡贴边只说明', () => {
    const { container } = render(<ChapterWorkbench />);
    // 全工作台零 ± 按钮（applyAddChapter/applyRemoveChapter 随唯一消费者删除）。
    expect(container.querySelector('[data-action="add-chapter"]')).toBeNull();
    expect(container.querySelector('[data-action="remove-chapter"]')).toBeNull();
    expect(container.querySelector('.workbench-chip-actions')).toBeNull();

    // 跨章卡（s_cross e0..2）：两缘把手齐备且皆活——起点=首章（贴边）只挂 title。
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    const crossLeft = cross.querySelector('[data-resize-edge="left"]') as HTMLElement;
    const crossRight = cross.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(crossLeft.classList.contains('workbench-chip-handle--disabled')).toBe(false);
    expect(crossRight.classList.contains('workbench-chip-handle--disabled')).toBe(false);
    // en fixture：贴左缘（colStart=0）→「左缘已是首章」；colEnd=2=末章 → 右缘说明。
    expect(crossLeft.getAttribute('title')).toBe('Left edge is already the first chapter');
    expect(crossRight.getAttribute('title')).toBe('Right edge is already the last built chapter');

    // 单章卡（s_plain ch1，下一章在）：左缘恒渲染但置灰（首章稳定原则——T11 前
    // 是吞把手）；右缘可扩仍活、零 title。
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.getAttribute('data-pending')).toBe('false');
    const plainLeft = plain.querySelector('[data-resize-edge="left"]') as HTMLElement;
    expect(plainLeft.classList.contains('workbench-chip-handle--disabled')).toBe(true);
    expect(plainLeft.getAttribute('data-disabled')).toBe('true');
    expect(plainLeft.getAttribute('title')).toBe(
      "A single-chapter card's left edge doesn't participate (first-chapter stability)"
    );
    const plainRight = plain.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(plainRight.classList.contains('workbench-chip-handle--disabled')).toBe(false);
    expect(plainRight.getAttribute('title')).toBeNull();

    // 末章单章卡（s_side ch2=最后已建章）：右把手在场但置灰 + 说明（T11 前消失
    // ——「有的只能左拉」困惑根因）。
    const side = container.querySelector('.workbench-chip[data-node-id="s_side"]') as HTMLElement;
    const sideRight = side.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(sideRight).not.toBeNull();
    expect(sideRight.classList.contains('workbench-chip-handle--disabled')).toBe(true);
    expect(sideRight.getAttribute('data-disabled')).toBe('true');
    expect(sideRight.getAttribute('title')).toBe('Right edge is already the last built chapter');
    // 灰片零把手（pending 无章语义）。
    const grey = container.querySelector(
      '.workbench-chip--pending .workbench-chip-handle'
    );
    expect(grey).toBeNull();
  });

  it('no episodes → grid rides the shared template (pending column only — 待编排列自证，不吞场景)', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: [] },
    } as any);
    const { container } = render(<ChapterWorkbench />);
    const grid = container.querySelector('.workbench-grid') as HTMLElement;
    // 零章：模板仍 subgrid 接轨（宿主 zero-chapter 模板 = lane + 待编排两列），
    // 行模板自理。
    expect(grid.style.gridTemplateColumns).toBe('subgrid');
    // 全部 4 场景进待编排（灰态）——design §2：dangling 不可见是缺口，不静默吞。
    expect(container.querySelectorAll('.workbench-chip--pending')).toHaveLength(4);
  });

  it('T26 ②：多线场景每线一枚实例全带双环标记；单线/死 lineTag 负断言（valid 线计数单源）', () => {
    // 局部 fixture：s_dual 双线（主线+副线）→ 两线行各一枚 chip，全部带标记；
    // s_dead 挂一活一死 lineTag（实际渲染单实例）→ **不**标记（拷贝数=valid 线数）。
    const g = sceneGraphSchema.parse({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        {
          id: 's_dual', lineTags: ['l_main', 'l_side'], storyTime: 5, role: 'normal',
          presentationOrder: { chapter: 2, pos: 1 }, title: '多线场景',
        },
        {
          id: 's_dead', lineTags: ['l_main', 'l_ghost'], storyTime: 6, role: 'normal',
          presentationOrder: { chapter: 2, pos: 2 }, title: '死线单实例',
        },
      ],
      edges: [],
    });
    useAppStore.setState({
      creativeFields: { scene_graph: g, episode_outlines: EPISODES() },
    } as any);
    const { container } = render(<ChapterWorkbench />);
    const dualChips = [
      ...container.querySelectorAll('.workbench-chip[data-node-id="s_dual"]'),
    ] as HTMLElement[];
    expect(dualChips).toHaveLength(2); // 每线一枚实例（主线行 + 副线行）
    for (const chip of dualChips) {
      expect(chip.getAttribute('data-multiline')).toBe('true');
      expect(chip.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(true);
    }
    // 死 lineTag：只渲染 l_main 一枚 → 非多线（计数单源 = valid 线）。
    const deadChips = [
      ...container.querySelectorAll('.workbench-chip[data-node-id="s_dead"]'),
    ] as HTMLElement[];
    expect(deadChips).toHaveLength(1);
    expect(deadChips[0]!.getAttribute('data-multiline')).toBe('false');
    expect(deadChips[0]!.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(false);
    // 既有单线场景负断言。
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.getAttribute('data-multiline')).toBe('false');
  });

  it('volume band row rides the chapter axis（#80 集映射：episode.phase_ref 直接定卷）', () => {
    // dogfood R2 #80：章轴卷带权威源 = episode.phase_ref——三章集纲全挂 ph1 →
    // 单 band 0..2。线上的 phase_ref 不再参与章轴卷带推导（投币路径保留给
    // storyTime 轴消费方，见 volumeBands.ts 文件头）。
    const eps = parseEpisodes([
      { id: 'e0', index: 0, title: '被包围的转学生', phase_ref: 'ph1' },
      { id: 'e1', index: 1, title: '共犯约定', phase_ref: 'ph1' },
      { id: 'e2', index: 2, title: '突围', phase_ref: 'ph1' },
    ]);
    useAppStore.setState({
      creativeFields: {
        scene_graph: workbenchGraph(),
        episode_outlines: eps,
        outline: { phases: [{ id: 'ph1', title: '卷一' }] },
      },
    } as any);
    const { container } = render(<ChapterWorkbench />);
    const band = container.querySelector('.workbench-band') as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.classList.contains('volume-band--v0')).toBe(true);
    // fromCol 0..toCol 2 → gridColumn "2 / 5"（章列 2..4）。
    expect(band.style.gridColumn).toBe('2 / 5');
    // 体色分段跨泳道行（3 / 5）。
    const tint = container.querySelector('.workbench-volume-tint') as HTMLElement;
    expect(tint).not.toBeNull();
    expect(tint.style.gridColumn).toBe('2 / 5');
    expect(tint.style.gridRow).toBe('3 / 5');
  });
});

describe('StructurePage stacking (batch 3 reflow)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: true, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
    } as any);
  });
  afterEach(() => cleanup());

  it('stacks causal skeleton ABOVE the workbench inside the zoom canvas（design §1.1）', () => {
    const { container } = render(<StructurePage />);
    const canvas = container.querySelector('[data-structure-canvas]') as HTMLElement;
    const causal = container.querySelector('[data-skeleton="causal"]') as HTMLElement;
    const workbench = container.querySelector('[data-skeleton="workbench"]') as HTMLElement;
    expect(canvas).not.toBeNull();
    expect(causal).not.toBeNull();
    expect(workbench).not.toBeNull();
    // 单列纵向堆叠：causal 在 canvas 内先于 workbench；46px 保留带在两者之间。
    expect(canvas.contains(causal)).toBe(true);
    expect(canvas.contains(workbench)).toBe(true);
    expect(causal.compareDocumentPosition(workbench) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const gap = container.querySelector('[data-skeleton-gap]') as HTMLElement;
    expect(gap).not.toBeNull();
  });

  it('reading skeleton + packing link layer are RETIRED (zero renders)', () => {
    const { container } = render(<StructurePage />);
    expect(container.querySelector('[data-skeleton="reading"]')).toBeNull();
    expect(container.querySelector('[data-packing-link-layer]')).toBeNull();
    expect(container.querySelector('.structure-content--horizontal')).toBeNull();
    expect(container.querySelector('.weaving-panel')).toBeNull();
  });

  it('batch 7 single source: host canvas owns ONE inline template === sharedColumnTracks(trackCountOf episodes)', () => {
    const { container } = render(<StructurePage />);
    const canvas = container.querySelector('[data-structure-canvas]') as HTMLElement;
    // 宿主列模板 = 单源函数直出（fixture 三章 + 待编排 → 轨道基数 4）。
    expect(canvas.style.display).toBe('grid');
    expect(canvas.style.gridTemplateColumns).toBe(sharedColumnTracks(3));
    expect(canvas.getAttribute('data-shared-track-count')).toBe('4');
    // 与派生口径一致：episodeTrackCountOf(EPISODES()) = 3。
    expect(episodeTrackCountOf(useAppStore.getState().creativeFields.episode_outlines)).toBe(3);
  });

  it('batch 7 lockstep: BOTH inner grids declare subgrid tracks (no self template strings)', () => {
    const { container } = render(<StructurePage />);
    const causalGrid = container.querySelector('[data-skeleton="causal"] .narrative-timeline-grid') as HTMLElement;
    const workbenchGrid = container.querySelector('.workbench-grid') as HTMLElement;
    // 两内网格各 subgrid 接轨——纵向参考线在两区连续（design §11 验收）。
    expect(causalGrid.style.gridTemplateColumns).toBe('subgrid');
    expect(workbenchGrid.style.gridTemplateColumns).toBe('subgrid');
    // 自算列宽字符串零残留（等距 repeat(N, 96px) 族随换轴退役）。
    expect(causalGrid.style.gridTemplateColumns).not.toContain('repeat(');
    expect(causalGrid.style.gridTemplateColumns).not.toContain('96px');
  });
});

// ── 08-26 批 5（P3 口径）：两区场景计数一致性——因果骨架泳道数 vs 工作台 chip 数
//    （值 = 已编排 + 待编排，同口径单测锁定；两区各自派生，漂移即在此爆红）──

describe('lane scene-count parity: causal skeleton lanes vs workbench chips (P3)', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: parseGraph({
          lines: [
            { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
            { id: 'l_side', name: '副线', topology_role: 'side' },
          ],
          nodes: [
            ...workbenchGraph().nodes,
            // 多线节点（l_main + l_side 各计一枚——两侧同口径）。
            {
              id: 's_multi', lineTags: ['l_main', 'l_side'], storyTime: 2, role: 'normal',
              presentationOrder: { chapter: 1, pos: 5 }, title: '双线场景',
            },
            // dangling（章 42 无对应 episode）→ 工作台进待编排列、因果侧照常出卡。
            {
              id: 's_dangling', lineTags: ['l_side'], storyTime: 9, role: 'normal',
              presentationOrder: { chapter: 42, pos: 0 }, title: '深夜的访客',
            },
          ],
          edges: [],
        }),
        episode_outlines: EPISODES(),
      },
      overlayToggles: { validation: false, displacement: true, visibility: true, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });
  afterEach(() => cleanup());

  it('every lane shows the SAME count text in both zones (scheduled + pending, multi-line per-line)', () => {
    const { container } = render(<StructurePage />);
    for (const lineId of ['l_main', 'l_side']) {
      const causalCount = container.querySelector(
        `[data-skeleton="causal"] [data-lane-id="${lineId}"] [data-lane-count]`
      )?.getAttribute('data-lane-count');
      const workbenchCount = container.querySelector(
        `[data-skeleton="workbench"] [data-lane-id="${lineId}"] [data-lane-count]`
      )?.getAttribute('data-lane-count');
      expect(causalCount, `causal lane ${lineId} count text`).toBeTruthy();
      expect(workbenchCount, `workbench lane ${lineId} count text`).toBeTruthy();
      expect(workbenchCount).toBe(causalCount);
    }
    // 具体值锚（数值口径 attr——locale 文案不再是断言锚）：l_main = s1/s_cross/
    // s_plain/s_multi 四枚；l_side = s_side/s_multi/s_dangling 三枚。
    const mainCount = container.querySelector(
      '[data-skeleton="workbench"] [data-lane-id="l_main"] [data-lane-count]'
    )?.getAttribute('data-lane-count');
    const sideCount = container.querySelector(
      '[data-skeleton="workbench"] [data-lane-id="l_side"] [data-lane-count]'
    )?.getAttribute('data-lane-count');
    expect(mainCount).toBe('4');
    expect(sideCount).toBe('3');
  });
});

// ── 批 8（08-26 晚第二批目检）：8.2 待编排列钉右组 + 8.3 待编排溢出折叠 ──

describe('batch 8: pinned-right pending column + overflow collapse', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
    } as any);
  });
  afterEach(() => cleanup());

  /** workbenchGraph + n 枚 dangling（章 42 无对应 episode——全部进待编排列）。 */
  function danglingGraph(count: number): SceneGraph {
    return parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        ...Array.from({ length: count }, (_, i) => ({
          id: `d${i}`, lineTags: ['l_side'], storyTime: 100 + i, role: 'normal' as const,
          presentationOrder: { chapter: 42, pos: i }, title: `未编排 ${i}`,
        })),
      ],
      edges: [],
    });
  }

  it('8.2 every workbench pending surface opts into .structure-pin-right (header/slots/band corner)', () => {
    const { container } = render(<ChapterWorkbench />);
    // 列头。
    const header = container.querySelector('.workbench-col-header--pending') as HTMLElement;
    expect(header.classList.contains('structure-pin-right')).toBe(true);
    // 各泳道 pending 格。
    const slots = container.querySelectorAll('.workbench-slot--pending');
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect((s as HTMLElement).classList.contains('structure-pin-right')).toBe(true);
    }
    // 卷带行角格（同列同行 1）。
    const corner = container.querySelector('.workbench-corner.structure-pin-right') as HTMLElement;
    expect(corner).not.toBeNull();
    expect(corner.style.gridColumn).toBe('5'); // 3 章轨道 + 待编排 = 第 5 轨
    expect(corner.style.gridRow).toBe('1');
  });

  it('8.3 (revised) + R7: >3 dangling → 全量渲染保留、堆内「+N」徽标退役、每线计数器报总数', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: danglingGraph(11), episode_outlines: EPISODES() },
    } as any);
    const { container } = render(<ChapterWorkbench />);
    const slot = container.querySelector(
      '.workbench-slot--pending[data-slot-line="l_side"]'
    ) as HTMLElement;
    // T8 滚动栈内化：pending-overflow 变体类挂内层 .workbench-pending-stack（滚动
    // 容器内迁——外层 slot 是计数器的非滚动定位锚），宿主级不再携带。
    const stack = slot.querySelector('.workbench-pending-stack') as HTMLElement;
    expect(stack.classList.contains('pending-overflow')).toBe(true);
    expect(slot.classList.contains('pending-overflow')).toBe(false);
    // 语义修订核心断言：全量渲染——d0..d10 全在 DOM（折叠的那部分靠滚动浏览）。
    const chips = slot.querySelectorAll('.workbench-chip');
    expect(chips).toHaveLength(11);
    for (let i = 0; i < 11; i++) {
      expect(slot.querySelector(`[data-node-id="d${i}"]`)).not.toBeNull();
    }
    // R7：堆内徽标零残留；行计数器 = 该线未编排总数 11。
    expect(container.querySelector('.pending-overflow-badge')).toBeNull();
    const counter = slot.querySelector('.lane-pending-counter') as HTMLElement;
    expect(counter.textContent).toBe('11');
    expect(counter.getAttribute('data-pending-total')).toBe('11');
    expect(counter.getAttribute('title')).toBeTruthy();
    expect(counter.getAttribute('aria-label')).toBeTruthy();
    // T8 结构性保证（V-F3 根除）：计数器是宿主直下子元素、不在 .pending-overflow
    // 滚动容器内——absolute 钉非滚动宿主，滚轮堆滚动零漂移。
    expect(counter.parentElement).toBe(slot);
    expect(stack.contains(counter)).toBe(false);
  });

  it('8.3 ≤3 dangling + R7: whole bucket visible（封顶未触、溢出变体与「+N」徽标零出现，计数器照报总数）', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: danglingGraph(3), episode_outlines: EPISODES() },
    } as any);
    const { container } = render(<ChapterWorkbench />);
    const slot = container.querySelector(
      '.workbench-slot--pending[data-slot-line="l_side"]'
    ) as HTMLElement;
    expect(slot.querySelectorAll('.workbench-chip')).toHaveLength(3);
    const stack = slot.querySelector('.workbench-pending-stack') as HTMLElement;
    expect(stack.classList.contains('pending-overflow')).toBe(false);
    // R7 计数器口径：n>0 恒报总数（与封顶无关）；堆内徽标恒无。
    const counter = slot.querySelector('.lane-pending-counter') as HTMLElement;
    expect(counter.getAttribute('data-pending-total')).toBe('3');
    expect(container.querySelector('.pending-overflow-badge')).toBeNull();
  });

  it('#63 drag a placed chip back onto the pending slot → chapter becomes the sentinel（撤章归属）', () => {
    // spy 先于 render（CR-19 同款：组件闭包引用渲染时的 updateField）。
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    const source = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(source).toBeTruthy();
    const slot = container.querySelector(
      '.workbench-slot--pending[data-slot-line="l_main"]'
    ) as HTMLElement;
    expect(slot).toBeTruthy();
    const dt = {
      getData: () => JSON.stringify({ nodeId: 's_plain', mode: 'weaving' }),
    } as unknown as DataTransfer;
    fireEvent.dragOver(slot, { dataTransfer: dt });
    fireEvent.drop(slot, { dataTransfer: dt });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const node = written.nodes.find((n) => n.id === 's_plain')!;
    expect(node.presentationOrder!.chapter).toBe(PENDING_CHAPTER_SENTINEL);
    updateSpy.mockRestore();
  });

  it('causal mirror keeps both behaviours consistent (same pin class + same R7 counter)', () => {
    useAppStore.setState({
      creativeFields: { scene_graph: danglingGraph(11), episode_outlines: EPISODES() },
    } as any);
    const { container } = render(<StructurePage />);
    // 钉右：因果侧列头与全部泳道镜像格。
    const causalHeader = container.querySelector(
      '[data-skeleton="causal"] .narrative-timeline-col-header--pending'
    ) as HTMLElement;
    expect(causalHeader.classList.contains('structure-pin-right')).toBe(true);
    const stacks = [
      ...container.querySelectorAll('[data-skeleton="causal"] .narrative-timeline-cell-stack--pending'),
    ] as HTMLElement[];
    expect(stacks.length).toBeGreaterThanOrEqual(2);
    for (const s of stacks) {
      expect(s.classList.contains('structure-pin-right')).toBe(true);
    }
    // R7 两区口径统一：镜像堆全量渲染（11 张）+ 计数器报**总数**（与工作台同值，
    // 徽标零残留）。
    const mirror = stacks.find((s) => s.querySelector('[data-node-id="d0"]'));
    expect(mirror).toBeTruthy();
    expect(mirror!.querySelectorAll('.scene-card')).toHaveLength(11);
    const counter = mirror!.querySelector('.lane-pending-counter') as HTMLElement;
    expect(counter.getAttribute('data-pending-total')).toBe('11');
    expect(mirror!.querySelector('.pending-overflow-badge')).toBeNull();
    // T8 两区同构（发现批4）：因果侧计数器同样挂非滚动宿主直下、不在内层
    // .pending-overflow 滚动栈内——「宿主右上角小徽标」两区统一形态。
    const causalStack = mirror!.querySelector('.narrative-timeline-pending-stack') as HTMLElement;
    expect(causalStack.classList.contains('pending-overflow')).toBe(true);
    expect(counter.parentElement).toBe(mirror);
    expect(causalStack.contains(counter)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R1/R6（08-27-structure-fixes §6.3）：工作台槽位容器面 = 唯一 drop 缝
//   - 空槽即合法落点（AC2 数据半）+ 往返整链无消失（#70 症状①②回归钉）
//   - 宽卡整区间平移保持宽度（AC10 操作半）＋ gap 槽拒收
//   - 整链过程 console.error 零调用（级联崩坏的「渲染树半途吞 DOM」哨兵）
// ─────────────────────────────────────────────────────────────────────────────

function makeDataTransfer(payload?: unknown): DataTransfer {
  const store = new Map<string, string>();
  return {
    effectAllowed: 'uninitialized',
    dropEffect: 'none',
    setData: vi.fn((mime: string, data: string) => {
      store.set(mime, data);
    }),
    getData: vi.fn((mime: string) => store.get(mime) ?? ''),
    clearData: vi.fn(),
    get types() {
      return [...store.keys()];
    },
  } as unknown as DataTransfer;
}

/** 从源 chip 真起手（dragStart 携带 payload），落到目标元素。 */
function dragChipTo(container: HTMLElement, sourceNodeId: string, targetSel: string): void {
  const chip = container.querySelector(
    `.workbench-chip[data-node-id="${sourceNodeId}"]:not(.workbench-chip--pending)`
  ) as HTMLElement;
  expect(chip, `source chip ${sourceNodeId}`).toBeTruthy();
  const target = container.querySelector(targetSel) as HTMLElement;
  expect(target, `target ${targetSel}`).toBeTruthy();
  const dt = makeDataTransfer();
  fireEvent.dragStart(chip, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  fireEvent.drop(target, { dataTransfer: dt });
}

const slotSel = (lineId: string, chapter: number | string) =>
  `.workbench-slot[data-slot-line="${lineId}"][data-chapter="${chapter}"]`;

describe('R1/R6: workbench slot-surface routing (integration)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // 错误哨兵先于 render（级联崩坏形态 = 渲染树中途抛错被边界静默吞掉的观测面）。
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
    errorSpy.mockRestore();
  });

  it('#70 回归：s_plain 与第 3 章空格往返 ×5 —— 每次 1 写、落点即时反映到 DOM、console 零错', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    for (let round = 0; round < 5; round++) {
      const goingOut = round % 2 === 0;
      dragChipTo(container, 's_plain', slotSel('l_main', goingOut ? 2 : 1));
      // 引用级 no-op 只会发生在真正等区间时；异章往返每次恰一次写。
      expect(updateSpy).toHaveBeenCalledTimes(round + 1);
      const written = updateSpy.mock.calls[round][1] as SceneGraph;
      expect(written.nodes.find((n) => n.id === 's_plain')!.presentationOrder!.chapter).toBe(
        goingOut ? 2 : 1
      );
      // 渲染树未被吞：chip 出现在目标槽位里（派生刷新链活着）。
      const destSlot = container.querySelector(slotSel('l_main', goingOut ? 2 : 1)) as HTMLElement;
      expect(destSlot.querySelector('[data-node-id="s_plain"]')).not.toBeNull();
      const prevSlot = container.querySelector(slotSel('l_main', goingOut ? 1 : 2)) as HTMLElement;
      expect(prevSlot.querySelector('[data-node-id="s_plain"]')).toBeNull();
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('跨行空槽直投合法（AC2：任意线格均为落点）——节点级章写入、行归属不变', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    dragChipTo(container, 's_plain', slotSel('l_side', 0));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    // 节点级写入（每节点一份章数据）：s_plain.chapter → 0；lineTags 不被 drop 改写
    // （换线归属是另一条语义，不在本手势承诺内——与因果侧同款）。
    expect(written.nodes.find((n) => n.id === 's_plain')!.presentationOrder!.chapter).toBe(0);
    expect(written.nodes.find((n) => n.id === 's_plain')!.lineTags).toEqual(['l_main']);
    // 渲染面：chip 落在 l_main 行的 ch0 格（chip 按线归属渲染，行不随落点漂移）。
    const mainSlot = container.querySelector(slotSel('l_main', 0)) as HTMLElement;
    expect(mainSlot.querySelector('[data-node-id="s_plain"]')).not.toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('同章兄弟 chip 表面落点 = 章内重排（e.target 判定沿用既有矩阵语义）', () => {
    // 专属夹具：ch0 两枚单章卡（s1 pos0 / sd pos1），保证重排前序不等于重排后序
    // （真等序落点走引用级 no-op 是零写——那是另一条守卫，见 useWeavingEdit 纯测）。
    const pair = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        { id: 'sd', lineTags: ['l_main'], storyTime: 5, role: 'normal', presentationOrder: { chapter: 0, pos: 1 } },
      ],
      edges: [],
    });
    useAppStore.setState({ creativeFields: { scene_graph: pair, episode_outlines: EPISODES() } } as any);
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    // 拖 sd（pos1）落到 s1（pos0）表面 → sd 插到 s1 前。
    dragChipTo(container, 'sd', '.workbench-chip[data-node-id="s1"]');
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    expect(written.nodes.find((n) => n.id === 'sd')!.presentationOrder!.chapter).toBe(0);
    expect(written.nodes.find((n) => n.id === 'sd')!.presentationOrder!.pos).toBeLessThan(
      written.nodes.find((n) => n.id === 's1')!.presentationOrder!.pos
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('gap 章轨（episode 缺席）不接 drop —— fire 在槽位上零写（拒收纪律对齐因果侧）', () => {
    const gapped = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
    ]);
    useAppStore.setState({ creativeFields: { scene_graph: workbenchGraph(), episode_outlines: gapped } } as any);
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    const gapSlot = container.querySelector(slotSel('l_main', 1)) as HTMLElement; // track 存在、episode 缺席
    expect(gapSlot).toBeTruthy();
    const dt = makeDataTransfer();
    fireEvent.dragStart(container.querySelector('[data-node-id="s_plain"]')!, { dataTransfer: dt });
    fireEvent.drop(gapSlot, { dataTransfer: dt });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(chapterOfSel()).toBe(1); // s_plain 原地未动
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('宽卡（spans e0..e2）投掷空槽 ch3 → 平移 [2..4] 保持宽度（五域 fixture；AC10 操作半）', () => {
    // CR3 G-F2 后契约：投回自身覆盖列（ch0..ch2）= 取消式投放零写入——本测投点
    // 须在自身区间之外（ch3），验证「真实平移意图」的整区间平移路径。
    const eps5 = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
      { id: 'e4', index: 4, title: 'C4' },
    ]);
    const wide = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        {
          id: 'w_wide', lineTags: ['l_main'], storyTime: 9, role: 'normal',
          presentationOrder: { chapter: 0, pos: 5 },
          presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 0 }],
        },
      ],
      edges: [],
    });
    useAppStore.setState({ creativeFields: { scene_graph: wide, episode_outlines: eps5 } } as any);
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    dragChipTo(container, 'w_wide', slotSel('l_main', 3));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const spans = (updateSpy.mock.calls[0][1] as SceneGraph)
      .nodes.find((n) => n.id === 'w_wide')!
      .presentationSpans!.map((s) => s.episodeId);
    // T=3、宽度 3（len=2）→ 钳 maxBuilt−len=2 → 新区间 [2..4]，宽度保持。
    expect(spans).toEqual(['e2', 'e3', 'e4']);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/** 当前面图里 s_plain 的裸章号（gap 用例读值锚）。 */
function chapterOfSel(): number | null {
  const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
  return g.nodes.find((n) => n.id === 's_plain')?.presentationOrder?.chapter ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CR3 blind G-F9：T1 实测列命中主路径集成覆盖。此前全部集成测经 fireEvent 直投、
// jsdom 全零 rect → resolveColumnAtClientX 恒 null → 全走 T2 面锚梯——T1 主路径
// （宽卡覆盖列防截胡 / 实测 x 正裁 / 实测命中 gap 门槛拒收）结构性零覆盖。本组
// 注入 fake rect 表使 T1 真跑；每例的断言值均与 T2 面锚口径**分叉**（T2 生效即红）
// ——钉的就是「同一 slot 处理器、target 来自实测 x」。
// ─────────────────────────────────────────────────────────────────────────────

/** fake 列几何：列 c 左缘 = 100 + c*120、宽 120（列中心 x = 160 + c*120）。 */
const FAKE_COL_LEFT = 100;
const FAKE_COL_WIDTH = 120;
const xOfCol = (c: number) => FAKE_COL_LEFT + c * FAKE_COL_WIDTH + FAKE_COL_WIDTH / 2;

/** 给全部章槽位注入 fake rect（resolveColumnAtClientX 只取每章文档序首枚，同列
 *  各行槽位几何一致，打全集即无歧义；pending 槽位 data-chapter 非整数天然跳过）。 */
function injectColumnRects(container: HTMLElement, trackCount: number) {
  container.querySelectorAll<HTMLElement>('.workbench-slot[data-chapter]').forEach((el) => {
    const idx = Number(el.getAttribute('data-chapter'));
    if (!Number.isInteger(idx) || idx < 0 || idx >= trackCount) return;
    const left = FAKE_COL_LEFT + idx * FAKE_COL_WIDTH;
    el.getBoundingClientRect = () =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        width: FAKE_COL_WIDTH,
        height: 40,
        right: left + FAKE_COL_WIDTH,
        bottom: 40,
        toJSON: () => ({}),
      }) as DOMRect;
  });
}

/**
 * 带实测 clientX 的 drop。DragEvent 的 init dictionary 不含 clientX（浏览器由引擎
 * 设置）——原生 MouseEvent（init 含 clientX）直派 + dataTransfer expando；React 的
 * DragEventInterface = MouseEventInterface + dataTransfer，两值皆可达 handler。
 * 直派发绕过 RTL 的 act 包装，drop 内 store 写入须显式包 act flush。
 */
function dropAt(target: HTMLElement, dt: DataTransfer, clientX: number) {
  const evt = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(evt, 'dataTransfer', { value: dt });
  act(() => {
    target.dispatchEvent(evt);
  });
}

/** dragChipTo 的实测 x 变体：drop 打在 target 元素上、列命中由 clientX 实测正裁。 */
function dragChipToX(
  container: HTMLElement,
  sourceNodeId: string,
  target: HTMLElement,
  clientX: number
): void {
  const chip = container.querySelector(
    `.workbench-chip[data-node-id="${sourceNodeId}"]:not(.workbench-chip--pending)`
  ) as HTMLElement;
  expect(chip, `source chip ${sourceNodeId}`).toBeTruthy();
  expect(target, 'drop target').toBeTruthy();
  const dt = makeDataTransfer();
  fireEvent.dragStart(chip, { dataTransfer: dt });
  fireEvent.dragOver(target, { dataTransfer: dt });
  dropAt(target, dt, clientX);
}

describe('T1 measured column-hit routing (fake rect injection, CR3 G-F9)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  /** 五章 fixture + 宽卡 w_wide [0..2]（渲染于 l_main×ch0 槽，顶面覆盖 ch0..ch2）。 */
  function wideFiveChapterFixture() {
    const eps5 = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e1', index: 1, title: 'C1' },
      { id: 'e2', index: 2, title: 'C2' },
      { id: 'e3', index: 3, title: 'C3' },
      { id: 'e4', index: 4, title: 'C4' },
    ]);
    const wide = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        {
          id: 'w_wide', lineTags: ['l_main'], storyTime: 9, role: 'normal',
          presentationOrder: { chapter: 0, pos: 5 },
          presentationSpans: [{ episodeId: 'e0', pos: 0 }, { episodeId: 'e2', pos: 0 }],
        },
      ],
      edges: [],
    });
    useAppStore.setState({
      creativeFields: { scene_graph: wide, episode_outlines: eps5 },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
    return eps5;
  }

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
    errorSpy.mockRestore();
  });

  it('他卡投到宽卡表面：同一 slot 处理器按实测 x 正裁到 ch3（T2 面锚会说 ch0——宽卡不截胡）', () => {
    const eps5 = wideFiveChapterFixture();
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField'); // 先于 render（组件闭包）
    const { container } = render(<ChapterWorkbench />);
    injectColumnRects(container, episodeTrackCountOf(eps5));
    // s_plain（ch1）投到宽卡 chip 表面（宿主槽 = l_main×ch0），实测 x 指向 ch3 列。
    const wideChip = container.querySelector('.workbench-chip[data-node-id="w_wide"]') as HTMLElement;
    dragChipToX(container, 's_plain', wideChip, xOfCol(3));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    // 落点 = 实测列 3（面锚截胡会写宿主章 0——正是 §6.3 唯一裁决句禁的路径）。
    expect(written.nodes.find((n) => n.id === 's_plain')!.presentationOrder!.chapter).toBe(3);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('宽卡自体表面 + 实测 x 出自身区间 → 整区间平移 [2..4]（AC10 平移半走 T1 主路径）', () => {
    const eps5 = wideFiveChapterFixture();
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    injectColumnRects(container, episodeTrackCountOf(eps5));
    // 拿起 w_wide 放回自己身上、实测 x 在 ch3（自身 [0..2] 之外）→ 真实平移意图。
    // （面锚口径 host ch0 ∈ 自身区间 → 取消式投放零写入——恰一次写即 T1 生效证明。）
    const wideChip = container.querySelector('.workbench-chip[data-node-id="w_wide"]') as HTMLElement;
    dragChipToX(container, 'w_wide', wideChip, xOfCol(3));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const spans = (updateSpy.mock.calls[0][1] as SceneGraph)
      .nodes.find((n) => n.id === 'w_wide')!
      .presentationSpans!.map((s) => s.episodeId);
    expect(spans).toEqual(['e2', 'e3', 'e4']); // T=3、len=2 → 钳 maxBuilt−len → [2..4]
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('实测命中 gap 列 → episodeIndexSet 门槛拒收零写入（T2 面锚会写 ch2——拒收纪律实测梯生效证明）', () => {
    const gapped = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
    ]);
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: gapped },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    injectColumnRects(container, episodeTrackCountOf(gapped));
    // drop 打在 ch2 槽（可写、面锚=2），实测 x 落 gap 列 1 轨道 → T1 返回 1 → 拒收。
    const slot2 = container.querySelector(slotSel('l_main', 2)) as HTMLElement;
    dragChipToX(container, 's1', slot2, xOfCol(1));
    expect(updateSpy).not.toHaveBeenCalled();
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(g.nodes.find((n) => n.id === 's1')!.presentationOrder!.chapter).toBe(0); // 原地未动
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R11/T24：工作台章列头「＋ 新建场景」按钮（与因果列头 ＋ 构造单源
// buildNewSceneAtChapterAction；T24 起从每章格右上迁列头——槽位钮被 T23 装填
// 宽卡遮死：宽卡是别的槽的 DOM 子元素，被覆盖槽收不到 :hover → 显形永不触发）
// ─────────────────────────────────────────────────────────────────────────────

describe('R11/T24: workbench col-header add-scene button', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      focusedLineId: 'l_side',
      currentProject: null,
    } as any);
  });

  afterEach(() => cleanup());

  it('章列头钮可见可达：点击后在归属章尾插一枚新场景并选中开抽屉（恰好 1 写）', () => {
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    const btn = container.querySelector(
      '.workbench-col-header[data-col-index="1"] [data-action="add-scene"]'
    ) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0][1] as SceneGraph;
    const created = written.nodes.find((n) => !['s1', 's_cross', 's_plain', 's_side'].includes(n.id))!;
    expect(created.presentationOrder!.chapter).toBe(1);
    expect(created.presentationOrder!.pos).toBeGreaterThan(0); // 追加该章尾
    expect(created.lineTags).toEqual(['l_side']); // 默认线=聚焦线
    // 建后选中 + 抽屉聚焦旗标（SP-1 手感契约，两区一致）。
    expect(useAppStore.getState().selectedNodeId).toBe(created.id);
    expect(useAppStore.getState().drawerTitleFocus).toBe(true);
    updateSpy.mockRestore();
  });

  it('T24 迁位锁：槽内零残留、每真实章列头恰一枚、待编排列头无 ＋（章语义不存在）', () => {
    const { container } = render(<ChapterWorkbench />);
    // 旧槽位钮退役——类名与「槽内 add-scene 钮」双负断言（96 枚 → 3 枚）。
    expect(container.querySelector('.workbench-slot-add')).toBeNull();
    expect(container.querySelector('.workbench-slot [data-action="add-scene"]')).toBeNull();
    // 每真实章列头各一枚（3 章 fixture；同一 .narrative-timeline-col-add 单类）。
    expect(container.querySelectorAll('.workbench-col-header [data-action="add-scene"]')).toHaveLength(3);
    // 待编排列头不开钮（与因果区 pending 列头同口径）。
    expect(container.querySelector('.workbench-col-header--pending [data-action="add-scene"]')).toBeNull();
  });

  it('gap 章轨不设钮（gap 无列头——「不造头，空轨诚实」同口径；真实章列头钮在场）', () => {
    const gapped = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
    ]);
    useAppStore.setState({ creativeFields: { ...useAppStore.getState().creativeFields, episode_outlines: gapped } } as any);
    const { container } = render(<ChapterWorkbench />);
    // gap index 1 无列头 → 无钮（写 gap 章 = 静默改判 pending 的空头承诺不开）。
    expect(container.querySelector('.workbench-col-header[data-col-index="1"]')).toBeNull();
    expect(container.querySelector('.workbench-col-header[data-col-index="0"] [data-action="add-scene"]')).toBeTruthy();
    expect(container.querySelector('.workbench-col-header[data-col-index="2"] [data-action="add-scene"]')).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 两区口径：同一行的待编排计数器值一致（工作台槽位 ↔ 因果镜像列），badge 零残留
// ─────────────────────────────────────────────────────────────────────────────

describe('R7: per-line pending counter parity across zones', () => {
  beforeEach(() => {
    useAppStore.setState({
      creativeFields: {
        scene_graph: parseGraph({
          lines: [
            { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
            { id: 'l_side', name: '副线', topology_role: 'side' },
          ],
          nodes: [
            ...workbenchGraph().nodes,
            // l_main 一枚 dangling；l_side 三枚 dangling（各线计数不同）。
            { id: 'm_dang', lineTags: ['l_main'], storyTime: 20, role: 'normal', presentationOrder: { chapter: 42, pos: 0 } },
            { id: 'a1d', lineTags: ['l_side'], storyTime: 21, role: 'normal', presentationOrder: { chapter: 43, pos: 0 } },
            { id: 'a2d', lineTags: ['l_side'], storyTime: 22, role: 'normal', presentationOrder: { chapter: 44, pos: 0 } },
            { id: 'a3d', lineTags: ['l_side'], storyTime: 23, role: 'normal', presentationOrder: { chapter: 45, pos: 0 } },
          ],
          edges: [],
        }),
        episode_outlines: EPISODES(),
      },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => cleanup());

  it.each([
    ['l_main', 1],
    ['l_side', 3],
  ])('%s 行：两区 counter data-pending-total 均为 %i（位置口径统一由同 class 承载）', (lineId, total) => {
    const { container } = render(<StructurePage />);
    const workbenchCounter = container.querySelector(
      `[data-skeleton="workbench"] ${slotSel(lineId, 'pending')} .lane-pending-counter`
    ) as HTMLElement | null;
    // 因果侧行渲染序 = label → 章栈… → pending 栈（同一行的后续兄弟里第一枚）。
    const causalLabel = container.querySelector(
      `[data-skeleton="causal"] [data-lane-id="${lineId}"]`
    ) as HTMLElement | null;
    expect(causalLabel).toBeTruthy();
    let cursor: Element | null = causalLabel!.nextElementSibling;
    let causalCounter: HTMLElement | null = null;
    while (cursor) {
      if (cursor.classList.contains('narrative-timeline-cell-stack--pending')) {
        causalCounter = (cursor.querySelector('.lane-pending-counter') as HTMLElement | null);
        break;
      }
      cursor = cursor.nextElementSibling;
    }
    expect(workbenchCounter?.getAttribute('data-pending-total')).toBe(String(total));
    expect(causalCounter?.getAttribute('data-pending-total')).toBe(String(total));
    expect(container.querySelector('.pending-overflow-badge')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8/R11（用户拍板「工作台空白右键补实现」+ CR3 拍板转化「插入新章本批实现」）：
//   - 空白（空槽面）/列头右键菜单（TimelineContextMenu 复用，与因果区同口径）
//   - gap 列 / 待编排带命中 → 两项置灰（addSceneBlocked 族——置灰而非消失）
//   - 元素（chip/泳道标签）右键不劫持
//   - 插入新章 = 双字段投影（episode 章表 k 位新章 + 裸章号右移；spans 零触碰）
// ─────────────────────────────────────────────────────────────────────────────

describe('R8/R11: workbench blank + column-header context menu', () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      focusedLineId: null,
      drawerTitleFocus: false,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
  });

  it('空白（空槽面）右键 → 列菜单弹出，add-scene 与 insert-chapter 两项可用', () => {
    const { container } = render(<ChapterWorkbench />);
    fireEvent.contextMenu(container.querySelector(slotSel('l_main', 1))!);
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    expect((menu!.querySelector('[data-menu-key="add-scene"]') as HTMLButtonElement).disabled).toBe(false);
    expect((menu!.querySelector('[data-menu-key="insert-chapter"]') as HTMLButtonElement).disabled).toBe(false);
  });

  it('待编排带右键 → 两项置灰不消失（与因果区 addSceneBlocked 纪律一致）', () => {
    const { container } = render(<ChapterWorkbench />);
    fireEvent.contextMenu(container.querySelector(slotSel('l_side', 'pending'))!);
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    for (const key of ['add-scene', 'insert-chapter']) {
      expect((menu!.querySelector(`[data-menu-key="${key}"]`) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('gap 列空槽右键 → 两项置灰（写通道不承诺未建章的归章/插入锚）', () => {
    const gapped = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
    ]);
    useAppStore.setState({ creativeFields: { ...useAppStore.getState().creativeFields, episode_outlines: gapped } } as any);
    const { container } = render(<ChapterWorkbench />);
    fireEvent.contextMenu(container.querySelector(slotSel('l_main', 1))!);
    const menu = container.querySelector('[data-testid="timeline-ctx-menu"]');
    expect(menu).not.toBeNull();
    for (const key of ['add-scene', 'insert-chapter']) {
      expect((menu!.querySelector(`[data-menu-key="${key}"]`) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('元素右键不劫持：chip / 泳道标签上右键 → 无应用菜单（交还浏览器默认）', () => {
    const { container } = render(<ChapterWorkbench />);
    fireEvent.contextMenu(container.querySelector('.workbench-chip[data-node-id="s_plain"]')!);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();
    fireEvent.contextMenu(container.querySelector('.workbench-lane-label[data-lane-id="l_main"]')!);
    expect(container.querySelector('[data-testid="timeline-ctx-menu"]')).toBeNull();
  });

  it('列头右键 → insert-chapter 双字段落盘：章表 k 位新章 + 旧章右移 + 裸章号场景同步 +1（spans 零触碰）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    fireEvent.contextMenu(container.querySelector('.workbench-col-header[data-col-index="1"]')!);
    const item = container.querySelector('[data-menu-key="insert-chapter"]') as HTMLButtonElement;
    expect(item.disabled).toBe(false);
    fireEvent.click(item);
    // 双字段各恰一写：章表（结构）先行、scene_graph（裸章号依赖面）随后。
    expect(updateSpy).toHaveBeenCalledTimes(2);
    expect(updateSpy.mock.calls[0][0]).toBe('episode_outlines');
    expect(updateSpy.mock.calls[1][0]).toBe('scene_graph');
    // 章表终态：4 章，index↔id 漂移正确（新章 ep-1 落 1）。
    const eps = useAppStore.getState().creativeFields.episode_outlines as ReturnType<typeof EPISODES>;
    expect(new Map(eps.map((e) => [e.index, e.id]))).toEqual(
      new Map([[0, 'e0'], [1, 'ep-1'], [2, 'e1'], [3, 'e2']])
    );
    // 场景终态：>= 1 的裸章号右移；s_cross spans + po 零触碰；哨兵（无）不适用。
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    const ch = (id: string) => g.nodes.find((n) => n.id === id)!.presentationOrder!.chapter;
    expect(ch('s1')).toBe(0);
    expect(ch('s_cross')).toBe(0);
    expect(ch('s_plain')).toBe(2);
    expect(ch('s_side')).toBe(3);
    expect(g.nodes.find((n) => n.id === 's_cross')!.presentationSpans)
      .toEqual([{ episodeId: 'e0', pos: 1 }, { episodeId: 'e2', pos: 0 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H1 移交接线（CR3 G-F3）：builtColumnSet={episodeIndexSet}——生产态 gap 门槛激活。
// 注入 fake rect 使 T1 实测梯生效；gap 列上的 resize 预览须被拒（保持无预览），
// 已建列照常出预览（未接线时 gap 预览会说谎——抬手零效果死手势）。
// ─────────────────────────────────────────────────────────────────────────────

/** 原生 MouseEvent 直派发 pointer*（jsdom 无 PointerEvent——clientX 经 init 保留）。 */
function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  init: { clientX?: number } = {}
) {
  const evt = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...(init.clientX !== undefined ? { clientX: init.clientX } : {}),
  });
  act(() => {
    el.dispatchEvent(evt);
  });
}

describe('H1 handover: builtColumnSet wiring (resize preview gap gate)', () => {
  afterEach(() => cleanup());

  it('宽卡右把手拖经 gap 列 → 预览拒收（零 data-resize-*）；到已建列照常出预览', () => {
    const gapped = parseEpisodes([
      { id: 'e0', index: 0, title: 'C0' },
      { id: 'e2', index: 2, title: 'C2' },
    ]);
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: gapped },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
    const updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    injectColumnRects(container, episodeTrackCountOf(gapped));
    // s_cross spans e0,e2 → 视觉 [0..2] 宽卡（覆盖 gap 列 1），右把手在场。
    const chip = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    const handle = chip.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(handle).not.toBeNull();
    firePointer(handle, 'pointerdown', { clientX: xOfCol(0) });
    firePointer(handle, 'pointermove', { clientX: xOfCol(1) }); // gap 轨
    // gap 门槛生效：预览保持空（未接线时 data-resize-end 会说谎落 "1"）。
    expect(chip.getAttribute('data-resizing')).toBe('false');
    expect(chip.getAttribute('data-resize-end')).toBeNull();
    firePointer(handle, 'pointermove', { clientX: xOfCol(2) }); // 已建列
    expect(chip.getAttribute('data-resizing')).toBe('true');
    expect(chip.getAttribute('data-resize-start')).toBe('0');
    expect(chip.getAttribute('data-resize-end')).toBe('2');
    // 抬手提交等值区间 → 模型层引用级 no-op（零写）。
    firePointer(handle, 'pointerup', { clientX: xOfCol(2) });
    expect(updateSpy).not.toHaveBeenCalled();
    updateSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR3 G-edge 两守卫：空白 data-chapter 串不别名章 0（T2 拒收）+ ghost drawer
// 落选前置校验（写通道未落图 → 不选不开抽屉）
// ─────────────────────────────────────────────────────────────────────────────

describe('CR3 G-edge guards: blank data-chapter + ghost drawer', () => {
  let updateSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      focusedLineId: null,
      drawerTitleFocus: false,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
    errorSpy.mockRestore();
  });

  it('空 data-chapter 串（DOM 篡改形态）→ T2 面锚不把空白串别名成章 0——drop 拒收零写', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    // 篡改 ch2 槽的 data-chapter 为空串（Number('')===0 会过 isInteger——守卫根除该路径）。
    const tampered = container.querySelector(slotSel('l_main', 2)) as HTMLElement;
    tampered.setAttribute('data-chapter', '');
    dragChipTo(container, 's_plain', '.workbench-slot[data-slot-line="l_main"][data-chapter=""]');
    expect(updateSpy).not.toHaveBeenCalled();
    const g = useAppStore.getState().creativeFields.scene_graph as SceneGraph;
    expect(g.nodes.find((n) => n.id === 's_plain')!.presentationOrder!.chapter).toBe(1); // 原地未动
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('ghost drawer 守卫：写通道未落图（updateField 失效注入）→ 不选 ghost、不开抽屉', () => {
    updateSpy = vi
      .spyOn(useAppStore.getState(), 'updateField')
      .mockImplementation(() => {});
    const { container } = render(<ChapterWorkbench />);
    const btn = container.querySelector('.workbench-col-header[data-col-index="1"] [data-action="add-scene"]') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(useAppStore.getState().selectedNodeId).toBeNull();
    expect(useAppStore.getState().drawerTitleFocus).not.toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T15（发现批7·实时变宽）：resize 手势期 chip 格跨实时跟随——经**父层真实 seam**
// （ChapterWorkbench resolveColumnBoxAt ← injectColumnRects 注入的 fake rect 表，
// canvasZoom 缺省 1 = 恒等归一）。孤立组件测见 workbenchResize.test；本组钉的是
// 「列盒 seam 接线后全链产出正确 inline 宽」——漏接 resolveColumnBox prop 即红。
// ─────────────────────────────────────────────────────────────────────────────

describe('T15 live-widen wiring (fake rect injection, parent seam)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
    errorSpy.mockRestore();
  });

  it('s1 右把手拖至第 2 格 → 卡体实时 2 格宽（240px）；拖回回 1 格；抬手清零', () => {
    const eps = EPISODES();
    // spy 先于 render（useWeavingEdit 经 hook 选择器捕获 updateField——render 后
    // 再 spy 组件闭包看不到，断言会假绿）。
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    injectColumnRects(container, episodeTrackCountOf(eps));
    // s1：单章卡 ch0（canExtendRight = has(1) 真）。fake 表：col0 [100..220]，
    // col1 [220..340]——预览 [0..1] → width = 340−100 = 240px、margin-left 0。
    const chip = container.querySelector(
      '.workbench-chip[data-node-id="s1"]:not(.workbench-chip--pending)'
    ) as HTMLElement;
    const handle = chip.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(handle.getAttribute('data-disabled')).toBe('false');
    firePointer(handle, 'pointerdown', { clientX: xOfCol(0) });
    firePointer(handle, 'pointermove', { clientX: xOfCol(1) });
    expect(chip.style.width).toBe('240px');
    expect(chip.style.marginLeft).toBe('0px');
    expect(chip.style.maxWidth).toBe('none');
    // 拖回第 1 格：回单格宽。
    firePointer(handle, 'pointermove', { clientX: xOfCol(0) });
    expect(chip.style.width).toBe('120px');
    // 抬手提交等值区间 → 模型层引用级 no-op（零写）+ 预览盒复位（T23：抬手回
    // 装填盒——单章卡名义宽 108px + maxWidth none；jsdom 无实测 → 无 inline
    // height，内容自撑）。
    firePointer(handle, 'pointerup', { clientX: xOfCol(0) });
    expect(updateSpy).not.toHaveBeenCalled();
    expect(chip.style.width).toBe('108px');
    expect(chip.style.maxWidth).toBe('none');
    expect(chip.style.height).toBe('');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T14（发现批6·真机红）：拖拽准入全死 + 标号不更新——槽位侧准入矩阵 + 序号活性。
//
// 真机探针读数「全部槽 dragover preventDefault=false / dropEffect=none」的源码面
// 核对：工作台槽位准入（onCellDragOver）**零 store/memo 消费**——只读
// dataTransfer.types（MIME 门控），不存在「陈旧 memo 冻结准入」的路径；drop 解析
// （T1/T2 梯）与序号派生（readIndex）才吃 memo。本组三测分别钉：
//   1. drag→drop 成功后，全部可落槽位准入保持 move（无状态残留杀准入——含对
//      主会话合成探针「dragstart 后任意格 none」的 jsdom 反证：共享 dataTransfer
//      下准入恒放行；真机读数的成因归档见任务报告——非 bubbling 合成事件/
//      逐事件新 dataTransfer/被 preventDefault 的 dragstart 三者皆可产出该读数）；
//   2. 中断序列（dragend 无 drop / dragstart 后零收尾）后准入照常；
//   3. 章移动后 chip 阅读序号即时刷新（readIndex 派生链渲染面活着——「标号不随
//      移动更新」的 UI 侧回归锚）。
// ─────────────────────────────────────────────────────────────────────────────

describe('T14: drag admission liveness + ordinal refresh (发现批6)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });
  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
  });

  /** 槽位准入探针：dragover 携共享 dataTransfer → preventDefault + dropEffect=move。 */
  function slotAdmits(slot: HTMLElement, dt: DataTransfer): boolean {
    const evt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'dataTransfer', { value: dt });
    act(() => {
      slot.dispatchEvent(evt);
    });
    return evt.defaultPrevented && dt.dropEffect === 'move';
  }

  /** 全部可落槽位（两线 × 三章）准入探针；返回未获准入的槽位选择器列表。 */
  function unfilledSlots(container: HTMLElement, dt: DataTransfer): string[] {
    const failed: string[] = [];
    for (const lineId of ['l_main', 'l_side']) {
      for (const c of [0, 1, 2]) {
        const slot = container.querySelector(slotSel(lineId, c)) as HTMLElement;
        if (!slotAdmits(slot, dt)) failed.push(`${lineId}@${c}`);
      }
    }
    return failed;
  }

  it('drag→drop 成功后全部可落槽位准入保持 move（无状态残留杀准入）', () => {
    const { container } = render(<ChapterWorkbench />);
    // 一次完整成功手势（真机序列第一段：ch1 卡挪 ch0 成功）。
    dragChipTo(container, 's_plain', slotSel('l_main', 0));
    // 同一 dataTransfer 上紧随其后的 dragover：全部真实章格照常放行。
    const dt = makeDataTransfer();
    const chip = container.querySelector(
      '.workbench-chip[data-node-id="s_plain"]:not(.workbench-chip--pending)'
    ) as HTMLElement;
    fireEvent.dragStart(chip, { dataTransfer: dt });
    expect(unfilledSlots(container, dt)).toEqual([]);
    // 换一枚新起手的 chip 同样全放行（无跨手势残留）。
    const dt2 = makeDataTransfer();
    const sideChip = container.querySelector('.workbench-chip[data-node-id="s_side"]') as HTMLElement;
    fireEvent.dragStart(sideChip, { dataTransfer: dt2 });
    expect(unfilledSlots(container, dt2)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('中断序列后准入照常：dragend 无 drop / dragstart 后零收尾（状态零悬空）', () => {
    const { container } = render(<ChapterWorkbench />);
    // 序列 A：dragstart → dragend（Esc/取消形态，无 drop）。
    const dtA = makeDataTransfer();
    const chipA = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    fireEvent.dragStart(chipA, { dataTransfer: dtA });
    fireEvent.dragEnd(chipA, { dataTransfer: dtA });
    expect(unfilledSlots(container, dtA)).toEqual([]);
    // 序列 B：dragstart 后无任何收尾事件（dragend 丢失形态）→ 新起手 + 准入照常。
    const dtB = makeDataTransfer();
    fireEvent.dragStart(chipA, { dataTransfer: dtB });
    const dtC = makeDataTransfer();
    const chipB = container.querySelector('.workbench-chip[data-node-id="s1"]') as HTMLElement;
    fireEvent.dragStart(chipB, { dataTransfer: dtC });
    expect(unfilledSlots(container, dtC)).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('章移动后 chip 阅读序号即时刷新（readIndex 派生链渲染面活着）', () => {
    const { container } = render(<ChapterWorkbench />);
    const before = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(before.getAttribute('data-read-index')).toBe('2'); // (ch1,pos0) 全局第 3 位
    expect(before.querySelector('.workbench-chip-ord')?.textContent).toBe('3');
    // 挪到 ch0（pos 0）：与 s1 平 (0,0) 票按数组序排后 → readIndex 1。
    dragChipTo(container, 's_plain', slotSel('l_main', 0));
    const after = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(after.getAttribute('data-read-index')).toBe('1');
    expect(after.querySelector('.workbench-chip-ord')?.textContent).toBe('2');
    // 连带重排：s_cross (0,1) 顺移到 readIndex 2（全局序即时重算，无冻结）。
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    expect(cross.getAttribute('data-read-index')).toBe('2');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T16b（发现批8·真机红「宽卡 8→7 能拖、7→8 拖不回」）：位移式平移集成——
// dragstart 记录抓起列（hook ref）、drop 消费（originCol 配对）。真机形态：宽卡
// spans [6..7]（第 7~8 章）从锚列拖到自身覆盖列 → 旧 G-F2 取消判据把整个覆盖区
// 判成静默取消；位移语义下 = 平移 +1，往返双通。
// ─────────────────────────────────────────────────────────────────────────────

describe('T16b: wide-card displacement translation (integration)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  /** 九章域（0..8）+ 宽卡 w78 spans [e6..e7]（第 7~8 章，锚列 6）。 */
  function wideNineChapterFixture() {
    const eps9 = parseEpisodes(
      Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, index: i, title: `C${i}` }))
    );
    const g = parseGraph({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        {
          id: 'w78', lineTags: ['l_main'], storyTime: 9, role: 'normal',
          presentationOrder: { chapter: 6, pos: 0 }, title: '宽卡 7-8',
          presentationSpans: [{ episodeId: 'e6', pos: 0 }, { episodeId: 'e7', pos: 0 }],
        },
      ],
      edges: [],
    });
    useAppStore.setState({
      creativeFields: { scene_graph: g, episode_outlines: eps9 },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
    return eps9;
  }

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    wideNineChapterFixture();
  });

  afterEach(() => {
    cleanup();
    updateSpy?.mockRestore();
    errorSpy.mockRestore();
  });

  it('锚列 6 → 自身覆盖列 7 = 位移 +1 平移 [7..8]（此前静默取消的真机红形态）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    dragChipTo(container, 'w78', slotSel('l_main', 7));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const spans = (updateSpy.mock.calls[0][1] as SceneGraph)
      .nodes.find((n) => n.id === 'w78')!
      .presentationSpans!.map((s) => s.episodeId);
    expect(spans).toEqual(['e7', 'e8']); // 宽度保持 + 位移 1
    // 渲染面：chip 挪到新锚列 7 的槽位（派生刷新链活着）。
    const destSlot = container.querySelector(slotSel('l_main', 7)) as HTMLElement;
    expect(destSlot.querySelector('[data-node-id="w78"]')).not.toBeNull();
    const prevSlot = container.querySelector(slotSel('l_main', 6)) as HTMLElement;
    expect(prevSlot.querySelector('[data-node-id="w78"]')).toBeNull();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('抓起列放回（位移 0）= 取消式零写（G-F2「拖起放回」语义保留）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    dragChipTo(container, 'w78', slotSel('l_main', 6));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('往返双通：6→7 平移 [7..8] 后 7→6 平移回 [6..7]（「拖得过去也拖得回」）', () => {
    updateSpy = vi.spyOn(useAppStore.getState(), 'updateField');
    const { container } = render(<ChapterWorkbench />);
    // 第一段：锚 6 → 7。
    dragChipTo(container, 'w78', slotSel('l_main', 7));
    expect(updateSpy).toHaveBeenCalledTimes(1);
    // 第二段：新锚 7 → 6（dragstart 重新记录抓起列 7）。
    dragChipTo(container, 'w78', slotSel('l_main', 6));
    expect(updateSpy).toHaveBeenCalledTimes(2);
    const spans = (updateSpy.mock.calls[1][1] as SceneGraph)
      .nodes.find((n) => n.id === 'w78')!
      .presentationSpans!.map((s) => s.episodeId);
    expect(spans).toEqual(['e6', 'e7']); // 数据净零复原
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T23（发现批10·宽卡天际线装填，用户三段拍板终案）：线行内 chip 全部绝对定位消费
// 装填输出（workbenchPacking 阅读序 first-fit 天际线）。jsdom 零 rect → 估算路径
// 全可算（纯数据+常量）——装填位置可断言；实测列盒接线经 fake rect 注入 + 重渲染
// 验证。v2 延伸带已退役（负断言）。
//
// fixture 装填推演（l_main，生产 geo；全部标题 1 行 → 高 26）：
//   s1[0..0] r0 → y0；s_cross[0..2] r1 撞 s1（col0）→ y28；s_plain[1..1] r2
//   只撞 s_cross——s_cross 顶带从 28 起，[0..28) 空 → first-fit 回填 y0（与 s1
//   共享首行，不同列）。最终：s1@2.4 / s_cross@30.4 / s_plain@2.4，
//   laneH = 2.4 + (28+26) + 2.4 = 58.8。
// ─────────────────────────────────────────────────────────────────────────────

describe('T23: lane skyline packing (integration)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    errorSpy.mockRestore();
  });

  it('l_main 装填几何：s1/s_plain 首行（first-fit 空穴回填）、s_cross 宽卡次行横跨 0-2；槽 minHeight=laneH；chip 仍属归属槽', () => {
    const { container } = render(<ChapterWorkbench />);
    const s1 = container.querySelector('.workbench-chip[data-node-id="s1"]') as HTMLElement;
    expect(s1.style.top).toBe('2.4px');
    expect(s1.style.left).toBe('0px');
    expect(s1.style.width).toBe('108px'); // 名义单列宽（jsdom 零 rect → 估算路径）
    // 宽卡让位：s_cross 撞 s1 → 下放次行；跨 3 章名义宽 324。
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    expect(cross.style.top).toBe('30.4px');
    expect(cross.style.width).toBe('324px');
    expect(cross.style.maxWidth).toBe('none');
    expect(cross.classList.contains('workbench-chip--packed')).toBe(true);
    expect(cross.classList.contains('workbench-chip--span')).toBe(true);
    // s_plain（ch1）只撞 s_cross——s_cross 顶带空 → 回填 y0（链式阶梯消失的构造性
    // 证明：不同列卡共享首行）。
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.style.top).toBe('2.4px');
    expect(plain.style.width).toBe('108px');
    // jsdom 估算帧：无实测高 → 无 inline height（内容自撑——「完全显示」托底）。
    expect(cross.style.height).toBe('');
    // chip 仍渲染为归属槽直接子节点（closest 契约不变）。
    expect((cross.closest('.workbench-slot') as HTMLElement).getAttribute('data-chapter')).toBe('0');
    expect((plain.closest('.workbench-slot') as HTMLElement).getAttribute('data-chapter')).toBe('1');
    // 线行高：同线全部章槽 inline minHeight = laneH（grid auto 行轨驱动位）。
    expect(
      (container.querySelector(slotSel('l_main', 1)) as HTMLElement).style.minHeight
    ).toBe('58.8px');
    // l_side 单卡线行 → 40 地板（2.4+26+2.4=30.8 < 40）。
    expect(
      (container.querySelector(slotSel('l_side', 2)) as HTMLElement).style.minHeight
    ).toBe('40px');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('实测列盒接线：注入 fake rect + 重渲染 → 跨列盒宽换真值（s_cross 360px / s_plain 120px）', () => {
    const eps = EPISODES();
    const { container } = render(<ChapterWorkbench />);
    // 真机时序对照：mount 的 settle effect 在真实 rect 下实测重排；jsdom 里
    // scrollHeight 恒 0（保持估算高）但列盒走 render 期直读——注入 fake rect 后
    // 任意一次重渲染即换真值（T18 零缓存纪律同款）。
    injectColumnRects(container, episodeTrackCountOf(eps));
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_cross' } as any);
    });
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    // s_cross 静态 [0..2] = col2.right − col0.left = 460−100 = 360px（实测跨列盒）。
    expect(cross.style.width).toBe('360px');
    const plain = container.querySelector('.workbench-chip[data-node-id="s_plain"]') as HTMLElement;
    expect(plain.style.width).toBe('120px'); // 单列 = fake 列宽
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('v2 延伸带退役 + 待编排灰片零扰动（in-flow 流态族，无 --packed）', () => {
    // 追加一枚 dangling（章 42 无对应 episode → 待编排灰片）。
    const g = sceneGraphSchema.parse({
      lines: [
        { id: 'l_main', name: '主线', topology_role: 'converging', is_main_thread: true },
        { id: 'l_side', name: '副线', topology_role: 'side' },
      ],
      nodes: [
        ...workbenchGraph().nodes,
        {
          id: 's_dangling', lineTags: ['l_side'], storyTime: 9, role: 'normal',
          presentationOrder: { chapter: 42, pos: 0 }, title: '深夜的访客',
        },
      ],
      edges: [],
    });
    useAppStore.setState({ creativeFields: { scene_graph: g, episode_outlines: EPISODES() } } as any);
    const { container } = render(<ChapterWorkbench />);
    // 延伸带零残留（任何形态）。
    expect(container.querySelector('.workbench-chip-span-band')).toBeNull();
    // 待编排灰片：无 --packed / 零 inline 装填坐标（in-flow 流态不受扰）+ 计数器在场。
    const pendingChip = container.querySelector('.workbench-chip[data-node-id="s_dangling"]') as HTMLElement;
    expect(pendingChip.classList.contains('workbench-chip--pending')).toBe(true);
    expect(pendingChip.classList.contains('workbench-chip--packed')).toBe(false);
    expect(pendingChip.style.top).toBe('');
    const pendingSlot = pendingChip.closest('.workbench-slot') as HTMLElement;
    expect(pendingSlot.getAttribute('data-chapter')).toBe('pending');
    expect(pendingSlot.querySelector('.lane-pending-counter')).not.toBeNull();
    expect(pendingSlot.style.minHeight).toBe(''); // 装填 minHeight 只挂章槽
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T23 真机回炉修正（max-depth）：settle 不动点回归。真机形态：measure→setState→
// re-measure 无限循环（jsdom 零布局不可达——scrollHeight 恒 0 提前退出，故 1770
// 全绿掩盖）。本组用 scrollHeight getter mock 复刻三类测量源形态，断言 settle 有
// 界停机（不抛 max-depth、读数封顶、高度有界）：
//   - 常量源（真实不动点）：第 1 轮设定 + 第 2 轮复核相等——共 2 读即停；
//   - ±ε 震荡源：epsilon 等值吞掉——2 读即停；
//   - 敌意增长源（每读 +2——边框双计回环的抽象形态，永无不动点）：轮次熔断停。
// ─────────────────────────────────────────────────────────────────────────────

describe('T23 settle fixed-point regression (hostile scrollHeight mocks)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    useAppStore.setState({
      creativeFields: { scene_graph: workbenchGraph(), episode_outlines: EPISODES() },
      overlayToggles: { validation: false, displacement: false, visibility: false, emotion: false, pacing: false },
      resolvedLocale: 'en-US',
      selectedNodeId: null,
      currentProject: null,
    } as any);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * mock 掉 title 元素的 scrollHeight getter（jsdom 原生恒 0——settle 提前退出，
   * 正是要绕开的口子）。fn 收 (el, 第几次被读)——可构造常量/震荡/增长三类源。
   * 返回 readsOf 探针（每元素读数）。非 title 元素照旧 0（jsdom 原生值）。
   */
  function mockTitleScrollHeight(fn: (el: HTMLElement, readCount: number) => number) {
    const reads = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype as unknown as { scrollHeight: number }, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        if (!this.classList?.contains('workbench-chip-title')) return 0;
        const n = (reads.get(this) ?? 0) + 1;
        reads.set(this, n);
        return fn(this, n);
      }
    );
    return { readsOf: (el: Element) => reads.get(el) ?? 0 };
  }

  it('常量源（真实不动点）：第 1 轮设定 + 第 2 轮复核相等——共 2 读停机；无关重渲染不重测', () => {
    const probe = mockTitleScrollHeight(() => 34); // 两行标题（≈ 2×16.848）
    const { container } = render(<ChapterWorkbench />);
    const cross = container.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    // 实测换算：max(26, max(18, 34) + 4 + 2) = 40。
    expect(cross.style.height).toBe('40px');
    const title = cross.querySelector('.workbench-chip-title') as HTMLElement;
    expect(probe.readsOf(title)).toBe(2); // 设定 + 复核——复核相等即停（不动点）
    // 无关重渲染（effect 依赖未变）不触发重测。
    act(() => {
      useAppStore.setState({ selectedNodeId: 's_cross' } as any);
    });
    expect(probe.readsOf(title)).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('±ε 震荡源（26.01/26 交替）：epsilon 等值吞掉——2 读即停（严格全等会在两值间永久震荡）', () => {
    const probe = mockTitleScrollHeight((_el, n) => (n % 2 === 1 ? 26.01 : 26));
    const { container } = render(<ChapterWorkbench />);
    const s1 = container.querySelector('.workbench-chip[data-node-id="s1"]') as HTMLElement;
    // 第 1 读 26.01 → need = max(26, 26.01+6) = 32.01；第 2 读 26 → need 32，
    // |Δ|=0.01 ≤ 0.5 → epsilon 相等——不再 setState（第 3 读不存在）。
    expect(s1.style.height).toBe('32.01px');
    expect(probe.readsOf(s1.querySelector('.workbench-chip-title') as HTMLElement)).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('敌意增长源（每读 +2——双计回环的抽象形态，永无不动点）：轮次熔断停——不抛 max-depth、读数封顶、高度有界、warn 一次', () => {
    const probe = mockTitleScrollHeight((_el, n) => 18 + 2 * n);
    // 旧形（测 chip 自身 scrollHeight + 边框补偿 + 严格全等）在此形态下
    // measure→setState→re-measure 无限增长——真机 max-depth 崩溃的复刻。
    let container: HTMLElement | null = null;
    let threw = false;
    try {
      container = render(<ChapterWorkbench />).container;
    } catch {
      threw = true; // React "Maximum update depth exceeded" 会从 render 的 act 抛出
    }
    expect(threw).toBe(false);
    const cross = container!.querySelector('.workbench-chip[data-node-id="s_cross"]') as HTMLElement;
    // 熔断轨迹：第 k 读值 18+2k → need = 24+2k；8 轮 setState 后第 9 轮复核不等 →
    // 熔断停。最终 applied = 第 8 轮值 = 40，读数封顶 9（= MAX_SETTLE_ROUNDS+1）。
    expect(cross.style.height).toBe('40px');
    const reads = probe.readsOf(cross.querySelector('.workbench-chip-title') as HTMLElement);
    expect(reads).toBe(MAX_SETTLE_ROUNDS + 1);
    // 追加 flush：读数不再增长（settle 已停——无 setState 即无 effect 再入）。
    act(() => {});
    expect(
      probe.readsOf(cross.querySelector('.workbench-chip-title') as HTMLElement)
    ).toBe(reads);
    expect(warnSpy).toHaveBeenCalledTimes(1); // 熔断可观测性（一次即够）
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
