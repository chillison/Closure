/**
 * dogfood R2 批次 B（SP-5）：卷背景带纯推导 deriveVolumeBands 单测。
 *
 * 归属/冲突取舍在 volumeBands.ts 文件头声明，此处逐条锁定：
 *   - 逐 cell 归属（多线 node 对各卷各计 1）
 *   - 同列多卷交叠 → cell 数最多者赢；平票 → outline.phases 声明序更早者赢
 *   - rangesByPhase = 各卷归属列的 min/max 闭包（不论逐列输赢）
 *   - 未分卷（无 phase_ref / dangling ref / 零归属列）→ phaseId=null 灰带
 *   - 相邻同赢家合并；同卷被别卷打断 → 多 band 同色号
 *
 * dogfood R2 #80 起增 volumeBandsFromEpisodes（章轴集映射——episode.phase_ref
 * 直接定卷）：三卷合并 / 悬空·缺锚·gap 灰带 / 空与防御 / 重复 index 与界外 /
 * 「稀疏场景但集全挂卷 → 零灰带」投币对照回归钥。
 *
 * 走真实管线：sceneGraphSchema.parse 夹具 → deriveWorkbenchLayout（批 7 单源——
 * 卷带换轴章轴后 causalSlots 的伪 cell {lineId,colValue:起始章} 即消费面）→
 * 稠密章 cols，再喂 deriveVolumeBands（不手搓伪 cell——防夹具与真实派生漂移）。
 *
 * Run: `cd apps/desktop/client/ui && pnpm test volumeBands`
 */
import { describe, expect, it } from 'vitest';
import {
  episodeOutlinesSchema,
  sceneGraphSchema,
  type SceneGraph,
} from '@orison/shared-contracts';
import { deriveWorkbenchLayout } from '../src/features/structure/workbenchLayout';
import {
  deriveVolumeBands,
  volumeBandsFromEpisodes,
  volumeBandColorIndex,
  type OutlinePhase,
} from '../src/features/structure/volumeBands';

function parseGraph(raw: unknown): SceneGraph {
  return sceneGraphSchema.parse(raw);
}

function phase(id: string, title = id): OutlinePhase {
  return { id, title };
}

/**
 * 夹具 episode 池：单源 `test/helpers/episodePool.ts`（曾与本目录 sceneGraphLayout
 * .test 逐字节复制——CR 组 1 测试卫生；legacy episodeId 已并入计轨）。投币路径
 * 专用（池不带 phase_ref）；集映射路径的 episodes 见各用例（#80 权威源在数据里）。
 */
import { poolFor } from './helpers/episodePool';

/**
 * 批 7 章轴管线：graph → 单源派生 → causalSlots 伪 cell + 稠密章 cols → 卷带。
 * （NTP 面板层同构；此处返回 trackCount 供断言轨道集合。）
 */
function derive(graph: SceneGraph, phases: OutlinePhase[]) {
  const wb = deriveWorkbenchLayout(graph, poolFor(graph));
  const pseudoCells = [...wb.causalSlots.values()]
    .flat()
    .map((c) => ({ lineId: c.lineId, colValue: c.colValue }));
  const denseCols = Array.from({ length: wb.chapterTrackCount }, (_, i) => i);
  return {
    ...deriveVolumeBands(pseudoCells, graph.lines, phases, denseCols),
    trackCount: wb.chapterTrackCount,
  };
}

/** 场景夹具简写：归属章即列语义（storyTime 不再参与列推导）。 */
function scene(id: string, lineTags: string[], chapter: number) {
  return {
    id,
    lineTags,
    storyTime: chapter + 1,
    role: 'normal' as const,
    presentationOrder: { chapter, pos: 0 },
  };
}

