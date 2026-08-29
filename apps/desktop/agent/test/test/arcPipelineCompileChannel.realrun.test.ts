/**
 * Story 8.5 Step 9 真跑 suite（B 任务②）：编译通道端到端——磁盘 project.yaml → write_chapter assemble
 * 路径 → brief-compiler 真节点 → chapter_brief.characterProgressions 三源齐。
 *
 * 驱动方式（mirror 8.2 write-chapter-arc-audit.test.ts：真临时项目目录 + 真 yaml 文件；本 suite 不 mock
 * LLM——brief-compiler 是纯代码节点，无需 LLM）：
 * 1. 真磁盘 fixture：growth_curve（8.5 canonical array，转折点 linked_episode_ids 锚 ep-1）
 *    + episode_outlines（ep-1 带 character_progressions + phase_ref）+ asset_cards（character 卡带 name）
 *    + outline_v2.phases + scene_graph（ep-1 场）。
 * 2. mirror write_chapter 入口（write-chapter.ts:123-197 loadChainProjectInput）：agent 直读 project.yaml
 *    + js-yaml 解析 + 逐字段抽取。
 * 3. 真 assembleChapterChainArtifacts（shared 单源，两入口共用）+ mirror write-chapter.ts:2284-2297
 *    post-assemble 注入（asset_cards 5.3 / growth_curve 4.4 caller-fetch 哲学——assemble 不注这两字段）。
 * 4. 真 createBriefCompilerNode().run() → 断言 chapter_brief.characterProgressions。
 *
 * 真跑命令（mirror 8.1 testing-discipline Pattern）：
 *   ELECTRON_RUN_AS_NODE=1 <electron.exe> node_modules/vitest/vitest.mjs run test/arcPipelineCompileChannel.realrun.test.ts
 * （cwd = agent 包）。无 native addon 依赖，plain-Node vitest 同样可跑（不造 ABI 门）。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assembleChapterChainArtifacts,
  type ChapterChainProjectInput,
  type ChapterBrief,
} from '@orison/shared-contracts';
import { createBriefCompilerNode } from '../src/nodes/brief-compiler-node';
import type { RunSnapshot } from '../src/contracts/run';

function makeRun(artifacts: Record<string, unknown>, projectPath: string): RunSnapshot {
  return {
    runId: 'run_arc_pipeline_realrun',
    status: 'running',
    currentNodeId: null,
    projectPath,
    completedNodes: [],
    pendingNodes: [],
    artifacts,
    review: null,
    archive: null,
    delivery: null,
    feedback: null,
  };
}

/** 真磁盘 fixture：三源齐的项目（growth_curve / episode_outlines / asset_cards + phases + scene_graph）。 */
const FIXTURE_YAML = `
meta:
  id: arc-pipeline-realrun
  name: 弧生产线编译通道真跑
  type: novel
  version: 3
  created_at: '2026-08-18T00:00:00.000Z'
  updated_at: '2026-08-18T00:00:00.000Z'
storyboard:
  shots: []
creative_brief:
  rawRequirement: 北境复仇成长线：主角从封闭自保走向重新信任
asset_cards:
  - id: char-lin
    type: character
    name: 林昭
outline_v2:
  phases:
    - id: phase-1
      title: 第一卷·北境风云
scene_graph:
  nodes:
    - id: s-1
      episodeId: ep-1
      storyTime: 0
      presentationOrder: { chapter: 0, pos: 0 }
  edges: []
  lines: []
episode_outlines:
  - id: ep-1
    index: 0
    title: 第一章·风雪叩门
    phase_ref: phase-1
    character_progressions:
      - characterId: char-lin
        from: 封闭自保
        to: 为同伴迈出第一步
  - id: ep-2
    index: 1
    title: 第二章·审判日
growth_curve:
  - character_id: char-lin
    start_state: 封闭自保，不信任任何人
    desire: 查清父亲污名的真相
    turning_points:
      - turning_point: 审判日为同伴作证，信任压过恐惧
        linked_episode_ids: [ep-1]
    regressions: []
    linked_episode_ids: []
`;

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
    } catch {
      // best-effort cleanup（tmpdir 系统级兜底）
    }
  }
});

/**
 * mirror write_chapter execute 前半（loadChainProjectInput + assemble + post-assemble 注入，
 * write-chapter.ts:2073-2091 / 2284-2297）——逐字段抽取 + caller-fetch 注入两段照抄生产时序，
 * 唯一省略的是 gate / retrieval / Director / runChapterChain 派发（LLM 依赖，非本通道对象）。
 */
