import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStyleInputMessage, computeStyleStats, renderStyleStatsBlock } from '@orison/shared-contracts';

// ─────────────────────────────────────────────────────────────────────────────
// 风格卡片 MVP A 路（task 08-28-style-card-mvp）：dispatch_style_analyzer 测试
//（mirror dispatch-planners.test.ts 形态 + batch-tools.test.ts 的 session 装配模式）。
// 契约修订（主会话拍板 2026-08-28）：**零参数**——材料引用 = 倒序取最近一条结构化风格片段
// 提交（C 路单源 parseStyleInputMessage，标记行结构），无自由文本回退。测六块：
// 1. D4 原文直传（AC5）：机械提取 → vars.sourceMaterial 与 fragment 载荷逐字节一致（===
//    断言）；两条结构化取最近；零命中返收集引导语；零参 schema strip 片段文本不入参数面。
// 2. setting_md_patch envelope（settingId='style'）：create / replace（含 CRLF 归一、空正文
//    insert_after、空文件 create_file CR-016）/ before-after 投影 / 不写盘（suggest 档语义）。
// 3. 材料不足双分支：分析者结论透传 + 短片段工具侧短路（零派发）+ 超长片段上限门（CR-019）。
// 4. 提取失败分支：无结构化提交 / 最近提交空片段 / 会话缺失。
// 5. graceful：skillExecutor 缺 / dispatch 抛错 / 空返回 / child 事件透传（#6 先例）。
// 6. 契约与注册：yaml user 模板 var 对齐守卫 / system 方法论要点 / CONTRACTS 镜像 +
//    YAML_AGENT_SLOT 档位 / builtin 注册 + classifyTool='diff' + readonly 不可见 /
//    yaml outputs 无 state_key（CR-017）/ 哨兵白名单真零工具（CR-005）。
// ─────────────────────────────────────────────────────────────────────────────

import { createSession, deleteSession } from '../src/agent/session';
import { closeDb } from '../src/agent/persistence';
import {
  INSUFFICIENT_MATERIAL_PREFIX,
  MAX_FRAGMENT_CHARS,
  MIN_FRAGMENT_CHARS,
  STYLE_ANALYZER_ALLOWED_TOOLS,
  STYLE_ANALYZER_ROLE,
  buildStyleAnalyzerVars,
  buildStyleCardActions,
  dispatchStyleAnalyzerTool,
  extractStyleSourcePayload,
  injectStyleStatsBlock,
} from '../src/tool/dispatch-style-analyzer';
import { registerBuiltinTools } from '../src/tool/builtin';
import { registry } from '../src/tool/registry';
import { loadAgentPrompt } from '../src/prompt/agentPrompt';
import { classifyTool, filterToolsForPolicy } from '../src/runtime/toolPolicy';
import { YAML_AGENT_SLOT } from '../src/runtime/taskModelRouting';
import { getAgentContract } from '../src/engine/agentContracts';
import type { SessionMessage, ToolContext } from '../src/types';

registerBuiltinTools();

/** prompts 目录（yaml 契约元数据守卫用，mirror promptYamlContract.test.ts 解析口径）。 */
const PROMPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

/** 从 yaml user 模板提取全部 {{var}} 名（对齐守卫用，mirror dispatch-planners.test.ts）。 */
function templateVarsOf(template: string): string[] {
  return [...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!);
}

/** ≥300 字的片段（非空白字符过 MIN_FRAGMENT_CHARS——工具侧短路不触发）。 */
const LONG_FRAGMENT =
  '  夜色像铁。他站在门口，没有进去……\n「你来了。」她说着——灯芯还在抖。' + '雨停了又下，灯灭了又亮。'.repeat(40);

/** 第二段结构化片段（两取最近用例）。 */
const LONG_FRAGMENT_2 =
  '  雪落了一整夜。他推门进来，抖掉肩上的白。\n「吃了吗。」她问——灶上的火还温着。' + '风停了又起，柴添了又烧。'.repeat(40);

/** 分析者返回的典型卡（②节只写标题——统计块由工具机械注入）。 */
const ANALYZER_CARD = [
  '# 风格卡片',
  '',
  '> 本卡管「像谁」（正面画像）；llmlint 管「不像 AI」（负面清单）——两者互补。',
  '',
  '## ① 声音画像',
  '',
  '冷眼旁观的叙述者。',
  '',
  '## ② 机械统计',
  '',
  '## ⑬ 节选（few-shot）',
  '',
  '```text',
  '夜色像铁。他站在门口，没有进去……',
  '```',
  '',
  '## ⑭ 原文附录',
  '',
  '```text',
  '（完整片段）',
  '```',
  '',
].join('\n');

