import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  createEmptyProjectDocument,
  saveProject,
  subscribeProjectSaved,
  applyFieldPatches,
} from '../sync/localProjectRepository';
import { onFieldEdited, toggleFieldLock } from '../sync/fieldSyncBridge';

const TEST_PROJECT_DIR = path.join(process.cwd(), 'test-tmp-save-notify');

/**
 * dogfood R2 #77：saveProject 是 project.yaml 唯一写入口，落盘后须广播
 * （subscribeProjectSaved）——shell 据此推 outline:changed，renderer 收敛刷新。
 * 四条生产写路径（saveProject / onFieldEdited / applyFieldPatches(WithSkipped) /
 * toggleFieldLock）全走 saveProject，故都应恰好触发一次；退订后不再触发。
 */
describe('subscribeProjectSaved', () => {
  afterEach(() => {
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  it('saveProject 直接落盘 → 触发一次（resolved 路径）', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSaved(listener);
    try {
      saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Notify Test'));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(path.resolve(TEST_PROJECT_DIR));
      // 落盘本身不受广播影响。
      expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('onFieldEdited（UI 手编 / agent 工具共用链）→ 触发一次', () => {
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Field Edit Notify'));
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSaved(listener);
    try {
      onFieldEdited(TEST_PROJECT_DIR, 'world_setting', {
        premise: 'p', era: 'e', locations: [], rules: [], power_structures: [],
        taboos: [], visual_language: [], tone_rules: [], open_questions: [],
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(path.resolve(TEST_PROJECT_DIR));
    } finally {
      unsubscribe();
    }
  });

  it('applyFieldPatches（补丁卡接受 / agent patch 应用）→ 触发一次', () => {
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Patch Notify'));
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSaved(listener);
    try {
      applyFieldPatches(TEST_PROJECT_DIR, {
        runId: 'run_notify',
        createdAt: new Date().toISOString(),
        patches: [{
          field: 'world_setting',
          action: 'set',
          data: { premise: 'p', era: 'e', locations: [], rules: [], power_structures: [], taboos: [], visual_language: [], tone_rules: [], open_questions: [] },
          fieldVersion: 1,
          generatedBy: 'agent-notify',
        }],
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(path.resolve(TEST_PROJECT_DIR));
    } finally {
      unsubscribe();
    }
  });

  it('toggleFieldLock（字段锁翻转）→ 触发一次', () => {
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Lock Notify'));
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSaved(listener);
    try {
      toggleFieldLock(TEST_PROJECT_DIR, 'world_setting');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(path.resolve(TEST_PROJECT_DIR));
    } finally {
      unsubscribe();
    }
  });

  it('退订后不再触发', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProjectSaved(listener);
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Pre Unsub'));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Post Unsub'));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('listener 抛错不阻断落盘与其他订阅者（广播是旁路，不是写链一环）', () => {
    const bad = vi.fn(() => { throw new Error('listener blew up'); });
    const good = vi.fn();
    const unsubBad = subscribeProjectSaved(bad);
    const unsubGood = subscribeProjectSaved(good);
    try {
      expect(() =>
        saveProject(TEST_PROJECT_DIR, createEmptyProjectDocument('Resilient Notify'))
      ).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
      expect(existsSync(path.join(TEST_PROJECT_DIR, 'project.yaml'))).toBe(true);
    } finally {
      unsubBad();
      unsubGood();
    }
  });
});
