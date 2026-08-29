import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../src/types';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2（task 08-25-dogfood-round2）：outline quality gates 三项运行时真验测试。
//
// 接线形态（见 src/tool/outline-quality-gates.ts 头注）：outline_update 在 agent 注册层换
// quality-gate 包装——execute 委托注入的 ExecuteToolFn（shell handler 照常产 field_patch
// envelope，行为零变），再对**合并后结果大纲**（当前现值 ⊕ 载荷，CR-7）验三项。本文件测四层：
// 1. validateOutlineQualityGates 纯函数：全过/缺一/全缺各态 + 议题形态（mirror SceneGraphIssue）。
// 2. attachOutlineQualityGates：tool result 挂warn（output 追加 + envelope 旁 metadata 键）。
// 3. registry 接线：mock ExecuteToolFn（按 toolId 路由——outline_read 现值 + outline_update
//    envelope，mirror batch-integration setExecuteToolFn 模式）跑注册后的 outline_update 工具
//    本体——envelope 原样透传 + 议题挂载形态 + CR-7 merge 语义 + CR-8 失败形直返。
// 4. CR-1 schema 收紧（builtin.ts 注册面）：缺核心字段（phases / central_conflict /
//    major_turning_points / ending_direction）的载荷被 zod 拒掉——shell action:'set' 整体替换
//    语义下防 LLM 部分载荷真抹掉未提及字段。
// ─────────────────────────────────────────────────────────────────────────────

import {
  attachOutlineQualityGates,
  outlineUpdateWithQualityGates,
  validateOutlineQualityGates,
  type OutlineQualityGateIssue,
} from '../src/tool/outline-quality-gates';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { setExecuteToolFn } from '../src/tool/remote';

registerBuiltinTools();

/** 三 gate 全过的大纲（major_turning_points 混一个缺 label 项——只要有一项带 label 即过）。 */
const COMPLETE_OUTLINE = {
  story_type: '末世修真长篇',
  central_conflict: '主角要在灵气枯竭前夺回被夺走的本源，而夺走它的是她曾经最信任的师尊',
  major_turning_points: [
    { type: 'core-anchor', label: '山门决战' },
    { type: 'secondary-anchor', label: '   ', description: '缺 label 的次锚点不拖累 gate' },
  ],
  ending_direction: '悲剧式圆满：本源夺回，师门已空，主角带着废土走向新的山门',
  phases: [{ id: 'p1', title: '卷一', goal: '察觉本源被夺', climax: '山门对峙', hook: '师尊的真面目' }],
};

/** shell outlineUpdateHandler 返回形态的基线 envelope（mock 载荷，mirror 真实 metadata 形状）。 */
function baselineEnvelope(outline: unknown) {
  return {
    title: 'outline_update',
    output: '大纲更新已备好（共 1 个阶段）。请在大纲面板审阅——确认后写入项目设定。',
    metadata: {
      type: 'field_patch',
      field: 'outline',
      action: 'set',
      data: outline,
    },
  };
}