function makeMessage(id: string, role: SessionMessage['role'], content: string): SessionMessage {
  return { id, role, content, createdAt: Date.now() };
}

function makeCtx(sessionId: string, projectPath: string, skillExecutor?: ToolContext['skillExecutor']): ToolContext {
  return { sessionId, projectPath, abort: new AbortController().signal, ...(skillExecutor ? { skillExecutor } : {}) };
}

describe('dispatch_style_analyzer — 派发接线 + D4 原文直传（AC5，零参数倒序取最近）', () => {
  let projectPath = '';
  let sessionId = '';

  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-style-analyzer-'));
    const session = createSession({ agentName: 'writer', projectPath });
    sessionId = session.id;
  });

  afterEach(async () => {
    closeDb(projectPath);
    deleteSession(sessionId);
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('结构化载荷：sourceMaterial 与 fragment 逐字节一致（===）+ role/vars/userNote + 哨兵白名单真零工具（CR-005）+ envelope create', async () => {
    const notes = '喜欢它的短句节奏，想学对话。';
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [makeMessage('msg-fragment-1', 'user', buildStyleInputMessage(LONG_FRAGMENT, notes))],
    });
    const runAgentWithExplicitSystem = vi.fn().mockResolvedValue({ content: ANALYZER_CARD });

    const result = await dispatchStyleAnalyzerTool.execute(
      {},
      makeCtx(session.id, projectPath, { runAgentWithExplicitSystem }),
    );

    expect(runAgentWithExplicitSystem).toHaveBeenCalledTimes(1);
    const [calledSessionId, role, vars, options] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(calledSessionId).toBe(session.id);
    expect(role).toBe(STYLE_ANALYZER_ROLE);
    expect(role).toBe('style-analyzer-agent');

    // AC5 逐字节：分析者收到的材料 = 提交 fragment 原文（含首尾空白/换行/省略号）。
    expect(vars.sourceMaterial).toBe(LONG_FRAGMENT);
    expect(vars.userNote).toBe(notes);
    // stats 喂入在场：= renderStyleStatsBlock(computeStyleStats(fragment)) 单源投影。
    expect(vars.styleStats).toBe(renderStyleStatsBlock(computeStyleStats(LONG_FRAGMENT)));
    expect(vars.styleStats).toContain('句长分布');
    // CR-005 哨兵法：白名单**非空**（seam 对空数组回落全工具面——空数组是假禁用）且过滤后真零工具。
    expect(options.allowedTools.length).toBeGreaterThan(0);
    expect(options.allowedTools).toEqual([...STYLE_ANALYZER_ALLOWED_TOOLS]);
    // seam 语义模拟（workflow.ts runChildAgentWithExplicitSystem 的同一 filter）：哨兵不命中
    // 任何注册工具 → 子 agent 可见工具集为空（真·无工具纯判断）。
    const visibleToChild = registry
      .all()
      .filter((t) => (options.allowedTools as string[]).includes(t.id));
    expect(visibleToChild).toEqual([]);

    // envelope：create 路径（无既有卡）。
    const meta = result.metadata as {
      ok: boolean; type: string; settingId: string; created: boolean;
      actions: Array<{ op: string; title?: string; content?: string }>;
      before: string; after: string; summary: string;
    };
    expect(meta.ok).toBe(true);
    expect(meta.type).toBe('setting_md_patch');
    expect(meta.settingId).toBe('style');
    expect(meta.created).toBe(true);
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0]!.op).toBe('create_file');
    expect(meta.actions[0]!.title).toBe('风格卡片');
    expect(meta.before).toBe('');
    // after 含 frontmatter 盖章（id/type/source）+ 卡 H1 + 机械注入的统计块。
    expect(meta.after).toContain("id: 'style'");
    expect(meta.after).toContain("type: 'style'");
    expect(meta.after).toContain("source: 'agent'");
    expect(meta.after).toContain('# 风格卡片');
    expect(meta.after).toContain(renderStyleStatsBlock(computeStyleStats(LONG_FRAGMENT)));
    // 不写盘（suggest 档语义——人审 accept 才落）。
    expect(existsSync(path.join(projectPath, 'settings', 'style.md'))).toBe(false);

    deleteSession(session.id);
  });

  it('两条结构化提交 → 取最近一条（重提交重做语义：新片段胜出）', async () => {
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [
        makeMessage('msg-old', 'user', buildStyleInputMessage(LONG_FRAGMENT)),
        makeMessage('msg-assistant-1', 'assistant', '收到了，我去分析。'),
        makeMessage('msg-new', 'user', buildStyleInputMessage(LONG_FRAGMENT_2, '换这个声音')),
      ],
    });
    const runAgentWithExplicitSystem = vi.fn().mockResolvedValue({ content: ANALYZER_CARD });

    await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem }));

    const [, , vars] = runAgentWithExplicitSystem.mock.calls[0]!;
    expect(vars.sourceMaterial).toBe(LONG_FRAGMENT_2);
    expect(vars.userNote).toBe('换这个声音');
    // 统计随新片段重算（非旧片段的）。
    expect(vars.styleStats).toBe(renderStyleStatsBlock(computeStyleStats(LONG_FRAGMENT_2)));

    deleteSession(session.id);
  });

  it('零命中（无结构化提交）→ 收集引导语 + 零派发（无自由文本回退——直贴流也走对话框）', async () => {
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [
        makeMessage('msg-plain', 'user', `${LONG_FRAGMENT}\n（作者直接在输入框贴的片段——不是结构化提交，不认）`),
        makeMessage('msg-assistant-2', 'assistant', ANALYZER_CARD),
      ],
    });
    const dispatch = vi.fn();

    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.output).toContain('request_style_input');
    expect(result.output).toContain('还没有作者提交的文风片段');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'no-style-input' });

    deleteSession(session.id);
  });

  it('child 事件通道透传（#6 先例）：ctx 带 emitChildEvent 时进派发 options，缺失时不占位', async () => {
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [makeMessage('msg-emit-1', 'user', buildStyleInputMessage(LONG_FRAGMENT))],
    });
    const runAgentWithExplicitSystem = vi.fn().mockResolvedValue({ content: ANALYZER_CARD });
    const emit = vi.fn();

    await dispatchStyleAnalyzerTool.execute({}, { ...makeCtx(session.id, projectPath, { runAgentWithExplicitSystem }), emitChildEvent: emit });
    expect(runAgentWithExplicitSystem.mock.calls[0]![3]!.emitChildEvent).toBe(emit);

    const runAgent2 = vi.fn().mockResolvedValue({ content: ANALYZER_CARD });
    await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: runAgent2 }));
    expect('emitChildEvent' in runAgent2.mock.calls[0]![3]!).toBe(false);

    deleteSession(session.id);
  });
});

