/**
 * CardForm 行为测试（task 08-30-asset-cards-visualization A2 波；B 波标签接 i18n）。
 *
 * 纯受控组件（零 store 直连——onSave/onDeleteRequest 是 props，vi.fn() 注入即可，无
 * zustand spy 场景）。覆盖：分区渲染序（主显前）+ 折叠、离散 change 即存（status/tier/
 * chips/boolean/select 快选）、键盘类 blur 存（文本/number——CR 裁决 1 后 number 归
 * blur 组）、number 钳制、secrets 双栏、details kv 增删、readOnly 禁用、spec 外未知
 * 字段保留、删除按钮透传。
 *
 * 标签（B 波）：真 i18n 渲染（真 useI18n + resolvedLocale 钉 zh-CN——组件真 t 通道冒烟，
 * zh 断言非键名 = AC7 中文化在测）。测试经由 aria-label 定位控件，与 fieldSpec 标签出口
 * 同步。
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetCard } from '@orison/shared-contracts';
import { CardForm } from '../src/features/setting/CardForm';
import { useAppStore } from '../src/shared/store/appStore';

// ── fixtures（dogfood 真实卡形态：中等填充度 + 全未标 tier）──

function characterCard(): AssetCard {
  return {
    id: 'protagonist',
    type: 'character',
    name: '琉璃月',
    status: 'draft',
    tags: [],
    relationships: [],
    sourceRefs: [],
    summary: '远古地球「长兔耳族」最后幸存者',
    secrets: { surface: '普通转学生', truth: '全星际最稀有的远古长兔耳族最后幸存者' },
    basics: { gender: '女', age: '外表约 16-17 岁' },
    personality: {
      coreTraits: ['警觉', '独立'],
      surface: '冷淡寡言的转学生',
      innerTruth: '渴望被接纳却不敢靠近',
      emotionElasticity: 0.6,
    },
    desireAndBottomline: {
      coreDesire: '作为普通人活下去',
      coreFear: '身份暴露后被当作实验体',
      oocAnchors: ['绝不主动伤人', '紧张时摸耳朵'],
    },
  };
}

function goldenFingerCard(): AssetCard {
  return {
    id: 'animal-affinity',
    type: 'golden_finger',
    name: '小动物亲和（天生体质）',
    status: 'draft',
    tags: [],
    relationships: [],
    sourceRefs: [],
    basics: { type: '体质型' },
    abilitySystem: { coreAbility: '小动物主动亲近', boundaries: '无法主动关闭' },
    limitations: { hardLimits: '只对小动物生效', usageCost: '无法隐藏气息' },
  };
}

/** 组区块（按组标题按钮找最近 section 祖先）——同名字段跨组（surface）需 within 定界。 */
function sectionOf(groupName: string): HTMLElement {
  const header = screen.getByRole('button', { name: groupName });
  return header.closest('section') as HTMLElement;
}

/** AssetCard 是 8-variant 联合：分支专字段（personality/basics.type…）须先判别收窄。 */
function asCharacter(card: AssetCard) {
  if (card.type !== 'character') throw new Error(`expected character, got ${card.type}`);
  return card;
}
function asGolden(card: AssetCard) {
  if (card.type !== 'golden_finger') throw new Error(`expected golden_finger, got ${card.type}`);
  return card;
}

