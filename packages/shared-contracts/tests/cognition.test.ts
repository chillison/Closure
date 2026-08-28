import { describe, expect, it } from 'vitest';
import {
  getCognitionAtTime,
  compileCognitionForScene,
  projectPerspective,
  detectPerspectiveGap,
  projectBeliefStatus,
  buildCognitionSnapshot,
  buildPresenceSignal,
  reduceSubject,
  infoReleaseMapSchema,
  infoReleaseEntrySchema,
  infoReleaseActionSchema,
  applyInfoReleaseActions,
  manipulationDirectiveSchema,
  projectDocumentSchema,
  type CharacterBeliefView,
  type CognitionSnapshot,
  type WorldPatch,
  type SceneNode,
  type PresenceSignal,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.1：CognitionGraph 查询层 + perspective 层 + InfoReleaseMap schema。
// 纯函数 + 纯 Zod schema → plain vitest（无 fs/db/LLM）。覆盖（AC1/AC3/AC5）：
// - getCognitionAtTime：认知轴预过滤 + reduce 复用（t 前叠加 / t 后忽略 / 多角色隔离 / 非 cognitive 过滤 / 分层 value）
// - compileCognitionForScene：storyTime 截断 + 多角色投影 + 空 graceful
// - projectPerspective：分层 value → {objective,readerPerceived} / 单值 → {characterPerceived} / 缺路径 → {}
// - detectPerspectiveGap：结构分歧检测（不命名叙事工具）/ 全等→null / 单视图→null / stable JSON 相等
// - InfoReleaseMap schema：additive（含/不含 info_release_map 的 projectDocument 均通过）
// ─────────────────────────────────────────────────────────────────────────────

/** 构造 cognitive patch（storyTime + path + value + subjectId；其余默认）。 */
function cogPatch(
  subjectId: string,
  storyTime: number,
  path: string,
  value: unknown,
  op: WorldPatch['op'] = 'replace',
  axis: WorldPatch['axis'] = 'cognitive',
): WorldPatch {
  return {
    id: `${subjectId}-${storyTime}-${path}`,
    sliceId: `ep1:${storyTime}`,
    subjectId,
    path,
    op,
    value,
    axis,
    source: 'derived',
    storyTime,
  };
}

const A = 'char-a';
const B = 'char-b';

describe('getCognitionAtTime（AC1：认知轴查询，复用 reduceSubject）', () => {
  it('t 前 patch 叠加、t 后忽略', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密X', true),
      cogPatch(A, 2, '/believes/国王', '忠诚'),
      cogPatch(A, 3, '/believes/国王', '怀疑'), // t=3，at=2 应忽略
    ];
    const state = getCognitionAtTime(patches, A, 2);
    expect(state).toEqual({ knows: { '秘密X': true }, believes: { 国王: '忠诚' } });
  });

  it('at 缺省取最新（全叠加）', () => {
    const patches = [
      cogPatch(A, 1, '/believes/国王', '忠诚'),
      cogPatch(A, 2, '/believes/国王', '怀疑'),
    ];
    const state = getCognitionAtTime(patches, A);
    expect(state).toEqual({ believes: { 国王: '怀疑' } });
  });

  it('多角色隔离（只 reduce 该角色）', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密X', true),
      cogPatch(B, 1, '/knows/秘密Y', true),
    ];
    expect(getCognitionAtTime(patches, A, 1)).toEqual({ knows: { '秘密X': true } });
    expect(getCognitionAtTime(patches, B, 1)).toEqual({ knows: { '秘密Y': true } });
  });

  it('非 cognitive 轴 patch 被过滤（axis 预过滤）', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密X', true),
      cogPatch(A, 1, '/位置', '王座厅', 'replace', 'physical'), // 物理 axis，应被忽略
    ];
    const state = getCognitionAtTime(patches, A, 1);
    expect(state).toEqual({ knows: { '秘密X': true } });
    expect(state).not.toHaveProperty('位置');
  });

  it('分层 value {objective, reader_perceived} 结构保留', () => {
    const patches = [
      cogPatch(A, 1, '/believes/国王', { objective: '怀疑篡位', reader_perceived: '表面效忠' }),
    ];
    const state = getCognitionAtTime(patches, A, 1);
    expect(state).toEqual({
      believes: { 国王: { objective: '怀疑篡位', reader_perceived: '表面效忠' } },
    });
  });
});

describe('compileCognitionForScene（AC2：per-scene 物化）', () => {
  const scene = (storyTime: number) => ({ storyTime }) as unknown as SceneNode;

  it('storyTime 截断 + 多角色投影', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密X', true),
      cogPatch(B, 2, '/believes/A', '盟友'),
      cogPatch(A, 3, '/knows/秘密Z', true), // 场 storyTime=2 之后，应忽略
    ];
    const result = compileCognitionForScene(scene(2), patches);
    expect(result).toEqual({
      [A]: { knows: { '秘密X': true } },
      [B]: { believes: { A: '盟友' } },
    });
  });

  it('无 cognitive patches → undefined（graceful）', () => {
    expect(compileCognitionForScene(scene(2), [])).toBeUndefined();
    expect(compileCognitionForScene(scene(2), undefined)).toBeUndefined();
  });

  it('该 storyTime 前无认知 → undefined', () => {
    const patches = [cogPatch(A, 5, '/knows/X', true)]; // 场 storyTime=2 之前无
    expect(compileCognitionForScene(scene(2), patches)).toBeUndefined();
  });
});