describe('dispatch_style_analyzer — setting_md_patch envelope（既有卡分支）', () => {
  let projectPath = '';
  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-style-analyzer-card-'));
  });
  afterEach(async () => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  function setupSession(messages: SessionMessage[]): { sessionId: string; dispatch: ReturnType<typeof vi.fn> } {
    const session = createSession({ agentName: 'writer', projectPath, messages });
    const dispatch = vi.fn().mockResolvedValue({ content: ANALYZER_CARD });
    return { sessionId: session.id, dispatch };
  }

  it('replace：quote=旧正文逐字（LF 归一）+ before=归一后全文（CR-015，LF 输入归一为恒等）+ after=frontmatter 保留 + 不写盘', async () => {
    const oldCard = "---\nid: 'style'\nsource: 'user'\n---\n# 风格卡片\n\n旧的声音画像。\n";
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), oldCard, 'utf8');

    const { sessionId, dispatch } = setupSession([makeMessage('msg-replace-1', 'user', buildStyleInputMessage(LONG_FRAGMENT))]);
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(sessionId, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(sessionId);

    const meta = result.metadata as {
      type: string; created: boolean; before: string; after: string;
      actions: Array<{ op: string; anchor: { quote: string }; replacement: string }>;
    };
    expect(meta.type).toBe('setting_md_patch');
    expect(meta.created).toBe(false);
    expect(meta.actions).toHaveLength(1);
    expect(meta.actions[0]!.op).toBe('replace_span');
    expect(meta.actions[0]!.anchor.quote).toBe('# 风格卡片\n\n旧的声音画像。\n');
    // CR-015：before 走归一（normalizeSettingMdContent 单源）——LF 输入归一恒等，逐字节保持。
    expect(meta.before).toBe(oldCard);
    expect(meta.after.startsWith("---\nid: 'style'")).toBe(true);
    expect(meta.after).toContain('# 风格卡片');
    expect(meta.after).not.toContain('旧的声音画像');
    expect(meta.after).toContain(renderStyleStatsBlock(computeStyleStats(LONG_FRAGMENT)));
    // 不写盘：磁盘保持旧卡原样。
    expect(readFileSync(path.join(projectPath, 'settings', 'style.md'), 'utf8')).toBe(oldCard);
  });

  it('CRLF 既有卡：锚引用按归一（LF）取，envelope before/after 均归一（CR-015——人审 diff 不全线飘红），after 全 LF', async () => {
    const oldCard = "---\r\nid: 'style'\r\nsource: 'agent'\r\n---\r\n# 风格卡片\r\n\r\n旧卡。\r\n";
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), oldCard, 'utf8');

    const { sessionId, dispatch } = setupSession([makeMessage('msg-crlf-1', 'user', buildStyleInputMessage(LONG_FRAGMENT))]);
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(sessionId, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(sessionId);

    const meta = result.metadata as { created: boolean; before: string; after: string; actions: Array<{ op: string; anchor: { quote: string } }> };
    expect(meta.created).toBe(false);
    expect(meta.actions[0]!.op).toBe('replace_span');
    // 锚 = 归一后旧正文（LF）——applySettingMdActions 内部同口径归一，精确命中。
    expect(meta.actions[0]!.anchor.quote).toBe('# 风格卡片\n\n旧卡。\n');
    expect(meta.actions[0]!.anchor.quote).not.toContain('\r\n');
    // CR-015：before 与 after 同口径归一（LF）——词级 diff 卡两侧同形态，CRLF 存量卡不再全线飘红。
    expect(meta.before).not.toContain('\r');
    expect(meta.before).toBe("---\nid: 'style'\nsource: 'agent'\n---\n# 风格卡片\n\n旧卡。\n");
    expect(meta.after).not.toContain('\r');
  });

  it('空正文既有卡（只有 frontmatter）→ insert_after 全文锚 + 卡接文末', async () => {
    const oldCard = "---\nid: 'style'\nsource: 'agent'\n---\n";
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), oldCard, 'utf8');

    const { sessionId, dispatch } = setupSession([makeMessage('msg-empty-body-1', 'user', buildStyleInputMessage(LONG_FRAGMENT))]);
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(sessionId, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(sessionId);

    const meta = result.metadata as { created: boolean; after: string; actions: Array<{ op: string; anchor: { quote: string }; insertion: string }> };
    expect(meta.created).toBe(false);
    expect(meta.actions[0]!.op).toBe('insert_after');
    expect(meta.actions[0]!.anchor.quote).toBe(oldCard);
    expect(meta.after.startsWith(oldCard)).toBe(true);
    expect(meta.after).toContain('# 风格卡片');
  });

  it('空文件既有卡 → 当无卡 create_file 新建（CR-016：无内容冲突，不再推作者手动删文件）', async () => {
    mkdirSync(path.join(projectPath, 'settings'), { recursive: true });
    writeFileSync(path.join(projectPath, 'settings', 'style.md'), '', 'utf8');

    const { sessionId, dispatch } = setupSession([makeMessage('msg-empty-file-1', 'user', buildStyleInputMessage(LONG_FRAGMENT))]);
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(sessionId, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(sessionId);

    const meta = result.metadata as {
      ok: boolean; type: string; created: boolean; before: string; after: string;
      actions: Array<{ op: string }>;
    };
    expect(meta.ok).toBe(true);
    expect(meta.type).toBe('setting_md_patch');
    expect(meta.created).toBe(true);
    expect(meta.actions[0]!.op).toBe('create_file');
    expect(meta.before).toBe('');
    expect(meta.after).toContain('# 风格卡片');
    expect(meta.after).toContain(renderStyleStatsBlock(computeStyleStats(LONG_FRAGMENT)));
    // 不写盘（人审 accept 才落——accept 重放走 applyAndPersistSettingMd，空白既有内容同放行）。
    expect(readFileSync(path.join(projectPath, 'settings', 'style.md'), 'utf8')).toBe('');
  });

  it('零参 schema：空对象过；LLM 幻觉多传的参数被 strip（片段文本不进参数面）', () => {
    expect(dispatchStyleAnalyzerTool.parameters.safeParse({}).success).toBe(true);
    expect(dispatchStyleAnalyzerTool.parameters.parse({ sourceMessageId: 'x', fragment: '不该出现的字段' })).toEqual({});
  });
});

