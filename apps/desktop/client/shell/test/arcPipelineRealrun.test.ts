/**
 * Story 8.5 Step 9 真跑 suite（B 任务①）：三工具 handler × 真实 project.yaml round-trip。
 *
 * 与 curveHandlers.test.ts / episodeOutlinesHandlers.test.ts（mock local-bff）互补：本 suite **不 mock
 * `@orison/desktop-local-bff`**——handler 内 dynamic import 走真 loadProject / onFieldEdited /
 * saveProject（fieldSyncBridge 作用链：version bump + markStaleFields 下游 stale 传播 + strict parse +
 * atomic write），fixture 是磁盘上真 project.yaml，回读断言用真 loadProject。唯一 mock = logger
 * （telemetry 非数据路径，mirror 既有 handler 套件）。
 *
 * 真跑命令（Story 8.1 testing-discipline Pattern，mirror arcSummaryRepository.test.ts）：
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> node_modules/vitest/vitest.mjs run test/arcPipelineRealrun.test.ts
 * （cwd = shell 包）。本 suite 无 native addon 依赖（纯 yaml/FS I/O），plain-Node vitest 同样可跑
 * （无 ABI skip 门——不造新门，mirror 8.2 哲学：只有 native 依赖才需要门）。
 */
import path from 'node:path';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectDocumentSchema } from '@orison/shared-contracts';

vi.mock('../main/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { loadProject, saveProject } from '@orison/desktop-local-bff';
import {
  growthCurveUpdateHandler,
  pacingCurveUpdateHandler,
} from '../main/ipc/toolHandlers/curveHandlers';
import { episodeOutlinesUpdateHandler } from '../main/ipc/toolHandlers/episodeOutlinesHandlers';

const PROJECT_DIR = path.join(process.cwd(), 'test-tmp-arc-pipeline-realrun');

function makeFixtureDoc() {
  return projectDocumentSchema.parse({
    meta: {
      id: 'arc-pipeline-realrun',
      name: '弧生产线真跑',
      type: 'novel',
      version: 1,
      created_at: '2026-08-18T00:00:00.000Z',
      updated_at: '2026-08-18T00:00:00.000Z',
    },
    storyboard: { shots: [] },
    // phases 给 episode_outlines_update 的 phase_ref 存在性校验一个真锚（phase-1）。
    outline_v2: {
      phases: [
        { id: 'phase-1', title: '第一卷·北境风云', goal: '在北境站稳脚跟' },
      ],
    },
    asset_cards: [{ id: 'char-lin', type: 'character', name: '林昭' }],
  });
}

beforeAll(() => {
  try { if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  mkdirSync(PROJECT_DIR, { recursive: true });
  saveProject(PROJECT_DIR, makeFixtureDoc());
});

afterAll(() => {
  try { if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
});

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: PROJECT_DIR,
  sessionId: 's-realrun',
  abort: new AbortController().signal,
});

/** 真 loadProject 读回当前 growth_curve（array canonical）。 */
function readCurves() {
  const doc = loadProject(PROJECT_DIR);
  expect(doc).not.toBeNull();
  return doc!.growth_curve ?? [];
}

function curveOf(characterId: string) {
  return readCurves().find((c) => c.character_id === characterId);
}

describe('真跑：growth_curve_update → 真实 project.yaml round-trip（Story 8.5 R1）', () => {
  it('autoApply（auto 档）add_curve ×2 → applied metadata + 盘上 2 条弧 + field_metadata version/source 正确 + 下游 episode_outlines stale 传播', async () => {
    const res = await growthCurveUpdateHandler(
      ctx({
        autoApply: true,
        actions: [
          {
            op: 'add_curve',
            curve: {
              character_id: 'char-lin',
              start_state: '封闭自保，不信任任何人',
              desire: '查清父亲污名的真相',
              need: '重新学会信任同伴',
              turning_points: [
                { turning_point: '审判日为同伴作证', linked_episode_ids: ['ep-1'] },
              ],
            },
          },
          {
            op: 'add_curve',
            curve: {
              character_id: 'char-yan',
              start_state: '奉命监视林昭',
              desire: '向上爬出人头地',
            },
          },
        ],
      }),
    );

    // applied metadata（非 field_patch——auto 档直落）
    expect(res.metadata).toMatchObject({ ok: true, applied: true, curveCount: 2 });
    expect(res.metadata?.type).toBeUndefined();
    expect(res.output).toContain('已写入项目设定');

    // 真 loadProject 回读：canonical array、两条弧、defaults 已填
    const curves = readCurves();
    expect(curves).toHaveLength(2);
    expect(curveOf('char-lin')).toMatchObject({
      character_id: 'char-lin',
      desire: '查清父亲污名的真相',
    });
    expect(curveOf('char-lin')!.turning_points).toEqual([
      { turning_point: '审判日为同伴作证', linked_episode_ids: ['ep-1'] },
    ]);
    expect(curveOf('char-yan')!.turning_points).toEqual([]); // growthCurveSchema.parse 填 defaults
    expect(curveOf('char-yan')!.regressions).toEqual([]);

    // onFieldEdited 作用链真效果：field_metadata.growth_curve version=1 source=agent stale=false
    const meta = loadProject(PROJECT_DIR)!.field_metadata?.growth_curve;
    expect(meta).toMatchObject({ version: 1, source: 'agent', stale: false });

    // markStaleFields 下游传播（依赖图 growth_curve → episode_outlines，真 onFieldEdited 才有这条）
    const epMeta = loadProject(PROJECT_DIR)!.field_metadata?.episode_outlines;
    expect(epMeta).toMatchObject({ stale: true });
  });

  it('suggest 档（无 autoApply）update_curve → field_patch envelope 携投影值 + 盘上不动（version 仍 1）', async () => {
    const before = curveOf('char-lin')!.desire;
    const beforeVersion = loadProject(PROJECT_DIR)!.field_metadata!.growth_curve!.version;

    const res = await growthCurveUpdateHandler(
      ctx({
        actions: [
          { op: 'update_curve', character_id: 'char-lin', patch: { desire: '新欲望（待人审）' } },
        ],
      }),
    );

    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('growth_curve');
    const data = res.metadata?.data as { character_id: string; desire: string }[];
    expect(data.find((c) => c.character_id === 'char-lin')!.desire).toBe('新欲望（待人审）');

    // 盘上不落：desire 原值 + version 不 bump（PatchReview 人审前零持久化）
    expect(curveOf('char-lin')!.desire).toBe(before);
    expect(loadProject(PROJECT_DIR)!.field_metadata!.growth_curve!.version).toBe(beforeVersion);
  });

  it('autoApply update_curve 改 desire → 盘上更新 + version bump', async () => {
    const beforeVersion = loadProject(PROJECT_DIR)!.field_metadata!.growth_curve!.version;
    const res = await growthCurveUpdateHandler(
      ctx({
        autoApply: true,
        actions: [
          { op: 'update_curve', character_id: 'char-lin', patch: { desire: '为死去同袍讨还公道' } },
        ],
      }),
    );
    expect(res.metadata).toMatchObject({ applied: true });
    expect(curveOf('char-lin')!.desire).toBe('为死去同袍讨还公道');
    // 未提字段保留（浅合并，真投影语义）
    expect(curveOf('char-lin')!.start_state).toBe('封闭自保，不信任任何人');
    expect(loadProject(PROJECT_DIR)!.field_metadata!.growth_curve!.version).toBe(beforeVersion + 1);
  });

  it('autoApply remove_curve → 盘上弧消失（幂等语义同族）', async () => {
    const res = await growthCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'remove_curve', character_id: 'char-yan' }] }),
    );
    expect(res.metadata).toMatchObject({ applied: true, curveCount: 1 });
    expect(readCurves().map((c) => c.character_id)).toEqual(['char-lin']);
  });
});

