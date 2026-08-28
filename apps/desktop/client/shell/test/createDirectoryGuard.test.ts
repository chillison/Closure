/**
 * create-directory 父目录判定（dogfood 2026-08-20 拍板退役静默回退）：
 * 范围外手选必须显式拒绝并附允许根路径——覆盖用户明确选择而不告知是最恶劣行为。
 * resolveCreateParent 是纯函数（pathGuard 单源），此处直接对它做表驱动验证。
 */
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { initProjectsRoot, resolveCreateParent } from '../main/ipc/pathGuard';

describe('resolveCreateParent（create-directory 无静默回退）', () => {
  const testRoot = path.join(os.tmpdir(), 'closure-create-parent-test', 'Closure');

  beforeEach(() => {
    initProjectsRoot(path.dirname(testRoot));
  });

  it('未提供父目录 → 默认项目根', () => {
    const r = resolveCreateParent(undefined);
    expect(r).toEqual({ ok: true, dir: testRoot });
  });

  it('空串父目录 → 同默认根（对话框初始态）', () => {
    const r = resolveCreateParent('');
    expect(r).toEqual({ ok: true, dir: testRoot });
  });

  it('根内子目录 → 原样透传', () => {
    const sub = path.join(testRoot, 'my-novels');
    const r = resolveCreateParent(sub);
    expect(r).toEqual({ ok: true, dir: sub });
  });

  it('根本身 → 透传（直接建在根下）', () => {
    const r = resolveCreateParent(testRoot);
    expect(r).toEqual({ ok: true, dir: testRoot });
  });

  it('范围外目录 → 拒绝，reason 含允许根路径（告诉用户能选哪）', () => {
    const r = resolveCreateParent(path.join(os.tmpdir(), 'elsewhere'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain(testRoot);
      expect(r.reason).toMatch(/outside/i);
    }
  });

  it('根的前缀相似目录（Closure-backup）→ 拒绝，不吃假前缀', () => {
    const r = resolveCreateParent(`${testRoot}-backup`);
    expect(r.ok).toBe(false);
  });
});
