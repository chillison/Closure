/**
 * 风格卡片 MVP（08-28 C 路）：request_style_input——leader 请作者提供文风参考片段。
 *
 * 纯 UI 请求工具：handler 唯一动作 = notifyUI 推 `style_input_requested` 轻事件
 * （tool:event 既有推送通道，零新 IPC/preload 面），renderer useToolEvents 收到后弹
 * 风格片段对话框（StyleInputDialog）。作者提交的片段以标记行结构化 user message 回
 * 对话（shared-contracts buildStyleInputMessage 约定），leader 据此派发风格分析。
 *
 * classifyTool 默认 'read'（纯 UI 请求零数据读写，三档可用，零 toolPolicy 登记；
 * 无补丁无人审面，无 B01 三处同步）。
 */
import { notifyUI } from '../toolNotify';
import type { ToolHandler } from './types';

/** prompt 上限（防御畸形超长入参撑爆对话框 UI）。 */
const PROMPT_MAX_CHARS = 300;

export const requestStyleInputHandler: ToolHandler = async ({ projectDir, params }) => {
  const rawPrompt = (params as { prompt?: unknown }).prompt;
  const prompt = typeof rawPrompt === 'string' && rawPrompt.trim().length > 0
    ? rawPrompt.trim().slice(0, PROMPT_MAX_CHARS)
    : undefined;
  notifyUI({ type: 'style_input_requested', projectPath: projectDir, prompt });
  return {
    title: 'request_style_input',
    // CR-022（08-28 BMad CR edge#4）：notifyUI 是 fire-and-forget——handler 无法确认作者
    // 真看到弹窗（可能已切换项目/窗口失焦）。措辞如实：「已请求」而非「已弹出」，并给
    // leader 兜底路径（未见弹窗 → 对话里直接请作者粘贴片段）。
    output:
      '已请求界面弹出风格片段对话框，请作者粘贴想模仿的小说原文（至少 300 字，可附备注）。'
      + '若作者没有看到弹窗（例如刚好切换了项目），就改为在对话里直接请作者粘贴片段。'
      + '作者提交后，内容会作为一条新消息进入对话，到时再继续；等待期间不要自行编造片段内容，'
      + '作者也可能取消或跳过——那时同样改用对话直接询问。',
    metadata: { ok: true },
  };
};