describe('validateOutlineQualityGates（纯函数，三 gate 各态）', () => {
  it('全过：三项齐备 → 零议题', () => {
    expect(validateOutlineQualityGates(COMPLETE_OUTLINE)).toEqual([]);
  });

  it('缺一：仅缺 central_conflict → 单议题且 code 对应', () => {
    const { central_conflict: _omit, ...rest } = COMPLETE_OUTLINE;
    const issues = validateOutlineQualityGates(rest);
    expect(issues.map((i) => i.code)).toEqual(['has_central_conflict']);
  });

  it('缺一：仅缺 major_turning_points → 单议题且 code 对应', () => {
    const { major_turning_points: _omit, ...rest } = COMPLETE_OUTLINE;
    expect(validateOutlineQualityGates(rest).map((i) => i.code)).toEqual(['has_major_turning_points']);
  });

  it('缺一：仅缺 ending_direction → 单议题且 code 对应', () => {
    const { ending_direction: _omit, ...rest } = COMPLETE_OUTLINE;
    expect(validateOutlineQualityGates(rest).map((i) => i.code)).toEqual(['has_ending_direction']);
  });

  it('全缺：空对象 → 三议题，code 集与 CONTRACTS qualityGates 三项一一对应（顺序稳定）', () => {
    const issues = validateOutlineQualityGates({});
    expect(issues.map((i) => i.code)).toEqual([
      'has_central_conflict',
      'has_major_turning_points',
      'has_ending_direction',
    ]);
  });

  it('空白串视同缺失（trim 后判空）：central_conflict 纯空白 → 议题', () => {
    const issues = validateOutlineQualityGates({ ...COMPLETE_OUTLINE, central_conflict: '   \n\t ' });
    expect(issues.map((i) => i.code)).toEqual(['has_central_conflict']);
  });

  it('major_turning_points 各坏态：非数组 / 空数组 / 全项无 label → 议题；一项有 label 即过', () => {
    for (const bad of ['not-an-array', [], [{ type: 'core-anchor' }, { type: 'fork-point', label: '' }]]) {
      const issues = validateOutlineQualityGates({ ...COMPLETE_OUTLINE, major_turning_points: bad });
      expect(issues.map((i) => i.code)).toEqual(['has_major_turning_points']);
    }
    const pass = validateOutlineQualityGates({
      ...COMPLETE_OUTLINE,
      major_turning_points: [{ type: 'secondary-anchor', label: '码头截货' }],
    });
    expect(pass).toEqual([]);
  });

  it('非 object 输入（null/数组/字符串）防御性全报，不抛', () => {
    for (const bad of [null, undefined, ['x'], 'outline']) {
      expect(validateOutlineQualityGates(bad)).toHaveLength(3);
    }
  });

  it('议题形态 mirror SceneGraphIssue：severity 恒 warning + targets 指向 outline 字段 + 叙事语言 message/suggestion', () => {
    const issues: OutlineQualityGateIssue[] = validateOutlineQualityGates({});
    for (const issue of issues) {
      expect(issue.severity).toBe('warning');
      expect(issue.targets).toEqual([{ kind: 'field', id: expect.any(String) }]);
      expect(issue.message.length).toBeGreaterThan(10);
      expect(issue.suggestion.length).toBeGreaterThan(10);
    }
    // targets 与 gate 的字段一一对应（后续 UI 定位高亮的锚）。
    expect(issues.map((i) => i.targets[0]!.id)).toEqual([
      'central_conflict',
      'major_turning_points',
      'ending_direction',
    ]);
    // 叙事语言锚句（非字段术语——任务给定的 ending_direction 例句逐字保留）。
    expect(issues[2]!.message).toBe('大纲缺结局方向——长篇没有终点站，中段会失去引力');
  });
});

describe('attachOutlineQualityGates（tool result 挂 warn，不阻断）', () => {
  it('全过 → 原样返回（同一引用，零开销快路径）', () => {
    const result = baselineEnvelope(COMPLETE_OUTLINE);
    expect(attachOutlineQualityGates(result, COMPLETE_OUTLINE)).toBe(result);
  });

  it('有缺口 → output 追加质量提示段（保留原 output + message + suggestion），metadata 附加 qualityGateIssues 且 envelope 本体字段不动', () => {
    const result = baselineEnvelope({});
    const enriched = attachOutlineQualityGates(result, {});
    expect(enriched).not.toBe(result);
    // 原样保留：output 前缀 + envelope 四字段。
    expect(enriched.output.startsWith(result.output)).toBe(true);
    expect(enriched.metadata).toMatchObject({
      type: 'field_patch',
      field: 'outline',
      action: 'set',
      data: {},
    });
    // 追加：警示段 + 三议题。
    expect(enriched.output).toContain('大纲质量提示');
    expect(enriched.output).toContain('不阻断');
    expect(enriched.output).toContain('大纲缺核心冲突');
    expect(enriched.output).toContain('建议：');
    const issues = (enriched.metadata as { qualityGateIssues?: OutlineQualityGateIssue[] }).qualityGateIssues;
    expect(issues).toHaveLength(3);
    expect(issues!.map((i) => i.code)).toEqual([
      'has_central_conflict',
      'has_major_turning_points',
      'has_ending_direction',
    ]);
  });

  it('原 result 不被 mutate（浅拷贝追加）', () => {
    const result = baselineEnvelope({});
    const snapshot = JSON.stringify(result);
    attachOutlineQualityGates(result, {});
    expect(JSON.stringify(result)).toBe(snapshot);
  });
});