describe('dispatch_style_analyzer — 材料不足双分支 + 超长上限门（CR-019）', () => {
  let projectPath = '';
  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-style-analyzer-insuff-'));
  });
  afterEach(async () => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('短片段：工具侧短路（零派发）+ 提示 leader 回问', async () => {
    const session = createSession({ agentName: 'writer', projectPath, messages: [makeMessage('msg-short-1', 'user', buildStyleInputMessage('太短了。'))] });
    const dispatch = vi.fn();

    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(session.id);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.output).toContain('材料不足');
    expect(result.output).toContain('重新提交');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'insufficient-material' });
  });

  it('超长片段（>100_000 字）：工具侧短路回「片段过长」（零派发，CR-019）', async () => {
    // 11 非空白字符 × 20_000 = 220_000 字（过上限；computeStyleStats 先算——reduce 修复后超大输入安全）。
    const giant = '夜色像铁，灯灭了又亮。'.repeat(20_000);
    const session = createSession({ agentName: 'writer', projectPath, messages: [makeMessage('msg-long-1', 'user', buildStyleInputMessage(giant))] });
    const dispatch = vi.fn();

    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(session.id);

    expect(dispatch).not.toHaveBeenCalled();
    expect(result.output).toContain('片段过长');
    expect(result.output).toContain('重新提交');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'fragment-too-long' });
  });

  it('分析者返回「材料不足」结论：透传 + 回问指引 + 无 envelope（机械字数达标、语义判定不足）', async () => {
    // 结构化长片段（过工具侧短路）；分析者按语义判不足（如正文里混了大段说明文字）。
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [makeMessage('msg-analyzer-insuff-1', 'user', buildStyleInputMessage(`${LONG_FRAGMENT}\n（作者误贴进正文框的大段说明文字，分析者判定剔除后正文不足。）`))],
    });
    const dispatch = vi.fn().mockResolvedValue({ content: '材料不足：剔除说明后正文只有 60 字，不足 300——建议提交更长的连续片段。' });

    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    deleteSession(session.id);

    expect(result.output).toContain(INSUFFICIENT_MATERIAL_PREFIX);
    expect(result.output).toContain('剔除说明后正文只有 60 字');
    expect(result.output).toContain('重新提交');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'insufficient-material' });
    expect((result.metadata as { type?: string }).type).toBeUndefined();
  });
});

