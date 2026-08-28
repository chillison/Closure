/**
 * dogfood T1 Stage 6（design §4 / §7.5）：ChainRunCard 渲染。
 *
 * 覆盖（implement.md Stage 6 测试清单）：
 * - 步进条三态：已完成实心（--done）/ 当前呼吸（--current）/ 未来空心（两者皆无）。
 * - 流式正文（streamText 经 marked+DOMPurify 渲染）；JSON 节点期（无正文）占位 =
 *   当前节点名 + 三点 loading。
 * - 中断/失败态：warning「已中断」/ error「失败」标 + 重试钮（mirror S4 重试动作）。
 * - paused 精简态：正文区隐藏（让位 ChapterReviewPanel，不叠加两卡）。
 * - AgentMessages 尾部挂载门：当前会话链 run 非 completed 挂卡 / completed 卸载。
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// dogfood T1 CR-T1-048：AgentMessages 的链卡 resume 入口走结构化 IPC——vi.mock 捕获调用
//（partial：其余导出原样，AgentMessages/组件链还有别的消费者）。
const apiMocks = vi.hoisted(() => ({
  resumeChapterChain: vi.fn(async () => ({ status: 'paused', errors: [] })),
}));
vi.mock('../src/shared/api/agent', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/shared/api/agent')>();
  return { ...original, ...apiMocks };
});
import { ChainRunCard } from '../src/features/agent-panel/ChainRunCard';
import { AgentMessages } from '../src/features/agent-panel/AgentMessages';
import { useAppStore } from '../src/shared/store/appStore';
import { useToastStore } from '../src/shared/store/toastStore';
import { __clearChainStreamState, type ChainRunState } from '../src/shared/store/chainStreamBuffer';

function baseRun(over: Partial<ChainRunState> = {}): ChainRunState {
  return {
    sessionId: 'sess-a',
    status: 'running',
    completedNodes: [],
    currentNodeId: null,
    errorNodeId: null,
    streamNodeId: null,
    streamRole: null,
    streamPhase: null,
    streamText: '',
    streaming: false,
    updatedAt: Date.now(),
    ...over,
  };
}

beforeEach(() => {
  apiMocks.resumeChapterChain.mockClear();
  apiMocks.resumeChapterChain.mockResolvedValue({ status: 'paused', errors: [] });
  // 两步 set：currentProject 变更会触发项目订阅的切换管线（runProjectResets →
  // resetAgentForProjectSwitch 把 agentSessionId 归 null）——视图会话态必须在其后补
  //（第二次 set 不再变路径，不触发 clobber）。
  useAppStore.setState({ currentProject: { path: '/proj-a' }, pausedReviewBySession: {} } as any);
  useAppStore.setState({
    agentSessionId: 'sess-a',
    agentMessages: [],
    activeSessionRunning: true,
    chainRunBySession: {},
    chainRunAnchorByProject: {},
  } as any);
});

afterEach(() => {
  cleanup();
  __clearChainStreamState();
  useAppStore.setState({
    chainRunBySession: {},
    chainRunAnchorByProject: {},
    agentSessionId: null,
    activeSessionRunning: false,
    currentProject: null,
    pausedReviewBySession: {},
  } as any);
});

describe('ChainRunCard — 步进条三态', () => {
  it('已完成节点实心（--done）/ 当前节点呼吸（--current）/ 未来节点空心', () => {
    render(
      <ChainRunCard
        run={baseRun({
          completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
          currentNodeId: 'revision-guard-agent',
        })}
      />,
    );
    const doneStep = screen.getByText('brief-compiler').closest('.chain-run-card-step');
    const currentStep = screen.getByText('revision-guard').closest('.chain-run-card-step');
    const pendingStep = screen.getByText('route').closest('.chain-run-card-step');
    expect(doneStep?.querySelector('.chain-run-card-step-dot--done')).toBeTruthy();
    expect(doneStep?.querySelector('.chain-run-card-step-dot--current')).toBeNull();
    expect(currentStep?.querySelector('.chain-run-card-step-dot--current')).toBeTruthy();
    expect(currentStep?.querySelector('.chain-run-card-step-dot--done')).toBeNull();
    // 当前节点名 accent（label--current）。
    expect(screen.getByText('revision-guard').className).toContain('chain-run-card-step-label--current');
    expect(pendingStep?.querySelector('.chain-run-card-step-dot--done')).toBeNull();
    expect(pendingStep?.querySelector('.chain-run-card-step-dot--current')).toBeNull();
  });

  it('error 节点：error 点 + label accent（失败定位）', () => {
    render(
      <ChainRunCard
        run={baseRun({
          completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
          currentNodeId: 'multi-review-agent',
          errorNodeId: 'multi-review-agent',
        })}
      />,
    );
    const step = screen.getByText('multi-review').closest('.chain-run-card-step');
    expect(step?.querySelector('.chain-run-card-step-dot--error')).toBeTruthy();
  });
});

describe('ChainRunCard — 正文区', () => {
  it('CR-T1-047 信封剥离：streamText 是 JSON 信封原文 → 正文区只渲 text 值（title/信封语法/尾部标记不可见）', () => {
    render(
      <ChainRunCard
        run={baseRun({
          streamNodeId: 'draft-writer-agent',
          streamText: '{"title":"第3章 黄昏","text":"黄昏的荒野上，主角深吸一口气。","wordCount":1832}\n<DRAFT_READY>',
          streaming: true,
        })}
      />,
    );
    expect(screen.getByText('黄昏的荒野上，主角深吸一口气。')).toBeTruthy();
    const body = document.querySelector('.chain-run-card-body') as HTMLElement;
    // 信封头（title）、转义字面、尾部 wordCount/<DRAFT_READY> 一概不进正文区。
    expect(body.textContent).not.toContain('第3章 黄昏');
    expect(body.textContent).not.toContain('"text"');
    expect(body.textContent).not.toContain('wordCount');
    expect(body.textContent).not.toContain('DRAFT_READY');
    const md = document.querySelector('.chain-run-card-body .agent-msg-md');
    expect(md?.className).toContain('agent-msg-md--streaming');
  });

  it('CR-T1-047 信封头在途（锚点未到）→ 正文区让位占位（节点名 + 三点，不流裸 JSON）', () => {
    render(
      <ChainRunCard
        run={baseRun({
          currentNodeId: 'draft-writer-agent',
          streamNodeId: 'draft-writer-agent',
          streamText: '{"title":"第3章 黄昏',
          streaming: true,
        })}
      />,
    );
    expect(screen.getByText('Working: draft-writer')).toBeTruthy();
    expect(document.querySelector('.chain-run-card-body .agent-msg-md')).toBeNull();
  });

  it('CR-T1-047 fallback：非信封形态（散文直出 / 契约变更）原样渲染（不比现状差）', () => {
    render(
      <ChainRunCard
        run={baseRun({
          streamNodeId: 'draft-writer-agent',
          streamText: '黄昏的荒野上，主角深吸一口气。',
          streaming: true,
        })}
      />,
    );
    expect(screen.getByText('黄昏的荒野上，主角深吸一口气。')).toBeTruthy();
    const md = document.querySelector('.chain-run-card-body .agent-msg-md');
    expect(md?.className).toContain('agent-msg-md--streaming');
  });

  it('JSON 节点期间：正文区占位 = 当前节点名 + 三点 loading（不流裸 JSON）', () => {
    render(
      <ChainRunCard
        run={baseRun({ completedNodes: ['brief-compiler-node'], currentNodeId: 'multi-review-agent' })}
      />,
    );
    expect(screen.getByText('Working: multi-review')).toBeTruthy();
    expect(document.querySelectorAll('.chain-run-card-placeholder .agent-loading-dot').length).toBe(3);
    expect(document.querySelector('.chain-run-card-body .agent-msg-md')).toBeNull();
  });
});

describe('ChainRunCard — 中断/失败态与 paused 精简', () => {
  it('aborted：warning「已中断」标 + 已累积文本保留 + 重试钮点击回调', async () => {
    const onRetry = vi.fn();
    render(
      <ChainRunCard
        run={baseRun({
          status: 'aborted',
          streamNodeId: 'draft-writer-agent',
          // CR-T1-047：中断保留态的真实形态 = 半 JSON 信封——已还原的 text 部分照显
          //（转义已 unescape，不含信封头）。
          streamText: '{"title":"第3章","text":"已流出的一半正文\\n第二段起头',
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText('Interrupted')).toBeTruthy();
    expect(screen.getByText(/已流出的一半正文/)).toBeTruthy();
    const body = document.querySelector('.chain-run-card-body') as HTMLElement;
    expect(body.textContent).toContain('已流出的一半正文\n第二段起头');
    expect(body.textContent).not.toContain('第3章');
    await userEvent.click(screen.getByText('Retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('error：error「失败」标', () => {
    render(<ChainRunCard run={baseRun({ status: 'error' })} />);
    expect(screen.getByText('Failed')).toBeTruthy();
  });

  it('paused 精简态：步进条在、正文区隐藏（让位 ChapterReviewPanel）', () => {
    render(
      <ChainRunCard
        run={baseRun({
          status: 'paused',
          completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
          currentNodeId: 'draft-writer-agent',
          streamText: '待审阅的正文',
        })}
      />,
    );
    // 步进条仍在（进度上下保留）。
    expect(screen.getByText('brief-compiler')).toBeTruthy();
    // 正文区隐藏。
    expect(document.querySelector('.chain-run-card-body')).toBeNull();
    expect(screen.queryByText('待审阅的正文')).toBeNull();
  });
});

describe('AgentMessages — 链卡尾部挂载门', () => {
  it('当前会话链 run 非 completed → 尾部挂卡；completed → 卸载（审阅流程接管）', () => {
    const { rerender } = render(
      <AgentMessages messages={[]} loading error={null} />,
    );
    expect(screen.queryByText('Chapter chain')).toBeNull();

    act(() => {
      useAppStore.setState({
        chainRunBySession: { 'sess-a': baseRun({ status: 'running' }) },
      });
    });
    rerender(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('Chapter chain')).toBeTruthy();

    act(() => {
      useAppStore.setState({
        chainRunBySession: { 'sess-a': baseRun({ status: 'completed' }) },
      });
    });
    rerender(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.queryByText('Chapter chain')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// dogfood T1 CR 批4/批5：JSON 节点期占位恢复（CR-T1-050）+ 项目级锚挂载与 resume 入口
// （CR-T1-048，decision 2A）
// ════════════════════════════════════════════════════════════════════════════

describe('CR-T1-050 JSON 节点期正文区占位（node-done 收口 streaming 后不再恒显旧文）', () => {
  it('running 非流式（流节点已 done，JSON 节点步进中）→ 占位 = 节点名 + 三点，不显已流文本', () => {
    render(
      <ChainRunCard
        run={baseRun({
          completedNodes: ['brief-compiler-node', 'draft-writer-agent'],
          currentNodeId: 'lint-node',
          streamNodeId: 'draft-writer-agent',
          streamText: '已写完的章稿正文',
          streaming: false,
        })}
      />,
    );
    expect(screen.getByText('Working: lint')).toBeTruthy();
    expect(document.querySelectorAll('.chain-run-card-placeholder .agent-loading-dot').length).toBe(3);
    // 旧正文不再顶占位（bodyHtml 非空自洽令占位永不可见的弱变体修复）。
    expect(screen.queryByText('已写完的章稿正文')).toBeNull();
  });

  it('streaming 在途 / 中断 / 失败态照显已流文本（设计原语义不回归）', () => {
    const { unmount } = render(
      <ChainRunCard
        run={baseRun({
          streamNodeId: 'draft-writer-agent',
          streamText: '流式正文',
          streaming: true,
        })}
      />,
    );
    expect(screen.getByText('流式正文')).toBeTruthy();
    unmount();

    render(
      <ChainRunCard
        run={baseRun({
          status: 'aborted',
          streamNodeId: 'draft-writer-agent',
          streamText: '中断保留正文',
          streaming: false,
        })}
      />,
    );
    expect(screen.getByText('中断保留正文')).toBeTruthy();
  });
});

describe('CR-T1-048 项目级锚挂载 + paused resume 入口（dogfood stub 链车道可见面）', () => {
  it('本会话无活跃卡时查项目锚兜底——stub 会话的链 run 在 AgentMessages 尾部渲染', () => {
    const { rerender } = render(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.queryByText('Chapter chain')).toBeNull();

    act(() => {
      useAppStore.setState({
        // 视图会话 sess-a 无链；锚指向 dogfood stub 会话（事件挂 stub id——决策 2A）。
        chainRunBySession: { 'stub-parent-1': baseRun({ sessionId: 'stub-parent-1', status: 'running' }) },
        chainRunAnchorByProject: { '/proj-a': 'stub-parent-1' },
      } as any);
    });
    rerender(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('Chapter chain')).toBeTruthy();

    // own 优先：本会话自己的链卡在场时锚不抢（一链只归一张卡）。
    act(() => {
      useAppStore.setState({
        chainRunBySession: {
          'sess-a': baseRun({ status: 'running', currentNodeId: 'route-agent' }),
          'stub-parent-1': baseRun({ sessionId: 'stub-parent-1', status: 'running' }),
        },
      } as any);
    });
    rerender(<AgentMessages messages={[]} loading error={null} />);
    // own 优先（一链只归一张卡）：当前锚点是 own 卡的 route-agent（步进条 label 高亮）。
    const currentLabel = document.querySelector('.chain-run-card-step-label--current');
    expect(currentLabel?.textContent).toBe('route');
  });

  it('锚键归一匹配：currentProject 路径漂移形态（盘符大小写/反斜杠）仍命中', () => {
    useAppStore.setState({
      currentProject: { path: 'C:\\PROJ\\A' },
      chainRunBySession: { 'stub-1': baseRun({ sessionId: 'stub-1', status: 'running' }) },
      chainRunAnchorByProject: { 'c:/proj/a': 'stub-1' },
    } as any);
    render(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.getByText('Chapter chain')).toBeTruthy();
  });

  it('paused + 视图会话无 pausedReview → 链卡带 resume 钮（点击按锚会话调 resume IPC continue）', async () => {
    useAppStore.setState({
      chainRunBySession: { 'stub-1': baseRun({ sessionId: 'stub-1', status: 'paused', completedNodes: ['brief-compiler-node', 'draft-writer-agent'] }) },
      chainRunAnchorByProject: { '/proj-a': 'stub-1' },
    } as any);
    render(<AgentMessages messages={[]} loading error={null} />);

    await userEvent.click(screen.getByText('Resume'));
    expect(apiMocks.resumeChapterChain).toHaveBeenCalledWith({
      projectPath: '/proj-a',
      sessionId: 'stub-1', // chainSnapshot 按链持有会话（stub）键——非视图会话
      action: 'continue',
    });
  });

  it('paused + 视图会话有 pausedReview（leader 路径）→ 链卡不给 resume 钮（ChapterReviewPanel 承载，不叠加）', () => {
    useAppStore.setState({
      agentSessionId: 'sess-a',
      pausedReviewBySession: { 'sess-a': { type: 'chapter_review', stage: 'draft', resumeOptions: ['continue'] } as any },
      chainRunBySession: { 'sess-a': baseRun({ status: 'paused', completedNodes: ['brief-compiler-node', 'draft-writer-agent'] }) },
    } as any);
    render(<AgentMessages messages={[]} loading error={null} />);
    expect(screen.queryByText('Resume')).toBeNull();
  });

  it('resume 返 error summary（busy 拒绝外）→ toast 告知不静默', async () => {
    apiMocks.resumeChapterChain.mockResolvedValueOnce({ status: 'error', errors: ['boom'] });
    useAppStore.setState({
      chainRunBySession: { 'stub-1': baseRun({ sessionId: 'stub-1', status: 'paused' }) },
      chainRunAnchorByProject: { '/proj-a': 'stub-1' },
    } as any);
    render(<AgentMessages messages={[]} loading error={null} />);

    await userEvent.click(screen.getByText('Resume'));
    await vi.waitFor(() => {
      // toast 在独立 toastStore（非 appStore）——错误不静默（busy 外的 error summary 告知）。
      expect(useToastStore.getState().toasts.length).toBeGreaterThan(0);
    });
  });
});
