import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Collapsible } from '../src/shared/components/Collapsible';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.5 Step 7：共享 <Collapsible> 原语——从 agent panel 四处手写折叠 idiom 抽取。
// 此处测原语本身；三处替换（AgentToolCard / ChildExecutionGroup / work-steps）由
// 既有组件测试覆盖（行为零变）。
// ─────────────────────────────────────────────────────────────────────────────

afterEach(() => cleanup());

describe('Collapsible primitive', () => {
  it('uncontrolled：默认折叠，点 header 展开/再折叠，aria-expanded 跟随', async () => {
    render(
      <Collapsible
        headerClassName="hdr"
        header={<span>Header</span>}
        chevronIcons={{ open: 'expand_less', closed: 'expand_more' }}
        chevronClassName="chev"
      >
        <p>Body</p>
      </Collapsible>,
    );

    expect(screen.queryByText('Body')).toBeNull();
    const header = screen.getByRole('button', { name: /Header/ });
    expect(header.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(header);
    expect(screen.getByText('Body')).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('true');

    await userEvent.click(header);
    expect(screen.queryByText('Body')).toBeNull();
  });

  it('defaultOpen：初始展开（work-steps 语义）', () => {
    render(<Collapsible defaultOpen header={<span>H</span>}><p>Body</p></Collapsible>);
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('controlled：open/onToggle（BatchGroup 用——折叠态入 panelsSlice）', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <Collapsible open={false} onToggle={onToggle} header={<span>H</span>}>
        <p>Body</p>
      </Collapsible>,
    );
    expect(screen.queryByText('Body')).toBeNull();

    // Click 只上报 next，不自行展开（controlled 语义）。
    await userEvent.click(screen.getByRole('button'));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.queryByText('Body')).toBeNull();

    rerender(
      <Collapsible open onToggle={onToggle} header={<span>H</span>}>
        <p>Body</p>
      </Collapsible>,
    );
    expect(screen.getByText('Body')).toBeTruthy();
  });

  it('chevron 位置与 class：start 放前、end 放后、none 不渲染', () => {
    const { container } = render(
      <Collapsible chevron="start" chevronClassName="my-chev" header={<span>H</span>}>
        <p>B</p>
      </Collapsible>,
    );
    const header = container.querySelector('button')!;
    const first = header.firstElementChild!;
    expect(first.className).toBe('material-symbols-outlined my-chev');
    expect(first.textContent).toBe('expand_more'); // 默认图标对的折叠态

    const end = render(<Collapsible chevron="end" header={<span>H</span>}><p>B</p></Collapsible>);
    expect(end.container.querySelector('button')!.lastElementChild!.className).toContain('material-symbols-outlined');

    const none = render(<Collapsible chevron="none" header={<span>H</span>}><p>B</p></Collapsible>);
    expect(none.container.querySelector('.material-symbols-outlined')).toBeNull();
  });
});
