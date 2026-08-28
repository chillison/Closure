/**
 * dogfood R2 #81（findings #81，2026-08-28）：链内结构化指令 JSON 折叠卡（ChainDirectiveCard）
 * 拦截 + 呈现。导演（director-agent）输出契约 = 纯 JSON 五段（entries/emotionPoints/
 * emotionTarget/atomicEditProposals/storyDecisions）作为 child 最终 assistant 正文——机器
 * 通道产出被当人读正文裸奔。经 AgentMessages → AgentMessageItem assistant 分支全链渲染
 * （真实拦截位）：整体形态命中 → 折叠小卡（标题计数 + 展开原文），不进正文通道；
 * 非 JSON / 键族外 JSON / leader 消息照旧正文渲染（零误伤）。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { parseChainDirectiveJson } from '../src/features/agent-panel/ChainDirectiveCard';
import { useAppStore } from '../src/shared/store/appStore';
import type { AgentMessage } from '../src/shared/store/agentSlice';

function msg(partial: Partial<AgentMessage> & { id: string; role: AgentMessage['role'] }): AgentMessage {
  return { content: '', createdAt: 1700000000, ...partial } as AgentMessage;
}

/** #81 实拍形态：导演五段契约 JSON（紧凑样本——含中文 directive 值）。 */
const DIRECTOR_JSON =
  '{"entries":[{"sceneRef":"s1","directive":{"mode":"reveal_first","actions":["plant"],'
  + '"forbiddenMoves":["提前揭露守门人身份"],"target":"地图残片"}}],'
  + '"emotionPoints":[{"refId":"s1","sceneMood":"压抑","sceneVad":{"v":-0.6,"a":0.3,"d":-0.4}}],'
  + '"emotionTarget":{"emotion":"恐惧","steer":"先压抑后爆发"},'
  + '"atomicEditProposals":[],"storyDecisions":[]}';

const DIRECTOR_TAG = '[subagent:director-agent]';

