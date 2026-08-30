/**
 * 设定卡表单引擎控件语义测试（task 08-30-asset-cards-visualization CR patch 波）。
 *
 * 覆盖 CR 裁决/patch 的控件级语义（页面集成测见 settingPageCrud）：
 * - P3/裁决 1：number blur 存——逐键零 commit（无中间脏值/undo 栈噪音），blur 落定钳制值。
 * - P5/裁决 3：外部回声聚焦期不回写（本地草稿优先）；blur 后未动则收养外部翻新值。
 * - P17：必填字段（rejectEmpty，卡名）空值 blur 拒绝并回显存量。
 * - P18：非字符串存值显影空串——清空提交 = 删键（ops 层 commitTextField/commitNumberField）。
 * - P9①：kv 仅改键行保留原值对象类型（42 不被改写成 '42'）。
 * - P9②：kv 重复键（trim 后同键）首行生效 + 后行 is-dup 标记。
 * - P9③：kv 清键瞬态 blur 不丢原条目（沿 origKey 保留）；rename 落定后 origKey 对齐生效键。
 * - P19：replaceCardById 无匹配不 append（防复活已删卡）；appendCard 显式追加。
 *
 * 控件直测（受控 props + onCommit spy——InsightCard 受控壳哲学的测试面）；ops 纯函数直测。
 */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FormKvTable,
  FormNumberControl,
  FormSelectControl,
  FormTextControl,
} from '../src/features/setting/formControls';
import {
  appendCard,
  commitTextField,
  replaceCardById,
} from '../src/features/setting/formCardOps';
import type { AssetCard } from '@orison/shared-contracts';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

// ── P3/裁决 1 + P5/裁决 3：number ──────────────────────────────────────────────

describe('FormNumberControl（CR P3 blur 存 + P5 回声抑制）', () => {
  it('逐键零 commit（0.5 → 0.75 全程三次键入只一次落盘，且为终值）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormNumberControl label="情绪弹性" value={0.5} min={0} max={1} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '0.7' } });
    expect(onCommit).not.toHaveBeenCalled(); // 键入期零落盘（无中间脏值/undo 栈噪音）

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(0.7);
    expect(input.value).toBe('0.7');
  });

  it('越界 blur 钳制落盘（max=1 输 5 → 1）；未变值 blur 零噪音', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormNumberControl label="x" value={0.2} min={0} max={1} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(1);
    expect(input.value).toBe('1');

    // 值未变再 blur（连点别处）：零重复提交。
    onCommit.mockClear();
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('清空 blur 删键（onCommit undefined）；非数存值（显影空串）清空同样删', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      <FormNumberControl label="x" value={0.5} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(undefined);

    onCommit.mockClear();
    // 非数存值（unknown seam：字符串垃圾）——显示空串，清空提交仍落「无值」（P18 同族）。
    rerender(<FormNumberControl label="x" value={'junk' as unknown} onCommit={onCommit} />);
    fireEvent.blur(container.querySelector('input') as HTMLInputElement);
    expect(onCommit).toHaveBeenCalledWith(undefined);
  });

  it('P5：聚焦期外部翻新不清草稿；blur 未动则收养外部值（防陈旧草稿反向覆盖）', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      <FormNumberControl label="x" value={0.5} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.focus(input);
    rerender(<FormNumberControl label="x" value={0.9} onCommit={onCommit} />); // agent 回声
    expect(input.value).toBe('0.5'); // 聚焦期不回写——草稿优先

    fireEvent.blur(input); // 用户未动
    expect(onCommit).not.toHaveBeenCalled(); // 不用陈旧 0.5 反向覆盖
    expect(input.value).toBe('0.9'); // 收养外部值
  });
});

// ── P5/P17/P18：text（含 textarea）与 select ──────────────────────────────────