describe('deriveVolumeBands', () => {
  it('single phased line → one band spanning all its columns; range closure = min..max', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' }],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l1'], 1),
        scene('s3', ['l1'], 2),
      ],
      edges: [],
    });
    const { bands, rangesByPhase, trackCount } = derive(g, [phase('p1', '卷一')]);
    expect(trackCount).toBe(3);
    expect(bands).toEqual([{ phaseId: 'p1', title: '卷一', fromCol: 0, toCol: 2 }]);
    expect(rangesByPhase.get('p1')).toEqual({ fromCol: 0, toCol: 2 });
  });

  it('scenes on an unphased line fall into a null (unassigned) grey band', () => {
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '闲笔', topology_role: 'side' },
      ],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l1'], 1),
        scene('s3', ['l2'], 2),
      ],
      edges: [],
    });
    const { bands } = derive(g, [phase('p1')]);
    expect(bands).toEqual([
      { phaseId: 'p1', title: 'p1', fromCol: 0, toCol: 1 },
      { phaseId: null, title: '', fromCol: 2, toCol: 2 },
    ]);
  });

  it('same-column volume overlap → the volume with the most cells wins the column', () => {
    // 章 0 列：p1 有 1 cell（s_a@l1）vs p2 有 2 cells（s_b/s_c 同章堆叠 @l2）→ p2。
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '乙', topology_role: 'side', phase_ref: 'p2' },
      ],
      nodes: [
        scene('s_a', ['l1'], 0),
        scene('s_b', ['l2'], 0),
        scene('s_c', ['l2'], 0),
      ],
      edges: [],
    });
    const { bands } = derive(g, [phase('p1'), phase('p2')]);
    expect(bands).toEqual([{ phaseId: 'p2', title: 'p2', fromCol: 0, toCol: 0 }]);
  });

  it('count tie → the EARLIER phase in outline.phases wins (declaration order, not id)', () => {
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'pZ' },
        { id: 'l2', name: '乙', topology_role: 'side', phase_ref: 'pA' },
      ],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l2'], 0),
      ],
      edges: [],
    });
    // 声明序 [pZ, pA] → 平票归 pZ；反序 [pA, pZ] → 平票归 pA（证 order 驱动非 id 驱动）。
    expect(derive(g, [phase('pZ'), phase('pA')]).bands[0]?.phaseId).toBe('pZ');
    expect(derive(g, [phase('pA'), phase('pZ')]).bands[0]?.phaseId).toBe('pA');
  });

  it('rangesByPhase keeps the min/max closure even when an inner column is won by another volume', () => {
    // p1 cells at 章 0 & 2；p2 cell at 章 1 → p1 range closure {0..2}，章 1 归 p2。
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '乙', topology_role: 'side', phase_ref: 'p2' },
      ],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l2'], 1),
        scene('s3', ['l1'], 2),
      ],
      edges: [],
    });
    const { bands, rangesByPhase } = derive(g, [phase('p1'), phase('p2')]);
    expect(bands.map((b) => b.phaseId)).toEqual(['p1', 'p2', 'p1']);
    expect(rangesByPhase.get('p1')).toEqual({ fromCol: 0, toCol: 2 });
    expect(rangesByPhase.get('p2')).toEqual({ fromCol: 1, toCol: 1 });
  });

  it('a volume interrupted by another volume splits into multiple bands with the SAME colour index', () => {
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '乙', topology_role: 'side', phase_ref: 'p2' },
      ],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l2'], 1),
        scene('s3', ['l1'], 2),
      ],
      edges: [],
    });
    const phases = [phase('p1'), phase('p2')];
    const { bands } = derive(g, phases);
    const p1Bands = bands.filter((b) => b.phaseId === 'p1');
    expect(p1Bands).toHaveLength(2);
    // 同卷多 band 同色号（outline 序 % 3）——被打断不换色。
    expect(volumeBandColorIndex(p1Bands[0]!, phases)).toBe(volumeBandColorIndex(p1Bands[1]!, phases));
    // p1 是 phases[0] → 色号 0；未分卷 → -1（灰类）。
    expect(volumeBandColorIndex(p1Bands[0]!, phases)).toBe(0);
    expect(volumeBandColorIndex({ phaseId: null, title: '', fromCol: 0, toCol: 0 }, phases)).toBe(-1);
  });

  it('dangling phase_ref (line points at a phase not in outline) → unassigned', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true, phase_ref: 'ghost' }],
      nodes: [scene('s1', ['l1'], 0)],
      edges: [],
    });
    const { bands, rangesByPhase } = derive(g, [phase('p1')]);
    expect(bands).toEqual([{ phaseId: null, title: '', fromCol: 0, toCol: 0 }]);
    expect(rangesByPhase.size).toBe(0);
  });

  it('multi-line node attributes one cell per lineTag to each line\'s volume (symmetric counting)', () => {
    // s1 桥接 l1(p1)+l2(p2)@章0 → 两卷各计 1（平票 → 声明序早者赢该列）。
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '乙', topology_role: 'side', phase_ref: 'p2' },
      ],
      nodes: [
        { id: 's1', lineTags: ['l1', 'l2'], storyTime: 1, role: 'normal', presentationOrder: { chapter: 0, pos: 0 } },
      ],
      edges: [],
    });
    const { bands, rangesByPhase } = derive(g, [phase('p1'), phase('p2')]);
    expect(bands).toEqual([{ phaseId: 'p1', title: 'p1', fromCol: 0, toCol: 0 }]);
    // 两卷的区间闭包都含该列（对称归属，无首线偏袒）。
    expect(rangesByPhase.get('p1')).toEqual({ fromCol: 0, toCol: 0 });
    expect(rangesByPhase.get('p2')).toEqual({ fromCol: 0, toCol: 0 });
  });

  it('no phases at all → every column unassigned (panel guards this off, fn stays total)', () => {
    const g = parseGraph({
      lines: [{ id: 'l1', name: '主线', topology_role: 'converging', is_main_thread: true }],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l1'], 1),
      ],
      edges: [],
    });
    const { bands } = derive(g, []);
    expect(bands).toEqual([{ phaseId: null, title: '', fromCol: 0, toCol: 1 }]);
  });
});

