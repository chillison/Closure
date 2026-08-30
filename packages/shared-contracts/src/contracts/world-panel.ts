import { z } from 'zod';
import { worldPatchAxisSchema, worldPatchSchema, worldSubjectSchema } from './world-state';
import type { WorldPatchAxis } from './world-state';

// ── dogfood R2 #92：世界状态面板读面契约（design v2「三级缩放 + 实时交互」）──
//
// 面板三读通道（world:overview / world:slice-detail / world:subject-detail）+ `world:changed` 推送
// 事件的载荷契约。纯读面（写面后置——重大误状态先经对话指挥 agent 修，prd 边界）。数据事实依据
// task research/world-event-system-reality.md：storyTime = 场级全局故事序数（非章号，与章序非线性
// 对齐）；读接口无分页（靠 at/subjectIds 参数收窄）；轴覆盖不恒定（缺轴是常态）。
//
// 设计要点（design「数据契约」+「权衡记录」；BMad CR 2026-08-30 #1+#200/#4/#8/#9 修订）：
// - 三通道而非一通道：L1 overview 轻查询保首开快——活动计数走 db 层 GROUP BY 聚合
//   （listWorldSubjectActivityStats / listWorldAnchorStats，不实例化 patch 行，CR #1+#200）；
//   patches 只出现在 L2（storyTime 精确切窄）/ L3（按主体收窄）。
// - 聚合行：WorldSubjectRow（主体 + 活动投影）/ WorldAnchorRow（storyTime 归并锚点 + 活动计数）
//   ——计数产自 SQL 聚合（repository 聚合查询，CR #1+#200），锚点 label/epRange/title 的切片归并
//   在 handler 内存做（slice 行轻量，非 patch 行）。
// - axisCounts 是**全键 total record**（缺轴计 0）：「轴 chips 计数 0 灰显」由数据承载，UI 不各自补
//     默认——缺省/钳制单源在契约（axisCounts 的 0 / lastStoryTime 的 null / latestT 的 null 语义都
//   在本文件注释定死，S2/S3 不另行约定）。
// - 复用 world-state.ts 既有 schema 组合（worldSubjectSchema / worldPatchSchema / worldIssueSchema），
//   零平行类型。
//
// ⚠️ 类型层 camelCase（db 列 snake_case，S2 shell worldIpc 聚合装配时做映射，db-repository.md 惯例）。
//
// expected_downstream_consumers:
// - S2 shell：main/ipc/worldIpc.ts 三 handler（入参用下方 request schema 校验 + 聚合装配）+
//   `world:changed` 三写入口发射（write_world_events handler / resetWorldStateForBackfill / amend
//   落点，事务提交后 best-effort send 不阻写路径）。
// - S2 preload：三 invoke + onWorldChanged/offWorldChanged 订阅面（removeListener 本监听器）。
// - S3 ui：worldStateSlice（三级视图状态机 + world:changed 事件驱动重拉，交互态不动）+
//   WorldStatePanel（L1 总览 / L2 时点切片 / L3 主体脊柱渲染）。

// ── 聚合行（L1/L2 共用投影）──

/**
 * 主体活动投影行（L1 主体选择区 / 活跃主体条 / L2 组头共用）= 既有 WorldSubject + 每主体一行
 * 最后变化轻量投影（数据源 listLastPatchFacts——不拉全量 patches）。
 */
export const worldSubjectRowSchema = worldSubjectSchema.extend({
  /** 该主体累计 patch 数；0 = 登记未写（resetWorldState 保身份、清切面的存量主体常态）。 */
  patchCount: z.number().int().nonnegative(),
  /** 最后一次变化的 storyTime；null = 无任何 patch（登记未写——主体选择区沉底呈现）。 */
  lastStoryTime: z.number().int().nullable(),
  /** 该主体涉足的轴（按固定轴序 physical→cognitive→emotional→relational→factional 去重——
   *  worldPatchAxisSchema enum 序，非字母序，BMad CR #11；缺轴是常态——轴随章内容有无，非恒全五轴）。 */
  axes: z.array(worldPatchAxisSchema),
});
export type WorldSubjectRow = z.infer<typeof worldSubjectRowSchema>;