beforeEach(() => {
  useAppStore.setState({
    resolvedLocale: 'zh-CN',
    activeSessionRunning: false,
    agentRunStates: {},
    agentSessionId: 'session-1',
    sendAgentMessage: vi.fn(),
    truncateAgentMessages: vi.fn(),
  } as any);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('parseChainDirectiveJson 形态判定（纯代码——不判语义）', () => {
  it('导演五段契约 JSON → 命中，itemCount = 四数组段条数和', () => {
    const payload = parseChainDirectiveJson(DIRECTOR_JSON);
    expect(payload).not.toBeNull();
    expect(payload!.itemCount).toBe(2); // entries 1 + emotionPoints 1 + proposals 0 + decisions 0
    expect(payload!.raw).toBe(DIRECTOR_JSON);
  });

  it('全空段（无操控无情绪无编辑无决策的契约兜底形态）→ 命中，count 0', () => {
    const payload = parseChainDirectiveJson(
      '{"entries":[],"emotionPoints":[],"emotionTarget":{"emotion":"平静"},"atomicEditProposals":[],"storyDecisions":[]}',
    );
    expect(payload).not.toBeNull();
    expect(payload!.itemCount).toBe(0);
  });

  it('整条 ```json fence 包裹（LLM 偶发形态）→ 命中，raw 保留原文', () => {
    const fenced = '```json\n' + DIRECTOR_JSON + '\n```';
    const payload = parseChainDirectiveJson(fenced);
    expect(payload).not.toBeNull();
    expect(payload!.raw).toBe(fenced.trim());
  });

  it('前导叙述 + JSON 混合形态 → 不认（那仍是人读正文，折叠会吃掉叙述）', () => {
    expect(parseChainDirectiveJson('好的，本章指令如下：\n' + DIRECTOR_JSON)).toBeNull();
  });

  it('流式不完整 JSON（无闭合）→ 不认（照旧正文流式，终帧收敛成卡）', () => {
    expect(parseChainDirectiveJson('{"entries":[{"sceneRef":"s1"')).toBeNull();
  });

  it('普通散文 / 键族外 JSON / 裸数组 → 不认（零误伤）', () => {
    expect(parseChainDirectiveJson('本章节奏规划完成，见上文分析。')).toBeNull();
    expect(parseChainDirectiveJson('{"foo":"bar","count":3}')).toBeNull();
    expect(parseChainDirectiveJson('[{"sceneRef":"s1"}]')).toBeNull();
    expect(parseChainDirectiveJson('')).toBeNull();
  });

  it('键族任一顶层键在场即命中（emotionTarget 单段也可）', () => {
    const payload = parseChainDirectiveJson('{"emotionTarget":{"emotion":"恐惧"}}');
    expect(payload).not.toBeNull();
  });
});

describe('渲染拦截（AgentMessageItem assistant 分支，R2 #81）', () => {
  it('child 导演 JSON 消息 → 折叠卡（标题计数），正文不含裸 JSON', () => {
    const { container } = render(
      <AgentMessages
        messages={[
          msg({ id: 'u1', role: 'user', content: '写第一章' }),
          msg({ id: 'a1', role: 'assistant', content: `${DIRECTOR_TAG} ${DIRECTOR_JSON}` }),
        ]}
        loading={false}
        error={null}
      />,
    );
    const card = container.querySelector('.agent-chain-directive');
    expect(card).not.toBeNull();
    // 默认折叠：机器产出非交付物，人读价值在「已产出 · N 条」事实（对照 DispatchDraftCard 默认展开）。
    expect(container.querySelector('.agent-chain-directive-body')).toBeNull();
    // 标题计数 = entries 1 + emotionPoints 1 = 2 条。
    expect(container.querySelector('.agent-chain-directive-title')?.textContent).toBe('已产出情感/信息差指令 · 2 条');
    // 不进正文通道：裸 JSON 不在任何正文节点里。
    expect(container.textContent).not.toContain('sceneRef');
    expect(container.querySelector('.agent-msg-md')).toBeNull();
    // 说话者标签仍在（「子代理 · 导演」——身份不因折叠丢失）。
    expect(container.textContent).toContain('子代理');
  });

  it('展开可见原始 JSON（verbatim 原文——保真机器通道，不重序列化）', () => {
    const { container } = render(
      <AgentMessages
        messages={[msg({ id: 'a1', role: 'assistant', content: `${DIRECTOR_TAG} ${DIRECTOR_JSON}` })]}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-chain-directive-json')).toBeNull();
    fireEvent.click(container.querySelector('.agent-chain-directive-header') as HTMLElement);
    const json = container.querySelector('.agent-chain-directive-json');
    expect(json).not.toBeNull();
    expect(json?.textContent).toBe(DIRECTOR_JSON);
  });

  it('普通文本 child 消息零回归——照旧正文渲染，无折叠卡', () => {
    const { container } = render(
      <AgentMessages
        messages={[
          // settledHistory：不走打字机动画（否则首帧 displayLen=0，正文断言不确定）。
          msg({ id: 'a1', role: 'assistant', settledHistory: true, content: `${DIRECTOR_TAG} 本章的情绪规划已完成，重点场次已定。` }),
        ]}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-chain-directive')).toBeNull();
    expect(container.querySelector('.agent-msg-md')?.textContent).toContain('本章的情绪规划已完成');
  });

  it('键族外 JSON 的 child 消息不拦截（零误伤）', () => {
    const { container } = render(
      <AgentMessages
        messages={[msg({ id: 'a1', role: 'assistant', settledHistory: true, content: `${DIRECTOR_TAG} {"foo":"bar"}` })]}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-chain-directive')).toBeNull();
    expect(container.querySelector('.agent-msg-md')?.textContent).toContain('"foo":"bar"');
  });

  it('leader（无 child 标签）消息整体 JSON 也不拦截——拦截面只挂 child 通道', () => {
    const { container } = render(
      <AgentMessages
        messages={[msg({ id: 'a1', role: 'assistant', settledHistory: true, content: DIRECTOR_JSON })]}
        loading={false}
        error={null}
      />,
    );
    expect(container.querySelector('.agent-chain-directive')).toBeNull();
    expect(container.querySelector('.agent-msg-md')).not.toBeNull();
  });
});
