/**
 * dogfood R2 #26：createNode 删件暂存——「删除对话」把 session jsonl 从磁盘移走后，
 * 旧 add 循环对不存在的文件 git.add → NotFoundError，**整个快照全炸**（用户 08-26
 * 14:30 两次实录失败，项目从此无法保存版本）。修复 = stageAllChanges 单源：删件走
 * git.remove（isomorphic-git 的 add 不接受工作区不存在的文件，与真 git 不同）。
 *
 * 临时目录放 os.tmpdir()（mirror gitFirstNode.test.ts——cwd 在 Closure 仓库内会让
 * findRoot 攀到外层 repo）。
 */
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { rmBestEffort } from './rmBestEffort';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { createNode, initRepo } from '../main/ipc/gitIpc';

const TEST_ROOT = path.join(os.tmpdir(), 'closure-git-create-node-del');

/** HEAD 树里是否挂着该路径（删件断言：新节点树里不该再有）。 */
async function headTreeHas(dir: string, filepath: string): Promise<boolean> {
  const log = await git.log({ fs, dir, depth: 1 });
  const { tree } = await git.readTree({ fs, dir, oid: log[0].commit.tree });
  return tree.some((e) => e.path === filepath);
}

describe('createNode 删件暂存（R2 #26）', () => {
  beforeEach(() => {
    rmBestEffort(TEST_ROOT);
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmBestEffort(TEST_ROOT);
  });

  it('已删文件（删除对话移走 session jsonl）：快照成功且删除进树', async () => {
    const dir = path.join(TEST_ROOT, 'del-session');
    mkdirSync(path.join(dir, '.orison', 'sessions'), { recursive: true });
    writeFileSync(path.join(dir, '.orison', 'sessions', 'gone.jsonl'), '[]', 'utf8');
    writeFileSync(path.join(dir, 'project.yaml'), 'meta:\n  name: x\n', 'utf8');
    await initRepo(dir); // 首节点捕获两文件
    unlinkSync(path.join(dir, '.orison', 'sessions', 'gone.jsonl')); // 「删除对话」

    const { oid } = await createNode(dir, 'snapshot: 删了会话');

    expect(typeof oid).toBe('string');
    expect(await headTreeHas(dir, '.orison/sessions/gone.jsonl')).toBe(false);
    expect(await headTreeHas(dir, 'project.yaml')).toBe(true);
  });

  it('混合变更（修改 + 删除 + 新增）收进同一节点', async () => {
    const dir = path.join(TEST_ROOT, 'mixed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.md'), 'v1', 'utf8');
    writeFileSync(path.join(dir, 'b.md'), 'bye', 'utf8');
    writeFileSync(path.join(dir, 'c.md'), 'stay', 'utf8');
    await initRepo(dir);
    writeFileSync(path.join(dir, 'a.md'), 'v2', 'utf8');
    unlinkSync(path.join(dir, 'b.md'));
    writeFileSync(path.join(dir, 'd.md'), 'new', 'utf8');

    await createNode(dir, 'snapshot: mixed');

    expect(await headTreeHas(dir, 'a.md')).toBe(true);
    expect(await headTreeHas(dir, 'b.md')).toBe(false);
    expect(await headTreeHas(dir, 'c.md')).toBe(true);
    expect(await headTreeHas(dir, 'd.md')).toBe(true);
    // 修改内容确实进了新节点（读 HEAD blob）。
    const log = await git.log({ fs, dir, depth: 1 });
    const { blob } = await git.readBlob({ fs, dir, oid: log[0].oid, filepath: 'a.md' });
    expect(new TextDecoder().decode(blob)).toBe('v2');
  });
});
