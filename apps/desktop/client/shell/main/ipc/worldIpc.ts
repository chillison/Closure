/**
 * dogfood R2 #92：世界状态面板读面 IPC（design v2「三级缩放 + 实时交互」· implement.md S2；
 * BMad CR 2026-08-30 #1+#200 / #3+#104 / #4 / #13 修订）。
 *
 * 三只读通道（`world:overview` / `world:slice-detail` / `world:subject-detail`——desktopIpcSchema
 * enum S1 已登记），数据契约单源 contracts/world-panel.ts。**纯读面零写副作用**：取数全部经
 * worldStateRepository 读接口；活动计数走 db 层 GROUP BY 聚合查询（CR #1+#200——**不实例化
 * patch 行**，替代旧「全量 listWorldSlices({withPatches:true}) 内存现算」的轻查询违例）：
 *
 * - overview = listWorldSubjects + listWorldSubjectActivityStats（每主体 patchCount/lastStoryTime/
 *   axes）+ listWorldAnchorStats（每 storyTime subjectCount/patchCount/axisCounts）+ listWorldSlices
 *   仅 slice 行（锚点 label=title / epRange 归并源）。**零 patch 的 storyTime 无锚点行、不抬
 *   latestT**（CR #13——锚点计数源 = patch 行 GROUP BY，空切片天然无行）；patchTotal = 锚点
 *   patchCount 合计。
 * - slice-detail = listWorldSlices({withPatches, storyTime: t})——**storyTime 精确切窄**，只拉该
 *   时点 patches（CR #1+#200，修掉与 overview 的全量照会共享；同 storyTime 跨多 slice：一场景
 *   跨多章时每章各产 `${episodeId}:${storyTime}` 切片，归并成同一锚点，research §1.2/§2.4）；
 *   主体组头行同 overview 聚合源（全史口径，契约注释）。
 * - subject-detail = listWorldPatches（全史，按主体收窄）。**零 reduce 计算**（CR #4：as-of 切线
 *   的快照折叠/issues 是 UI 本地纯函数重算——reduceSubject 单源复用，全史 patches 已在手；
 *   通道不收 at，切线零 IPC 不变式由「全史一次拉回」承载）。
 *
 * TODO(dogfood #92 S3+)：AnchorRow.label 的语义源是 project.yaml 场 storyTimeLabel（「入学首日」）
 * ——repository 无现成查询面，本版 label 以 slice.title 代（title 同源）。接 storyTimeLabel 时**勿
 * 为它加 db 面**：走 local-bff loadProject（mirror worldStateMaterialize 三源读取）在 handler 组装。
 *
 * TODO(dogfood #92 S3+)：overview.extracting（「世界提取中…」态）本版不产（shell 侧无写章链世界
 * 提取相位的现成真相源；schema optional 缺省）。S3 若需真源，从 per-project run 租约（agentIpc）
 * 或链相位事件推导，不在本层造轮询。
 *
 * 入口无路径解析：projectId = registry 5 位 id（mirror closureIndexIpc 的 projectId 直查形态——
 * 读查询参数全绑定，无路径安全面）；Zod 在 handler 入口校验（ipc-handlers.md「Zod 在边界」），
 * 坏参 throw（模式 B 不变量，mirror task:upsert 的 parse 形态）。
 */
import { ipcMain } from 'electron';
import {
  worldOverviewRequestSchema,
  worldSliceDetailRequestSchema,
  worldSubjectDetailRequestSchema,
  type WorldAnchorRow,
  type WorldOverview,
  type WorldPatch,
  type WorldPatchAxis,
  type WorldSlice,
  type WorldSliceDetail,
  type WorldSubject,
  type WorldSubjectDetail,
  type WorldSubjectRow,
} from '@orison/shared-contracts';
import {
  listWorldAnchorStats,
  listWorldPatches,
  listWorldSlices,
  listWorldSubjects,
  listWorldSubjectActivityStats,
  type WorldAnchorStats,
  type WorldSubjectActivityStats,
} from '../db/worldStateRepository';

// ── 每主体活动投影（WorldSubjectRow）──

/** 轴呈现序 = worldPatchAxisSchema enum 序（physical→cognitive→emotional→relational→factional）。 */
const AXIS_ORDER: readonly WorldPatchAxis[] = [
  'physical',
  'cognitive',
  'emotional',
  'relational',
  'factional',
];
/** 已知五轴集合（db 轴漂移防御——未知轴不进 axes/axisCounts，仍计入 patchCount）。 */
const KNOWN_AXES: ReadonlySet<string> = new Set(AXIS_ORDER);

/**
 * 单主体聚合行。registeredById 未命中（patch 引用未登记主体——数据漂移防御）时合成 entity 哨兵
 * 形态（#91 迁移同语义），不静默丢组（L2 组头完整性）。计数源 = db 聚合行（全史口径，
 * SubjectRow.patchCount / axes 契约语义）；无聚合行 = 登记未写（0 / null / []）。
 */