// ── Story 6.2：typed BeliefStatus 投影层（projectBeliefStatus + buildCognitionSnapshot）──
// 纯函数：认知轴自由 JSON 字典 → typed BeliefStatus 视图。覆盖（AC5 + 范式判据）：
// - key→status 结构映射（knows/believes→believes_true / suspects→suspects / misunderstands→believes_false）
// - absent key → unaware（消费侧：fact 不在 facts[] = 角色 unaware）
// - 分层 value（{objective,reader_perceived}）标 hasReaderPerceivedLayer / CR-E4 单 objective 不误判
// - 灰区不细分（believes 含怀疑义归 believes_true，细分归 L2）
// - 缺失 graceful（空 cognition / 未识别 key / 畸形 bucket）
// - buildCognitionSnapshot：filter cognitive + 多角色投影 + 空 graceful

describe('projectBeliefStatus（AC5：自由 JSON → typed BeliefStatus 投影）', () => {
  it('knows key → believes_true', () => {
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/knows/秘密X', true)], A, 1);
    const view = projectBeliefStatus(cognition, A);
    expect(view.characterSubjectId).toBe(A);
    expect(view.facts).toHaveLength(1);
    expect(view.facts[0]).toEqual({
      path: '/knows/秘密X',
      status: 'believes_true',
      value: true,
      hasReaderPerceivedLayer: false,
    });
  });

  it('believes key → believes_true（灰区不细分：含怀疑义仍归 believes_true，细分归 L2）', () => {
    // believes 国王=「怀疑」——纯代码不判「真怀疑」（dramatic_irony/suspense 叙事意图归 LLM）。
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/believes/国王', '怀疑')], A, 1);
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts[0].status).toBe('believes_true');
    expect(view.facts[0].value).toBe('怀疑');
  });

  it('suspects key → suspects', () => {
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/suspects/内鬼', '队长')], A, 1);
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts[0].status).toBe('suspects');
    expect(view.facts[0].path).toBe('/suspects/内鬼');
  });

  it('misunderstands key → believes_false', () => {
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/misunderstands/动机', '以为是要害自己')],
      A,
      1,
    );
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts[0].status).toBe('believes_false');
  });

  it('分层 value {objective, reader_perceived} → hasReaderPerceivedLayer=true（白名单信号）', () => {
    // 角色表象 vs 真实分歧 = reader_perceived 键在场 → 该「表现知情」可能是叙述视角差/伪装，不报 KNOWLEDGE_VIOLATION。
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/believes/国王', { objective: '怀疑篡位', reader_perceived: '表面效忠' })],
      A,
      1,
    );
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts[0].hasReaderPerceivedLayer).toBe(true);
    expect(view.facts[0].value).toEqual({ objective: '怀疑篡位', reader_perceived: '表面效忠' });
  });

  it('CR-E4：value 含 objective 键但无 reader_perceived → 不误判分层（hasReaderPerceivedLayer=false）', () => {
    // "objective" 是常用词（任务目标义），非 perspective 分层；reader_perceived 缺席 → isLayeredValue 返 false。
    // CR-001 fix：用 /knows/任务目标（识别的 key）让 projectBeliefStatus 进到 isLayeredValue 调用——旧测试
    // 用 /goal（未识别 key）在 `if (!status) continue` 早退，根本没测到 isLayeredValue（facts 空因 key 跳过
    // 非因 CR-E4 返 false），改回旧 bug（只认 objective 键判分层）此测试仍绿——零回归防线。
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/knows/任务目标', { objective: '夺取王位' })],
      A,
      1,
    );
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts).toHaveLength(1);
    expect(view.facts[0].path).toBe('/knows/任务目标');
    expect(view.facts[0].status).toBe('believes_true');
    expect(view.facts[0].hasReaderPerceivedLayer).toBe(false);
  });

  it('absent key → unaware（fact 不在视图 = 角色 unaware，消费侧判 KNOWLEDGE_VIOLATION）', () => {
    // A 只 knows 秘密X，不 knows 秘密Y → 秘密Y 不在 facts[]（消费侧据 absent 判 unaware）。
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/knows/秘密X', true)], A, 1);
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts.some((f) => f.path === '/knows/秘密Y')).toBe(false);
    expect(view.facts.some((f) => f.path === '/knows/秘密X')).toBe(true);
  });

  it('多 fact 混合 key → 各自 status 投影', () => {
    const cognition = getCognitionAtTime(
      [
        cogPatch(A, 1, '/knows/秘密X', true),
        cogPatch(A, 2, '/believes/国王', '忠诚'),
        cogPatch(A, 3, '/suspects/内鬼', '队长'),
        cogPatch(A, 4, '/misunderstands/动机', '恶意'),
      ],
      A,
      10,
    );
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts).toHaveLength(4);
    const statusByPath = Object.fromEntries(view.facts.map((f) => [f.path, f.status]));
    expect(statusByPath['/knows/秘密X']).toBe('believes_true');
    expect(statusByPath['/believes/国王']).toBe('believes_true');
    expect(statusByPath['/suspects/内鬼']).toBe('suspects');
    expect(statusByPath['/misunderstands/动机']).toBe('believes_false');
  });

  it('缺失 graceful：空 cognition → facts: []（角色 unaware 所有 fact）', () => {
    const view = projectBeliefStatus({}, A);
    expect(view.characterSubjectId).toBe(A);
    expect(view.facts).toEqual([]);
  });

  it('未识别顶层 key → 跳过（认知轴自由 JSON，不强加枚举）', () => {
    // 顶层非 knows/believes/suspects/misunderstands（如提取器写了自定义 key）→ 跳过，不报错。
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/custom_field', '值', 'replace', 'cognitive')],
      A,
      1,
    );
    const view = projectBeliefStatus(cognition, A);
    expect(view.facts).toHaveLength(0);
  });
});

