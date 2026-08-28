/**
 * dogfood R2 #27：两族 suggest 审阅卡（author_profile / setting_md）resolved map 的
 * localStorage 持久化。背景实录：#25 钉底后重启 app，resolved map（内存态）清空 →
 * 已应用过的「编辑笔记」卡重新钉底待决 → 再点接受 = 往作者档案**重复追加同一条**
 * （用户 14:03 应用 + 14:45 重启后重 accepting，档案双条，已手工去重）。
 *
 * 水合测试用 vi.resetModules + 动态 import 重建 appStore 模块图（slice 创建时读
 * storage）；写穿测试断言 storage.get 能读回 resolve 结果。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '../src/shared/store/storage';
import { useAppStore } from '../src/shared/store/appStore';

beforeEach(() => {
  localStorage.clear();
});

describe('resolved map 持久化（R2 #27）', () => {
  it('写穿：resolve 后 storage 能读回（重启前的落盘面）', () => {
    useAppStore.getState().resolveAuthorProfilePatch('author-profile:call-1', 'applied');
    useAppStore.getState().resolveSettingMdPatch('setting-md:call-2', 'rejected');
    expect(
      storage.get<Record<string, 'applied' | 'rejected'>>('resolvedAuthorProfilePatches', {})['author-profile:call-1'],
    ).toBe('applied');
    expect(
      storage.get<Record<string, 'applied' | 'rejected'>>('resolvedSettingMdPatches', {})['setting-md:call-2'],
    ).toBe('rejected');
  });

  it('水合：storage 预置 resolved → store 重建（= 重启）后初始 map 带上，已处理卡不复活', async () => {
    storage.set('resolvedAuthorProfilePatches', { 'author-profile:call-9': 'applied' });
    storage.set('resolvedSettingMdPatches', { 'setting-md:call-8': 'rejected' });
    vi.resetModules();
    const { useAppStore: fresh } = await import('../src/shared/store/appStore');
    expect(fresh.getState().resolvedAuthorProfilePatches['author-profile:call-9']).toBe('applied');
    expect(fresh.getState().resolvedSettingMdPatches['setting-md:call-8']).toBe('rejected');
  });

  it('水合安全面：storage 空 / 损坏 JSON → 初始 map 为空对象不抛（storage 助手 fail-soft）', async () => {
    localStorage.setItem('orison_resolvedAuthorProfilePatches', '{not json');
    vi.resetModules();
    const { useAppStore: fresh } = await import('../src/shared/store/appStore');
    expect(fresh.getState().resolvedAuthorProfilePatches).toEqual({});
  });
});