function subjectRowFor(
  subjectId: string,
  registeredById: Map<string, WorldSubject>,
  statsById: Map<string, WorldSubjectActivityStats>,
): WorldSubjectRow {
  const stat = statsById.get(subjectId);
  const base: WorldSubject = registeredById.get(subjectId) ?? {
    id: subjectId,
    type: 'entity',
    firstSeenStoryTime: stat?.firstStoryTime ?? 0,
  };
  return {
    ...base,
    patchCount: stat?.patchCount ?? 0,
    // null = 无任何 patch（登记未写——契约注释：主体选择区沉底呈现的判定键）。
    lastStoryTime: stat?.lastStoryTime ?? null,
    // db 聚合 axes 无序——canonical 轴序在此归一（AXIS_ORDER filter 兼做未知轴过滤）。
    axes: stat ? AXIS_ORDER.filter((a) => stat.axes.includes(a)) : [],
  };
}

// ── storyTime 场锚点（WorldAnchorRow）──

/** 全键 total record 构造器（缺轴计 0——契约：灰显由数据承载，UI 不各自补默认）。 */
function zeroAxisCounts(): Record<WorldPatchAxis, number> {
  return { physical: 0, cognitive: 0, emotional: 0, relational: 0, factional: 0 };
}

/** 尾部数字串拆分（'ep1-10' → {head:'ep1-', tail:10}；无数字尾 → tail null）。 */
function splitTrailingNumber(id: string): { head: string; tail: number | null } {
  const m = /^(.*?)(\d+)$/.exec(id);
  if (!m) return { head: id, tail: null };
  return { head: m[1], tail: Number.parseInt(m[2], 10) };
}

/**
 * 章 id 数值序 comparator（BMad CR #3+#104——修字典序倒置：`'ep1-10' < 'ep1-9'` 按字典序使
 * epRange 首尾倒挂）。先比数字尾外的 head（跨卷 `ep1-…` < `ep2-…` 正确），head 同则尾数字
 * **数值**序（ep1-9 < ep1-10 < ep1-101）；任一无数字尾回退 localeCompare 全串。
 */
function compareEpisodeIds(a: string, b: string): number {
  const sa = splitTrailingNumber(a);
  const sb = splitTrailingNumber(b);
  if (sa.tail !== null && sb.tail !== null) {
    if (sa.head !== sb.head) return sa.head.localeCompare(sb.head);
    return sa.tail !== sb.tail ? sa.tail - sb.tail : a.localeCompare(b);
  }
  return a.localeCompare(b);
}

/**
 * 章范围徽标（contract 示例 "ep1-13..20"）：去重**数值尾排序**后公共前缀 + 双侧数字尾 → 紧凑形；
 * 非数字尾回落全 id `a..b`；单 id 原样；无 episodeId → undefined（「不可算时缺省」）。
 */