describe('dispatch_style_analyzer — 提取失败分支（零参数倒序契约）', () => {
  let projectPath = '';
  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-style-analyzer-extract-'));
  });
  afterEach(async () => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('最近一条结构化提交 fragment 为空 → empty-fragment（响亮拒，不静默取更旧一条）', () => {
    const session = createSession({
      agentName: 'writer',
      projectPath,
      messages: [
        makeMessage('msg-old-good', 'user', buildStyleInputMessage(LONG_FRAGMENT)),
        makeMessage('msg-new-empty', 'user', buildStyleInputMessage('   ', 'x')),
      ],
    });
    const extraction = extractStyleSourcePayload(session.id);
    expect(extraction.ok === false && extraction.reason).toBe('empty-fragment');
    deleteSession(session.id);
  });

  it('会话缺失 → session-missing', () => {
    const extraction = extractStyleSourcePayload('no-such-session');
    expect(extraction.ok === false && extraction.reason).toBe('session-missing');
  });

  it('execute 侧：零命中零派发 + 引导输出（含 request_style_input 指引）', async () => {
    const session = createSession({ agentName: 'writer', projectPath });
    const dispatch = vi.fn();
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({ ok: false, reason: 'no-style-input' });
    expect(result.output).toContain('request_style_input');
    deleteSession(session.id);
  });
});

