import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InsightCard, insightCodeLabel, toInsightSeverity } from '../src/features/agent-panel/InsightCard';
import { useAppStore } from '../src/shared/store/appStore';
import { translate } from '../src/shared/i18n/useI18n';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.7 WP1：InsightCard 统一展示组件（design D2）——纯受控 props、零执行逻辑。
// 验：severity 两族归一（toInsightSeverity）、降级矩阵（无 severity/grounding/action
// 各组合正确隐/中性）、折叠 line-clamp / 展开全文 + grounding + children、
// applyLabel 覆盖、applyDisabled、按钮回调。
// ─────────────────────────────────────────────────────────────────────────────

function card(container: HTMLElement): HTMLElement {
  return container.querySelector('.insight-card') as HTMLElement;
}

describe('Story 3.7 — toInsightSeverity 两族归一（R6）', () => {
  it('结构 issue 三档原样透传', () => {
    expect(toInsightSeverity('error')).toBe('error');
    expect(toInsightSeverity('warning')).toBe('warning');
    expect(toInsightSeverity('info')).toBe('info');
  });

  it('Reader-Audit finding 二档映射 block→error / warn→warning', () => {
    expect(toInsightSeverity('block')).toBe('error');
    expect(toInsightSeverity('warn')).toBe('warning');
  });

  it('缺/未知 → undefined（中性渲染）', () => {
    expect(toInsightSeverity(undefined)).toBeUndefined();
    expect(toInsightSeverity('critical')).toBeUndefined();
  });
});

describe('Story 3.7 — insightCodeLabel 词表（词表外显原文）', () => {
  it('词表内 code 显标签（zh-CN i18n key 解析）', () => {
    const t = (key: string) => translate('zh-CN', key);
    expect(insightCodeLabel('causal-cycle', t)).toBe('因果环');
    expect(insightCodeLabel('dangling-edge-endpoint', t)).toBe('边端点悬空');
  });

  it('词表外 code 显原文（不编造标签，mirror GUARD_DRIFT_PATTERN_LABELS 先例）', () => {
    const t = (key: string) => translate('zh-CN', key);
    expect(insightCodeLabel('future-new-rule', t)).toBe('future-new-rule');
  });
});

describe('Story 3.7 — InsightCard 降级矩阵（R1：字段/action 缺失不造数据）', () => {
  beforeEach(() => {
    useAppStore.setState({ resolvedLocale: 'en-US' } as any);
  });
  afterEach(() => cleanup());

  it('最小 props（title + source）→ 无 severity 修饰 class、无 grounding、无应用/忽略按钮', () => {
    const { container } = render(<InsightCard title="线 A 缺汇聚目标" source="agent.insight.sourceStructure" />);

    expect(screen.getByText('线 A 缺汇聚目标')).toBeTruthy();
    expect(screen.getByText('Structure check')).toBeTruthy();
    // 中性：无 --error/--warning/--info 修饰。
    expect(card(container).className).not.toMatch(/insight-card--(error|warning|info)/);
    expect(card(container).dataset.insightSeverity).toBe('none');
    // 无 onApply/onIgnore → 按钮隐藏（展开按钮恒在）。
    expect(screen.queryByText('Apply')).toBeNull();
    expect(screen.queryByText('Ignore')).toBeNull();
    expect(screen.getByText('Expand')).toBeTruthy();
  });

  it('grounding：折叠态紧凑行（quote 有才显，WP0 controller 修正）；展开态完整呈现', async () => {
    const { container } = render(
      <InsightCard
        title="t"
        source="agent.insight.sourceReaderAudit"
        grounding={{ quote: '原文引用', location: '句3', before: '改前', after: '改后' }}
      />,
    );
    // 折叠态：紧凑 grounding 行（quote+location 单行）——证据就在卡上；完整 quote/beforeafter 区块不渲染。
    const compact = container.querySelector('.insight-card-grounding--compact') as HTMLElement;
    expect(compact).toBeTruthy();
    expect(compact.textContent).toContain('原文引用');
    expect(compact.textContent).toContain('（句3）');
    expect(container.querySelector('.insight-card-grounding--quote')).toBeNull();
    expect(container.querySelector('.insight-card-grounding--beforeafter')).toBeNull();

    await userEvent.click(screen.getByText('Expand'));
    // 展开态：紧凑行隐藏，完整 grounding（quote + before→after）渲染。
    expect(container.querySelector('.insight-card-grounding--compact')).toBeNull();
    expect(container.querySelectorAll('.insight-card-grounding').length).toBe(2);
    expect(screen.getByText(/原文引用/)).toBeTruthy();
    expect(screen.getByText(/（句3）/)).toBeTruthy();
    expect(container.querySelector('.insight-card-grounding-arrow')!.textContent).toBe(' → ');
  });

  it('无 quote 的 grounding（仅 before/after）→ 折叠态无紧凑行（quote 缺不造数据）', () => {
    const { container } = render(
      <InsightCard title="t" source="agent.insight.sourceRevisionGuard" grounding={{ before: '改前', after: '改后' }} />,
    );
    expect(container.querySelector('.insight-card-grounding--compact')).toBeNull();
  });

  it('仅 before（无 after）→ 箭头不渲染（单侧不误导，mirror Edge-007 精神）', async () => {
    const { container } = render(
      <InsightCard title="t" source="agent.insight.sourceRevisionGuard" grounding={{ before: '改前' }} />,
    );
    await userEvent.click(screen.getByText('Expand'));
    expect(screen.getByText('改前')).toBeTruthy();
    expect(container.querySelector('.insight-card-grounding-arrow')).toBeNull();
  });
});