describe('CardForm', () => {
  let onSave: ReturnType<typeof vi.fn>;
  let onDeleteRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onSave = vi.fn();
    onDeleteRequest = vi.fn();
    // B 波：标签走真 i18n——钉 zh-CN（真 t 通道渲染中文标签，断言非键名 = AC7 冒烟）。
    useAppStore.setState({ resolvedLocale: 'zh-CN' } as any);
  });
  afterEach(() => {
    cleanup();
  });

  it('分区渲染序：主显组（性格）在次显组（基本信息）之前', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const personality = screen.getByRole('button', { name: '性格' });
    const basics = screen.getByRole('button', { name: '基本信息' });
    expect(
      (personality.compareDocumentPosition(basics) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    ).toBe(true);
  });

  it('主显组默认展开、次显组默认折叠（点击展开）', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    // 主显：personality chips 直接可见
    expect(screen.getByText('警觉')).toBeInTheDocument();
    // 次显：basics 的性别不在 DOM
    expect(screen.queryByLabelText('性别')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '基本信息' }));
    expect(screen.getByLabelText('性别')).toBeInTheDocument();
  });

  it('卡头：status select 离散即存（收到整张新卡、兄弟字段保留）', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });
    expect(onSave).toHaveBeenCalledTimes(1);
    const next = onSave.mock.calls[0][0] as AssetCard;
    expect(next.status).toBe('active');
    expect(next.id).toBe('protagonist');
    expect(next.name).toBe('琉璃月');
    expect(asCharacter(next).personality?.coreTraits).toEqual(['警觉', '独立']);
  });

  it('卡头：name 文本 blur 存、空值不落盘', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const nameInput = screen.getByLabelText('名称');
    fireEvent.change(nameInput, { target: { value: '琉璃月（真名）' } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(nameInput);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).name).toBe('琉璃月（真名）');

    // 置空 blur → 不落盘（name 必填 min(1)）
    onSave.mockClear();
    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.blur(nameInput);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('tier 三态：未标显结构默认角标（character → core）；点核心写值；未标键清除', () => {
    const card = characterCard(); // tier 未标
    const { rerender } = render(<CardForm card={card} onSave={onSave} />);
    expect(screen.getByText('默认')).toBeInTheDocument(); // 结构默认 core 的角标
    expect(screen.getByRole('radio', { name: '未标' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('radio', { name: /核心/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).tier).toBe('core');

    // 显式 core 后再点未标 → 删键
    onSave.mockClear();
    const explicit: AssetCard = { ...card, tier: 'core' };
    rerender(<CardForm card={explicit} onSave={onSave} />);
    fireEvent.click(screen.getByRole('radio', { name: '未标' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const next = onSave.mock.calls[0][0] as AssetCard;
    expect(next.tier).toBeUndefined();
    expect('tier' in next).toBe(false);
  });

  it('文本字段：输入中不存、blur 存、清空 blur 删键', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const input = within(sectionOf('性格')).getByLabelText('表层表现');
    fireEvent.change(input, { target: { value: '温和表象' } });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(asCharacter(onSave.mock.calls[0][0] as AssetCard).personality?.surface).toBe('温和表象');

    // 清空 → 删键（optional 字段缺失即未设）
    onSave.mockClear();
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(asCharacter(onSave.mock.calls[0][0] as AssetCard).personality?.surface).toBeUndefined();
  });

  it('外部回写同步：agent 改字段后草稿跟随（echo 模式）', () => {
    const card = characterCard();
    const { rerender } = render(<CardForm card={card} onSave={onSave} />);
    const updated: AssetCard = {
      ...card,
      personality: { ...card.personality!, surface: '新表面' },
    };
    rerender(<CardForm card={updated} onSave={onSave} />);
    const input = within(sectionOf('性格')).getByLabelText('表层表现') as HTMLInputElement;
    expect(input.value).toBe('新表面');
  });

  it('chips 增删即存（去重 + 数组其余项保留；父层回声后继续操作——受控组件语义）', () => {
    const view = render(<CardForm card={characterCard()} onSave={onSave} />);
    const chipsInput = () => within(sectionOf('性格')).getByLabelText('核心性格');

    // 增
    fireEvent.change(chipsInput(), { target: { value: '温柔' } });
    fireEvent.keyDown(chipsInput(), { key: 'Enter' });
    expect(onSave).toHaveBeenCalledTimes(1);
    const added = onSave.mock.calls[0][0] as AssetCard;
    expect(asCharacter(added).personality?.coreTraits).toEqual(['警觉', '独立', '温柔']);
    // 父层落盘后以新卡重渲（回声）——后续操作基于新值
    view.rerender(<CardForm card={added} onSave={onSave} />);

    // 重复添加 → 无变化不落盘
    onSave.mockClear();
    fireEvent.change(chipsInput(), { target: { value: '警觉' } });
    fireEvent.keyDown(chipsInput(), { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();

    // 删（chips 删除钮 aria 已中文化——AC7）
    fireEvent.click(screen.getByRole('button', { name: '删除 警觉' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(asCharacter(onSave.mock.calls[0][0] as AssetCard).personality?.coreTraits).toEqual(['独立', '温柔']);
  });

  it('number 钳制（CR P3/裁决 1：blur 存）：键入零落盘、blur 落钳制值（超上限 max / 超下限 min）', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const input = within(sectionOf('性格')).getByLabelText('情绪弹性');
    fireEvent.change(input, { target: { value: '5' } });
    expect(onSave).not.toHaveBeenCalled(); // 键盘类连续输入——逐键零落盘（无中间脏值/undo 噪音）
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(asCharacter(onSave.mock.calls[0][0] as AssetCard).personality?.emotionElasticity).toBe(1);

    cleanup();
    onSave.mockClear();
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const input2 = within(sectionOf('性格')).getByLabelText('情绪弹性');
    fireEvent.change(input2, { target: { value: '-3' } });
    fireEvent.blur(input2);
    expect(asCharacter(onSave.mock.calls[0][0] as AssetCard).personality?.emotionElasticity).toBe(0);
  });

  it('secrets 双栏：表面 | 真相 并排同组渲染', () => {
    render(<CardForm card={characterCard()} onSave={onSave} />);
    const secretsSect = document.querySelector('.card-form-sect-secrets');
    expect(secretsSect).not.toBeNull();
    expect(within(secretsSect as HTMLElement).getByLabelText('表面')).toBeInTheDocument();
    expect(within(secretsSect as HTMLElement).getByLabelText('真相')).toBeInTheDocument();
  });

  it('select：词表快选即存（词表只是建议，非门禁）', () => {
    render(<CardForm card={goldenFingerCard()} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: '系统型' }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const next = asGolden(onSave.mock.calls[0][0] as AssetCard);
    expect(next.basics?.type).toBe('系统型');
    expect(next.basics?.packaging).toBeUndefined();
  });

  it('boolean：checkbox 即存（golden_finger.basics.unique）', () => {
    render(<CardForm card={goldenFingerCard()} onSave={onSave} />);
    fireEvent.click(screen.getByLabelText('是否唯一'));
    expect(onSave).toHaveBeenCalledTimes(1);
    const next = asGolden(onSave.mock.calls[0][0] as AssetCard);
    expect(next.basics?.unique).toBe(true);
    expect(next.basics?.type).toBe('体质型');
  });

  it('details kv 表：改值 blur 存、加行提交、删行即存', () => {
    const card: AssetCard = { ...characterCard(), details: { 宿舍号: '203' } };
    render(<CardForm card={card} onSave={onSave} />);

    // 改值（kv 行 aria 已中文化：1 基行号——AC7）
    fireEvent.change(screen.getByLabelText('值 1'), { target: { value: '204' } });
    fireEvent.blur(screen.getByLabelText('值 1'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).details).toEqual({ 宿舍号: '204' });

    // 加行（本地行 → 填键值 blur 提交）
    onSave.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加字段' }));
    fireEvent.change(screen.getByLabelText('键 2'), { target: { value: '生日' } });
    fireEvent.change(screen.getByLabelText('值 2'), { target: { value: '3月3日' } });
    fireEvent.blur(screen.getByLabelText('值 2'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).details).toEqual({ 宿舍号: '204', 生日: '3月3日' });

    // 删行（行索引随删除重排：先删「宿舍号」行 → 只剩「生日」）
    onSave.mockClear();
    fireEvent.click(screen.getByLabelText('删除第 1 行'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).details).toEqual({ 生日: '3月3日' });

    // 删最后一行 → details 整键删除（空对象不落 yaml）
    onSave.mockClear();
    fireEvent.click(screen.getByLabelText('删除第 1 行'));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect((onSave.mock.calls[0][0] as AssetCard).details).toBeUndefined();
  });

  it('readOnly：全控件禁用、删除按钮不渲染、交互不落盘', () => {
    render(<CardForm card={characterCard()} onSave={onSave} readOnly onDeleteRequest={onDeleteRequest} />);
    expect(screen.getByLabelText('名称')).toBeDisabled();
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(within(sectionOf('性格')).getByLabelText('核心性格')).toBeDisabled();
    expect(within(sectionOf('性格')).getByLabelText('情绪弹性')).toBeDisabled();
    expect(screen.queryByRole('button', { name: '删除这张卡' })).toBeNull();

    // 禁用控件上的事件不触发落盘
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } });
    expect(onSave).not.toHaveBeenCalled();
  });

  it('未知字段防御：卡上 spec 外字段经保存浅拷贝保留不丢', () => {
    const card = {
      ...characterCard(),
      customExtra: { nested: [1, 2] },
    } as AssetCard;
    render(<CardForm card={card} onSave={onSave} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'deprecated' } });
    const next = onSave.mock.calls[0][0] as unknown as { customExtra: unknown };
    expect(next.customExtra).toEqual({ nested: [1, 2] });
  });

  it('删除按钮：透传 onDeleteRequest、不触发 onSave；未传则不渲染', () => {
    const card = characterCard();
    const { rerender } = render(<CardForm card={card} onSave={onSave} />);
    expect(screen.queryByRole('button', { name: '删除这张卡' })).toBeNull();

    rerender(<CardForm card={card} onSave={onSave} onDeleteRequest={onDeleteRequest} />);
    fireEvent.click(screen.getByRole('button', { name: '删除这张卡' }));
    expect(onDeleteRequest).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('入口防御：未知 type 返回 null 不渲染表单', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const bogus = { id: 'x', type: 'image', name: '越界卡' } as unknown as AssetCard;
      const { container } = render(<CardForm card={bogus} onSave={onSave} />);
      expect(container.querySelector('.card-form')).toBeNull();
      expect(onSave).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });
});