describe('真跑：pacing_curve_update → 真实 project.yaml round-trip（Story 8.5 R1）', () => {
  it('autoApply add_point → 盘上 pacing_curve {unit:episode, points:[ep-1@7]}（absent 基底 fresh unit 基线）', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({
        autoApply: true,
        actions: [{ op: 'add_point', point: { refId: 'ep-1', intensity: 7, note: '审判日开庭' } }],
      }),
    );
    expect(res.metadata).toMatchObject({ ok: true, applied: true, pointCount: 1 });

    const doc = loadProject(PROJECT_DIR)!;
    expect(doc.pacing_curve).toBeDefined();
    expect(doc.pacing_curve!.unit).toBe('episode');
    expect(doc.pacing_curve!.points).toEqual([{ refId: 'ep-1', intensity: 7, note: '审判日开庭' }]);
    expect(doc.field_metadata?.pacing_curve).toMatchObject({ version: 1, source: 'agent' });
  });

  it('suggest 档 update_point → envelope 携新值 + 盘上 intensity 不动', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({
        actions: [{ op: 'update_point', point: { refId: 'ep-1', intensity: 9 } }],
      }),
    );
    expect(res.metadata?.type).toBe('field_patch');
    expect(res.metadata?.field).toBe('pacing_curve');
    expect((res.metadata?.data as { points: { intensity: number }[] }).points[0].intensity).toBe(9);
    // 盘上不动（人审前零持久化）
    expect(loadProject(PROJECT_DIR)!.pacing_curve!.points[0].intensity).toBe(7);
  });

  it('autoApply update_point → 盘上 intensity 9（by refId 覆盖，非追加）', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'update_point', point: { refId: 'ep-1', intensity: 9 } }] }),
    );
    expect(res.metadata).toMatchObject({ applied: true });
    const curve = loadProject(PROJECT_DIR)!.pacing_curve!;
    expect(curve.points).toHaveLength(1); // 覆盖非追加
    expect(curve.points[0].intensity).toBe(9);
  });

  it('autoApply remove_point → 盘上 points 空', async () => {
    const res = await pacingCurveUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'remove_point', refId: 'ep-1' }] }),
    );
    expect(res.metadata).toMatchObject({ applied: true, pointCount: 0 });
    expect(loadProject(PROJECT_DIR)!.pacing_curve!.points).toEqual([]);
  });
});