/** 轴→计数 total record 的 shape（satisfies 强制全键：新增轴时此处编译期同步）。 */
const worldAxisCountShape = {
  physical: z.number().int().nonnegative(),
  cognitive: z.number().int().nonnegative(),
  emotional: z.number().int().nonnegative(),
  relational: z.number().int().nonnegative(),
  factional: z.number().int().nonnegative(),
} satisfies Record<WorldPatchAxis, z.ZodNumber>;

/**
 * storyTime 场锚点聚合行（L1 时点脊柱 / L2 面包屑 + 组头共用）。锚点 = 同 storyTime 归并的全部
 * patches（跨主体跨轴），label/epRange/title 缺省容忍（场景无标注 / 章窗不可算 / slice 无标题时
 * graceful 不造数）。
 */
export const worldAnchorRowSchema = z.object({
  /** storyTime 场锚点（全局故事序数；脊柱排序键——现在在上 = 降序渲染，数据层升序返回）。 */
  t: z.number().int(),
  /** 时点语义标签（project.yaml 场 storyTimeLabel，如「入学首日」；无标注场景缺省）。 */
  label: z.string().optional(),
  /** 章范围徽标（该 storyTime 覆盖的章窗，如 "ep1-13..20"——一场景可跨多章；不可算时缺省）。 */
  epRange: z.string().optional(),
  /** 场景标题（slice.title = merge 取该 storyTime 组首个非空轴标题；全空时缺省）。 */
  title: z.string().optional(),
  /** 该时点涉及的主体数。 */
  subjectCount: z.number().int().nonnegative(),
  /** 该时点 patch 总数。 */
  patchCount: z.number().int().nonnegative(),
  /** 轴→patch 数（**全键 total record，缺轴计 0**——灰显由数据承载；缺任一键 reject）。 */
  axisCounts: z.object(worldAxisCountShape),
});
export type WorldAnchorRow = z.infer<typeof worldAnchorRowSchema>;

// ── 三读通道响应 schema ──

/** L1 世界总览（面板默认视图；数据源 listWorldSubjects + listWorldSubjectActivityStats / listWorldAnchorStats db 聚合 + 切片行归并）。 */
export const worldOverviewSchema = z.object({
  subjects: z.array(worldSubjectRowSchema),
  /** storyTime 场锚点行（数据层升序；UI 脊柱降序渲染——现在在上）。 */
  anchors: z.array(worldAnchorRowSchema),
  /** 全项目 patch 总数。 */
  patchTotal: z.number().int().nonnegative(),
  /** 最新 storyTime；null = 空库（尚未从正文提取任何世界状态——L1 空态判定键）。 */
  latestT: z.number().int().nullable(),
  /** 写章链世界提取运行中（面板顶部「世界提取中…」细条，#82 相位可见性）；非运行缺省。 */
  extracting: z.boolean().optional(),
});
export type WorldOverview = z.infer<typeof worldOverviewSchema>;

/** L2 时点详情：该 storyTime 全部变更跨主体分组（数据源 listWorldSlices({withPatches, storyTime}) 精确切窄，BMad CR #1+#200）。 */
export const worldSliceDetailSchema = z.object({
  anchor: worldAnchorRowSchema,
  groups: z.array(
    z.object({
      subject: worldSubjectRowSchema,
      patches: z.array(worldPatchSchema),
    }),
  ),
});
export type WorldSliceDetail = z.infer<typeof worldSliceDetailSchema>;

/**
 * L3 主体详情：**仅全史 patches**（数据源 listWorldPatches——按主体收窄）。as-of 切线的快照折叠 /
 * issues 是 **UI 本地纯函数重算**（reduceSubject 单源复用，全史 patches 已在手零 IPC——「切线零
 * IPC」不变式保此形态）；shell 侧 reduce 计算 + reduced/issues 载荷是死开销，BMad CR #4 砍除。
 */
export const worldSubjectDetailSchema = z.object({
  /** 该主体全史 patches（轴过滤/path 钻取/as-of 折叠/issues 全部 UI 本地做——数据已在手零 IPC）。 */
  patches: z.array(worldPatchSchema),
});
export type WorldSubjectDetail = z.infer<typeof worldSubjectDetailSchema>;

// ── `world:changed` 推送事件（shell → renderer，main webContents.send）──

