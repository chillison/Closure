/**
 * R6 方案 D：WorkbenchChip 缘部直拖手势（pointer events）单元矩阵。
 *
 * 冻结契约（design §6.3「手势发起区分」+ 08-27 T10/T11 修订）：
 *  - 把手热区 pointerdown 起手；move 只产预览态（类名 + data 属性，零写盘）；
 *  - pointerup 一次 dispatch onResizeSpanRange = applyResizeSpanRange 一条 op
 *    （一次手势一次写）；指针解析失败保持上一预览，不误提交非法列；
 *  - T11 恒渲染：把手不再被「不可用」条件吞掉——单章左缘/末章单章右缘置灰
 *    （disabled 类 + data-disabled + title 说明，零手势）；宽卡贴边为部分可用
 *    （收边仍可），只挂 title 不置灰；
 *  - T10：「续至第 N 章」徽记退役（continueToLabel prop 删除——宽卡形态即表达）；
 *  - resize 提交后的尾随 click 吞掉（不开抽屉）；
 *  - 提交层越界/非法区间由 applyResizeSpanRange 原引用拒收（在模型测覆盖）。
 *
 * CR3 G 域 patch 批加固（08-27 Review）：
 *  - G-F3 预览 gap 门槛：解析列不在 builtColumnSet → 与解析失败同处（保持上一预览
 *    = 钉在最近已建列），预览永不承诺未建章；
 *  - G-F6 多点触控配对：gestureRef 持 pointerId，第二指针不覆盖、他指 move/up 不
 *    混写不误收手；
 *  - G-F7 吞旗标只武装到宏任务边界（cancel/窗外 up 无 click 跟随 → 定时器 disarm）；
 *  - edge：capture 失败/窗外 up → window 级兜底收手（陈旧 gestureRef 不再永久
 *    阻塞卡体拖拽）；up 端等值也照发（真 no-op 归模型层引用级短路）。
 *
 * Run: `cd apps/desktop/client/ui && npx vitest run workbenchResize`
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchChip } from '../src/features/structure/WorkbenchChip';
import type { WorkbenchChipData } from '../src/features/structure/workbenchLayout';
import { __resetNodeSharedStateForTests } from '../src/features/structure/nodeSharedState';

function chipData(overrides: Partial<WorkbenchChipData> = {}): WorkbenchChipData {
  return {
    nodeId: 's1',
    lineId: 'l_main',
    role: 'normal',
    title: '普通场景',
    colStart: 1,
    colEnd: 1,
    readIndex: 0,
    reordered: false,
    pending: false,
    ...overrides,
  };
}

/** 序列化解析器：clientX → 列（测试注入 fake rect 表的替身——jsdom 无几何）。 */
function resolverByX(map: Record<number, number | null>) {
  return (clientX: number) => map[clientX] ?? null;
}

type Setup = {
  chip?: WorkbenchChipData;
  resolveColumnAt?: (x: number) => number | null;
  /** T15 实时变宽的列盒 seam（生产态由 ChapterWorkbench 注入——本文件 fake 常量表）。 */
  resolveColumnBox?: (col: number) => { left: number; right: number } | null;
  /** T23 装填盒（生产态由 ChapterWorkbench 的 workbenchPacking 产出注入）。 */
  box?: { left: number; top: number; width: number; height?: number };
  builtColumnSet?: ReadonlySet<number>;
  builtMinCol?: number;
  builtMaxCol?: number;
  canExtendRight?: boolean;
  handleHint?: {
    rightAtEnd?: string;
    leftSingle?: string;
    leftAtFirst?: string;
  };
};

function setup({
  chip,
  resolveColumnAt,
  resolveColumnBox,
  box,
  builtColumnSet,
  builtMinCol = 0,
  builtMaxCol = 4,
  canExtendRight = true,
  handleHint,
}: Setup = {}) {
  const commitSpy = vi.fn();
  const clickSpy = vi.fn();
  // dragStartGuard 放行探针：gestureRef 悬空时它才会被调（edge「陈旧手势永久阻塞
  // 拖拽」回归锚）。
  const dragStartSpy = vi.fn();
  const utils = render(
    <WorkbenchChip
      chip={chip ?? chipData()}
      onSceneClick={clickSpy}
      selectedNodeId={null}
      onSceneDragStart={(id) => {
        dragStartSpy(id);
        return () => {};
      }}
      onResizeSpanRange={commitSpy}
      resolveColumnAt={resolveColumnAt}
      resolveColumnBox={resolveColumnBox}
      box={box}
      builtColumnSet={builtColumnSet}
      builtMinCol={builtMinCol}
      builtMaxCol={builtMaxCol}
      canExtendRight={canExtendRight}
      handleHint={handleHint}
    />
  );
  return { commitSpy, clickSpy, dragStartSpy, ...utils };
}

/**
 * jsdom（本仓版本）无 window.PointerEvent——testing-library 的 fireEvent.pointer*
 * 只能产普通 Event，init 里的 clientX 全部丢失（probe 实证）。本文件用原生
 * MouseEvent 直派发 pointer* 类型：React 委托根照样收单，nativeEvent 是真
 * MouseEvent → clientX 真值可达。pointerId 经 defineProperty 挂上（React 的
 * PointerEventInterface 含 pointerId，会从 nativeEvent 拷贝——多点触控配对用例）。
 * 直派发绕过了 RTL 的 act 包装——setPreview 的提交必须显式包 act 才能在断言前
 * flush（fireEvent 帮我们做的事这里补齐）。
 */
function firePointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  init: { clientX?: number; pointerId?: number } = {}
) {
  const evt = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...(init.clientX !== undefined ? { clientX: init.clientX } : {}),
  });
  if (init.pointerId !== undefined) {
    Object.defineProperty(evt, 'pointerId', { value: init.pointerId });
  }
  act(() => {
    el.dispatchEvent(evt);
  });
}

/** dragStart 最小 dataTransfer 桩（dragStartGuard 路径不消费其内容）。 */
const stubDataTransfer = {
  setData: () => {},
  getData: () => '',
} as unknown as DataTransfer;

describe('WorkbenchChip edge handles (R6 方案 D)', () => {
  afterEach(() => cleanup());

  it('把手渲染规则（T11 恒渲染）：宽卡两缘皆活、单章左缘在场但置灰；无提交缝零把手', () => {
    const wide = setup({
      chip: chipData({ colStart: 1, colEnd: 3 }),
    });
    const wideLeft = wide.container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    const wideRight = wide.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(wideLeft).not.toBeNull();
    expect(wideRight).not.toBeNull();
    // 宽卡（下一章 4 在 builtMaxCol 内且跨章）两缘皆活。
    expect(wideLeft.classList.contains('workbench-chip-handle--disabled')).toBe(false);
    expect(wideLeft.getAttribute('data-disabled')).toBe('false');
    expect(wideRight.classList.contains('workbench-chip-handle--disabled')).toBe(false);

    // 单章卡：左缘恒渲染但置灰（首章稳定原则——T11 前是吞把手）；右缘可扩仍活。
    const single = setup({ chip: chipData({ colStart: 1, colEnd: 1 }) });
    const singleLeft = single.container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    expect(singleLeft).not.toBeNull();
    expect(singleLeft.classList.contains('workbench-chip-handle--disabled')).toBe(true);
    expect(singleLeft.getAttribute('data-disabled')).toBe('true');
    expect(
      single.container.querySelector('[data-resize-edge="right"]')!.classList.contains('workbench-chip-handle--disabled')
    ).toBe(false);

    // 无提交缝（孤立形态）→ 零把手。
    const inert = render(
      <WorkbenchChip chip={chipData()} canExtendRight />
    );
    expect(inert.container.querySelector('.workbench-chip-handle')).toBeNull();
  });

  it('T11 边界 tooltip：末章单章右缘置灰+说明；宽卡贴左缘只挂说明不置灰', () => {
    const hint = {
      rightAtEnd: '右缘已是最后已建章',
      leftSingle: '单章卡左缘不参与',
      leftAtFirst: '左缘已是首章',
    };
    // 末章单章卡（colEnd=4=builtMaxCol 且 canExtendRight=false）：右把手置灰 + title。
    const last = setup({ chip: chipData({ colStart: 4, colEnd: 4 }), canExtendRight: false, handleHint: hint });
    const lastRight = last.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    expect(lastRight.classList.contains('workbench-chip-handle--disabled')).toBe(true);
    expect(lastRight.getAttribute('data-disabled')).toBe('true');
    expect(lastRight.getAttribute('title')).toBe('右缘已是最后已建章');
    const lastLeft = last.container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    expect(lastLeft.getAttribute('title')).toBe('单章卡左缘不参与');

    // 宽卡贴左缘（colStart=0=builtMinCol）：左把手**活**（收起点仍可），title=贴边说明。
    const wide = setup({ chip: chipData({ colStart: 0, colEnd: 2 }), handleHint: hint });
    const wideLeft = wide.container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    expect(wideLeft.classList.contains('workbench-chip-handle--disabled')).toBe(false);
    expect(wideLeft.getAttribute('title')).toBe('左缘已是首章');

    // 对照：未贴边宽卡零 title；无 handleHint 时边界态也零 title（孤立形态）。
    const mid = setup({ chip: chipData({ colStart: 1, colEnd: 3 }), handleHint: hint });
    expect(mid.container.querySelector('[data-resize-edge="left"]')!.getAttribute('title')).toBeNull();
    const noHint = setup({ chip: chipData({ colStart: 0, colEnd: 2 }) });
    expect(noHint.container.querySelector('[data-resize-edge="left"]')!.getAttribute('title')).toBeNull();
  });

  it('T11 disabled 把手零手势：置灰左右缘 pointerdown/move/up 全程零预览零提交', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 4, colEnd: 4 }),
      canExtendRight: false,
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    // 置灰右把手（不可扩不可缩）——起手早退，无预览无提交。
    const right = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(right, 'pointerdown', { clientX: 400 });
    firePointer(right, 'pointermove', { clientX: 300 });
    firePointer(right, 'pointerup', { clientX: 300 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 置灰左把手（单章左缘不参与）——同款零手势。
    const left = container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    firePointer(left, 'pointerdown', { clientX: 400 });
    firePointer(left, 'pointermove', { clientX: 300 });
    firePointer(left, 'pointerup', { clientX: 300 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it('右缘拖过列界 → up 时恰一次提交 [start..target]；预览属性全程可见后清除', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    // move 只做预览（零提交），root 挂预览态类 + 数据属性。
    expect(commitSpy).not.toHaveBeenCalled();
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.getAttribute('data-resizing')).toBe('true');
    expect(root.getAttribute('data-resize-start')).toBe('1');
    expect(root.getAttribute('data-resize-end')).toBe('2');
    expect(root.classList.contains('workbench-chip--resizing')).toBe(true);

    firePointer(handle, 'pointerup', { clientX: 300 });
    expect(commitSpy).toHaveBeenCalledTimes(1); // 一次手势一次写
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 2);
    expect(root.getAttribute('data-resizing')).toBe('false');
    expect(root.classList.contains('workbench-chip--resizing')).toBe(false);
  });

  it('AC9 一步恢复路径：跨章卡右缘左拖收终点，单 write 收敛区间', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 0, colEnd: 2 }),
      resolveColumnAt: resolverByX({ 120: 1 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 400 });
    firePointer(handle, 'pointermove', { clientX: 120 }); // 终点从 2 收到 1
    firePointer(handle, 'pointerup', { clientX: 120 });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 0, 1);
  });

  it('多章卡左缘调起点（收/扩双向），end 锚不动', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 3 }),
      resolveColumnAt: resolverByX({ 60: 0, 500: 4 }),
    });
    const handle = container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 90 });
    firePointer(handle, 'pointermove', { clientX: 60 }); // 起点 1 → 0（扩）
    firePointer(handle, 'pointerup');
    expect(commitSpy).toHaveBeenCalledWith('s1', 0, 3);
    commitSpy.mockClear();

    firePointer(handle, 'pointerdown', { clientX: 90 });
    firePointer(handle, 'pointermove', { clientX: 500 }); // 越过 end → 钳到 end=3
    firePointer(handle, 'pointerup');
    expect(commitSpy).toHaveBeenCalledWith('s1', 3, 3); // ≤ end 约束（此处等值仍合法）
  });

  it('解析失败（null）保持上一预览；拖回等区间再抬手 → 照发提交缝（等值判定归模型层 no-op）', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 100: null, 150: 1, 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 90 });
    // 无效解析：无预览、零提交前提（手势还在进行）。
    firePointer(handle, 'pointermove', { clientX: 100 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 有效解析 → 预览出现；再次无效解析 → 保持上一预览（不误清、不误提交）。
    firePointer(handle, 'pointermove', { clientX: 300 });
    expect(root.getAttribute('data-resize-end')).toBe('2');
    firePointer(handle, 'pointermove', { clientX: 100 }); // 未映射——保持
    expect(root.getAttribute('data-resize-end')).toBe('2');
    // 拖回原区间后抬手：等值也照发（CR3 edge——chip 侧 colStart/colEnd 在手势中
    // 可能被其他写者改陈旧，本地等值比较会吞掉真变更）；零写入由模型层引用级
    // no-op 兜底（sceneGraphEditModel 测试域），「一次手势一次写」仍是恰一次调用。
    firePointer(handle, 'pointermove', { clientX: 150 });
    expect(root.getAttribute('data-resize-end')).toBe('1');
    firePointer(handle, 'pointerup');
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 1);
  });

  it('resize 提交后的尾随 click 被吞（不开抽屉）；常规 click 照常选中', () => {
    const { container, commitSpy, clickSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    firePointer(handle, 'pointerup');
    expect(commitSpy).toHaveBeenCalledTimes(1);
    fireEvent.click(root); // 引擎在 pointerup 后合成的尾随 click
    expect(clickSpy).not.toHaveBeenCalled();

    // 对照组：未参与手势的常规点击照常上报（吞旗标只吃一发）。
    fireEvent.click(root);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('右缘超出 builtMaxCol 的解析列在预览端钳制（提交层还有二次校验）', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 999: 42 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 10 });
    firePointer(handle, 'pointermove', { clientX: 999 });
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.getAttribute('data-resize-end')).toBe('4'); // builtMaxCol
    firePointer(handle, 'pointerup');
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CR3 G 域 patch 批：预览 gap 门槛（G-F3）/ 多点触控配对（G-F6）/ 吞旗标宏任务
// 边界（G-F7）/ pointercancel 收敛（blind G-F9）/ window 兜底收手（edge）
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkbenchChip gesture hardening (CR3 patch batch)', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('G-F3 gap 门槛：解析列未建（gap 轨）不产预览、拖回 gap 保持上一预览——抬手所见即所写', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 0, colEnd: 0 }),
      resolveColumnAt: resolverByX({ 130: 1, 250: 2 }), // 列 1 = gap（不在 built 集）
      builtColumnSet: new Set([0, 2, 3, 4]),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 60 });
    // gap 轨 1：预览零出现（不再谎称扩到未建章——旧钳制域只看 min/max 会照常渲染）。
    firePointer(handle, 'pointermove', { clientX: 130 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 已建列 2：预览出现。
    firePointer(handle, 'pointermove', { clientX: 250 });
    expect(root.getAttribute('data-resize-end')).toBe('2');
    // 拖回 gap 轨：保持上一预览（= 钉在最近已建列，同「解析失败保持上一预览」语义）。
    firePointer(handle, 'pointermove', { clientX: 130 });
    expect(root.getAttribute('data-resize-end')).toBe('2');
    // 抬手提交 = 预览所承诺的最近已建列（不再有「全程有预览、抬手零效果」死手势）。
    firePointer(handle, 'pointerup', { clientX: 130 });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 0, 2);
  });

  it('G-F3 对照：未传 builtColumnSet（稠密缺省）时 gap 位照常预览（旧接线形态兼容）', () => {
    const { container } = setup({
      chip: chipData({ colStart: 0, colEnd: 0 }),
      resolveColumnAt: resolverByX({ 130: 1 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 60 });
    firePointer(handle, 'pointermove', { clientX: 130 });
    expect(root.getAttribute('data-resize-end')).toBe('1');
  });

  it('G-F9 pointercancel：零提交、预览即清、手势不悬挂（dragstart 放行 + 新手势照常）', () => {
    const { container, commitSpy, dragStartSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    expect(root.getAttribute('data-resizing')).toBe('true');
    firePointer(handle, 'pointercancel');
    expect(commitSpy).not.toHaveBeenCalled(); // 中断不提交
    expect(root.getAttribute('data-resizing')).toBe('false'); // 预览即清
    // 手势确已收手：gestureRef 空 → dragStartGuard 不再 preventDefault（卡体拖拽放行）。
    fireEvent.dragStart(root, { dataTransfer: stubDataTransfer });
    expect(dragStartSpy).toHaveBeenCalledWith('s1');
    // 可再起新手势并正常提交（无永久阻塞 / 无残留旗标卡死）。
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    firePointer(handle, 'pointerup', { clientX: 300 });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 2);
  });

  it('G-F7 吞旗标只武装到宏任务边界：cancel 后无尾随 click → 定时器 disarm，下一次真实点击不被误吞', () => {
    vi.useFakeTimers();
    const { container, clickSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    // pointercancel：通常无 click 跟随——旧实现旗标悬空，下一次真实点击被吞一次。
    firePointer(handle, 'pointercancel');
    act(() => {
      vi.advanceTimersByTime(1); // 宏任务边界（真实机 = 下一个 task）
    });
    fireEvent.click(root);
    expect(clickSpy).toHaveBeenCalledTimes(1); // 不被悬空旗标误吞（G-F7 回归锚）
  });

  it('edge capture 失败/窗外 up：window 兜底收手——零提交、手势不悬挂、可再起手势', () => {
    const { container, commitSpy, dragStartSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    expect(root.getAttribute('data-resizing')).toBe('true');
    // capture 失败形态：up 不落把手元素（打在卡体上）——冒泡末站 window 兜底收手。
    firePointer(root, 'pointerup', { clientX: 300 });
    expect(commitSpy).not.toHaveBeenCalled(); // 兜底 = cancel 语义（capture 失败下落点不可信）
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 手势不悬挂：dragStartGuard 放行（陈旧 gestureRef 会永久卡死卡体拖拽——edge 回归锚）。
    fireEvent.dragStart(root, { dataTransfer: stubDataTransfer });
    expect(dragStartSpy).toHaveBeenCalledWith('s1');
    // 新手势照常（含提交）。
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    firePointer(handle, 'pointerup', { clientX: 300 });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 2);
  });

  it('G-F6 双把手多点触控：第二指针不覆盖进行中手势——move/up 只认配对指针', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 3 }),
      resolveColumnAt: resolverByX({ 60: 0, 300: 2, 500: 4 }),
    });
    const left = container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    const right = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    // 指针 1 在左把手起手（edge=left）。
    firePointer(left, 'pointerdown', { clientX: 90, pointerId: 1 });
    // 指针 2 按右把手：后入不抢槽（旧实现会覆写 edge 成 right）。
    firePointer(right, 'pointerdown', { clientX: 400, pointerId: 2 });
    // 指针 2 的 move（若劫持手势：right 语义 end 收成 2）——预览必须零出现。
    firePointer(right, 'pointermove', { clientX: 300, pointerId: 2 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 指针 1 的 move 才写预览（left 语义：start 收到 0、end 锚不动）。
    firePointer(left, 'pointermove', { clientX: 60, pointerId: 1 });
    expect(root.getAttribute('data-resize-start')).toBe('0');
    expect(root.getAttribute('data-resize-end')).toBe('3');
    // 指针 2 先抬：非配对 up 不收手（预览仍在）。
    firePointer(right, 'pointerup', { clientX: 400, pointerId: 2 });
    expect(root.getAttribute('data-resizing')).toBe('true');
    // 配对指针 1 抬手 → 按 left 手势恰一次提交 [0..3]。
    firePointer(left, 'pointerup', { clientX: 60, pointerId: 1 });
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith('s1', 0, 3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T14（发现批6·真机红）：拖拽准入全死 + 标号不更新——手势单例中断矩阵。
//
// 真机序列（用户）：ch1 卡挪 ch0 成功后，部分卡「不能拖动」、部分能动——
// 定位 = WorkbenchChip 的 gestureRef 单例在「收尾事件永不到达」的中断路径上悬空
// （dragStartGuard 对被卡卡的每次拖拽起手 preventDefault；HTML5 拖拽起手会抑制
// 后续 pointer 事件，失败尝试自身不再产生可自愈的 up——死亡循环）。本组钉三类
// 中断面的收尾义务：window blur（Alt+Tab 持键切走、他处松开）、他位落指（鼠标
// 单指针下新 pointerdown ⇒ 本手势 up 已丢）、pending 中途翻转（endResize 旧早退
// 把手势整个卡死）。每例的判据 = dragStartSpy 被调（gestureRef 已清 → 起手放行）。
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkbenchChip gesture interrupt matrix (T14)', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * 起一个带预览的进行中手势（down+move 到列 2），并 flush 微任务边界
   * （selfDown 自取消守卫在起手事件的微任务后放行——真机 = 起手派发任务结束）。
   */
  async function beginLiveGesture(utils: ReturnType<typeof setup>) {
    const handle = utils.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    await Promise.resolve(); // 微任务边界（selfDown 守卫窗关闭）
    const root = utils.container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.getAttribute('data-resizing')).toBe('true');
    return { handle, root };
  }

  /** 断言卡体拖拽起手放行（gestureRef 已清——被卡时 dragStartGuard preventDefault）。 */
  function expectDragStartReleased(utils: ReturnType<typeof setup>, root: HTMLElement) {
    fireEvent.dragStart(root, { dataTransfer: stubDataTransfer });
    expect(utils.dragStartSpy).toHaveBeenCalledWith('s1');
  }

  it('T14-blur：手势进行中窗口失焦（Alt+Tab 他处松开）→ 手势取消，拖拽起手放行', async () => {
    const utils = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const { root } = await beginLiveGesture(utils);
    // 窗口失焦 = 释放事件永不到达本窗口（真机中断形态——jsdom 以 window blur 近似）。
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(root.getAttribute('data-resizing')).toBe('false');
    expect(utils.commitSpy).not.toHaveBeenCalled(); // 中断面恒 cancel 语义
    expectDragStartReleased(utils, root);
    // 收尾后新手势照常提交（无残留监听/旗标）。
    const handle = utils.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    firePointer(handle, 'pointerup', { clientX: 300 });
    expect(utils.commitSpy).toHaveBeenCalledTimes(1);
    expect(utils.commitSpy).toHaveBeenCalledWith('s1', 1, 2);
  });

  it('T14-foreign-down：他位落指（卡体上的新 pointerdown = 拖拽尝试起手）→ 陈旧手势自愈放行', async () => {
    const utils = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const { root } = await beginLiveGesture(utils);
    // 真机 doom loop 复刻：up 已丢（窗外释放）后，用户转而拖这张卡——起手的
    // pointerdown 落在卡体（非把手）——此缝必须先行收手，否则手势吞掉整次拖拽。
    firePointer(root, 'pointerdown', { clientX: 150, pointerId: 9 });
    expect(root.getAttribute('data-resizing')).toBe('false');
    expect(utils.commitSpy).not.toHaveBeenCalled();
    expectDragStartReleased(utils, root);
  });

  it('T14-self-down 豁免：起手 pointerdown 自身的 window 冒泡末站不触发自取消（手势存活）', async () => {
    const utils = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
    });
    const handle = utils.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = utils.container.querySelector('.workbench-chip') as HTMLElement;
    // down 后微任务边界内（selfDown 守卫窗）同事件已越过 window——手势必须存活。
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    expect(root.getAttribute('data-resizing')).toBe('true');
    // 把手上的他指落指（G-F6 双把手形态）同样不作陈旧信号：第一指针手势存活。
    const left = utils.container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    firePointer(left, 'pointerdown', { clientX: 90, pointerId: 2 });
    expect(root.getAttribute('data-resizing')).toBe('true');
    // 正常收尾路径不受影响。
    firePointer(handle, 'pointerup', { clientX: 300 });
    expect(utils.commitSpy).toHaveBeenCalledTimes(1);
    expect(utils.commitSpy).toHaveBeenCalledWith('s1', 1, 2);
  });

  it('T14-pending-flip：手势中 pending 翻转 → up 仍收手不提交；翻回后拖拽起手放行（旧早退卡死回归锚）', () => {
    const commitSpy = vi.fn();
    const dragStartSpy = vi.fn();
    const baseChip = chipData({ colStart: 1, colEnd: 1 });
    const pendingChip = {
      nodeId: 's1',
      lineId: 'l_main',
      role: 'normal' as const,
      title: '普通场景',
      readIndex: 0,
      pending: true as const,
    };
    const props = {
      chip: baseChip,
      onSceneClick: vi.fn(),
      selectedNodeId: null as string | null,
      onSceneDragStart: (id: string) => {
        dragStartSpy(id);
        return () => {};
      },
      onResizeSpanRange: commitSpy,
      resolveColumnAt: resolverByX({ 300: 2 }),
      builtMinCol: 0,
      builtMaxCol: 4,
      canExtendRight: true,
    };
    const utils = render(<WorkbenchChip {...props} />);
    const handle = utils.container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    const root = utils.container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.getAttribute('data-resizing')).toBe('true');
    // 手势进行中节点翻成 pending（章语义消失）——把手卸载但组件实例存活，
    // window 兜底监听仍在。
    utils.rerender(<WorkbenchChip {...props} chip={pendingChip} />);
    act(() => {
      window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    // 收手不提交（pending = 无章语义可写）；预览即清。
    expect(commitSpy).not.toHaveBeenCalled();
    expect(root.getAttribute('data-resizing')).toBe('false');
    // 翻回非 pending 后：dragStartGuard 放行（旧实现 `!st || pending` 早退把
    // gestureRef 永久卡死——本断言即红测）。
    utils.rerender(<WorkbenchChip {...props} chip={baseChip} />);
    fireEvent.dragStart(root, { dataTransfer: stubDataTransfer });
    expect(dragStartSpy).toHaveBeenCalledWith('s1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T15（发现批7·用户拍板 UX 升级）：边缘直拖 resize 手势进行中，chip 格跨**实时
// 跟随**——拖到第 2 格即占 2 格宽、第 3 格即占 3 格；旧形态只画虚线轮廓不动完宽。
//
// 冻结契约（见 WorkbenchChip resolveColumnBox / ResizePreviewBox 注）：
//  - 手势期卡体脱流抬升（`--resizing` 类 absolute，CSS 面）+ 实测列盒驱动 inline 宽
//    （width = [start.left..end.right] 跨列盒宽；margin-left = 起始列对归属列平移差
//    ——左缘拖动时卡体随起点平移）；212px 上界手势期解除（maxWidth 'none'）；
//  - 几何 seam（resolveColumnBox）不可用 → box=null → 预览退回纯虚线轮廓形态
//    （旧观感零断裂——上文全部既有用例不传该 prop，即天然覆盖回退分支）；
//  - 抬手随预览清除一并回退（width/margin-left/maxWidth 复位）。
// ─────────────────────────────────────────────────────────────────────────────

/** fake 列盒：列 c 左缘 = 100 + c*120、宽 120（与 chapterWorkbench 注入表同款口径）。 */
const COL_LEFT = 100;
const COL_W = 120;
const colBoxAt = (c: number) => ({ left: COL_LEFT + c * COL_W, right: COL_LEFT + (c + 1) * COL_W });

describe('WorkbenchChip live-widen preview (T15)', () => {
  afterEach(() => cleanup());

  it('右拖至第 2 格 → 卡体实时 2 格宽（width/margin-left 内联）；拖回 1 格回 1 格；抬手复位', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 150: 1, 300: 2, 420: 3 }),
      resolveColumnBox: colBoxAt,
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    // 拖到第 2 格（预览 [1..2]）：width = col2.right − col1.left = 460−220 = 240px
    // （= 2 格 × 120）；起点未动 → margin-left 0；212 上界解除。
    firePointer(handle, 'pointermove', { clientX: 300 });
    expect(root.style.width).toBe('240px');
    expect(root.style.marginLeft).toBe('0px');
    expect(root.style.maxWidth).toBe('none');
    // 再拖到第 3 格（预览 [1..3]）：3 格宽。
    firePointer(handle, 'pointermove', { clientX: 420 });
    expect(root.style.width).toBe('360px');
    // 拖回 1 格（预览 [1..1]）：回单格宽（用户拍板「实时跟随」的双向义）。
    firePointer(handle, 'pointermove', { clientX: 150 });
    expect(root.style.width).toBe('120px');
    // 抬手：提交 + 预览盒即清（width 复位、maxWidth 回 212 静止态锚）。
    firePointer(handle, 'pointerup', { clientX: 150 });
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 1);
    expect(root.style.width).toBe('');
    expect(root.style.maxWidth).toBe('212px');
  });

  it('左缘拖动跨列平移：宽卡左把手拖到更早列 → margin-left 负平移 + 盒宽按新区间', () => {
    const { container } = setup({
      chip: chipData({ colStart: 1, colEnd: 3 }),
      resolveColumnAt: resolverByX({ 60: 0 }),
      resolveColumnBox: colBoxAt,
    });
    const handle = container.querySelector('[data-resize-edge="left"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 90 });
    // 起点 1 → 0（扩）：margin-left = col0.left − col1.left = 100−220 = −120px；
    // width = [col0.left..col3.right] = 580−100 = 480px（4 格跨）。
    firePointer(handle, 'pointermove', { clientX: 60 });
    expect(root.style.marginLeft).toBe('-120px');
    expect(root.style.width).toBe('480px');
    // 收手即清预览盒（cancel 语义同款）——T23 起静止态宽卡 = 装填盒（孤立测试
    // 未传 box → 非装填 in-flow 形态）：width 复位内容宽（''）、marginLeft 归零；
    // 延伸带已随 T23 退役（负断言）。
    firePointer(handle, 'pointercancel');
    expect(root.style.width).toBe('');
    expect(root.querySelector('.workbench-chip-span-band')).toBeNull();
    expect(root.style.marginLeft).toBe('');
  });

  it('几何 seam 不可用 → 预览退回纯虚线轮廓形态（零 inline 盒，旧观感零断裂）', () => {
    const { container } = setup({
      chip: chipData({ colStart: 1, colEnd: 1 }),
      resolveColumnAt: resolverByX({ 300: 2 }),
      // 不传 resolveColumnBox（jsdom 零 rect / 未接线形态同款）。
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 200 });
    firePointer(handle, 'pointermove', { clientX: 300 });
    // 预览态照常（类名 + data 属性），但零 inline 变宽——回退分支与既有用例兼容。
    expect(root.classList.contains('workbench-chip--resizing')).toBe(true);
    expect(root.getAttribute('data-resize-end')).toBe('2');
    expect(root.style.width).toBe('');
    expect(root.style.maxWidth).toBe('212px');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T23（发现批10·用户三段拍板终案）：跨 N 章的卡 = 一张真正的横长方形横跨覆盖列
// ——线行内 chip 绝对定位消费装填盒（workbenchPacking 阅读序 first-fit 天际线，
// ChapterWorkbench 注入 box prop）。v2 延伸带（span-band）整体退役删除。冻结
// 契约：
//  - box 在场 = 装填形态：--packed 类 + inline left/top/width（跨列盒宽）+
//    maxWidth none；height 仅实测帧带上（估算帧内容自撑——「完全显示」托底）；
//  - 手势期预览盒与装填坐标共存：width/margin-left 走预览、left/top/height
//    静止沿用（高度随装填高走）；抬手复位到装填盒；
//  - 无 box（待编排灰片 / 孤立测试）= 既有 in-flow 形态（212 上界、无 inline
//    宽）——pending 消费面零扰动。
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkbenchChip packed box (T23)', () => {
  afterEach(() => cleanup());

  it('估算帧装填形态：--packed 类 + left/top/width inline + maxWidth none；无 height（内容自撑）', () => {
    const { container } = setup({
      chip: chipData({ colStart: 1, colEnd: 2 }),
      resolveColumnBox: colBoxAt,
      box: { left: 0, top: 30.4, width: 240 },
    });
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.classList.contains('workbench-chip--packed')).toBe(true);
    expect(root.classList.contains('workbench-chip--span')).toBe(true); // 选择器锚保留
    expect(root.style.left).toBe('0px');
    expect(root.style.top).toBe('30.4px');
    expect(root.style.width).toBe('240px'); // 跨列盒宽（跨 2 章 = 2×120）
    expect(root.style.maxWidth).toBe('none');
    expect(root.style.height).toBe(''); // 估算帧不钉高——文字完全显示由内容自撑
  });

  it('实测帧：height 内联钉装填高（两遍法收敛态）', () => {
    const { container } = setup({
      chip: chipData({ colStart: 1, colEnd: 2 }),
      resolveColumnBox: colBoxAt,
      box: { left: 0, top: 2.4, width: 240, height: 40 },
    });
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.style.height).toBe('40px');
    expect(root.style.width).toBe('240px');
  });

  it('v2 延伸带退役：任何形态零 .workbench-chip-span-band；无 box 的 span chip 保持 in-flow（212 上界、零 inline 宽、无 --packed）', () => {
    const { container } = setup({
      chip: chipData({ colStart: 1, colEnd: 3 }),
      resolveColumnBox: colBoxAt, // 几何 seam 可用也不复活带——形态本体退役
    });
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    expect(root.querySelector('.workbench-chip-span-band')).toBeNull();
    expect(root.classList.contains('workbench-chip--span')).toBe(true);
    expect(root.classList.contains('workbench-chip--packed')).toBe(false);
    expect(root.style.width).toBe('');
    expect(root.style.maxWidth).toBe('212px');
  });

  it('手势期预览盒与装填坐标共存：width/margin-left 走预览、left/top/height 静止；抬手回装填盒', () => {
    const { container, commitSpy } = setup({
      chip: chipData({ colStart: 1, colEnd: 2 }),
      resolveColumnAt: resolverByX({ 500: 4 }),
      resolveColumnBox: colBoxAt,
      box: { left: 0, top: 12, width: 240, height: 26 },
    });
    const handle = container.querySelector('[data-resize-edge="right"]') as HTMLElement;
    const root = container.querySelector('.workbench-chip') as HTMLElement;
    firePointer(handle, 'pointerdown', { clientX: 400 });
    firePointer(handle, 'pointermove', { clientX: 500 });
    // 预览 [1..4]：width = col4.right − col1.left = 700−220 = 480px（4 格跨）；
    // 装填坐标静止——手势不动纵向位，高度随装填高走（T23）。
    expect(root.style.width).toBe('480px');
    expect(root.style.marginLeft).toBe('0px');
    expect(root.style.top).toBe('12px');
    expect(root.style.height).toBe('26px');
    expect(root.style.maxWidth).toBe('none');
    firePointer(handle, 'pointerup', { clientX: 500 });
    expect(commitSpy).toHaveBeenCalledWith('s1', 1, 4);
    // 抬手复位到装填盒（预览盒清除）：width 回跨列盒 240px、margin-left 清、
    // left/top/height 保持静止值。
    expect(root.style.width).toBe('240px');
    expect(root.style.marginLeft).toBe('');
    expect(root.style.top).toBe('12px');
    expect(root.style.height).toBe('26px');
    expect(root.style.maxWidth).toBe('none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T26（发现批10·多线实例三合一）：同 nodeId 每线一枚 chip 实例（多线投影）。
// 用户定谳事实：提交时全实例同步 ✓（updateField 单写通道）——缺陷在手势期预览
// 只在被拖实例显示（旧 T15 预览=本地 state，兄弟不知情）。冻结契约：
//  - ① 预览值发布到按 nodeId 键的轻量 mini-store（nodeSharedState，不进 app
//    store，通知粒度=该 nodeId 订阅实例）——兄弟实例照画同款实时值盒（--resizing
//    类 + data-resize-* + inline 盒；几何 seam 各自注入换算）；抬手/取消清共享键
//    兄弟随订阅回落；提交仍只从被拖实例（一次手势一次写）。
//  - ② 悬停任一实例 → 全 nodeId 实例柔光类（含悬停者自身——CSS :not(:hover) 退
//    让）；多线圆号双环类（数据面 chip.multiline）。
// ─────────────────────────────────────────────────────────────────────────────

describe('WorkbenchChip sibling sync (T26)', () => {
  afterEach(() => {
    cleanup();
    __resetNodeSharedStateForTests();
  });

  /** 同 node 两线双实例：A=主线（手势承载者），B=副线（兄弟观察者）。 */
  function renderSiblings() {
    const commitA = vi.fn();
    const commitB = vi.fn();
    const utils = render(
      <>
        <WorkbenchChip
          chip={chipData({ nodeId: 's_multi', lineId: 'l_main', colStart: 1, colEnd: 1, multiline: true })}
          onResizeSpanRange={commitA}
          resolveColumnAt={resolverByX({ 300: 2 })}
          resolveColumnBox={colBoxAt}
          /* 单章卡右缘可扩（canExtendRight 缺省 false = 置灰零手势——T11 纪律）。 */
          canExtendRight
        />
        <WorkbenchChip
          chip={chipData({ nodeId: 's_multi', lineId: 'l_side', colStart: 1, colEnd: 1, multiline: true })}
          onResizeSpanRange={commitB}
          resolveColumnAt={resolverByX({ 300: 2 })}
          resolveColumnBox={colBoxAt}
          canExtendRight
        />
      </>
    );
    const roots = [...utils.container.querySelectorAll('.workbench-chip')] as HTMLElement[];
    const a = roots.find((r) => r.getAttribute('data-line-id') === 'l_main')!;
    const b = roots.find((r) => r.getAttribute('data-line-id') === 'l_side')!;
    return { commitA, commitB, a, b, ...utils };
  }

  it('T26 ①：A 拖宽 → 兄弟 B 同步画同款实时值盒（类 + data 属性 + inline 盒值逐位一致）', () => {
    const { a, b, commitA, commitB } = renderSiblings();
    const handleA = a.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handleA, 'pointerdown', { clientX: 200 });
    firePointer(handleA, 'pointermove', { clientX: 300 }); // 预览 [1..2]（2 格）
    // B 无手势状态也照画（吃的是共享值）——旧实现 B 全程静止即用户报的缺陷。
    expect(b.classList.contains('workbench-chip--resizing')).toBe(true);
    expect(b.getAttribute('data-resizing')).toBe('true');
    expect(b.getAttribute('data-resize-start')).toBe('1');
    expect(b.getAttribute('data-resize-end')).toBe('2');
    // 像素盒由 B 自己的视图 resolver 换算，同列几何 → 同值（width=col2.right−col1.left=240）。
    expect(b.style.width).toBe('240px');
    expect(b.style.marginLeft).toBe('0px');
    expect(a.style.width).toBe('240px');
    // 手势归属不变：move 期零提交（两端皆然）。
    expect(commitA).not.toHaveBeenCalled();
    expect(commitB).not.toHaveBeenCalled();
    firePointer(handleA, 'pointerup', { clientX: 300 });
    // 提交只从被拖实例 A 一次（一次手势一次写）；B 零提交。
    expect(commitA).toHaveBeenCalledTimes(1);
    expect(commitA).toHaveBeenCalledWith('s_multi', 1, 2);
    expect(commitB).not.toHaveBeenCalled();
    // 抬手清共享键 → B 随订阅回落（预览类/属性/inline 盒全清）。
    expect(b.classList.contains('workbench-chip--resizing')).toBe(false);
    expect(b.getAttribute('data-resizing')).toBe('false');
    expect(b.style.width).toBe('');
    expect(a.style.width).toBe('');
  });

  it('T26 ①：cancel 语义同款清共享键（兄弟不留残影）；A 卸载于手势中亦清（防永久卡死）', () => {
    const { a, b, commitA } = renderSiblings();
    const handleA = a.querySelector('[data-resize-edge="right"]') as HTMLElement;
    firePointer(handleA, 'pointerdown', { clientX: 200 });
    firePointer(handleA, 'pointermove', { clientX: 300 });
    expect(b.getAttribute('data-resizing')).toBe('true');
    firePointer(handleA, 'pointercancel');
    expect(commitA).not.toHaveBeenCalled();
    expect(b.getAttribute('data-resizing')).toBe('false'); // 兄弟同步回落
    // 手势拥有者中途卸载：gestureRef 非空 = 发布者——共享键随葬（B 不永久卡预览）。
    firePointer(handleA, 'pointerdown', { clientX: 200 });
    firePointer(handleA, 'pointermove', { clientX: 300 });
    expect(b.getAttribute('data-resizing')).toBe('true');
    cleanup(); // 卸载全部实例（B 同卸——以 B 重建观察共享键已清）。
    const commitC = vi.fn();
    const again = render(
      <WorkbenchChip
        chip={chipData({ nodeId: 's_multi', lineId: 'l_side', colStart: 1, colEnd: 1 })}
        onResizeSpanRange={commitC}
      />
    );
    const againRoot = again.container.querySelector('.workbench-chip') as HTMLElement;
    expect(againRoot.getAttribute('data-resizing')).toBe('false'); // 无陈旧共享预览复活
  });

  it('T26 ②：悬停 A → A/B 同 nodeId 全实例柔光；移开全清；非同 node 不受牵连', () => {
    const { a, b } = renderSiblings();
    fireEvent.mouseOver(a);
    expect(a.classList.contains('workbench-chip--sibling-lit')).toBe(true); // 悬停者自身也命中（CSS :not(:hover) 退让）
    expect(b.classList.contains('workbench-chip--sibling-lit')).toBe(true);
    const other = render(
      <WorkbenchChip chip={chipData({ nodeId: 's_other', lineId: 'l_side', colStart: 1, colEnd: 1 })} />
    );
    const otherRoot = other.container.querySelector('.workbench-chip') as HTMLElement;
    expect(otherRoot.classList.contains('workbench-chip--sibling-lit')).toBe(false);
    fireEvent.mouseOut(a);
    expect(a.classList.contains('workbench-chip--sibling-lit')).toBe(false);
    expect(b.classList.contains('workbench-chip--sibling-lit')).toBe(false);
    cleanup();
  });

  it('T26 ②：多线圆号双环 + data-multiline；单线场景负断言（无标记）', () => {
    const { a } = renderSiblings();
    expect(a.getAttribute('data-multiline')).toBe('true');
    expect(a.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(true);
    const single = render(
      <WorkbenchChip chip={chipData({ nodeId: 's_single', lineId: 'l_main', colStart: 1, colEnd: 1 })} />
    );
    const singleRoot = single.container.querySelector('.workbench-chip') as HTMLElement;
    expect(singleRoot.getAttribute('data-multiline')).toBe('false');
    expect(singleRoot.querySelector('.workbench-chip-ord')!.classList.contains('workbench-chip-ord--multiline')).toBe(false);
  });
});