describe('真跑：episode_outlines_update → 真实 project.yaml round-trip（Story 8.5 R2）', () => {
  it('autoApply add_episode 挂真 phase_ref（phase-1）→ 无悬空警告 + 盘上落 episode 带 phase_ref', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        autoApply: true,
        actions: [
          {
            op: 'add_episode',
            episode: {
              id: 'ep-1',
              index: 0,
              title: '第一章·风雪叩门',
              phase_ref: 'phase-1',
              character_progressions: [{ characterId: 'char-lin', from: '封闭自保', to: '为同伴迈出第一步' }],
            },
          },
        ],
      }),
    );

    expect(res.metadata).toMatchObject({ ok: true, applied: true, episodeCount: 1 });
    // 真 phases id 挂钩 → 零警告（输出无 ⚠ 段 + metadata.phaseWarnings 空）
    expect(res.output).not.toContain('⚠');
    expect(res.metadata?.phaseWarnings).toEqual([]);

    const eps = loadProject(PROJECT_DIR)!.episode_outlines!;
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ id: 'ep-1', phase_ref: 'phase-1', title: '第一章·风雪叩门' });
    expect(eps[0].character_progressions).toEqual([
      { characterId: 'char-lin', from: '封闭自保', to: '为同伴迈出第一步' },
    ]);
  });

  it('悬空 phase_ref（phase-ghost）→ warn 透传不拒（output ⚠ 段 + metadata.phaseWarnings）+ suggest 档盘上不落', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        actions: [
          {
            op: 'add_episode',
            episode: { id: 'ep-2', index: 1, title: '第二章·审判日', phase_ref: 'phase-ghost' },
          },
        ],
      }),
    );

    // warn 透传不拒（design §3.1：硬拒会挡 LLM 先排章后补 phase 的合法顺序）
    expect(res.output).toContain('⚠ phase_ref 悬空警告');
    expect(res.output).toContain('phase-ghost');
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-2', phaseRef: 'phase-ghost' }]);
    // suggest 档 envelope（非 applied）→ 盘上仍只有 ep-1
    expect(res.metadata?.type).toBe('field_patch');
    expect(loadProject(PROJECT_DIR)!.episode_outlines!).toHaveLength(1);
  });

  it('autoApply add_episode 无 phase_ref（先排章后补 phase 合法顺序）→ 落盘 + 预存悬空锚每次 surfaced（projected 全量检查）', async () => {
    // ep-1（phase-1 真锚）+ ep-2（phase-ghost 悬空——上一例 envelope 手动落盘模拟「先排章」结果）
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        autoApply: true,
        actions: [
          { op: 'add_episode', episode: { id: 'ep-2', index: 1, title: '第二章·审判日', phase_ref: 'phase-ghost' } },
        ],
      }),
    );
    expect(res.metadata).toMatchObject({ applied: true, episodeCount: 2 });
    // projected 全量检查：ep-2 悬空锚 surfaced（ep-1 真锚不误报）
    expect(res.metadata?.phaseWarnings).toEqual([{ episodeId: 'ep-2', phaseRef: 'phase-ghost' }]);
    expect(loadProject(PROJECT_DIR)!.episode_outlines!).toHaveLength(2);
  });

  it('autoApply update_episode 补挂 phase_ref → 悬空锚修复后零警告 + 盘上 patch 落', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({
        autoApply: true,
        actions: [{ op: 'update_episode', episodeId: 'ep-2', patch: { phase_ref: 'phase-1' } }],
      }),
    );
    expect(res.metadata).toMatchObject({ applied: true });
    expect(res.metadata?.phaseWarnings).toEqual([]); // 悬空锚已修复 → 全量检查零警告
    const eps = loadProject(PROJECT_DIR)!.episode_outlines!;
    expect(eps.find((e) => e.id === 'ep-2')!.phase_ref).toBe('phase-1');
  });

  it('autoApply remove_episode → 盘上删除（by id 幂等族）', async () => {
    const res = await episodeOutlinesUpdateHandler(
      ctx({ autoApply: true, actions: [{ op: 'remove_episode', episodeId: 'ep-1' }] }),
    );
    expect(res.metadata).toMatchObject({ applied: true, episodeCount: 1 });
    expect(loadProject(PROJECT_DIR)!.episode_outlines!.map((e) => e.id)).toEqual(['ep-2']);
  });
});
