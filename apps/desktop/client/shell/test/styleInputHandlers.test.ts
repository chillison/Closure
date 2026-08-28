/**
 * 风格卡片 MVP（08-28 C 路）CR-021：request_style_input shell handler 单测。
 *
 * 覆盖（此前零测试，blind#21）：
 * - notifyUI 载荷组装：type='style_input_requested' + projectPath + prompt（经 tool:event
 *   既有通道广播，mirror toolNotify BrowserWindow.getAllWindows 形态——mock electron）。
 * - prompt 可选：缺省 / 空白串 / 非字符串 → 载荷不带 prompt（UI 侧用默认文案）。
 * - 超长截断：PROMPT_MAX_CHARS（300）防御畸形超长入参撑爆对话框 UI。
 * - 工具输出契约（CR-022）：「已请求」措辞（非「已弹出」断言）+ 未见弹窗兜底指引 +
 *   不编造片段纪律。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const PROJECT_DIR = 'C:\\proj\\style-mvp';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
}));

import { requestStyleInputHandler } from '../main/ipc/toolHandlers/styleInputHandlers';

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: PROJECT_DIR,
  sessionId: 'sess-1',
  abort: new AbortController().signal,
});

/** notifyUI 推送出的 tool:event 载荷（BrowserWindow.getAllWindows → webContents.send）。 */
function pushedEvent(): { type: string; projectPath: string; prompt?: string } {
  expect(send).toHaveBeenCalledTimes(1);
  const [channel, payload] = send.mock.calls[0] as [string, { type: string; projectPath: string; prompt?: string }];
  expect(channel).toBe('tool:event');
  return payload;
}

describe('request_style_input handler（风格卡 CR-021/CR-022）', () => {
  beforeEach(() => {
    send.mockReset();
  });

  it('有 prompt → notifyUI 推 style_input_requested（type + projectPath + prompt）', async () => {
    const res = await requestStyleInputHandler(ctx({ prompt: '贴一段带对话的场景原文' }));

    const payload = pushedEvent();
    expect(payload.type).toBe('style_input_requested');
    expect(payload.projectPath).toBe(PROJECT_DIR);
    expect(payload.prompt).toBe('贴一段带对话的场景原文');
    // 工具结果形态：title + metadata.ok（handler 执行面成功——与 UI 是否真弹窗无关）。
    expect(res.title).toBe('request_style_input');
    expect((res.metadata as { ok: unknown }).ok).toBe(true);
  });

  it('prompt 缺省 / 空白串 / 非字符串 → 载荷不带 prompt（UI 侧默认文案）', async () => {
    await requestStyleInputHandler(ctx({}));
    expect(pushedEvent().prompt).toBeUndefined();

    send.mockClear();
    await requestStyleInputHandler(ctx({ prompt: '   \n\t  ' }));
    expect(pushedEvent().prompt).toBeUndefined();

    send.mockClear();
    await requestStyleInputHandler(ctx({ prompt: 42 }));
    expect(pushedEvent().prompt).toBeUndefined();
  });

  it('超长 prompt → 截断至 PROMPT_MAX_CHARS=300（防撑爆对话框 UI）', async () => {
    const long = '长'.repeat(400);
    await requestStyleInputHandler(ctx({ prompt: long }));

    const payload = pushedEvent();
    expect(payload.prompt).toHaveLength(300);
    expect(payload.prompt).toBe('长'.repeat(300));
  });

  it('CR-022：输出措辞如实（「已请求」非「已弹出」）+ 未见弹窗兜底指引 + 不编造纪律', async () => {
    const res = await requestStyleInputHandler(ctx({ prompt: '贴一段' }));

    // fire-and-forget 不可断言弹窗真出现——措辞须给 leader 兜底路径。
    expect(res.output).toContain('已请求');
    expect(res.output).not.toContain('已请作者在弹出的对话框里粘贴');
    expect(res.output).toContain('没有看到弹窗');
    expect(res.output).toContain('直接请作者粘贴片段');
    // 等待纪律（既有语义保留）：不自行编造片段内容。
    expect(res.output).toContain('不要自行编造片段内容');
  });
});