/**
 * `world:changed` 推送通道名（**单源常量**，BMad CR #8）：shell 发射器（worldNotify）/ preload 订阅面
 * （onWorldChanged / offWorldChanged）共同引用，禁各处硬编码。**不在** desktopIpcSchema enum——push
 * 事件与 update:event / tool:event / agent:stream-event 同例（enum 只收 invoke 通道）。
 *
 * dogfood R2 #99：常量本体迁入零依赖叶子 ./channels（zod-free）——preload sandbox
 * 只能内联无 zod 的模块图，此处 re-export 保住 barrel 消费面（shell worldNotify）
 * 的既有导入路径不变。
 */
export { WORLD_CHANGED_CHANNEL } from './channels';

/** world 数据写入种类（三写入口 + amendment 覆盖层）。 */
export const worldChangedKindSchema = z.enum([
  /** 写章链逐 slice 落表（toolExecution write_world_events handler 发射）。 */
  'slice-written',
  /** 全量重提取 reset（resetWorldStateForBackfill——清 patches/slices/checkpoint，保 subjects）。 */
  'backfill',
  /** reset（同 backfill 清理面，kind 语义区分调用来源）。 */
  'reset',
  /** amendment 覆盖层写入（amend 落点）。 */
  'amendment',
]);
export type WorldChangedKind = z.infer<typeof worldChangedKindSchema>;

/**
 * `world:changed` 事件载荷。三写入口全覆盖发射（事务提交后 best-effort，send 失败只 warn 不阻写
 * 路径）。面板响应（design「实时数据交互」）：L1 恒重拉；L2 当前 anchorT 受影响（sliceT 相同 /
 * backfill / reset）才重拉；L3 选中 subjectId ∈ subjectIds 才重拉——交互状态（as-of/轴过滤/钻取）
 * 与数据刷新解耦。
 *
 * **kind × 字段强绑定**（BMad CR #9+#108，superRefine 形状守门）：slice-written / amendment 必带
 * sliceT；此二 kind 带 subjectIds 时非空（无受影响主体 = 缺省不传）。backfill / reset 全量语义，
 * 二者不要求。
 */
export const worldChangedEventSchema = z
  .object({
    projectId: z.string().min(1),
    kind: worldChangedKindSchema,
    /** kind=slice-written / amendment 时的 slice storyTime（L2 判「当前时点受影响」用）。 */
    sliceT: z.number().int().optional(),
    /** 受影响主体（slice-written/amendment 填，非空；backfill/reset = 全量不清空——L3 无法收窄时保守重拉）。 */
    subjectIds: z.array(z.string().min(1)).optional(),
  })
  .superRefine((event, ctx) => {
    const perSliceKind = event.kind === 'slice-written' || event.kind === 'amendment';
    if (perSliceKind && event.sliceT === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sliceT'],
        message: `kind='${event.kind}' 必带 sliceT（该 slice 的 storyTime——L2 时点命中判定键）`,
      });
    }
    if (perSliceKind && event.subjectIds !== undefined && event.subjectIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['subjectIds'],
        message: `kind='${event.kind}' 的 subjectIds 须非空（无受影响主体时缺省不传）`,
      });
    }
  });
export type WorldChangedEvent = z.infer<typeof worldChangedEventSchema>;

// ── 三读通道请求入参 schema（S2 handler 入口 Zod 校验 + S3 调用面共用单源）──

/** world:overview 入参。 */
export const worldOverviewRequestSchema = z.object({
  projectId: z.string().min(1),
});
export type WorldOverviewRequest = z.infer<typeof worldOverviewRequestSchema>;

/** world:slice-detail 入参（t = storyTime 场锚点，非章号）。 */
export const worldSliceDetailRequestSchema = z.object({
  projectId: z.string().min(1),
  t: z.number().int(),
});
export type WorldSliceDetailRequest = z.infer<typeof worldSliceDetailRequestSchema>;

/**
 * world:subject-detail 入参。**无 as-of 参数**（BMad CR #4）：全史 patches 一次拉回，切线回放的
 * 快照折叠全部 UI 本地重算（「切线零 IPC」不变式），通道不收 as-of 截断点。
 */
export const worldSubjectDetailRequestSchema = z.object({
  projectId: z.string().min(1),
  subjectId: z.string().min(1),
});
export type WorldSubjectDetailRequest = z.infer<typeof worldSubjectDetailRequestSchema>;