describe('registry 接线（outline_update 包装工具本体，mock ExecuteToolFn）', () => {
  let remoteExecute: ReturnType<typeof vi.fn>;
  const ctx: ToolContext = {
    sessionId: 'leader-1',
    projectPath: 'C:/tmp/dogfood-r2',
    abort: new AbortController().signal,
  };

  beforeEach(() => {
    remoteExecute = vi.fn();
    setExecuteToolFn(remoteExecute);
  });

  /**
   * 按 toolId 路由的 mock（CR-7 起 wrapper 会先 outline_update 再 outline_read 取现值）：
   * outline_read → 现值 JSON（null = 尚未建大纲的提示文案形态）；outline_update → 回载荷的 envelope。
   */
  function routeRemote(current: unknown, updateResult?: Record<string, unknown>) {
    remoteExecute.mockImplementation(async (toolId: string, params: unknown) => {
      if (toolId === 'outline_read') {
        return {
          title: 'outline_read',
          output: current === null ? '项目尚未建立大纲（outline 为空）。' : JSON.stringify(current, null, 2),
        };
      }
      return updateResult ?? baselineEnvelope((params as { outline?: unknown }).outline);
    });
  }

  it('全过：shell envelope 原样透传（output 逐字 + metadata 无 qualityGateIssues 键）', async () => {
    routeRemote(COMPLETE_OUTLINE);

    const result = await registry.get('outline_update')!.execute(
      { outline: COMPLETE_OUTLINE },
      ctx,
    );

    // 转发契约：update 调用同 toolId + 参数原样（包装不改执行路径）；outline_read 是 CR-7 的
    // 现值读取（只在 envelope 确认后发——见 CR-8 测试的反向断言）。
    const updateCall = remoteExecute.mock.calls.find((c) => c[0] === 'outline_update')!;
    expect(updateCall![1]).toEqual({ outline: COMPLETE_OUTLINE });
    expect(remoteExecute).toHaveBeenCalledTimes(2);

    expect(result.output).toBe(baselineEnvelope(COMPLETE_OUTLINE).output);
    expect(result.metadata).toEqual(baselineEnvelope(COMPLETE_OUTLINE).metadata);
    expect('qualityGateIssues' in (result.metadata ?? {})).toBe(false);
  });

  it('全缺：Warn 议题挂 tool result——output 追加警示段，metadata.qualityGateIssues 三项（envelope 本体不动）', async () => {
    // 现值 = 尚未建大纲（outline_read 返回提示文案，JSON.parse 失败 → null）→ merged 即载荷。
    const hollow = { phases: [{ id: 'p1', title: '卷一' }] };
    routeRemote(null);

    const result = await registry.get('outline_update')!.execute({ outline: hollow }, ctx);

    expect(result.output).toContain('大纲更新已备好'); // 原 output 保留
    expect(result.output).toContain('大纲质量提示');
    expect(result.output).toContain('大纲缺结局方向——长篇没有终点站，中段会失去引力');
    const meta = result.metadata as {
      type?: string; field?: string; action?: string;
      qualityGateIssues?: OutlineQualityGateIssue[];
    };
    expect(meta.type).toBe('field_patch');
    expect(meta.field).toBe('outline');
    expect(meta.action).toBe('set');
    expect(meta.qualityGateIssues).toHaveLength(3);
  });

  it('CR-7：校验合并后结果——载荷漏键回落现值，合法部分重规划不吃「缺核心冲突」假警告', async () => {
    // 现值完整；载荷只带 phases（CR-1 收紧前的真实病灶形态——schema 面已拒，wrapper 的
    // merge 是防御层）→ merged 从现值补齐三个 gate 字段 → 零议题。
    routeRemote(COMPLETE_OUTLINE);
    const partialReplan = { phases: [{ id: 'p2', title: '卷二' }] };

    const result = await registry.get('outline_update')!.execute({ outline: partialReplan }, ctx);

    expect(result.output).not.toContain('大纲质量提示');
    expect('qualityGateIssues' in (result.metadata ?? {})).toBe(false);
  });

  it('CR-7：载荷提供的键是新的真相——现值有核心冲突但载荷清空 → 照样告警（merge 非拿现值兜底）', async () => {
    routeRemote(COMPLETE_OUTLINE);
    const wiping = { ...COMPLETE_OUTLINE, central_conflict: '' };

    const result = await registry.get('outline_update')!.execute({ outline: wiping }, ctx);

    const issues = (result.metadata as { qualityGateIssues?: OutlineQualityGateIssue[] }).qualityGateIssues;
    expect(issues!.map((i) => i.code)).toEqual(['has_central_conflict']);
  });

  it('CR-7：现值读取通道失败（outline_read 抛错）→ 回落仅载荷校验，不阻断 update 主路径', async () => {
    remoteExecute.mockImplementation(async (toolId: string) => {
      if (toolId === 'outline_read') throw new Error('read channel down');
      return baselineEnvelope({ phases: [] });
    });

    const result = await registry.get('outline_update')!.execute({ outline: { phases: [] } }, ctx);

    expect(result.output).toContain('大纲质量提示');
    expect((result.metadata as { qualityGateIssues?: OutlineQualityGateIssue[] }).qualityGateIssues).toHaveLength(3);
  });

  it('CR-8：error/failure 形结果（未 stage patch）直返——不贴 qualityGateIssues/warn 文本，且不读现值', async () => {
    const failed: Record<string, unknown> = {
      title: 'outline_update',
      output: 'Error: shell handler 拒绝（失败形演示）',
      metadata: { type: 'error', message: 'demo' },
    };
    routeRemote(COMPLETE_OUTLINE, failed);

    const result = await registry.get('outline_update')!.execute(
      { outline: { phases: [] } as unknown as Record<string, unknown> },
      ctx,
    );

    // 原样返回（同一引用）+ 只有 update 一跳（读现值在 envelope 判定之后，失败路径零额外 IPC）。
    expect(result as unknown as Record<string, unknown>).toBe(failed);
    expect(remoteExecute).toHaveBeenCalledTimes(1);
    expect(remoteExecute.mock.calls[0]![0]).toBe('outline_update');
    expect('qualityGateIssues' in ((result.metadata as Record<string, unknown>) ?? {})).toBe(false);
  });

  it('注册面 CR-1：schema 全量收紧——缺核心字段的载荷被 zod 拒掉（全量替换语义的防抹掉闸）', () => {
    const tool = registry.get('outline_update')!;
    expect(tool.id).toBe('outline_update');
    expect(tool.description).toContain('Propose an update to the project outline');
    // description 同步注明全量替换语义 + 部分更新先 outline_read 再全量回写（CR-1）。
    expect(tool.description).toContain('FULL-REPLACE');
    expect(tool.description).toContain('outline_read');
    // 全量载荷过；缺任一核心字段 → 拒。
    expect(tool.parameters.safeParse({ outline: COMPLETE_OUTLINE }).success).toBe(true);
    for (const key of ['phases', 'central_conflict', 'major_turning_points', 'ending_direction'] as const) {
      const { [key]: _omit, ...rest } = COMPLETE_OUTLINE;
      expect(tool.parameters.safeParse({ outline: rest }).success).toBe(false);
    }
    // 核心齐 + 零可选元数据 → 过（纯可选元数据项保持可选）。
    const coreOnly = {
      phases: COMPLETE_OUTLINE.phases,
      central_conflict: COMPLETE_OUTLINE.central_conflict,
      major_turning_points: COMPLETE_OUTLINE.major_turning_points,
      ending_direction: COMPLETE_OUTLINE.ending_direction,
    };
    expect(tool.parameters.safeParse({ outline: coreOnly }).success).toBe(true);
    // major_turning_points 允许空数组——真无锚点显式给 []（防的是沉默漏发抹掉既有锚点）。
    expect(tool.parameters.safeParse({ outline: { ...coreOnly, major_turning_points: [] } }).success).toBe(true);
  });

  it('outlineUpdateWithQualityGates 工厂转发语义：注入 fn 抛错时原样穿透（包装不吞错）', async () => {
    setExecuteToolFn(async () => {
      throw new Error('shell unreachable');
    });
    const tool = outlineUpdateWithQualityGates({
      id: 'outline_update',
      description: 'test',
      parameters: z.object({ outline: z.unknown() }),
    });
    await expect(tool.execute({ outline: {} }, ctx)).rejects.toThrow('shell unreachable');
  });
});