describe('volumeBandsFromEpisodes（dogfood R2 #80：章轴集映射——episode.phase_ref 直接定卷）', () => {
  it('三卷连续段各自合并成带（章序 = episode.index 升序，fromCol/toCol = 章列 index）', () => {
    const bands = volumeBandsFromEpisodes(
      [
        { index: 0, phase_ref: 'p1' },
        { index: 1, phase_ref: 'p1' },
        { index: 2, phase_ref: 'p2' },
        { index: 3, phase_ref: 'p2' },
        { index: 4, phase_ref: 'p3' },
      ],
      [phase('p1', '卷一'), phase('p2', '卷二'), phase('p3', '卷三')]
    );
    expect(bands).toEqual([
      { phaseId: 'p1', title: '卷一', fromCol: 0, toCol: 1 },
      { phaseId: 'p2', title: '卷二', fromCol: 2, toCol: 3 },
      { phaseId: 'p3', title: '卷三', fromCol: 4, toCol: 4 },
    ]);
  });

  it('缺锚/悬空集夹灰带：相邻 null 合并成一段，同卷被它打断成两 band（色号仍同源 phases 序）', () => {
    const bands = volumeBandsFromEpisodes(
      [
        { index: 0, phase_ref: 'p1' },
        { index: 1, phase_ref: 'p1' },
        { index: 2 }, // 缺锚（LLM 先排章后补 phase 的中间态）
        { index: 3, phase_ref: 'ghost' }, // 悬空（指向不存在的 phase）
        { index: 4, phase_ref: 'p1' },
      ],
      [phase('p1'), phase('p2')]
    );
    expect(bands).toEqual([
      { phaseId: 'p1', title: 'p1', fromCol: 0, toCol: 1 },
      { phaseId: null, title: '', fromCol: 2, toCol: 3 },
      { phaseId: 'p1', title: 'p1', fromCol: 4, toCol: 4 },
    ]);
  });

  it('gap 轨（无 episode 的中间章）落未分卷灰带——与投币路径 denseCols 口径一致', () => {
    const bands = volumeBandsFromEpisodes(
      [
        { index: 0, phase_ref: 'p1' },
        { index: 2, phase_ref: 'p2' },
      ],
      [phase('p1'), phase('p2')]
    );
    expect(bands).toEqual([
      { phaseId: 'p1', title: 'p1', fromCol: 0, toCol: 0 },
      { phaseId: null, title: '', fromCol: 1, toCol: 1 },
      { phaseId: 'p2', title: 'p2', fromCol: 2, toCol: 2 },
    ]);
  });

  it('空/非数组 episodes → 空带（CR-001 口径：store 原样引用防御性归零）', () => {
    expect(volumeBandsFromEpisodes([], [phase('p1')])).toEqual([]);
    expect(volumeBandsFromEpisodes(undefined as unknown as [], [phase('p1')])).toEqual([]);
  });

  it('确定性边界：同 index 重复以后枚胜（mirror episodeByIndex 覆盖写）；界外 index 整枚跳过（#125 同界）', () => {
    const bands = volumeBandsFromEpisodes(
      [
        { index: 0, phase_ref: 'p1' },
        { index: 0, phase_ref: 'p2' },
        { index: 999, phase_ref: 'p1' }, // ≥ MAX_CHAPTER_TRACKS → 渲染轨道不存在
      ],
      [phase('p1'), phase('p2')]
    );
    expect(bands).toEqual([{ phaseId: 'p2', title: 'p2', fromCol: 0, toCol: 0 }]);
  });

  it('#80 回归钥：稀疏场景但集全挂卷 → 集映射零灰带（同图投币灰带交错——旧症状在场证明）', () => {
    // 真实工程形态缩影（160 章 38 场 → 7 章 3 场）：章 0/3/6 各一场，中间章无场景；
    // 章表 phase_ref 7/7 有效（i≤3 挂 p1、其余 p2）。
    const g = parseGraph({
      lines: [
        { id: 'l1', name: '甲', topology_role: 'converging', is_main_thread: true, phase_ref: 'p1' },
        { id: 'l2', name: '乙', topology_role: 'side' },
      ],
      nodes: [
        scene('s1', ['l1'], 0),
        scene('s2', ['l1'], 3),
        scene('s3', ['l2'], 6),
      ],
      edges: [],
    });
    const eps = episodeOutlinesSchema.parse(
      Array.from({ length: 7 }, (_, i) => ({
        id: `e${i}`,
        index: i,
        title: `第${i + 1}章`,
        phase_ref: i <= 3 ? 'p1' : 'p2',
      }))
    );
    const phases = [phase('p1', '卷一'), phase('p2', '卷二')];
    // 旧路径（场景投币——storyTime 轴保留者）喂章轴伪 cell：无场景章零票 → 灰带
    // 与卷色交错，正是 #80 的症状形态。
    const wb = deriveWorkbenchLayout(g, eps);
    const pseudoCells = [...wb.causalSlots.values()]
      .flat()
      .map((c) => ({ lineId: c.lineId, colValue: c.colValue }));
    const denseCols = Array.from({ length: wb.chapterTrackCount }, (_, i) => i);
    const voted = deriveVolumeBands(pseudoCells, g.lines, phases, denseCols).bands;
    expect(voted.some((b) => b.phaseId === null)).toBe(true);
    // 新路径（#80 修后章轴消费方产出）：卷一 [0..3] + 卷二 [4..6]，零灰带。
    const mapped = volumeBandsFromEpisodes(eps, phases);
    expect(mapped).toEqual([
      { phaseId: 'p1', title: '卷一', fromCol: 0, toCol: 3 },
      { phaseId: 'p2', title: '卷二', fromCol: 4, toCol: 6 },
    ]);
    expect(mapped.every((b) => b.phaseId !== null)).toBe(true);
  });
});