async function compileBriefFromDisk(
  projectPath: string,
  episodeId: string,
  leaderBrief: ChapterBrief,
): Promise<Record<string, unknown>> {
  const raw = readFileSync(path.join(projectPath, 'project.yaml'), 'utf8');
  const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const obj = yaml.load(bomStripped) as Record<string, unknown>;

  // loadChainProjectInput 逐字段抽取（write-chapter.ts:148-197 同款，本通道消费的字段子集）。
  const input: ChapterChainProjectInput & { growth_curve?: unknown } = {};
  if (obj.creative_brief && typeof obj.creative_brief === 'object') {
    input.creative_brief = obj.creative_brief as ChapterChainProjectInput['creative_brief'];
  }
  if (Array.isArray(obj.asset_cards)) {
    input.asset_cards = obj.asset_cards as ChapterChainProjectInput['asset_cards'];
  }
  if (obj.scene_graph && typeof obj.scene_graph === 'object') {
    input.scene_graph = obj.scene_graph as ChapterChainProjectInput['scene_graph'];
  }
  if (Array.isArray(obj.episode_outlines)) {
    input.episode_outlines = obj.episode_outlines as ChapterChainProjectInput['episode_outlines'];
  }
  if (obj.growth_curve !== undefined) {
    input.growth_curve = obj.growth_curve;
  }

  // 真 assemble（两入口单源）：chapter_brief_input / scene_graph / settings_context / episode_outlines …
  const initialArtifacts = assembleChapterChainArtifacts(input, episodeId, leaderBrief);

  // post-assemble caller-fetch 注入（mirror write-chapter.ts:2284-2297 逐行）：
  // asset_cards（5.3 既有注入点，compileCharacterProgressions 名字解析源）+ growth_curve（4.4 既有注入点，
  // 转折点 join 源）。assemble 不处理这两字段——brief-compiler 需直读 raw。
  if (Array.isArray(input.asset_cards)) {
    initialArtifacts['asset_cards'] = input.asset_cards;
  }
  if (input.growth_curve !== undefined) {
    initialArtifacts['growth_curve'] = input.growth_curve;
  }

  // 真 brief-compiler 节点（链上首节点，纯代码无 LLM）。
  const node = createBriefCompilerNode();
  const result = await node.run({
    run: makeRun(initialArtifacts, projectPath),
    requirement: '',
  });
  expect(result.stateKey).toBe('chapter_brief');
  const artifact = result.artifact as Record<string, unknown>;
  expect(artifact.error).toBeUndefined(); // 非 error artifact（schema reject 路径不触发）
  return artifact;
}

function writeProject(): string {
  const projectPath = mkdtempSync(path.join(os.tmpdir(), 'arc-pipeline-realrun-'));
  writeFileSync(path.join(projectPath, 'project.yaml'), FIXTURE_YAML.trimStart(), 'utf8');
  dirs.push(projectPath);
  return projectPath;
}

describe('真跑：编译通道端到端（project.yaml → assemble → brief-compiler → chapter_brief，Story 8.5 R3）', () => {
  it('三源齐：episode from→to + growth_curve 转折点 join（linked_episode_ids 锚 ep-1）+ character 卡名解析', async () => {
    const projectPath = writeProject();
    const brief = await compileBriefFromDisk(projectPath, 'ep-1', { goal: '林昭在审判日为同伴作证' });

    // 主断言（AC：from→to + turningPoint + characterName 三源齐，经真磁盘数据全链路）
    expect(brief.characterProgressions).toEqual([
      {
        characterId: 'char-lin',
        characterName: '林昭',
        from: '封闭自保',
        to: '为同伴迈出第一步',
        turningPoint: '审判日为同伴作证，信任压过恐惧',
      },
    ]);

    // 同一 brief 的既有通道不被本 feature 破坏（真 assemble 产物顺带锚定）：
    expect(brief.goal).toBe('林昭在审判日为同伴作证'); // LLM 段透传
    expect((brief.plotPoints as { sceneId: string }[]).map((p) => p.sceneId)).toEqual(['s-1']); // #6 汇编
  });

  it('过场章二态：episode 无 progressions（ep-2）→ characterProgressions 不设字段（undefined 非空数组）', async () => {
    const projectPath = writeProject();
    const brief = await compileBriefFromDisk(projectPath, 'ep-2', { goal: '审判日开庭前夜' });

    // growth_curve 转折点只锚 ep-1——即使 growth_curve 在盘上，ep-2 无 episode progressions 主源 → 不设字段
    expect(brief.characterProgressions).toBeUndefined();
    expect(brief.goal).toBe('审判日开庭前夜');
  });

  it('IPC 降级同款语义在真磁盘也成立：growth_curve 缺（不注入）→ 仅 episode 源 + 名字解析（join 降级不抛）', async () => {
    // mirror closureChainIpc 路径（不注 growth_curve artifact）——在真磁盘数据上验证降级零回归：
    // growth_curve 字段从 yaml 里拿掉后重写盘，compile 只剩 episode 源 + asset_cards 名字源。
    const projectPath = writeProject();
    const raw = readFileSync(path.join(projectPath, 'project.yaml'), 'utf8');
    const parsed = yaml.load(raw) as Record<string, unknown>;
    delete parsed.growth_curve;
    writeFileSync(path.join(projectPath, 'project.yaml'), yaml.dump(parsed), 'utf8');

    const brief = await compileBriefFromDisk(projectPath, 'ep-1', { goal: '林昭在审判日为同伴作证' });
    expect(brief.characterProgressions).toEqual([
      {
        characterId: 'char-lin',
        characterName: '林昭', // asset_cards 注入仍在（真锚）
        from: '封闭自保',
        to: '为同伴迈出第一步',
        // turningPoint 缺（growth_curve 无 → join 降级）
      },
    ]);
  });
});
