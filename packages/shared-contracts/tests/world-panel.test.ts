import { describe, expect, it } from 'vitest';
import {
  WORLD_CHANGED_CHANNEL,
  worldSubjectRowSchema,
  worldAnchorRowSchema,
  worldOverviewSchema,
  worldSliceDetailSchema,
  worldSubjectDetailSchema,
  worldChangedEventSchema,
  worldOverviewRequestSchema,
  worldSliceDetailRequestSchema,
  worldSubjectDetailRequestSchema,
  worldPatchSchema,
  type WorldAnchorRow,
  type WorldPatch,
  type WorldSubjectRow,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #92 世界状态面板读面契约（design v2 三级缩放 + 实时交互）。纯 Zod schema
// -> plain vitest。覆盖：
// - 聚合行（WorldSubjectRow / WorldAnchorRow）：既有字段继承 + 活动投影 + axisCounts 全键 total
// - 三读通道 roundtrip：overview（含空库）/ slice-detail / subject-detail（BMad CR #4 后仅 patches）
// - 三请求入参：t 必填 / projectId+subjectId 必填 / subject-detail 无 as-of 参数
// - worldChangedEvent：四 kind 各形态 + kind×字段强绑定（superRefine，BMad CR #9+#108）+ WORLD_CHANGED_CHANNEL 单源
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 valid WorldPatch（mirror world-state.test.ts mkPatch；value 仅在 !== undefined 时带）。 */
let patchSeq = 0;
function mkPatch(
  over: Pick<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'> &
    Partial<Omit<WorldPatch, 'subjectId' | 'path' | 'op' | 'storyTime'>>,
): WorldPatch {
  return worldPatchSchema.parse({
    id: over.id ?? `wp${++patchSeq}`,
    sliceId: over.sliceId ?? 'ep1-01:1',
    subjectId: over.subjectId,
    path: over.path,
    op: over.op,
    axis: over.axis ?? 'physical',
    source: over.source ?? 'derived',
    storyTime: over.storyTime,
    ...(over.value !== undefined ? { value: over.value } : {}),
    ...(over.summary ? { summary: over.summary } : {}),
    ...(over.evidenceSceneId ? { evidenceSceneId: over.evidenceSceneId } : {}),
  });
}

/** 构造 valid WorldSubjectRow（活动投影行）。 */
function mkSubjectRow(over: Partial<WorldSubjectRow> & Pick<WorldSubjectRow, 'id'>): WorldSubjectRow {
  return worldSubjectRowSchema.parse({
    id: over.id,
    type: over.type ?? 'character',
    firstSeenStoryTime: over.firstSeenStoryTime ?? 1,
    ...(over.name !== undefined ? { name: over.name } : {}),
    ...(over.sourceCardId !== undefined ? { sourceCardId: over.sourceCardId } : {}),
    patchCount: over.patchCount ?? 3,
    lastStoryTime: over.lastStoryTime ?? 2,
    axes: over.axes ?? ['physical', 'cognitive'],
  });
}

/** 构造 valid WorldAnchorRow（全键 axisCounts）。 */
function mkAnchor(over: Partial<WorldAnchorRow> & Pick<WorldAnchorRow, 't'>): WorldAnchorRow {
  return worldAnchorRowSchema.parse({
    t: over.t,
    ...(over.label !== undefined ? { label: over.label } : {}),
    ...(over.epRange !== undefined ? { epRange: over.epRange } : {}),
    ...(over.title !== undefined ? { title: over.title } : {}),
    subjectCount: over.subjectCount ?? 5,
    patchCount: over.patchCount ?? 7,
    axisCounts: over.axisCounts ?? { physical: 7, cognitive: 6, emotional: 3, relational: 0, factional: 0 },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 聚合行 schema
// ─────────────────────────────────────────────────────────────────────────────

describe('world-panel 聚合行 schema', () => {
  it('WorldSubjectRow：既有 WorldSubject 字段 + patchCount/lastStoryTime/axes（lastStoryTime null = 登记未写）', () => {
    const row = worldSubjectRowSchema.parse({
      id: 'character:shen-yan',
      type: 'character',
      name: '沈砚',
      firstSeenStoryTime: 1,
      patchCount: 13,
      lastStoryTime: 3,
      axes: ['physical', 'cognitive', 'emotional'],
    });
    expect(row.patchCount).toBe(13);
    expect(row.lastStoryTime).toBe(3);
    expect(row.axes).toEqual(['physical', 'cognitive', 'emotional']);

    // 登记未写（reset 保身份、清切面的存量主体）。
    const bare = worldSubjectRowSchema.parse({
      id: 'item:cryo-pod-01',
      type: 'item',
      firstSeenStoryTime: 1,
      patchCount: 0,
      lastStoryTime: null,
      axes: [],
    });
    expect(bare.lastStoryTime).toBeNull();
    expect(bare.axes).toEqual([]);
  });

  it('WorldSubjectRow：缺聚合字段 / lastStoryTime 非法形态 → reject', () => {
    expect(() =>
      worldSubjectRowSchema.parse({ id: 'x', type: 'character', firstSeenStoryTime: 1 }),
    ).toThrow();
    expect(() =>
      worldSubjectRowSchema.parse({
        id: 'x',
        type: 'character',
        firstSeenStoryTime: 1,
        patchCount: 1,
        lastStoryTime: undefined,
        axes: [],
      }),
    ).toThrow();
    expect(() =>
      worldSubjectRowSchema.parse({
        id: 'x',
        type: 'character',
        firstSeenStoryTime: 1,
        patchCount: 1,
        lastStoryTime: 1,
        axes: ['not-an-axis'],
      }),
    ).toThrow();
  });

  it('WorldAnchorRow：label/epRange/title 全缺省可 parse（无标注场景 graceful 不造数）', () => {
    const anchor = worldAnchorRowSchema.parse({
      t: 1,
      subjectCount: 2,
      patchCount: 2,
      axisCounts: { physical: 2, cognitive: 0, emotional: 0, relational: 0, factional: 0 },
    });
    expect(anchor.label).toBeUndefined();
    expect(anchor.epRange).toBeUndefined();
    expect(anchor.title).toBeUndefined();
  });

  it('WorldAnchorRow：axisCounts 全键 total——缺任一轴 → reject（0 灰显由数据承载，不靠 UI 补默认）', () => {
    expect(() =>
      worldAnchorRowSchema.parse({
        t: 1,
        subjectCount: 1,
        patchCount: 1,
        axisCounts: { physical: 1, cognitive: 1, emotional: 1, relational: 1 }, // 缺 factional
      }),
    ).toThrow();
    expect(() =>
      worldAnchorRowSchema.parse({
        t: 1,
        subjectCount: 1,
        patchCount: -1,
        axisCounts: { physical: 1, cognitive: 1, emotional: 1, relational: 1, factional: 1 },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L1 worldOverviewSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('worldOverviewSchema（L1 世界总览）', () => {
  it('roundtrip：subjects + anchors + patchTotal + latestT + extracting', () => {
    const r = worldOverviewSchema.parse({
      subjects: [
        mkSubjectRow({ id: 'character:shen-yan', name: '沈砚', patchCount: 13, lastStoryTime: 3 }),
        mkSubjectRow({ id: 'group:archaeology-team', type: 'group', patchCount: 0, lastStoryTime: null, axes: [] }),
      ],
      anchors: [
        mkAnchor({ t: 1, label: '唤醒当日', epRange: 'ep1-01..05', title: '荒野舱醒' }),
        mkAnchor({ t: 3, label: '入学首日', epRange: 'ep1-13..20' }),
      ],
      patchTotal: 16,
      latestT: 3,
      extracting: true,
    });
    expect(r.subjects).toHaveLength(2);
    expect(r.anchors).toHaveLength(2);
    expect(r.latestT).toBe(3);
    expect(r.extracting).toBe(true);
  });

  it('空库形态：全空数组 + patchTotal=0 + latestT=null（L1 空态判定键）', () => {
    const r = worldOverviewSchema.parse({
      subjects: [],
      anchors: [],
      patchTotal: 0,
      latestT: null,
    });
    expect(r.subjects).toEqual([]);
    expect(r.anchors).toEqual([]);
    expect(r.latestT).toBeNull();
    expect(r.extracting).toBeUndefined(); // 非运行中缺省
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 worldSliceDetailSchema
// ─────────────────────────────────────────────────────────────────────────────

describe('worldSliceDetailSchema（L2 时点详情）', () => {
  it('roundtrip：anchor + 跨主体 groups（WorldSubjectRow + patches）', () => {
    const r = worldSliceDetailSchema.parse({
      anchor: mkAnchor({ t: 1, label: '唤醒当日', subjectCount: 2, patchCount: 2 }),
      groups: [
        {
          subject: mkSubjectRow({ id: 'character:shen-yan', name: '沈砚' }),
          patches: [
            mkPatch({
              subjectId: 'character:shen-yan',
              path: '/presence_scene',
              op: 'replace',
              value: 's1',
              storyTime: 1,
              summary: '沈砚在核心场景 s1 在场',
            }),
          ],
        },
        {
          subject: mkSubjectRow({ id: 'item:cryo-pod-01', type: 'item', axes: ['physical'] }),
          patches: [
            mkPatch({
              subjectId: 'item:cryo-pod-01',
              path: '/status',
              op: 'replace',
              value: 'excavated',
              storyTime: 1,
              axis: 'physical',
              summary: '出土',
            }),
          ],
        },
      ],
    });
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0].patches[0].value).toBe('s1');
    expect(r.groups[1].subject.type).toBe('item');
  });

  it('groups 空合法（该时点零变更）', () => {
    const r = worldSliceDetailSchema.parse({
      anchor: mkAnchor({ t: 5, subjectCount: 0, patchCount: 0 }),
      groups: [],
    });
    expect(r.groups).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 worldSubjectDetailSchema（BMad CR #4：仅全史 patches——as-of 折叠/issues 归 UI 本地重算）
// ─────────────────────────────────────────────────────────────────────────────

describe('worldSubjectDetailSchema（L3 主体详情）', () => {
  it('roundtrip：patches 直通；分层 value（objective/reader_perceived/vad）与 subject:// ref 不改写', () => {
    const layered = {
      objective: '警觉不安',
      reader_perceived: '镇定自持',
      vad: { v: -0.5, a: 0.7, d: -0.3 },
    };
    const r = worldSubjectDetailSchema.parse({
      patches: [
        mkPatch({
          subjectId: 'character:shen-yan',
          path: '/mood',
          op: 'replace',
          value: layered,
          axis: 'emotional',
          storyTime: 1,
          summary: '双层情绪（角色真实 vs 读者感知）',
        }),
        mkPatch({
          subjectId: 'character:shen-yan',
          path: '/suspects/舱体来源异常',
          op: 'replace',
          value: '该舱体表面光洁无锈、密封完好，与埋藏地层的年代严重不符',
          axis: 'cognitive',
          storyTime: 1,
          summary: '产生来源疑虑',
        }),
        mkPatch({
          subjectId: 'character:shen-yan',
          path: '/relationship/subject:character:miya',
          op: 'replace',
          value: 'subject://character:miya',
          axis: 'relational',
          storyTime: 3,
          summary: '关系 ref（reduce 不解引用）',
        }),
      ],
    });
    expect(r.patches).toHaveLength(3);
    // 分层 value 逐字段直通（unknown 不改写）。
    expect(r.patches[0].value).toEqual(layered);
    expect(r.patches[2].value).toBe('subject://character:miya');
  });

  it('patches 空合法（登记未写主体）；reduced/issues 字段已砍（CR #4）——携带旧字段被 strip', () => {
    const r = worldSubjectDetailSchema.parse({ patches: [] });
    expect(r.patches).toEqual([]);
    // 旧字段（reduced/issues）已非契约面——zod 默认 strip 未知键，不再透传。
    expect('reduced' in r).toBe(false);
    expect('issues' in r).toBe(false);
  });

  it('缺 patches / patches 非数组 → reject', () => {
    expect(() => worldSubjectDetailSchema.parse({})).toThrow();
    expect(() => worldSubjectDetailSchema.parse({ patches: 'not-an-array' })).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// worldChangedEventSchema（`world:changed` 推送）
// ─────────────────────────────────────────────────────────────────────────────

describe('worldChangedEventSchema（world:changed 推送）', () => {
  it('四 kind 各形态：slice-written 带 sliceT+subjectIds / backfill / reset / amendment 带 sliceT', () => {
    // 写章链逐 slice 落表（toolExecution write_world_events）。
    const sliceWritten = worldChangedEventSchema.parse({
      projectId: '00004',
      kind: 'slice-written',
      sliceT: 3,
      subjectIds: ['character:shen-yan', 'character:miya'],
    });
    expect(sliceWritten.kind).toBe('slice-written');
    expect(sliceWritten.sliceT).toBe(3);
    expect(sliceWritten.subjectIds).toHaveLength(2);

    // 全量重提取 reset。
    const backfill = worldChangedEventSchema.parse({ projectId: '00004', kind: 'backfill' });
    expect(backfill.sliceT).toBeUndefined();
    expect(backfill.subjectIds).toBeUndefined();

    // reset。
    expect(worldChangedEventSchema.parse({ projectId: '00004', kind: 'reset' }).kind).toBe('reset');

    // amendment 覆盖层（sliceT 必带——superRefine；subjectIds 可缺省=无受影响主体）。
    const amendment = worldChangedEventSchema.parse({
      projectId: '00004',
      kind: 'amendment',
      sliceT: 3,
      subjectIds: ['character:shen-yan'],
    });
    expect(amendment.sliceT).toBe(3);
    expect(amendment.subjectIds).toEqual(['character:shen-yan']);
    expect(worldChangedEventSchema.parse({ projectId: '00004', kind: 'amendment', sliceT: 5 }).subjectIds)
      .toBeUndefined();
  });

  it('非法 kind / 缺 projectId → reject', () => {
    expect(() => worldChangedEventSchema.parse({ projectId: '00004', kind: 'polling' })).toThrow();
    expect(() => worldChangedEventSchema.parse({ kind: 'reset' })).toThrow();
  });

  it('kind×字段强绑定（superRefine，BMad CR #9+#108）：slice-written/amendment 必带 sliceT，subjectIds 非空', () => {
    // slice-written 缺 sliceT → reject。
    expect(() =>
      worldChangedEventSchema.parse({ projectId: '00004', kind: 'slice-written', subjectIds: ['a'] }),
    ).toThrow();
    // amendment 缺 sliceT → reject。
    expect(() =>
      worldChangedEventSchema.parse({ projectId: '00004', kind: 'amendment', subjectIds: ['a'] }),
    ).toThrow();
    // slice-written / amendment 带**空** subjectIds → reject（空集语义是缺省不传）。
    expect(() =>
      worldChangedEventSchema.parse({ projectId: '00004', kind: 'slice-written', sliceT: 2, subjectIds: [] }),
    ).toThrow();
    expect(() =>
      worldChangedEventSchema.parse({ projectId: '00004', kind: 'amendment', sliceT: 2, subjectIds: [] }),
    ).toThrow();
    // backfill / reset 不要求（全量语义——不带 sliceT/subjectIds 合法，带上也不绑形状）。
    expect(worldChangedEventSchema.safeParse({ projectId: '00004', kind: 'backfill' }).success).toBe(true);
    expect(worldChangedEventSchema.safeParse({ projectId: '00004', kind: 'reset' }).success).toBe(true);
  });

  it('WORLD_CHANGED_CHANNEL 单源常量 = world:changed（shell 发射器 / preload 订阅面共同引用，CR #8）', () => {
    expect(WORLD_CHANGED_CHANNEL).toBe('world:changed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 三请求入参 schema（缺省单源）
// ─────────────────────────────────────────────────────────────────────────────

describe('三请求入参 schema', () => {
  it('worldOverviewRequestSchema：projectId 必填', () => {
    expect(worldOverviewRequestSchema.parse({ projectId: '00004' }).projectId).toBe('00004');
    expect(() => worldOverviewRequestSchema.parse({})).toThrow();
  });

  it('worldSliceDetailRequestSchema：projectId + t 必填（t = storyTime 整数）', () => {
    const r = worldSliceDetailRequestSchema.parse({ projectId: '00004', t: 3 });
    expect(r.t).toBe(3);
    expect(() => worldSliceDetailRequestSchema.parse({ projectId: '00004' })).toThrow();
    expect(() => worldSliceDetailRequestSchema.parse({ projectId: '00004', t: 'ep1-01' })).toThrow();
    expect(() => worldSliceDetailRequestSchema.parse({ projectId: '00004', t: 1.5 })).toThrow();
  });

  it('worldSubjectDetailRequestSchema：projectId + subjectId 必填；**无 as-of 参数**（CR #4——切线归 UI 本地）', () => {
    const r = worldSubjectDetailRequestSchema.parse({
      projectId: '00004',
      subjectId: 'character:shen-yan',
    });
    expect(r.subjectId).toBe('character:shen-yan');
    // 旧 `at` 字段已出契约面——携带时被 strip（通道不收截断点；zod 默认 strip 未知键）。
    const legacy = worldSubjectDetailRequestSchema.parse({
      projectId: '00004',
      subjectId: 'character:shen-yan',
      at: 2,
    });
    expect('at' in legacy).toBe(false);
    expect(() =>
      worldSubjectDetailRequestSchema.parse({ projectId: '00004', at: 2 }),
    ).toThrow(); // 缺 subjectId
    expect(() => worldSubjectDetailRequestSchema.parse({ projectId: '00004' })).toThrow();
  });
});
