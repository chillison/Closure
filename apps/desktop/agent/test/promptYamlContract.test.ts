import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { loadAgentPrompt } from '../src/prompt/agentPrompt';

// ─────────────────────────────────────────────────────────────────────────────
// Story 8.5 CR（CR-Acceptance-#2 / Edge-F6 补测）：prompt yaml 契约测试。
// agentPrompt.test.ts 只锁 system/user 段；本文件锁**契约元数据**（agent_id / from_state / outputs）
// 与 8.5 修真后的关键 prompt 内容——yaml 与 agentContracts.ts 双表示手动同步（ADR-4），漂移只能靠
// 测试拦。prompts 目录解析 mirror agentPrompt.ts（test/ 比 src/prompt/ 浅一层 → ../prompts）。
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', 'prompts');

/** 读 prompts/<role>.yaml 整篇（含契约元数据顶层键；mirror parseAgentPromptYaml 的 BOM 防御）。 */
function loadPromptYaml(role: string): Record<string, unknown> {
  const raw = readFileSync(path.join(PROMPTS_DIR, `${role}.yaml`), 'utf-8');
  const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return yaml.load(bomStripped) as Record<string, unknown>;
}

describe('episode-planner-agent.yaml 契约（Story 8.5 修真后）', () => {
  const contract = loadPromptYaml('episode-planner-agent');

  it('outputs.schema 是真实 schema 名 episodeOutlinesSchema（非空引用 episodePlannerOutputSchema）', () => {
    // 8.5 前 schema 名是空引用（全仓无该 zod）；修真后指向真实 schema。
    expect((contract.outputs as Record<string, unknown>)?.schema).toBe('episodeOutlinesSchema');
    expect((contract.outputs as Record<string, unknown>)?.state_key).toBe('episode_outlines');
  });

  it('inputs.from_state 含 scene_graph（多线场景结构对齐输入，agentContracts.ts reads 镜像）', () => {
    const fromState = (contract.inputs as Record<string, unknown>)?.from_state;
    expect(Array.isArray(fromState)).toBe(true);
    expect(fromState).toContain('scene_graph');
  });

  it('system 段含 phase_ref 挂钩指令与 character_progressions 对齐段（8.5 R2 语义锚）', async () => {
    const { system } = await loadAgentPrompt('episode-planner-agent');
    expect(system).toContain('phase_ref');
    expect(system).toContain('character_progressions');
    expect(system).toContain('phases'); // 按卷/阶段切分
    // 转折点对号（growth_curve turning_points 联动）。
    expect(system).toContain('turning_points');
  });

  it('user 模板含 scene_graph 行（LLM 输入面真的注入多线结构）', async () => {
    const { userTemplate } = await loadAgentPrompt('episode-planner-agent');
    expect(userTemplate).toContain('{{scene_graph}}');
  });

  it('产出路径指向 episode_outlines_update 工具（单一写通道两驱动）', async () => {
    const { userTemplate } = await loadAgentPrompt('episode-planner-agent');
    expect(userTemplate).toContain('episode_outlines_update');
  });
});

describe('story-planner-agent.yaml 结构三型段（Story 8.5 Step 4）', () => {
  it('system 段三型选型指导齐备（总分总莲花 / 递进阶梯 / 并列无限）', async () => {
    const { system } = await loadAgentPrompt('story-planner-agent');
    expect(system).toContain('总分总莲花');
    expect(system).toContain('递进阶梯');
    expect(system).toContain('并列无限');
  });

  it('scene_graph 产出规范要求每场带 title（dogfood R2 批次0：场景人类标题，schema 已同步）', async () => {
    const { system } = await loadAgentPrompt('story-planner-agent');
    expect(system).toContain('每场必须带 title');
  });

  it('user 模板含创作方法论检查单位 {{craftGuide}}（dogfood R2：四因说大纲语法注入，位于 pattern 指引段之后）', async () => {
    const { userTemplate } = await loadAgentPrompt('story-planner-agent');
    expect(userTemplate).toContain('{{craftGuide}}');
    // 位次锁：pattern 指引段之后（任务拍板的模板位——mirror patternGuide/narrativeEnumGuide 资料行）。
    expect(userTemplate.indexOf('{{craftGuide}}')).toBeGreaterThan(userTemplate.indexOf('{{patternGuide}}'));
    expect(userTemplate.indexOf('{{craftGuide}}')).toBeGreaterThan(userTemplate.indexOf('{{narrativeEnumGuide}}'));
  });
});