describe('FormTextControl（CR P5/P17/P18）', () => {
  it('P5：聚焦期外部回声不清草稿；blur 提交草稿（用户编辑 latest-wins）', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      <FormTextControl label="x" value="旧值" onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '用户输入中' } });
    rerender(<FormTextControl label="x" value="agent 改写" onCommit={onCommit} />);
    expect(input.value).toBe('用户输入中'); // 回声被抑制

    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('用户输入中'); // 草稿提交（latest-wins）
  });

  it('P5：聚焦期外部翻新 + 用户未动 → blur 收养外部值（不回写陈旧草稿）', () => {
    const onCommit = vi.fn();
    const { container, rerender } = render(
      <FormTextControl label="x" value="a" onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.focus(input);
    rerender(<FormTextControl label="x" value="b" onCommit={onCommit} />);
    fireEvent.blur(input);

    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('b');
  });

  it('P17：rejectEmpty（卡名）空/纯空白 blur —— 拒绝提交并回显存量', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormTextControl label="名称" value="琉璃月" rejectEmpty onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('琉璃月'); // 回显

    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('琉璃月');
  });

  it('P17 对照：可选字段（缺省）清空提交空串（ops 层删键）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormTextControl label="摘要" value="有值" onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith('');
  });

  it('P18：非字符串存值（42）显影空串——清空 blur 提交删键（非 no-op）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormTextControl label="x" value={42} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(''); // 非串显影空

    fireEvent.blur(input); // 不键入直接 blur（显式清空确认）
    expect(onCommit).toHaveBeenCalledWith('');
  });
});

describe('FormSelectControl（CR P5/P18 同族）', () => {
  it('P5 聚焦期回声抑制 + blur 收养；P18 非字符串存值清空提交删键', () => {
    const onCommit = vi.fn();
    const suggestions = [{ value: '修炼', gloss: '境界突破' }];
    const { container, rerender } = render(
      <FormSelectControl label="x" value="网游" suggestions={suggestions} onCommit={onCommit} />,
    );
    const input = container.querySelector('input') as HTMLInputElement;

    fireEvent.focus(input);
    rerender(<FormSelectControl label="x" value="超能" suggestions={suggestions} onCommit={onCommit} />);
    expect(input.value).toBe('网游'); // 聚焦期不回写
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe('超能'); // 收养

    rerender(<FormSelectControl label="x" value={7 as unknown} suggestions={suggestions} onCommit={onCommit} />);
    fireEvent.blur(container.querySelector('input') as HTMLInputElement);
    expect(onCommit).toHaveBeenCalledWith(''); // P18：垃圾存值清空删键
  });
});

// ── P9①②③：kv 表 ─────────────────────────────────────────────────────────────

function kvKeyInput(container: HTMLElement, index = 0): HTMLInputElement {
  return container.querySelectorAll('.card-form-kv-key')[index] as HTMLInputElement;
}
function kvValueInput(container: HTMLElement, index = 0): HTMLInputElement {
  return container.querySelectorAll('.card-form-kv-value')[index] as HTMLInputElement;
}

