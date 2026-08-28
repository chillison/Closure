/**
 * Story 2.6 StoryDecision tool handler - story_decisions_update.
 *
 * 创作决策 ADR 登记（register / supersede / drop），leader 工作台对话 + Director auto 模式共用。
 * Mirror genreContractHandlers（suggest 档产 envelope 不写盘）+ storySyncHandlers autoApply
 * （auto 档 project lock + fresh 读写）。
 *
 * 三档（复用 autonomy 轴，mirror 既有写工具）：
 * - autoApply=true（auto 档）：直写 novel.story_decisions。**复用 applyFieldPatchesWithSkipped
 *   story_decisions 分支**（单写路径：auto 直写与 PatchReview accept 重放走同一 replay 守卫 +
 *   saveProject + meta bump，防两处漂移）。守卫拒 -> 不写盘，错误文案回 tool output。
 * - 缺省（suggest 档）：返回 field_patch envelope（field:'story_decisions'，data={actions, force}
 *   重放语义非 stale after）-> leader runLoop metadata -> PatchReviewPanel 人审 -> accept 经
 *   applyAgentFieldPatch IPC -> applyFieldPatchesWithSkipped 同一分支落盘（2.2 CR-201 教训：
 *   accept 时对 fresh 状态重放，守卫按当时磁盘状态判）。
 * - readonly 档：leader 不调写工具（toolPolicy 门），无此 handler 事。
 *
 * staging 时 dry-run（对当前盘上决策跑 applyDecisionActions）：① 守卫错误早反馈（supersede 目标
 * 不存在 / 转换非法 / user-source 无 force），LLM 当场改；② dangling supersededBy warnings 回
 * tool output（单源双消费：写入方即时反馈，accept 重放处不重复报）。dry-run 不锁盘不写盘。
 *
 * 范式判据（creative-vs-mechanical）：决策内容（summary/reason/alternatives/risk 值不值得记）=
 * LLM 上游（leader / Director）；本 handler 只做 schema 校验 + 守卫重放 + envelope 路由 = 纯代码。
 */
import {
  applyDecisionActions,
  findDanglingSuperseded,
  storyDecisionsUpdateRequestSchema,
  type StoryDecision,
} from '@orison/shared-contracts';
import { getLogger } from '../../logger';
import { withProjectLock } from '../../fs/projectWriteLock';
import type { ToolHandler } from './types';

/** 读盘上 novel.story_decisions（loadProject null -> null，caller 拒写盘）。 */
async function readStoryDecisions(
  projectDir: string,
): Promise<StoryDecision[] | null> {
  try {
    const { loadProject } = await import('@orison/desktop-local-bff');
    const doc = loadProject(projectDir) as { novel?: { story_decisions?: StoryDecision[] } } | null;
    if (doc === null) return null;
    return doc.novel?.story_decisions ?? [];
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    getLogger().warn({ err: reason, projectDir }, '[story_decisions] loadProject threw');
    return null;
  }
}

export const storyDecisionsUpdateHandler: ToolHandler = async ({ params, projectDir }) => {
  const parsed = storyDecisionsUpdateRequestSchema.safeParse(params);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      title: 'story_decisions_update',
      output:
        `创作决策更新被拒：请求格式无效（${issue?.path.join('.') ?? '?'}：${issue?.message ?? '未知'}）。` +
        '请提供 actions[]（register/supersede/drop）+ 可选 autoApply / force。decision 须带 id/summary/reason/risk（risk 必填：登记前想清楚风险）。',
    };
  }
  const { actions, autoApply, force } = parsed.data;

  const current = await readStoryDecisions(projectDir);
  if (current === null) {
    return {
      title: 'story_decisions_update',
      output:
        '创作决策更新被拒：项目设定文件无法读取（可能损坏或缺失），拒绝暂存决策编辑。' +
        '请先检查并修复项目文件。',
    };
  }

  // staging dry-run（不写盘）：守卫错误早反馈 + dangling warnings 即时呈现。
  const nowISO = new Date().toISOString();
  const dry = applyDecisionActions(current, actions, { nowISO, force });
  if (!dry.ok) {
    return {
      title: 'story_decisions_update',
      output: `创作决策更新被守卫拒绝：${dry.error}。请修正 actions（改 id / 走 supersede / 补 force）后重试。`,
      metadata: { ok: false, applied: false },
    };
  }
  const warningLines = dry.warnings.length > 0 ? ` 警告：${dry.warnings.join('；')}。` : '';
  const actionSummary = actions
    .map((a) => (a.op === 'register' ? `register ${a.decision.id}` : a.op === 'supersede' ? `supersede ${a.oldId}->${a.decision.id}` : `drop ${a.id}`))
    .join(', ');
  // CR-E05 缓解：force 可见性——batch 级 force 越过 user-source 保护，summary 提及（PatchReview 行不显
  // data，leader transcript / output 是人审前唯一可见层）。
  const forceNote = force === true ? '（含 force：将越过 source:user 决策的作者权威保护）' : '';

  // ── auto 档：直写（复用 applyFieldPatchesWithSkipped story_decisions 分支 = 单写路径）──
  if (autoApply) {
    try {
      return await withProjectLock(projectDir, async () => {
        const { applyFieldPatchesWithSkipped } = await import('@orison/desktop-local-bff');
        const applied = applyFieldPatchesWithSkipped(projectDir, {
          runId: `story-decisions-${Date.now()}`,
          createdAt: nowISO,
          patches: [
            {
              field: 'story_decisions',
              action: 'set',
              data: { actions, force },
              fieldVersion: 0,
              generatedBy: 'story_decisions_update',
            },
          ],
        });
        // dangling 复算于落盘后数据（fresh 真值非 dry-run 快照）。
        const landed = applied.applied.novel?.story_decisions ?? [];
        const warnings = findDanglingSuperseded(landed);
        const warnLine = warnings.length > 0 ? ` 警告：${warnings.map((w) => `${w.id}->${w.supersededBy} 悬空`).join('；')}。` : '';
        return {
          title: 'story_decisions_update',
          output: `创作决策已登记并落盘（${actionSummary}${forceNote}；source 由 decision.source 标注）。${warnLine}`,
          metadata: { ok: true, applied: true, actionCount: actions.length, warnings },
        };
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn({ err: reason, projectDir }, '[story_decisions] autoApply landing failed');
      return {
        title: 'story_decisions_update',
        output: `创作决策自动落盘失败：${reason}。未做任何改动。`,
        metadata: { ok: false, applied: false },
      };
    }
  }

  // ── suggest 档：envelope 人审（accept 时对 fresh 状态重放，见 applyFieldPatches story_decisions 分支）──
  return {
    title: 'story_decisions_update',
    output: `创作决策登记已备好（${actionSummary}${forceNote}）。请在补丁面板审阅后落盘（确认时按最新盘上状态应用守卫）。${warningLines}`,
    metadata: {
      type: 'field_patch',
      field: 'story_decisions',
      action: 'set',
      data: { actions, force },
    },
  };
};
