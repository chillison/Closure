import { describe, expect, it } from 'vitest';
import { useAppStore } from '../src/shared/store/appStore';
import { runProjectResets } from '../src/shared/store/resetRegistry';
import { insightDismissKey } from '../src/shared/store/insightInteractionSlice';

// ─────────────────────────────────────────────────────────────────────────────
// Story 3.7 WP1：insightInteractionSlice（design D3）——会话级 dismissed 集合 +
// 「应用并补充」draftPreset 预填。忽略 = 会话内隐藏（不持久化、无 ledger，3.3 决议）；
// registerProjectReset 切项目清空（spec ui/state-management 硬约束）。
// ─────────────────────────────────────────────────────────────────────────────

describe('Story 3.7 — insightDismissKey 身份键', () => {
  it('source + title + quote 拼接；同文本同议题 = 同键（跨面忽略共享的语义基础）', () => {
    expect(insightDismissKey('reader-audit', '动机未铺垫', '主角突然决定进城'))
      .toBe(insightDismissKey('reader-audit', '动机未铺垫', '主角突然决定进城'));
    // 任一分量不同 → 不同键。
    expect(insightDismissKey('structure', '动机未铺垫', '主角突然决定进城'))
      .not.toBe(insightDismissKey('reader-audit', '动机未铺垫', '主角突然决定进城'));
    expect(insightDismissKey('reader-audit', '另一个议题', '主角突然决定进城'))
      .not.toBe(insightDismissKey('reader-audit', '动机未铺垫', '主角突然决定进城'));
  });

  it('quote 缺省 → 空串后缀（无 grounding 的议题按 source+title 识别）', () => {
    expect(insightDismissKey('structure', 't', undefined)).toBe(insightDismissKey('structure', 't'));
    expect(insightDismissKey('structure', 't', undefined)).not.toBe(insightDismissKey('structure', 't', 'q'));
  });
});

describe('Story 3.7 — dismissed 忽略集合', () => {
  it('dismissInsight 记录键；isDismissed 语义 = dismissed[key] 查询', () => {
    useAppStore.setState({ dismissed: {} } as any);
    const key = insightDismissKey('structure', '议题 A');
    useAppStore.getState().dismissInsight(key);
    expect(useAppStore.getState().dismissed[key]).toBe(true);
  });

  it('clearAll 清空全部忽略记录（忽略 = 会话内隐藏，真解决由数据自然反映）', () => {
    useAppStore.setState({ dismissed: { a: true, b: true } } as any);
    useAppStore.getState().clearAll();
    expect(useAppStore.getState().dismissed).toEqual({});
  });
});

describe('Story 3.7 — draftPreset 应用并补充预填', () => {
  it('presetDraft 设置后 consumeDraft 返回并清空（一次性消费）', () => {
    useAppStore.setState({ draftPreset: null } as any);
    useAppStore.getState().presetDraft('请修复这条结构问题：X\n补充说明：');
    expect(useAppStore.getState().draftPreset).toBe('请修复这条结构问题：X\n补充说明：');

    expect(useAppStore.getState().consumeDraft()).toBe('请修复这条结构问题：X\n补充说明：');
    expect(useAppStore.getState().draftPreset).toBeNull();
    // 二次消费 → null（无重复注入）。
    expect(useAppStore.getState().consumeDraft()).toBeNull();
  });

  it('从未预填 → consumeDraft 返 null', () => {
    useAppStore.setState({ draftPreset: null } as any);
    expect(useAppStore.getState().consumeDraft()).toBeNull();
  });
});

describe('Story 3.7 — 项目切换重置（registerProjectReset）', () => {
  it('runProjectResets 清空 dismissed + draftPreset（旧项目忽略记录/预填不泄漏进新项目）', () => {
    useAppStore.setState({
      dismissed: { stale: true },
      draftPreset: '旧项目预填',
    } as any);
    runProjectResets();
    expect(useAppStore.getState().dismissed).toEqual({});
    expect(useAppStore.getState().draftPreset).toBeNull();
  });
});
