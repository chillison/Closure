import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * dogfood R2 #12（findings #12）：从 AgentMessageItem 提出的 MD 渲染单源——
 * 子代理产出卡（DispatchDraftCard）复用同一 sanitize 先例。
 *
 * Sanitize：agent/tool/file content 会到达 renderer（其持有 fs/git 写工具的 IPC
 * 访问权），原始模型输出绝不能作为 HTML 直接执行。
 */
export function renderMarkdown(content: string): string {
  const html = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(html);
}