describe('dispatch_style_analyzer — graceful（mirror dispatch-planners 降级谱）', () => {
  let projectPath = '';
  beforeEach(() => {
    projectPath = mkdtempSync(path.join(os.tmpdir(), 'dispatch-style-analyzer-graceful-'));
  });
  afterEach(async () => {
    rmBestEffort(projectPath);
    vi.clearAllMocks();
  });

  it('skillExecutor 缺 → dispatch-unavailable（零派发）', async () => {
    const session = createSession({ agentName: 'writer', projectPath, messages: [makeMessage('msg-g1', 'user', buildStyleInputMessage(LONG_FRAGMENT))] });
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath));
    expect(result.output).toContain('不可用');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'dispatch-unavailable' });
    deleteSession(session.id);
  });

  it('dispatch 抛错 → dispatch-failed（不假成功）', async () => {
    const session = createSession({ agentName: 'writer', projectPath, messages: [makeMessage('msg-g2', 'user', buildStyleInputMessage(LONG_FRAGMENT))] });
    const dispatch = vi.fn().mockRejectedValue(new Error('network down'));
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    expect(result.output).toContain('派发失败');
    expect(result.output).toContain('network down');
    expect(result.metadata).toMatchObject({ ok: false, reason: 'dispatch-failed' });
    deleteSession(session.id);
  });

  it('空返回 → empty-output（不把空串当卡）', async () => {
    const session = createSession({ agentName: 'writer', projectPath, messages: [makeMessage('msg-g3', 'user', buildStyleInputMessage(LONG_FRAGMENT))] });
    const dispatch = vi.fn().mockResolvedValue({ content: '   ' });
    const result = await dispatchStyleAnalyzerTool.execute({}, makeCtx(session.id, projectPath, { runAgentWithExplicitSystem: dispatch }));
    expect(result.metadata).toMatchObject({ ok: false, reason: 'empty-output' });
    deleteSession(session.id);
  });
});

describe('统计块机械注入（第②节——LLM 复述数字漂移防线）', () => {
  it('有标题：该节内容整段替换为注入块（分析者写的杂质被清掉）', () => {
    const card = '# 风格卡片\n\n## ① 声音画像\n\n画像内容。\n\n## ② 机械统计\n\n分析者不该抄的数字 12345\n\n## ⑬ 节选（few-shot）\n\n```text\n原文\n```\n';
    const stats = '- 字数（非空白字符）：42';
    const injected = injectStyleStatsBlock(card, stats);
    expect(injected).toContain('## ② 机械统计\n\n- 字数（非空白字符）：42');
    expect(injected).not.toContain('12345');
    // 节边界不被吃：⑬ 仍在且原内容保留。
    expect(injected).toContain('## ⑬ 节选（few-shot）');
    expect(injected).toContain('```text\n原文\n```');
    expect(injected).toContain('画像内容。');
  });

  it('无②节标题：插在首个节标题之前（卡头之后）——不落卡尾破 14 节序（CR-020）', () => {
    const card = '# 风格卡片\n\n> 分工注记。\n\n## ① 声音画像\n\n只有画像。\n\n## ⑬ 节选（few-shot）\n\n```text\n原文\n```\n';
    const stats = '- 字数（非空白字符）：7';
    const injected = injectStyleStatsBlock(card, stats);
    expect(injected).toContain('## ② 机械统计（代码预计算）\n\n- 字数（非空白字符）：7');
    // 位置序：卡头注记 → ②（兜底注入）→ ① → ⑬（② 不落⑭附录之后的卡尾）。
    const noteIdx = injected.indexOf('> 分工注记。');
    const statsIdx = injected.indexOf('## ② 机械统计');
    const voiceIdx = injected.indexOf('## ① 声音画像');
    const excerptIdx = injected.indexOf('## ⑬ 节选');
    expect(noteIdx).toBeLessThan(statsIdx);
    expect(statsIdx).toBeLessThan(voiceIdx);
    expect(voiceIdx).toBeLessThan(excerptIdx);
    // 原内容无损。
    expect(injected).toContain('只有画像。');
    expect(injected).toContain('```text\n原文\n```');
  });

  it('无②节标题且无任何节标题：插卡头（# H1）之后（CR-020 兜底第二级）', () => {
    const injected = injectStyleStatsBlock('# 风格卡片\n\n只有一段引言没有节。', 'S');
    expect(injected.indexOf('## ② 机械统计')).toBeGreaterThan(injected.indexOf('# 风格卡片'));
    expect(injected.indexOf('## ② 机械统计')).toBeLessThan(injected.indexOf('只有一段引言没有节。'));
    expect(injected).toContain('只有一段引言没有节。');
  });

  it('fenced 内的 ② 形标题不算（⑬/⑭ 内嵌原文）；fenced 外真②节仍命中（CR-020）', () => {
    const card = [
      '# 风格卡片',
      '',
      '## ① 声音画像',
      '',
      '画像。',
      '',
      '## ② 机械统计',
      '',
      '## ⑬ 节选（few-shot）',
      '',
      '```text',
      '## ② 机械统计', // 原文里碰巧的 stats 形标题——片段正文，不是卡结构
      '正文……',
      '```',
      '',
      '## ⑭ 原文附录',
      '',
      '```text',
      '更多原文。',
      '```',
      '',
    ].join('\n');
    const injected = injectStyleStatsBlock(card, 'STATS');
    // fenced 外的真②节被注入（走替换路径，非兜底补节）。
    expect(injected).toContain('## ② 机械统计\n\nSTATS');
    expect(injected).not.toContain('（代码预计算）');
    // ⑬ fenced 里的形似标题原样保留（未被当节标题清掉）。
    expect(injected).toContain('```text\n## ② 机械统计\n正文……\n```');
    expect(injected).toContain('## ⑭ 原文附录');
  });

  it('无真②节但 fenced 内有 ② 形标题：不命中 fenced，兜底插首个节标题之前（CR-020）', () => {
    const card = [
      '# 风格卡片',
      '',
      '## ① 声音画像',
      '',
      '画像。',
      '',
      '## ⑬ 节选（few-shot）',
      '',
      '```text',
      '## ② 机械统计',
      '```',
      '',
    ].join('\n');
    const injected = injectStyleStatsBlock(card, 'STATS');
    const statsIdx = injected.indexOf('## ② 机械统计（代码预计算）');
    const voiceIdx = injected.indexOf('## ① 声音画像');
    expect(statsIdx).toBeGreaterThan(injected.indexOf('# 风格卡片'));
    expect(statsIdx).toBeLessThan(voiceIdx);
    // fenced 里的形似标题原样保留。
    expect(injected).toContain('```text\n## ② 机械统计\n```');
  });

  it('节边界探测排除 fenced：⑬ fenced 内的 `## ` 行不切节，⑭ 仍完整保留', () => {
    const card = [
      '# 风格卡片',
      '',
      '## ② 机械统计',
      '',
      '## ⑬ 节选（few-shot）',
      '',
      '```text',
      '## ⑭ 原文附录', // 原文里形似节标题——不得当节边界
      '正文。',
      '```',
      '',
      '## ⑭ 原文附录',
      '',
      '```text',
      '完整原文。',
      '```',
      '',
    ].join('\n');
    const injected = injectStyleStatsBlock(card, 'STATS');
    // ②节替换的边界 = fenced 外的下一节（真⑬），fenced 内的 `## ⑭` 行不切——⑬ 的 fenced 块完整保留。
    expect(injected).toContain('## ② 机械统计\n\nSTATS\n## ⑬ 节选（few-shot）');
    expect(injected).toContain('```text\n## ⑭ 原文附录\n正文。\n```');
    expect(injected).toContain('完整原文。');
  });

  it('标题变体（## 2. 机械统计 / ## ②机械统计 / ##②机械统计 无空格形态）同样命中（CR-009 零空白容忍，与 B 路统一）', () => {
    for (const heading of ['## 2. 机械统计', '## ②机械统计', '##②机械统计', '##②、机械统计（代码）']) {
      const injected = injectStyleStatsBlock(`# 风格卡片\n\n${heading}\n\n## ⑬ 节选\n`, 'S');
      expect(injected).toContain('S');
      // 命中既有标题走替换路径（保留原标题文本），非兜底补节。
      expect(injected).not.toContain('## ② 机械统计（代码预计算）');
    }
  });
});

