/**
 * CR-28（dogfood R2）wiring：project:save-meta / project:ensure-document 的「全新文档
 * 首写」路径在 yaml 落地后挂 git 首节点（commitProjectCreateNode）；存量文档不挂；首
 * 节点失败不阻塞创建（yaml 已成功落盘不能被翻成 {ok:false}——NewProjectDialog 会把
 * 它当创建失败弹错）。
 *
 * gitIpc 整体 mock（首节点真语义在 gitFirstNode.test.ts 用真 isomorphic-git 钉）；
 * local-bff 用真包（纯 fs）；electron 只 mock 本文件触到的面（ipcMain/dialog/
 * BrowserWindow.getAllWindows——notifyUI 走它）。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyProjectDocument, saveProject } from '@orison/desktop-local-bff';

const { handle, commitProjectCreateNode } = vi.hoisted(() => ({
  handle: vi.fn(),
  commitProjectCreateNode: vi.fn(async () => ({ committed: true })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../main/ipc/gitIpc', () => ({ commitProjectCreateNode }));

import { registerProjectMetaIpc } from '../main/ipc/projectMetaIpc';
import { allowPath } from '../main/ipc/pathGuard';

const TEST_ROOT = path.join(process.cwd(), 'test-tmp-meta-first-node');

type MetaHandler = (event: unknown, projectDir: string, meta: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;

function pickHandler(channel: string): MetaHandler {
  const call = handle.mock.calls.find(([c]) => c === channel);
  if (!call) throw new Error(`handler not registered: ${channel}`);
  return call[1] as unknown as MetaHandler;
}

function freshProject(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('project:save-meta / ensure-document → git 首节点 wiring（CR-28）', () => {
  beforeEach(() => {
    handle.mockReset();
    commitProjectCreateNode.mockReset();
    commitProjectCreateNode.mockResolvedValue({ committed: true });
    rmSync(TEST_ROOT, { recursive: true, force: true });
    allowPath(TEST_ROOT);
    registerProjectMetaIpc();
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('save-meta 全新目录（无 project.yaml）→ 首写落地后挂首节点', async () => {
    const dir = freshProject('新建小说');
    const handler = pickHandler('project:save-meta');

    const result = await handler({}, dir, { name: '新建小说', type: 'novel' });

    expect(result).toEqual({ ok: true });
    expect(existsSync(path.join(dir, 'project.yaml'))).toBe(true);
    expect(commitProjectCreateNode).toHaveBeenCalledTimes(1);
    expect(commitProjectCreateNode).toHaveBeenCalledWith(dir);
  });

  it('save-meta 存量目录（project.yaml 已在）→ 不挂首节点（meta 更新不偷节点）', async () => {
    const dir = freshProject('存量项目');
    saveProject(dir, createEmptyProjectDocument('存量项目', 'novel') as any);
    const handler = pickHandler('project:save-meta');

    const result = await handler({}, dir, { name: '改名' });

    expect(result).toEqual({ ok: true });
    expect(commitProjectCreateNode).not.toHaveBeenCalled();
  });

  it('首节点失败不阻塞创建：commitProjectCreateNode 拒绝 → save-meta 仍 ok:true（yaml 已落盘）', async () => {
    const dir = freshProject('失败不阻塞');
    commitProjectCreateNode.mockRejectedValue(new Error('git boom'));
    const handler = pickHandler('project:save-meta');

    const result = await handler({}, dir, { name: '失败不阻塞', type: 'novel' });

    expect(result).toEqual({ ok: true });
    expect(existsSync(path.join(dir, 'project.yaml'))).toBe(true);
  });

  it('ensure-document 全新目录 → 也挂首节点（save-meta 半途失败后的补救路径）', async () => {
    const dir = freshProject('补救路径');
    const handler = pickHandler('project:ensure-document');

    const result = await handler({}, dir, { name: '补救路径', type: 'novel' });

    expect(result).toEqual({ ok: true });
    expect(commitProjectCreateNode).toHaveBeenCalledTimes(1);
    expect(commitProjectCreateNode).toHaveBeenCalledWith(dir);
  });

  it('ensure-document 存量目录 → 早退不挂首节点', async () => {
    const dir = freshProject('已有文档');
    saveProject(dir, createEmptyProjectDocument('已有文档', 'novel') as any);
    const handler = pickHandler('project:ensure-document');

    const result = await handler({}, dir, { name: '已有文档' });

    expect(result).toEqual({ ok: true });
    expect(commitProjectCreateNode).not.toHaveBeenCalled();
  });
});