describe('buildCognitionSnapshot（AC5/AC7：patches → CognitionSnapshot，graceful）', () => {
  it('多角色 cognitive patches → per-character BeliefStatus 视图聚合', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密X', true),
      cogPatch(B, 2, '/believes/A', '盟友'),
      // 物理轴 patch 应被过滤（非 cognitive）
      cogPatch(A, 1, '/位置', '王座厅', 'replace', 'physical'),
    ];
    const snapshot = buildCognitionSnapshot(patches);
    expect(snapshot).toBeDefined();
    expect(snapshot!.characters).toHaveLength(2);
    const charA = snapshot!.characters.find((c) => c.characterSubjectId === A);
    const charB = snapshot!.characters.find((c) => c.characterSubjectId === B);
    expect(charA?.facts[0].path).toBe('/knows/秘密X');
    expect(charA?.facts[0].status).toBe('believes_true');
    expect(charB?.facts[0].path).toBe('/believes/A');
    expect(charB?.facts[0].status).toBe('believes_true');
  });

  it('无 cognitive patches → undefined（graceful）', () => {
    expect(buildCognitionSnapshot([])).toBeUndefined();
    expect(
      buildCognitionSnapshot([cogPatch(A, 1, '/位置', '厅', 'replace', 'physical')]),
    ).toBeUndefined();
  });

  it('分层 value 透传到 snapshot（hasReaderPerceivedLayer 保留）', () => {
    const patches = [
      cogPatch(A, 1, '/believes/国王', { objective: '怀疑', reader_perceived: '效忠' }),
    ];
    const snapshot = buildCognitionSnapshot(patches);
    expect(snapshot!.characters[0].facts[0].hasReaderPerceivedLayer).toBe(true);
  });
});

describe('projectPerspective（AC3：三视角投影）', () => {
  it('分层 value → {objective, readerPerceived}', () => {
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/believes/国王', { objective: '怀疑', reader_perceived: '效忠' })],
      A,
      1,
    );
    expect(projectPerspective(cognition, '/believes/国王')).toEqual({
      objective: '怀疑',
      readerPerceived: '效忠',
    });
  });

  it('单值 → {characterPerceived}', () => {
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/knows/秘密X', true)], A, 1);
    expect(projectPerspective(cognition, '/knows/秘密X')).toEqual({ characterPerceived: true });
  });

  it('缺路径 → {}（空 views）', () => {
    const cognition = getCognitionAtTime([cogPatch(A, 1, '/knows/X', true)], A, 1);
    expect(projectPerspective(cognition, '/knows/不存在')).toEqual({});
  });

  it('CR-E4：value 含 objective 键但无 reader_perceived（如 {objective:"任务目标"}）→ 不误判分层', () => {
    // "objective" 是常用词（任务目标义），非 perspective 分层；reader_perceived 缺席 → 单值 characterPerceived。
    const cognition = getCognitionAtTime(
      [cogPatch(A, 1, '/goal', { objective: '夺取王位' })],
      A,
      1,
    );
    expect(projectPerspective(cognition, '/goal')).toEqual({
      characterPerceived: { objective: '夺取王位' },
    });
  });
});