describe('buildStyleCardActions（action 组装纯函数）', () => {
  it('无既有卡 → create_file（title=风格卡片 + type=style）', () => {
    const plan = buildStyleCardActions(undefined, '# 新卡\n');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.created).toBe(true);
    expect(plan.actions[0]).toMatchObject({ op: 'create_file', title: '风格卡片', type: 'style' });
  });

  it('既有卡空文件/纯空白/BOM-only → 同无卡 create_file（CR-016：无内容冲突不推手动运维）', () => {
    for (const raw of ['', '\n\n  \n', '\uFEFF']) {
      const plan = buildStyleCardActions(raw, '# 新卡\n');
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.created).toBe(true);
      expect(plan.actions[0]).toMatchObject({ op: 'create_file', title: '风格卡片', type: 'style' });
    }
  });
});

describe('yaml 契约 + CONTRACTS 镜像 + 注册与分类', () => {
  it('yaml 加载非降级 + user 模板 var 与 buildStyleAnalyzerVars 键集逐字对齐（防模板 var 漂移）', async () => {
    const { system, userTemplate } = await loadAgentPrompt(STYLE_ANALYZER_ROLE);
    expect(system.length).toBeGreaterThan(200);
    expect(userTemplate.length).toBeGreaterThan(50);
    expect(new Set(templateVarsOf(userTemplate)))
      .toEqual(new Set(['sourceMaterial', 'styleStats', 'userNote']));
    expect(new Set(templateVarsOf(userTemplate)))
      .toEqual(new Set(Object.keys(buildStyleAnalyzerVars({ sourceMaterial: 'x', styleStats: 'y', userNote: 'z' }))));
  });

  it('system 含方法论要点：九遍扫描 / 宁缺毋滥 / 三段式 / 材料不足 300 字 / 节选 800-2000 / 无工具声明', async () => {
    const { system } = await loadAgentPrompt(STYLE_ANALYZER_ROLE);
    expect(system).toContain('九遍扫描');
    expect(system).toContain('宁缺毋滥');
    expect(system).toContain('三段式');
    expect(system).toContain('材料不足');
    expect(system).toContain('300');
    expect(system).toContain('800-2000');
    expect(system).toContain('来源域');
    expect(system).toContain('你没有任何工具可用');
  });

  it('CONTRACTS[] 镜像：条目在、owns/reads 空（mirror route-agent——自由 markdown 卡非链段 state key）', () => {
    const contract = getAgentContract('style-analyzer-agent');
    expect(contract).toBeDefined();
    expect(contract!.owns).toEqual([]);
    expect(contract!.reads).toEqual([]);
    expect(contract!.qualityGates).toContain('quotes_verbatim');
    expect(contract!.must.join(' ')).toContain('三段式');
    expect(contract!.must.join(' ')).toContain('300');
  });

  it('yaml outputs 无 state_key（CR-017：leader 侧派发子 agent 非链段 state——不指向不存在的 state）', () => {
    const raw = readFileSync(path.join(PROMPTS_DIR, `${STYLE_ANALYZER_ROLE}.yaml`), 'utf8');
    const bomStripped = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    const contract = yaml.load(bomStripped) as Record<string, unknown>;
    const outputs = contract.outputs as Record<string, unknown> | undefined;
    expect(outputs).toBeDefined();
    expect(outputs && Object.hasOwn(outputs, 'state_key')).toBe(false);
    // schema 为自由 markdown 契约名（非 Zod schema 引用——与 CONTRACTS[] outputSchemaName 注记同口径）。
    expect(outputs?.schema).toBe('styleCardMarkdown');
  });

  it('YAML_AGENT_SLOT 档位注册：语义质量档 review-judge（九遍扫描深分析，质量敏感）', () => {
    expect(YAML_AGENT_SLOT['style-analyzer-agent']).toBe('review-judge');
  });

  it('builtin 注册 + classifyTool=diff（readonly 拦 / suggest 可见）', () => {
    expect(registry.get('dispatch_style_analyzer')?.id).toBe('dispatch_style_analyzer');
    expect(classifyTool('dispatch_style_analyzer')).toBe('diff');
    const readonlyVisible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'readonly' }).map((t) => t.id);
    const suggestVisible = filterToolsForPolicy({ tools: registry.all(), sessionMode: 'suggest' }).map((t) => t.id);
    expect(readonlyVisible).not.toContain('dispatch_style_analyzer');
    expect(suggestVisible).toContain('dispatch_style_analyzer');
  });

  it('MIN_FRAGMENT_CHARS = 300 / MAX_FRAGMENT_CHARS = 100_000（PRD 口径 + CR-019 上限；联动点见常量注记）', () => {
    expect(MIN_FRAGMENT_CHARS).toBe(300);
    expect(MAX_FRAGMENT_CHARS).toBe(100_000);
  });
});

describe('request_style_input — prompt 参数截断语义（CR-025，C 路同族）', () => {
  it('超长 prompt 截断到 300 不硬拒；空串仍拒；不传可选', () => {
    const tool = registry.get('request_style_input');
    expect(tool).toBeDefined();

    const parsed = tool!.parameters.parse({ prompt: 'a'.repeat(400) }) as { prompt?: string };
    expect(parsed.prompt).toHaveLength(300);
    // 短值原样过。
    expect((tool!.parameters.parse({ prompt: '请贴一段带对话的原文。' }) as { prompt?: string }).prompt)
      .toBe('请贴一段带对话的原文。');
    // 空串仍拒（min(1)——空 prompt 是无效值非截断事）。
    expect(tool!.parameters.safeParse({ prompt: '' }).success).toBe(false);
    // 不传可选。
    expect(tool!.parameters.parse({})).toEqual({});
  });
});
