/**
 * dogfood R2 批次0（地基补项4）：新项目自动开版本管理——project:create-directory
 * 在项目目录创建完成的路径上调 gitIpc.initRepo（幂等，已是 repo 则 no-op）。
 *
 * wiring 测试：mock initRepo 捕获调用与失败路径；initRepo 本体（幂等判定 / 空目录
 * 不落空节点、存量目录全量 stage 首节点「开启版本管理」）属 gitIpc 职责——真语义在
 * gitFirstNode.test.ts 用真 isomorphic-git 钉（CR-28）。electron 只 mock ipcMain
 * （registerProjectFileIpc 唯一用到的 electron 面）。
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handle, initRepo } = vi.hoisted(() => ({
  handle: vi.fn(),
  initRepo: vi.fn(async () => ({ initialized: true })),
}));

vi.mock('electron', () => ({ ipcMain: { handle } }));
vi.mock('../main/ipc/gitIpc', () => ({ initRepo }));

import { registerProjectFileIpc } from '../main/ipc/projectFileIpc';
import { initProjectsRoot } from '../main/ipc/pathGuard';

// 尾段必须是 Closure（initProjectsRoot 语义：documents 参数 + '/Closure'），
// mirror createDirectoryGuard.test.ts 的根构造。
const TEST_ROOT = path.join(process.cwd(), 'test-tmp-create-git-init', 'Closure');

/** handler 首参是 ipc event（unused），测试传 {} 占位（mirror fieldSyncIpc.test 调用形）。 */
function createHandler(): (event: unknown, parentDir: string, name: string) => Promise<string> {
  const call = handle.mock.calls.find((c) => c[0] === 'project:create-directory');
  if (!call) throw new Error('project:create-directory handler not registered');
  return call[1] as unknown as (event: unknown, parentDir: string, name: string) => Promise<string>;
}

describe('project:create-directory → initRepo 接线（新项目自动开版本管理）', () => {
  beforeEach(() => {
    handle.mockReset();
    initRepo.mockReset();
    initRepo.mockResolvedValue({ initialized: true });
    rmSync(TEST_ROOT, { recursive: true, force: true });
    initProjectsRoot(path.dirname(TEST_ROOT));
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('新项目目录创建后对它调 initRepo（版本管理从创建起开启）', async () => {
    registerProjectFileIpc();
    const handler = createHandler();

    const projectDir = await handler({}, TEST_ROOT, '新小说');

    expect(projectDir).toBe(path.join(TEST_ROOT, '新小说'));
    expect(existsSync(projectDir)).toBe(true);
    expect(initRepo).toHaveBeenCalledTimes(1);
    expect(initRepo).toHaveBeenCalledWith(projectDir);
  });

  it('initRepo 失败不阻塞项目创建（返回路径不抛——版本管理失败不该让新建项目失败）', async () => {
    initRepo.mockRejectedValue(new Error('git init boom'));
    registerProjectFileIpc();
    const handler = createHandler();

    const projectDir = await handler({}, TEST_ROOT, '另一本');

    expect(projectDir).toBe(path.join(TEST_ROOT, '另一本'));
    expect(existsSync(projectDir)).toBe(true);
  });

  it('目录已存在（同名单次重入）→ 仍调 initRepo（幂等判定交 gitIpc 本体）', async () => {
    mkdirSync(path.join(TEST_ROOT, '已有目录'), { recursive: true });
    registerProjectFileIpc();
    const handler = createHandler();

    await handler({}, TEST_ROOT, '已有目录');

    expect(initRepo).toHaveBeenCalledWith(path.join(TEST_ROOT, '已有目录'));
  });
});