describe('detectPerspectiveGap（AC3：纯结构分歧检测，不命名叙事工具）', () => {
  it('objective ≠ readerPerceived → objective_vs_reader 分歧', () => {
    const gap = detectPerspectiveGap({ objective: '真相', readerPerceived: '假象' }, '/f/1');
    expect(gap).not.toBeNull();
    expect(gap!.divergences).toEqual(['objective_vs_reader']);
    expect(gap!.factPath).toBe('/f/1');
  });

  it('readerPerceived ≠ characterPerceived → reader_vs_character 分歧（戏剧反讽方向信号）', () => {
    const gap = detectPerspectiveGap({ readerPerceived: 'B 是叛徒', characterPerceived: 'B 是盟友' }, '/f/2');
    expect(gap).not.toBeNull();
    expect(gap!.divergences).toEqual(['reader_vs_character']);
  });

  it('三视角全不同 → 3 个 divergences', () => {
    const gap = detectPerspectiveGap(
      { objective: '甲', readerPerceived: '乙', characterPerceived: '丙' },
      '/f/3',
    );
    expect(gap!.divergences).toEqual([
      'objective_vs_reader',
      'objective_vs_character',
      'reader_vs_character',
    ]);
  });

  it('全等 → null（无 gap）', () => {
    expect(detectPerspectiveGap({ objective: 'x', readerPerceived: 'x', characterPerceived: 'x' }, '/f')).toBeNull();
  });

  it('单视图 → null（无对比对象）', () => {
    expect(detectPerspectiveGap({ characterPerceived: 'x' }, '/f')).toBeNull();
    expect(detectPerspectiveGap({}, '/f')).toBeNull();
  });

  it('stable JSON 相等（{a:1,b:2} === {b:2,a:1}）→ 无分歧', () => {
    expect(
      detectPerspectiveGap(
        { objective: { a: 1, b: 2 }, readerPerceived: { b: 2, a: 1 } },
        '/f',
      ),
    ).toBeNull();
  });

  it('不命名叙事工具（divergences 只有方向，无 foreshadow/dramatic_irony 等）', () => {
    const gap = detectPerspectiveGap({ objective: 'x', readerPerceived: 'y' }, '/f');
    // 纯代码只报方向；命名（伏笔/戏剧反讽/悬念/误导）归 LLM。
    expect(gap!.divergences.every((d) => d.includes('_vs_'))).toBe(true);
  });
});

