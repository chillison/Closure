/**
 * Story 7.5：SideBySideDiff 词级 highlight + unified 视图 + readonly 渲染测试。
 *
 * 覆盖（design §3/§4/§5）：
 * - 词级 highlight 渲染：changed 行内出现 .diff-word--add / .diff-word--remove span（GitHub 式红绿词块）。
 * - CJK 整串切：「她死死盯着」→「她紧紧盯着」产整块红绿（非逐字碎块）。
 * - unified 视图切换：点切换按钮 → 出现 .diff-unified-body + -/+ 前缀符号。
 * - readonly 模式：隐藏 Accept All / Reject All 按钮（revision-guard 卡场景）。
 * - 装饰性 per-line 假按钮已清除：无 .diff-sbs-gutter* 元素（R4）。
 * - 整 diff 级 Accept All：点击 → 调 acceptDiff（非 per-line）。
 *
 * 照 ui/testing.md：直接渲染组件（SideBySideDiff 纯渲染，mock window.orisonDesktop 非必需——
 * 不调 IPC；store 的 acceptDiff/rejectDiff 是 zustand action，渲染时不触发）。
 */
import { cleanup, screen, render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SideBySideDiff } from '../src/features/agent-panel/SideBySideDiff';
import { useAppStore } from '../src/shared/store/appStore';

const passageDiff = {
  kind: 'passage' as const,
  id: 'diff-1',
  toolId: 'rewrite_passage',
  sourceType: 'chapter' as const,
  chapterId: 'ch01',
  originalText: '她死死盯着窗外，the cat sat',
  replacement: '她紧紧盯着窗外，the dog sat',
};

beforeEach(() => {
  useAppStore.setState({
    acceptDiff: vi.fn(),
    rejectDiff: vi.fn(),
  } as any);
});

afterEach(() => cleanup());