function computeEpRange(episodeIds: Array<string | undefined>): string | undefined {
  const uniq = [
    ...new Set(episodeIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ].sort(compareEpisodeIds);
  if (uniq.length === 0) return undefined;
  if (uniq.length === 1) return uniq[0];
  const first = uniq[0];
  const last = uniq[uniq.length - 1];
  let i = 0;
  while (i < first.length && i < last.length && first[i] === last[i]) i += 1;
  const head = first.slice(0, i);
  const firstTail = first.slice(i);
  const lastTail = last.slice(i);
  if (/^\d+$/.test(firstTail) && /^\d+$/.test(lastTail)) {
    return `${head}${firstTail}..${lastTail}`;
  }
  return `${first}..${last}`;
}

/** 组内首个非空 slice.title（merge 机械取「首个非空轴标题」的镜像；组序 = repo id ASC，确定性）。 */
function firstNonEmptyTitle(slices: WorldSlice[]): string | undefined {
  for (const s of slices) {
    if (typeof s.title === 'string' && s.title.length > 0) return s.title;
  }
  return undefined;
}

/** 锚点行的 label/title/epRange 装配（label 现以 slice.title 代，见文件头 TODO）。 */
function anchorChrome(slices: WorldSlice[]): Pick<WorldAnchorRow, 'label' | 'title' | 'epRange'> {
  const title = firstNonEmptyTitle(slices);
  return { label: title, title, epRange: computeEpRange(slices.map((s) => s.episodeId)) };
}

/**
 * L1 锚点行：db 聚合计数（listWorldAnchorStats——零 patch storyTime 无行，CR #13）× slice 行
 * 归并（title/epRange）。slice 行缺失（数据漂移）时计数照用、chrome 字段缺省——graceful 不造数。
 */
function buildOverviewAnchors(stats: WorldAnchorStats[], slices: WorldSlice[]): WorldAnchorRow[] {
  const slicesByT = new Map<number, WorldSlice[]>();
  for (const slice of slices) {
    const group = slicesByT.get(slice.storyTime);
    if (group) group.push(slice);
    else slicesByT.set(slice.storyTime, [slice]);
  }
  return stats.map((stat) => ({
    t: stat.t,
    ...anchorChrome(slicesByT.get(stat.t) ?? []),
    subjectCount: stat.subjectCount,
    patchCount: stat.patchCount,
    axisCounts: stat.axisCounts,
  }));
}

/** L2 锚点行：该时点 patches 已在手（storyTime 精确拉取）——计数现算，与组内容同源。 */
function buildAnchorRowFromPatches(
  t: number,
  slices: Array<WorldSlice & { patches?: WorldPatch[] }>,
): WorldAnchorRow {
  const axisCounts = zeroAxisCounts();
  const subjectIds = new Set<string>();
  let patchCount = 0;
  for (const slice of slices) {
    for (const p of slice.patches ?? []) {
      patchCount += 1;
      subjectIds.add(p.subjectId);
      if (KNOWN_AXES.has(p.axis)) axisCounts[p.axis as WorldPatchAxis] += 1;
    }
  }
  return {
    t,
    ...anchorChrome(slices),
    subjectCount: subjectIds.size,
    patchCount,
    axisCounts,
  };
}

// ── 注册（registerAllIpc 恰一次；纯读通道无窗口面——world:changed 发射归 worldNotify 广播）──

export function registerWorldIpc(): void {
  ipcMain.handle('world:overview', async (_, input: unknown): Promise<WorldOverview> => {
    const { projectId } = worldOverviewRequestSchema.parse(input);
    const subjects = listWorldSubjects(projectId);
    const registeredById = new Map(subjects.map((s) => [s.id, s]));
    const statsById = new Map(
      listWorldSubjectActivityStats(projectId).map((s) => [s.subjectId, s]),
    );
    const anchors = buildOverviewAnchors(
      listWorldAnchorStats(projectId),
      // 仅 slice 行（锚点 title/epRange 归并源）——轻量，不带 withPatches（CR #1+#200）。
      listWorldSlices(projectId, {}),
    );
    return {
      // 登记主体 ∪ 聚合行里未登记的 subjectId（CR #6：patch 引用未登记主体时合成 entity 哨兵行，
      // 与 slice-detail 同口径——否则同一主体在 L2 可见可点、L1 选择区不可达，头部计数对不上）。
      subjects: [
        ...subjects.map((s) => subjectRowFor(s.id, registeredById, statsById)),
        ...[...statsById.keys()]
          .filter((id) => !registeredById.has(id))
          .sort()
          .map((id) => subjectRowFor(id, registeredById, statsById)),
      ],
      // 数据层升序（契约注释：UI 脊柱降序渲染——现在在上）。
      anchors,
      // patchTotal = 锚点 patchCount 合计（db 聚合行全集 = 项目全部 patch 行，无第三个真相源）。
      patchTotal: anchors.reduce((sum, a) => sum + a.patchCount, 0),
      // null = 空库（尚未提取任何世界状态——L1 空态判定键，契约注释）；零 patch slice 不抬此值（CR #13）。
      latestT: anchors.length > 0 ? anchors[anchors.length - 1].t : null,
    };
  });

  ipcMain.handle('world:slice-detail', async (_, input: unknown): Promise<WorldSliceDetail> => {
    const { projectId, t } = worldSliceDetailRequestSchema.parse(input);
    // storyTime 精确收窄（repo `at` 是 <= 累计语义，故用 storyTime opt——只拉该时点，CR #1+#200）；
    // 缺失时点 repo 返 [] → 零值锚点 + 空组（graceful 读：不 throw，UI 渲染「该时点无变更」
    // ——mirror 查询工具 friendly-empty 先例）。
    const slices = listWorldSlices(projectId, { withPatches: true, storyTime: t });
    const subjects = listWorldSubjects(projectId);
    const statsById = new Map(
      listWorldSubjectActivityStats(projectId).map((s) => [s.subjectId, s]),
    );
    const registeredById = new Map(subjects.map((s) => [s.id, s]));
    const patchesBySubject = new Map<string, WorldPatch[]>();
    for (const slice of slices) {
      for (const p of slice.patches ?? []) {
        const list = patchesBySubject.get(p.subjectId);
        if (list) list.push(p);
        else patchesBySubject.set(p.subjectId, [p]);
      }
    }
    const groups = [...patchesBySubject.keys()].sort().map((subjectId) => ({
      subject: subjectRowFor(subjectId, registeredById, statsById),
      patches: patchesBySubject.get(subjectId)!,
    }));
    return { anchor: buildAnchorRowFromPatches(t, slices), groups };
  });

  ipcMain.handle('world:subject-detail', async (_, input: unknown): Promise<WorldSubjectDetail> => {
    const { projectId, subjectId } = worldSubjectDetailRequestSchema.parse(input);
    // CR #4：仅全史 patches（按主体收窄）——as-of 切线快照折叠 / 轴过滤 / path 钻取 / issues 全部
    // UI 本地 reduceSubject 重算，通道零 reduce 计算、不收 at。
    return { patches: listWorldPatches(projectId, subjectId) };
  });
}