describe('FormKvTable（CR P9 三修）', () => {
  it('P9①：仅改键行——原值对象类型保留（42 不被改写成 "42"）', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormKvTable details={{ 宿舍号: 42 }} onCommit={onCommit} />,
    );
    fireEvent.change(kvKeyInput(container), { target: { value: '宿舍' } });
    fireEvent.blur(kvKeyInput(container));
    expect(onCommit).toHaveBeenCalledWith({ 宿舍: 42 }); // 数字类型保真
  });

  it('P9②：重复键（trim 后同键）首行生效 + 后行 is-dup 标记', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormKvTable details={{ a: '1' }} onCommit={onCommit} />,
    );
    // 加一行并键入同键 'a'。
    fireEvent.click(container.querySelector('.card-form-kv-add')!);
    fireEvent.change(kvKeyInput(container, 1), { target: { value: ' a ' } });
    fireEvent.change(kvValueInput(container, 1), { target: { value: '2' } });

    // 后行标记（trim 后同键）：第二行键输入挂 is-dup。
    expect(kvKeyInput(container, 1).classList.contains('is-dup')).toBe(true);
    expect(kvKeyInput(container, 0).classList.contains('is-dup')).toBe(false);

    // blur：保序去重首行生效——有效记录不变（{a:'1'}）→ 零提交（后行值不静默覆盖首行）。
    fireEvent.blur(kvKeyInput(container, 1));
    expect(onCommit).not.toHaveBeenCalled();

    // rename 已有键撞上现存键：首行生效、被撞键的旧条目随之退场（标记可见非静默）。
    onCommit.mockClear();
    cleanup();
    const second = render(
      <FormKvTable details={{ a: '1', b: '2' }} onCommit={onCommit} />,
    );
    fireEvent.change(kvKeyInput(second.container, 1), { target: { value: 'a' } });
    expect(kvKeyInput(second.container, 1).classList.contains('is-dup')).toBe(true);
    fireEvent.blur(kvKeyInput(second.container, 1));
    expect(onCommit).toHaveBeenCalledWith({ a: '1' });
  });

  it('P9③：清键瞬态 blur 不丢原条目（沿 origKey 保留）；rename 落定后清键回落生效键', () => {
    const onCommit = vi.fn();
    const { container } = render(
      <FormKvTable details={{ 旧键: 'v' }} onCommit={onCommit} />,
    );

    // 清键 blur（改键中途点到别处）：原条目保留——零提交（盘上记录未动）。
    fireEvent.change(kvKeyInput(container), { target: { value: '' } });
    fireEvent.blur(kvKeyInput(container));
    expect(onCommit).not.toHaveBeenCalled();

    // 补完新键 rename 落定。
    fireEvent.change(kvKeyInput(container), { target: { value: '新键' } });
    fireEvent.blur(kvKeyInput(container));
    expect(onCommit).toHaveBeenCalledWith({ 新键: 'v' });
    onCommit.mockClear();

    // rename 落定后再清键：回落的是生效键「新键」（不复活 rename 前旧键）。
    fireEvent.change(kvKeyInput(container), { target: { value: '' } });
    fireEvent.blur(kvKeyInput(container));
    expect(onCommit).not.toHaveBeenCalled(); // 记录 {'新键':'v'} 未动
  });
});

// ── P18/P19：formCardOps 纯函数 ───────────────────────────────────────────────

describe('formCardOps（CR P18/P19）', () => {
  const card = { id: 'c1', type: 'character', name: 'A', status: 'draft' } as AssetCard;

  it('P18：commitTextField 清空提交——字符串原值/非字符串原值/undefined 三态', () => {
    const withStr = { ...card, summary: 'x' } as AssetCard;
    const cleared = commitTextField(withStr, 'summary', '');
    expect(cleared).not.toBeNull();
    expect((cleared as Record<string, unknown>).summary).toBeUndefined(); // 删键

    const withNum = { ...card, summary: 42 } as unknown as AssetCard;
    const clearedNum = commitTextField(withNum, 'summary', '  ');
    expect(clearedNum).not.toBeNull();
    expect((clearedNum as Record<string, unknown>).summary).toBeUndefined(); // 垃圾值清空也删键

    expect(commitTextField(card, 'summary', ' ')).toBeNull(); // 原本无值 → 无变化
  });

  it('P19：replaceCardById 无匹配（目标已被删）→ 原样返回不 append（不复活已删卡）', () => {
    const raw = [{ id: 'other', type: 'character', name: 'B', status: 'draft' }];
    const next = { ...card, name: '滞留编辑的旧卡' };
    expect(replaceCardById(raw, next)).toEqual(raw); // 引用原数组内容——无 append 无改动

    const empty = replaceCardById(undefined, next);
    expect(empty).toEqual([]); // raw 缺省同样不 append
  });

  it('P19：replaceCardById 有匹配替换首个 + 垃圾元素保留；appendCard 显式追加', () => {
    const raw = [null, card, 42, { id: 'c1', type: 'rule', name: '重复 id 后条', status: 'draft' }];
    const next = { ...card, name: 'A2' } as AssetCard;
    const out = replaceCardById(raw, next);
    expect(out).toHaveLength(4);
    expect(out[0]).toBeNull();
    expect((out[1] as { name: string }).name).toBe('A2'); // 首个匹配替换
    expect(out[3]).toEqual(raw[3]); // 后条原样（显示层已 first-wins 去重）

    const appended = appendCard(raw, next);
    expect(appended).toHaveLength(5); // 新建流显式追加
    expect(appended[4]).toBe(next);
  });
});