describe('Story 3.7 — InsightCard 折叠/展开 + 操作', () => {
  beforeEach(() => {
    useAppStore.setState({ resolvedLocale: 'en-US' } as any);
  });
  afterEach(() => cleanup());

  it('全 props 折叠态：severity class + badge + 三钮 + children 隐藏；title 带 clamp class', () => {
    const { container } = render(
      <InsightCard
        title="主角进城动机未铺垫"
        severity="warning"
        source="agent.insight.sourceStructure"
        dimension="Causal cycle"
        onApply={() => {}}
        onIgnore={() => {}}
      >
        <div data-testid="extra-children">展开态内容</div>
      </InsightCard>,
    );

    expect(card(container).className).toContain('insight-card--warning');
    expect(screen.getByText('Causal cycle')).toBeTruthy();
    expect(screen.getByText('Apply')).toBeTruthy();
    expect(screen.getByText('Ignore')).toBeTruthy();
    // 折叠态：clamp + children/grounding 不渲染。
    expect(container.querySelector('.insight-card-title--clamped')).toBeTruthy();
    expect(screen.queryByTestId('extra-children')).toBeNull();
  });

  it('展开：clamp 解除 + children 渲染；再点收起', async () => {
    const { container } = render(
      <InsightCard title="t" source="agent.insight.sourceStructure">
        <div data-testid="extra-children">X</div>
      </InsightCard>,
    );

    await userEvent.click(screen.getByText('Expand'));
    expect(container.querySelector('.insight-card-title--clamped')).toBeNull();
    expect(screen.getByTestId('extra-children')).toBeTruthy();
    expect(screen.getByText('Collapse')).toBeTruthy();

    await userEvent.click(screen.getByText('Collapse'));
    expect(container.querySelector('.insight-card-title--clamped')).toBeTruthy();
    expect(screen.queryByTestId('extra-children')).toBeNull();
  });

  it('defaultExpanded → 初始即展开（#6 确认卡不折叠语义）', () => {
    render(
      <InsightCard title="t" source="agent.insight.sourceRevisionIntent" defaultExpanded>
        <div data-testid="extra-children">X</div>
      </InsightCard>,
    );
    expect(screen.getByTestId('extra-children')).toBeTruthy();
  });

  it('applyLabel 覆盖应用按钮文案（i18n key 传入，#6「确认并改稿」场景）', () => {
    render(
      <InsightCard
        title="t"
        source="agent.insight.sourceRevisionIntent"
        onApply={() => {}}
        applyLabel="agent.intentConfirmRedo"
      />,
    );
    expect(screen.getByText('Confirm and redo')).toBeTruthy();
    expect(screen.queryByText('Apply')).toBeNull();
  });

  it('applyDisabled → 应用按钮禁用（D11 agentLoading 门；忽略/展开不受限）', () => {
    render(
      <InsightCard
        title="t"
        source="agent.insight.sourceReaderAudit"
        onApply={() => {}}
        onIgnore={() => {}}
        applyDisabled
      />,
    );
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Ignore') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('Expand') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ignoreDisabled → 忽略按钮禁用（D5b stale 全组禁用；应用/展开独立受控）', () => {
    render(
      <InsightCard
        title="t"
        source="agent.insight.sourceReaderAudit"
        onApply={() => {}}
        onIgnore={() => {}}
        ignoreDisabled
      />,
    );
    expect((screen.getByText('Ignore') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('Apply') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('Expand') as HTMLButtonElement).disabled).toBe(false);
  });

  it('onApply/onIgnore 回调触发（执行逻辑归接入方，组件零执行）', async () => {
    const onApply = vi.fn();
    const onIgnore = vi.fn();
    render(<InsightCard title="t" source="agent.insight.sourceReaderAudit" onApply={onApply} onIgnore={onIgnore} />);

    await userEvent.click(screen.getByText('Apply'));
    expect(onApply).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText('Ignore'));
    expect(onIgnore).toHaveBeenCalledTimes(1);
  });
});
