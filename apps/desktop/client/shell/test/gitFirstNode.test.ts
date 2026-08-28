/**
 * CR-28（dogfood R2）：新项目 git 首节点语义——真 isomorphic-git 集成（纯 JS + node:fs）。
 *   - initRepo 空目录（create-directory 路径）：只建 repo，不落「开启版本管理」空节点；
 *   - initRepo 存量目录（git:init opt-in 导入形态）：全量 stage + 首节点「开启版本管理」；
 *   - commitProjectCreateNode：初始内容（project.yaml + 封面）落地时挂「项目创建」，
 *     只在零提交（unborn HEAD）repo 上生效——存量/非 repo 目录 no-op。
 *
 * 临时目录放 os.tmpdir()：cwd 在 Closure 仓库内，findRoot 会攀到外层 repo 让
 * initRepo 的幂等判定（isGitRepo）误判 no-op。wiring 面（save-meta/ensure-document
 * 何时调用）在 projectMetaFirstNode.test.ts。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { commitProjectCreateNode, initRepo } from '../main/ipc/gitIpc';

const TEST_ROOT = path.join(os.tmpdir(), 'closure-git-first-node');

/** unborn repo 上 git.log 会抛——统一映射为「零提交」。 */
async function commitMessages(dir: string): Promise<string[]> {
  try {
    const logs = await git.log({ fs, dir, depth: 10 });
    return logs.map((e) => e.commit.message.trim());
  } catch {
    return [];
  }
}

function freshDir(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('git 首节点语义（CR-28）', () => {
  beforeEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('initRepo 空目录：建 repo 但零提交——首节点等初始内容，不再是空「开启版本管理」节点', async () => {
    const dir = freshDir('empty-create');

    const result = await initRepo(dir);

    expect(result).toEqual({ initialized: true });
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
    expect(await commitMessages(dir)).toEqual([]);
  });

  it('initRepo 存量目录（opt-in 导入形态）：首节点「开启版本管理」捕获磁盘现状', async () => {
    const dir = freshDir('imported');
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: 存量\n', 'utf8');

    const result = await initRepo(dir);

    expect(result).toEqual({ initialized: true });
    expect(await commitMessages(dir)).toEqual(['开启版本管理']);
  });

  it('initRepo 幂等：已是 repo 则 no-op（复跑不偷挂节点）', async () => {
    const dir = freshDir('idempotent');
    await initRepo(dir);
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: x\n', 'utf8');

    const again = await initRepo(dir);

    expect(again).toEqual({ initialized: false });
    expect(await commitMessages(dir)).toEqual([]);
  });

  it('commitProjectCreateNode：unborn repo + project.yaml/封面落地 → 首节点「项目创建」含初始内容', async () => {
    const dir = freshDir('create-flow');
    await initRepo(dir); // create-directory 语义：repo 已建、unborn
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: 新小说\n', 'utf8');
    writeFileSync(path.join(dir, 'cover.png'), 'png', 'utf8');

    const result = await commitProjectCreateNode(dir);

    expect(result).toEqual({ committed: true });
    expect(await commitMessages(dir)).toEqual(['项目创建']);
    // 首节点确实含初始内容（project.yaml 在树里，内容可读回）。
    const log = await git.log({ fs, dir, depth: 1 });
    const { blob } = await git.readBlob({ fs, dir, oid: log[0].oid, filepath: 'project.yaml' });
    expect(new TextDecoder().decode(blob)).toContain('新小说');
  });

  it('commitProjectCreateNode：repo 已有提交 → no-op（存量项目 meta 更新不偷挂节点）', async () => {
    const dir = freshDir('has-commits');
    writeFileSync(path.join(dir, 'old.md'), 'old', 'utf8');
    await initRepo(dir); // 「开启版本管理」
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: 更新\n', 'utf8');

    const result = await commitProjectCreateNode(dir);

    expect(result).toEqual({ committed: false });
    expect(await commitMessages(dir)).toEqual(['开启版本管理']); // 原样，无新节点
  });

  it('commitProjectCreateNode：非 repo 目录 → no-op 不抛（打开的既有目录不开版本管理）', async () => {
    const dir = freshDir('no-repo');
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: 打开\n', 'utf8');

    const result = await commitProjectCreateNode(dir);

    expect(result).toEqual({ committed: false });
  });

  it('commitProjectCreateNode：unborn repo 但无内容 → 不落空节点（CR-28 的另一半守卫）', async () => {
    const dir = freshDir('unborn-empty');
    await initRepo(dir);

    const result = await commitProjectCreateNode(dir);

    expect(result).toEqual({ committed: false });
    expect(await commitMessages(dir)).toEqual([]);
  });
});