describe('InfoReleaseMap schema（AC5：additive creative field）', () => {
  it('infoReleaseEntrySchema：sceneRef 挂场景 + directive shape', () => {
    const entry = infoReleaseEntrySchema.parse({
      id: 'ir-1',
      sceneRef: 'scene-banquet',
      reveal: ['国王的疑心'],
      withhold: ['主角的真实身份'],
      directive: { mode: 'sustain_unknown', actions: ['withhold', 'plant'], forbiddenMoves: ['直接提及身份'] },
    });
    expect(entry.sceneRef).toBe('scene-banquet');
    expect(entry.directive?.mode).toBe('sustain_unknown');
  });

  it('manipulationDirectiveSchema：actions 至少 1', () => {
    expect(() => manipulationDirectiveSchema.parse({ mode: 'reveal_first', actions: [] })).toThrow();
    expect(
      manipulationDirectiveSchema.parse({ mode: 'reveal_first', actions: ['release'] }).actions,
    ).toEqual(['release']);
  });

  it('infoReleaseMapSchema：默认 entries/version/updatedBy', () => {
    const map = infoReleaseMapSchema.parse({ entries: [] });
    expect(map.entries).toEqual([]);
    expect(map.version).toBe(0);
    expect(map.updatedBy).toBe('agent');
  });

  it('projectDocumentSchema：含 info_release_map 通过', () => {
    const doc = {
      meta: { id: 'proj-1', name: 't', type: 'novel', version: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      storyboard: { shots: [] },
      info_release_map: { entries: [{ id: 'ir-1', sceneRef: 's1' }], version: 1, updatedBy: 'user' },
    };
    const parsed = projectDocumentSchema.parse(doc);
    expect(parsed.info_release_map?.entries[0].sceneRef).toBe('s1');
  });

  it('projectDocumentSchema：不含 info_release_map 仍通过（additive 零 migration）', () => {
    const doc = {
      meta: { id: 'proj-1', name: 't', type: 'novel', version: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
      storyboard: { shots: [] },
    };
    const parsed = projectDocumentSchema.parse(doc);
    expect(parsed.info_release_map).toBeUndefined();
  });
});

describe('applyInfoReleaseActions（InfoReleaseMap bounded action 投影，mirror applySceneGraphActions）', () => {
  const entry = (id: string, sceneRef = 's1') => infoReleaseEntrySchema.parse({ id, sceneRef, reveal: [id] });
  const emptyMap = infoReleaseMapSchema.parse({ entries: [] });

  it('add_entry：新 id 追加', () => {
    const out = applyInfoReleaseActions(emptyMap, [{ op: 'add_entry', entry: entry('ir-1') }]);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].id).toBe('ir-1');
  });

  it('add_entry：id 已存在 → 覆盖（幂等）', () => {
    const out = applyInfoReleaseActions(
      { ...emptyMap, entries: [entry('ir-1', 's1')] },
      [{ op: 'add_entry', entry: entry('ir-1', 's2') }],
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].sceneRef).toBe('s2');
  });

  it('update_entry：id 已存在 → 覆盖；不存在 → 追加（容错）', () => {
    const out = applyInfoReleaseActions(
      { ...emptyMap, entries: [entry('ir-1')] },
      [
        { op: 'update_entry', entry: entry('ir-1', 's9') },
        { op: 'update_entry', entry: entry('ir-2', 's2') },
      ],
    );
    expect(out.entries.map((e) => e.id).sort()).toEqual(['ir-1', 'ir-2']);
    expect(out.entries.find((e) => e.id === 'ir-1')?.sceneRef).toBe('s9');
  });

  it('remove_entry：存在 → 删；不存在 → 幂等跳过', () => {
    const out = applyInfoReleaseActions(
      { ...emptyMap, entries: [entry('ir-1'), entry('ir-2')] },
      [
        { op: 'remove_entry', entryId: 'ir-1' },
        { op: 'remove_entry', entryId: '不存在' },
      ],
    );
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].id).toBe('ir-2');
  });

  it('projector 不 bump version（落盘侧 fieldSyncBridge 职责）', () => {
    const out = applyInfoReleaseActions(emptyMap, [{ op: 'add_entry', entry: entry('ir-1') }]);
    expect(out.version).toBe(0); // onFieldEdited 落盘时 bump，projector 不动
  });

  it('infoReleaseActionSchema：discriminatedUnion op 校验', () => {
    expect(infoReleaseActionSchema.parse({ op: 'remove_entry', entryId: 'x' }).op).toBe('remove_entry');
    expect(() => infoReleaseActionSchema.parse({ op: 'remove_entry' })).toThrow(); // 缺 entryId
    expect(() => infoReleaseActionSchema.parse({ op: 'add_entry', entry: { id: 'x' } })).toThrow(); // entry 缺 sceneRef
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 6.4 D1（6.2 DW-1）：buildPresenceSignal 在场性预筛
// 纯函数（filter cognitive evidenceSceneId + reduce physical presence_scene → 比对）。plain vitest。
// 覆盖：graceful（无 evidenceSceneId / 无 physical）+ 信号产出（!=）/ 不产出（==）+ 时序 reduce at storyTime + 多角色。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造带 evidenceSceneId 的 cognitive patch（A 知道某 fact，transmit 场 = scene）。 */
function cogPatchWithScene(
  subjectId: string,
  storyTime: number,
  path: string,
  evidenceSceneId: string,
): WorldPatch {
  return { ...cogPatch(subjectId, storyTime, path, true), evidenceSceneId };
}

/** 构造 physical /presence_scene patch（A 在 storyTime 在场 scene）。 */
function phyPresence(subjectId: string, storyTime: number, sceneId: string): WorldPatch {
  return {
    id: `${subjectId}-presence-${storyTime}`,
    sliceId: `ep1:${storyTime}`,
    subjectId,
    path: '/presence_scene',
    op: 'replace',
    value: sceneId,
    axis: 'physical',
    source: 'derived',
    storyTime,
  };
}

describe('buildPresenceSignal（6.4 D1 / 6.2 DW-1：在场性预筛）', () => {
  it('无 evidenceSceneId cognitive → 空（graceful）', () => {
    const patches = [
      cogPatch(A, 1, '/knows/秘密', true), // 无 evidenceSceneId
      phyPresence(A, 1, 'scene-1'),
    ];
    expect(buildPresenceSignal(patches)).toEqual([]);
  });

  it('无 physical presence → 空（graceful，降级纯语义判）', () => {
    const patches = [cogPatchWithScene(A, 1, '/knows/秘密', 'scene-1')]; // 无 physical /presence_scene
    expect(buildPresenceSignal(patches)).toEqual([]);
  });

  it('A 在场场 == evidenceSceneId → 不产信号（在场正常）', () => {
    const patches = [
      cogPatchWithScene(A, 1, '/knows/秘密', 'scene-1'),
      phyPresence(A, 1, 'scene-1'), // A 在场 scene-1 = 揭露场
    ];
    expect(buildPresenceSignal(patches)).toEqual([]);
  });

  it('A 在场场 != evidenceSceneId → 产信号（不在场嫌疑）', () => {
    const patches = [
      cogPatchWithScene(A, 1, '/knows/秘密', 'scene-1'), // 揭露在 scene-1
      phyPresence(A, 1, 'scene-2'), // A 在场 scene-2 ≠ scene-1
    ];
    const signals = buildPresenceSignal(patches);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      characterSubjectId: A,
      factPath: '/knows/秘密',
      evidenceSceneId: 'scene-1',
      storyTime: 1,
      presenceSceneId: 'scene-2',
    });
  });

  it('时序：reduce at cognitive storyTime（后续换场不影响该时刻判定）', () => {
    // A 在 storyTime=1 在场 scene-1（fact 揭露场），storyTime=2 换到 scene-2。
    // cognitive 揭露在 storyTime=1 → reduce at 1 → presence=scene-1 → 在场，不产信号。
    const patches = [
      cogPatchWithScene(A, 1, '/knows/秘密', 'scene-1'),
      phyPresence(A, 1, 'scene-1'),
      phyPresence(A, 2, 'scene-2'), // 后续换场，被 at=1 截断忽略
    ];
    expect(buildPresenceSignal(patches)).toEqual([]);
  });

  it('多角色多 fact：只对不在场的角色产信号', () => {
    const patches = [
      cogPatchWithScene(A, 1, '/knows/秘密', 'scene-1'),
      cogPatchWithScene(B, 1, '/knows/秘密', 'scene-1'),
      phyPresence(A, 1, 'scene-2'), // A 不在揭露场
      phyPresence(B, 1, 'scene-1'), // B 在揭露场
    ];
    const signals = buildPresenceSignal(patches);
    expect(signals).toHaveLength(1);
    expect(signals[0].characterSubjectId).toBe(A); // 只 A 产信号
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.3 S7 算法修复对拍：groupBy(subjectId) 预分组 ≡ 全量数组 per-call filter。
//
// 修法（src/contracts/cognition.ts）：buildPresenceSignal / buildCognitionSnapshot 入口一次
// groupBy(subjectId) 建 Map，循环内 reduceSubject(该 subject 的子集)。等价性论证：reduceSubject
// 首步 `filter(p => p.subjectId === subjectId)` 对预分组子集恒真；storyTime 截断与排序键
// （storyTime 升序 → derived 先 amendment → 输入序稳定）不变；filter 与 groupBy 均保相对序 →
// 进 applyPatches 的 patch 序列逐位相同。本块用**修前实现**（全量数组 per-call filter）作基线
// reference，多 fixture deep-equal 对拍——纯性能优化零行为变化（S7 红线：对拍等效硬要求）。
// 修前根因：per-cognitive-patch 全量 physical 扫描 = O(cog × phys_total)，S6 满配压测 presence
// 投影 P95 129.79ms 超 20ms 阈值；修后 O(phys_total + Σ cog_i × phys_{subject_i})。
// ─────────────────────────────────────────────────────────────────────────────

/** 修前形态（S7 基线）：per-cognitive-patch 全量 physical 数组 reduceSubject。零行为变化的锚。 */
function referencePresenceSignals(patches: WorldPatch[]): PresenceSignal[] {
  const cognitiveWithScene = patches.filter(
    (p) => p.axis === 'cognitive' && typeof p.evidenceSceneId === 'string',
  );
  if (cognitiveWithScene.length === 0) return [];
  const physical = patches.filter((p) => p.axis === 'physical');
  if (physical.length === 0) return [];
  const signals: PresenceSignal[] = [];
  for (const c of cognitiveWithScene) {
    const { state } = reduceSubject(physical, c.subjectId, c.storyTime);
    const presence = state.presence_scene;
    if (typeof presence === 'string' && presence !== c.evidenceSceneId) {
      signals.push({
        characterSubjectId: c.subjectId,
        factPath: c.path,
        evidenceSceneId: c.evidenceSceneId as string,
        storyTime: c.storyTime,
        presenceSceneId: presence,
      });
    }
  }
  return signals;
}

/** 修前形态（S7 基线）：first-seen 收集 subjectIds → per-subject 全量 cognitive 数组 reduce。 */
function referenceCognitionSnapshot(
  patches: WorldPatch[],
  subjectCap = 12,
): CognitionSnapshot | undefined {
  const cognitive = patches.filter((p) => p.axis === 'cognitive');
  if (cognitive.length === 0) return undefined;
  const subjectIds: string[] = [];
  const seen = new Set<string>();
  for (const p of cognitive) {
    if (p.subjectId && !seen.has(p.subjectId)) {
      seen.add(p.subjectId);
      subjectIds.push(p.subjectId);
    }
  }
  const capped = subjectIds.slice(0, subjectCap);
  const characters: CharacterBeliefView[] = [];
  for (const subjectId of capped) {
    const { state } = reduceSubject(cognitive, subjectId);
    if (Object.keys(state).length === 0) continue;
    const view = projectBeliefStatus(state, subjectId);
    if (view.facts.length > 0) characters.push(view);
  }
  return characters.length > 0 ? { characters } : undefined;
}

/** 构造带 source 覆盖的 patch 工厂（amendment 叠加序 fixture 用）。 */
function patchWith(
  base: WorldPatch,
  overrides: Partial<WorldPatch> & { id?: string },
): WorldPatch {
  return { ...base, ...overrides, id: overrides.id ?? `${base.id}-v2` };
}

/** 确定性 LCG（Numerical Recipes 常数；无 Math.random——mirror 压测 fixture 纪律）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('S7 算法修复对拍（buildPresenceSignal：groupBy 预分组 ≡ 全量数组 filter）', () => {
  it('多 subject 多场 + 交叉 storyTime：与修前基线 deep-equal', () => {
    // A 两场切换 + B 单场 + C 无 physical（?? [] 路径）+ 无关轴混入。
    const patches = [
      phyPresence(A, 1, 'scene-1'),
      cogPatchWithScene(A, 1, '/knows/秘密1', 'scene-1'), // at 1：在场 → 无信号
      phyPresence(A, 2, 'scene-2'),
      cogPatchWithScene(A, 3, '/knows/秘密2', 'scene-1'), // at 3：scene-2 ≠ scene-1 → 信号
      cogPatchWithScene(A, 2, '/knows/秘密3', 'scene-9'), // at 2：presence=scene-2 ≠ scene-9 → 信号
      cogPatchWithScene(B, 2, '/knows/秘密4', 'scene-1'),
      phyPresence(B, 2, 'scene-1'), // B 在场 → 无信号
      cogPatchWithScene('char-c', 2, '/knows/秘密5', 'scene-1'), // C 无 physical → 无信号
      cogPatch(A, 1, '/knows/无证据', true), // cognitive 无 evidenceSceneId → 不进循环
      patchWith(cogPatch(A, 1, '/mood-x', 'x'), { axis: 'emotional' }), // 无关轴
      patchWith(cogPatch(B, 2, '/trust', 1), { axis: 'relational', op: 'increment' }), // 无关轴
    ];
    expect(buildPresenceSignal(patches)).toEqual(referencePresenceSignals(patches));
    // 非退化守卫：fixture 本身确有信号产出（防「双空对拍」假等价）。
    expect(buildPresenceSignal(patches).length).toBeGreaterThanOrEqual(2);
  });

  it('amendment 叠加序：同 storyTime derived/amendment physical 对拍一致', () => {
    // t=5：derived presence=scene-A + amendment presence=scene-B（同 storyTime amendment 后叠 → 胜）。
    // cognitive at 5 evidence=scene-A → reduce 出 scene-B ≠ scene-A → 信号 presenceSceneId=scene-B。
    const patches = [
      phyPresence(A, 5, 'scene-A'),
      patchWith(phyPresence(A, 5, 'scene-B'), { source: 'amendment' }),
      cogPatchWithScene(A, 5, '/knows/秘密', 'scene-A'),
      // t=4 的认知：physical 都在 t=5（> 4 截断）→ presence undefined → 无信号。
      cogPatchWithScene(A, 4, '/knows/早期', 'scene-A'),
    ];
    const signals = buildPresenceSignal(patches);
    expect(signals).toEqual(referencePresenceSignals(patches));
    expect(signals).toHaveLength(1);
    expect(signals[0]!.presenceSceneId).toBe('scene-B'); // amendment 胜出——两实现同判
  });

  it('乱序输入（确定性 shuffle）：相对序保持的等价性（信号序随输入序，值不漂）', () => {
    const rng = makeRng(20260820);
    const patches: WorldPatch[] = [
      phyPresence(A, 1, 'scene-1'),
      phyPresence(A, 2, 'scene-2'),
      phyPresence(A, 3, 'scene-3'),
      phyPresence(A, 2, 'scene-2b'), // 同 storyTime 同 source 后写胜——输入序敏感点
      cogPatchWithScene(A, 2, '/knows/f1', 'scene-1'),
      cogPatchWithScene(A, 2, '/knows/f2', 'scene-9'),
      cogPatchWithScene(A, 3, '/knows/f3', 'scene-3'),
      phyPresence(B, 2, 'scene-1'),
      cogPatchWithScene(B, 2, '/knows/f4', 'scene-1'),
    ];
    // Fisher-Yates 确定性打乱（两实现对同一打乱输入对拍——filter 与 groupBy 均保相对序）。
    const shuffled = patches.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    expect(buildPresenceSignal(shuffled)).toEqual(referencePresenceSignals(shuffled));
    // 原序也对拍（同一实现族对两种输入序各自自洽）。
    expect(buildPresenceSignal(patches)).toEqual(referencePresenceSignals(patches));
  });

  it('seeded 大 fixture（多 subject × 多 storyTime 混合轴）：整体 deep-equal', () => {
    const rng = makeRng(83);
    const subjects = ['hero', 'core-01', 'core-02', 'core-03', 'core-04', 'solo-01', 'solo-02'];
    const patches: WorldPatch[] = [];
    for (let t = 1; t <= 60; t++) {
      for (const [idx, s] of subjects.entries()) {
        // cognitive：多数带 evidenceSceneId（偶发无 → 混 graceful 路径）。
        if (rng() < 0.8) {
          const p = cogPatch(s, t, `/knows/f${Math.floor(rng() * 5)}`, '知');
          patches.push(rng() < 0.85 ? { ...p, evidenceSceneId: `sc-${t % 7}-${idx}` } : p);
        }
        // physical：hero/cores 有 presence 史（偶发 amendment 同刻覆盖 + /hp 数值），solo 无 physical。
        if (idx < 5 && rng() < 0.7) {
          patches.push(phyPresence(s, t, `sc-${Math.floor(rng() * 6)}`));
          if (rng() < 0.1) {
            patches.push(patchWith(phyPresence(s, t, `sc-amend`), { source: 'amendment' }));
          }
          if (rng() < 0.3) {
            patches.push(patchWith(phyPresence(s, t, 'ignored'), { path: '/hp', value: 40 }));
          }
        }
        // 无关轴混入。
        if (rng() < 0.2) {
          patches.push(patchWith(cogPatch(s, t, '/mood', '怒'), { axis: 'emotional' }));
        }
      }
    }
    expect(buildPresenceSignal(patches)).toEqual(referencePresenceSignals(patches));
    // 非退化守卫：大 fixture 有实质信号产出。
    expect(buildPresenceSignal(patches).length).toBeGreaterThan(50);
  });

  it('S7-A 增量折叠专项：乱序查询点（降序输入）+ 同 (subject, storyTime) 重复查询点 + 空窗查询点', () => {
    // 认知输入序 = storyTime 降序（增量内部须自排序查询点）；f2/f2b 同刻重复查询点（去重）；
    // t=1 查询点前无 physical（空窗 = presence undefined，≡ 修前 reduceSubject 截断空）。
    const patches = [
      cogPatchWithScene(A, 5, '/knows/f3', 'scene-5'),
      cogPatchWithScene(A, 3, '/knows/f2', 'scene-1'),
      cogPatchWithScene(A, 3, '/knows/f2b', 'scene-2'),
      cogPatchWithScene(A, 1, '/knows/f1', 'scene-1'),
      phyPresence(A, 2, 'scene-2'),
      phyPresence(A, 4, 'scene-4'),
      phyPresence(A, 5, 'scene-5x'),
    ];
    const signals = buildPresenceSignal(patches);
    expect(signals).toEqual(referencePresenceSignals(patches));
    // 非退化 + 逐点核对：t=5 → presence=scene-5x ≠ scene-5 → 信号；t=3 → scene-2 ≠ scene-1 → 信号
    // （f2b evidence=scene-2 = presence → 不产）；t=1 → 无 physical → 无信号。信号序 = 输入序。
    expect(signals.map((s) => s.factPath)).toEqual(['/knows/f3', '/knows/f2']);
    expect(signals[0]!.presenceSceneId).toBe('scene-5x');
    expect(signals[1]!.presenceSceneId).toBe('scene-2');
  });

  it('graceful 边界对拍：空 / 仅 cognitive / 仅 physical', () => {
    for (const patches of [
      [],
      [cogPatchWithScene(A, 1, '/knows/x', 'scene-1')],
      [phyPresence(A, 1, 'scene-1')],
    ]) {
      expect(buildPresenceSignal(patches)).toEqual(referencePresenceSignals(patches));
    }
  });
});

describe('S7 算法修复对拍（buildCognitionSnapshot：同族 groupBy 修复）', () => {
  it('多角色 + amendment cognitive + 超额 subject（cap 截断）：deep-equal', () => {
    const rng = makeRng(7);
    const patches: WorldPatch[] = [];
    // 15 subjects（超 subjectCap=12 → 截断路径）× 交错 storyTime。
    for (let t = 1; t <= 40; t++) {
      for (let s = 0; s < 15; s++) {
        const subjectId = `char-${String(s).padStart(2, '0')}`;
        if (rng() < 0.7) {
          const p = cogPatch(subjectId, t, `/believes/topic${Math.floor(rng() * 4)}`, '疑');
          patches.push(rng() < 0.1 ? patchWith(p, { source: 'amendment' }) : p);
        }
        if (rng() < 0.2) {
          patches.push(patchWith(cogPatch(subjectId, t, '/位置', '厅'), { axis: 'physical' })); // 非认知轴过滤
        }
      }
    }
    expect(buildCognitionSnapshot(patches)).toEqual(referenceCognitionSnapshot(patches));
    expect(buildCognitionSnapshot(patches, 5)).toEqual(referenceCognitionSnapshot(patches, 5));
    // 非退化守卫：cap 12 截断确实起效（15 subjects > 12）。
    expect(buildCognitionSnapshot(patches)!.characters.length).toBe(12);
    expect(buildCognitionSnapshot(patches, 5)!.characters.length).toBe(5);
  });

  it('同 subject 同 storyTime 多 patch（输入序 tie-break）+ graceful 边界：deep-equal', () => {
    const patches = [
      cogPatch(A, 3, '/believes/国王', '忠诚'),
      cogPatch(A, 3, '/believes/国王', '怀疑'), // 同 storyTime 同 source 后写胜
      patchWith(cogPatch(A, 3, '/believes/国王', '修正'), { source: 'amendment' }), // amendment 后叠胜
      cogPatch(B, 1, '/knows/y', true),
    ];
    expect(buildCognitionSnapshot(patches)).toEqual(referenceCognitionSnapshot(patches));
    expect(buildCognitionSnapshot(patches)!.characters[0]!.facts[0]!.value).toBe('修正');

    expect(buildCognitionSnapshot([])).toEqual(referenceCognitionSnapshot([]));
    expect(buildCognitionSnapshot([phyPresence(A, 1, 's1')])).toEqual(
      referenceCognitionSnapshot([phyPresence(A, 1, 's1')]),
    );
  });
});