describe('SideBySideDiff — Story 7.5 词级 diff 渲染', () => {
  it('changed 行内渲染词级 highlight（diff-word--add/remove span）', () => {
    const { container } = render(
      <SideBySideDiff diff={passageDiff} oldContent={passageDiff.originalText} onClose={() => {}} />,
    );
    // CJK 整串：死死盯着 vs 紧紧盯着 → remove 块 + add 块；the cat/dog → remove(cat)+add(dog)。
    expect(container.querySelectorAll('.diff-word--remove').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.diff-word--add').length).toBeGreaterThan(0);
  });

  it('CJK 整串改：字符级细化标出真正改动的字（死死/紧紧），首尾相同字保留（质量优化）', () => {
    const { container } = render(
      <SideBySideDiff
        diff={passageDiff}
        oldContent={'她死死盯着'}
        newContent={'她紧紧盯着'}
        onClose={() => {}}
      />,
    );
    // CJK 整串切下「她死死盯着」/「她紧紧盯着」是两个 cjk token，但 refineCjkPairs 对成对
    // CJK 块做字符级 LCS：「她」「盯着」相同→equal（不染色），「死死」/「紧紧」→ remove/add。
    const removes = Array.from(container.querySelectorAll('.diff-word--remove')).map((n) => n.textContent);
    const adds = Array.from(container.querySelectorAll('.diff-word--add')).map((n) => n.textContent);
    expect(removes.join('')).toBe('死死');
    expect(adds.join('')).toBe('紧紧');
  });

  it('CJK 完全无公共字：整块换（细化无害）', () => {
    const { container } = render(
      <SideBySideDiff
        diff={passageDiff}
        oldContent={'甲乙丙'}
        newContent={'丁戊己'}
        onClose={() => {}}
      />,
    );
    // 无公共字 → 字符级 LCS 仍全 remove + 全 add（整块换），与未细化等价。
    const removes = Array.from(container.querySelectorAll('.diff-word--remove')).map((n) => n.textContent);
    const adds = Array.from(container.querySelectorAll('.diff-word--add')).map((n) => n.textContent);
    expect(removes.join('')).toBe('甲乙丙');
    expect(adds.join('')).toBe('丁戊己');
  });

  it('英文行级改动：词级切出公共词（the 保留，cat/dog 整词换）', () => {
    const { container } = render(
      <SideBySideDiff
        diff={passageDiff}
        oldContent={'the cat sat'}
        newContent={'the dog sat'}
        onClose={() => {}}
      />,
    );
    const removes = Array.from(container.querySelectorAll('.diff-word--remove')).map((n) => n.textContent);
    const adds = Array.from(container.querySelectorAll('.diff-word--add')).map((n) => n.textContent);
    // the / sat 是 equal（不染色），cat 整词 remove、dog 整词 add。
    expect(removes.join('')).toBe('cat');
    expect(adds.join('')).toBe('dog');
  });

  it('decorative per-line 假按钮已清除（无 gutter 元素，R4）', () => {
    const { container } = render(
      <SideBySideDiff diff={passageDiff} oldContent={passageDiff.originalText} onClose={() => {}} />,
    );
    expect(container.querySelectorAll('.diff-sbs-gutter').length).toBe(0);
    expect(container.querySelectorAll('.diff-sbs-gutter-btn').length).toBe(0);
  });

  it('readonly 模式隐藏 Accept All / Reject All 按钮', () => {
    render(
      <SideBySideDiff
        readonly
        oldContent={'改前'}
        newContent={'改后'}
        fileName="test"
      />,
    );
    // 默认 i18n 未加载时 acceptAll/rejectAll 走 fallback 显示空串——用 button role + 语义判断。
    // readonly 下整 diff 级按钮组不渲染（只剩 view 切换）。
    const buttons = screen.getAllByRole('button');
    // 只有视图切换按钮（1 个），无 accept/reject/close。
    expect(buttons.length).toBe(1);
  });

  it('非 readonly 模式：点 Accept All 调 acceptDiff（整 diff 级，非 per-line）', () => {
    const acceptDiff = vi.fn();
    useAppStore.setState({ acceptDiff, agentSessionId: 'sess-sbs' } as any);
    render(
      <SideBySideDiff diff={passageDiff} oldContent={passageDiff.originalText} onClose={() => {}} />,
    );
    // acceptAll 按钮是 diff-sbs-btn--accept（i18n 未加载文案空，按 class 定位）。
    const acceptBtn = document.querySelector('.diff-sbs-btn--accept') as HTMLButtonElement;
    expect(acceptBtn).toBeTruthy();
    fireEvent.click(acceptBtn);
    // r8 键控：accept 按视图会话键发（sessionId 先行）。
    expect(acceptDiff).toHaveBeenCalledWith(useAppStore.getState().agentSessionId, passageDiff.id);
  });

  it('unified 视图切换：点切换 → 出现 unified body + -/+ 符号', () => {
    const { container } = render(
      <SideBySideDiff
        diff={passageDiff}
        oldContent={'line one\nold line'}
        newContent={'line one\nnew line'}
        onClose={() => {}}
      />,
    );
    // 默认 split。点 view-toggle。
    const toggle = container.querySelector('.diff-sbs-view-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    // 切换后出现 unified body。
    expect(container.querySelector('.diff-unified-body')).toBeTruthy();
    // changed 行有符号（- 或 +）。
    const signs = container.querySelectorAll('.diff-unified-sign');
    const signTexts = Array.from(signs).map((n) => n.textContent);
    expect(signTexts).toContain('-');
    expect(signTexts).toContain('+');
  });

  it('BMad CR-001 grid 结构：split 视图左右 cell 同行（grid 而非两独立列）', () => {
    const { container } = render(
      <SideBySideDiff diff={passageDiff} oldContent={'old'} newContent={'new'} onClose={() => {}} />,
    );
    // grid 化后用 .diff-sbs-grid（非旧的 .diff-sbs-body 两列 flex）。
    expect(container.querySelector('.diff-sbs-grid')).toBeTruthy();
    expect(container.querySelector('.diff-sbs-body')).toBeNull();
    expect(container.querySelectorAll('.diff-sbs-cell').length).toBeGreaterThan(0);
  });

  it('dogfood 2026-08-21 回归：左右 cell 必须逐对相邻进 DOM（同一 DiffLine 同一 grid row）', () => {
    // 修复前：先渲染全部左列再渲染全部右列——行优先 auto-placement 把左格两两排进
    // 同一行、右格整段堆到下方，split 视图整体错乱（用户实录「看不懂在说什么」）。
    const { container } = render(
      <SideBySideDiff
        oldContent={'第一行\n第二行\n第三行'}
        newContent={'第一行\n改了\n第三行'}
      />,
    );
    const cells = Array.from(container.querySelectorAll('.diff-sbs-cell'));
    // 4 个 DiffLine（same / remove / add / same）× 2 列 = 8 cell。
    expect(cells.length).toBe(8);
    // 逐对断言（第 2k、2k+1 个 cell = 同一 DiffLine 的左右格）：
    // 行1（same）：左=右=「第一行」，行号都是 1。
    expect(cells[0].textContent).toBe('1第一行');
    expect(cells[1].textContent).toBe('1第一行');
    // 行2a（remove）：左=「第二行」行号 2，右侧空（remove 行 lineRight=0）。
    expect(cells[2].textContent).toBe('2第二行');
    expect(cells[3].textContent).toBe('');
    expect(cells[2].className).toContain('diff-sbs-cell--remove');
    // 行2b（add）：左侧空，右=「改了」行号 2。
    expect(cells[4].textContent).toBe('');
    expect(cells[5].textContent).toBe('2改了');
    expect(cells[5].className).toContain('diff-sbs-cell--add');
    // 行3（same）：左右都是「第三行」行号 3——旧 bug 下右列 cell 堆在全部左格之后，
    // 该位置会是左列第 4 格（「3第三行」左侧）而非同行右格，配对断言必挂。
    expect(cells[6].textContent).toBe('3第三行');
    expect(cells[7].textContent).toBe('3第三行');
  });

  it('BMad CR-004 leftLabel/rightLabel：自定义列头标签透传', () => {
    render(
      <SideBySideDiff
        diff={passageDiff}
        oldContent={'old'}
        newContent={'new'}
        onClose={() => {}}
        leftLabel="你的原稿"
        rightLabel="AI 改的"
      />,
    );
    expect(screen.getByText('你的原稿')).toBeTruthy();
    expect(screen.getByText('AI 改的')).toBeTruthy();
  });
});

describe('SideBySideDiff — 体量门折叠（dogfood R2 108KB 风格卡实测）', () => {
  it('超限内容走折叠视图：无逐行表格，有摘要与预览', () => {
    useAppStore.setState({ resolvedLocale: 'zh-CN' } as any);
    const big = 'x'.repeat(41_000);
    render(
      <SideBySideDiff
        oldContent=""
        newContent={big}
        readonly
        fileName="style.md"
      />,
    );
    const root = document.querySelector('[data-large-diff-folded="true"]');
    expect(root).not.toBeNull();
    // 无逐行表（体量门的意义：不渲染两三千行 DOM）
    expect(document.querySelectorAll('.diff-sbs-line, .diff-sbs-row')).toHaveLength(0);
    // 摘要与预览在场
    expect(screen.getByText(/内容过大，词级对比已折叠/)).toBeTruthy();
    expect(document.querySelector('.diff-sbs-folded-preview')).not.toBeNull();
  });

  it('常规体量不受影响（阈值下照常词级表）', () => {
    render(
      <SideBySideDiff
        oldContent="她死死盯着窗外"
        newContent="她紧紧盯着窗外"
        readonly
        fileName="ch01.md"
      />,
    );
    expect(document.querySelector('[data-large-diff-folded="true"]')).toBeNull();
  });
});
