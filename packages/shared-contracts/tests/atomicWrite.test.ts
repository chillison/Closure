import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { atomicWriteFileSync } from '../src/fs/atomicWrite';

// mock node:fs 的 renameSync：failures 队列非空时按序抛对应 code 的错，
// 队列空则透传真实 renameSync。其余 fs 函数保持原实现（tmp 写/清理走真盘）。
const renameState = vi.hoisted(() => ({
  failures: [] as string[],
  calls: 0,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync(from: string, to: string) {
      renameState.calls++;
      const code = renameState.failures.shift();
      if (code !== undefined) {
        throw Object.assign(new Error(`mocked rename failure: ${code}`), { code });
      }
      return actual.renameSync(from, to);
    },
  };
});

const TEST_DIR = path.join(process.cwd(), 'tests', '.tmp-atomic-write');

const tmpLeftovers = () => readdirSync(TEST_DIR).filter((name) => name.includes('.tmp-'));

describe('atomicWriteFileSync — rename 瞬态错重试（dogfood R2 #85/#106）', () => {
  beforeEach(() => {
    renameState.failures.length = 0;
    renameState.calls = 0;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('happy path：首次 rename 即成功，不重试、无 tmp 残留', () => {
    const target = path.join(TEST_DIR, 'project.yaml');

    atomicWriteFileSync(target, 'version: 3', 'utf-8');

    expect(readFileSync(target, 'utf-8')).toBe('version: 3');
    expect(renameState.calls).toBe(1);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('#85 EPERM 连抛两次后第三次过：重试跨过瞬态窗口，落盘成功', () => {
    renameState.failures.push('EPERM', 'EPERM');
    const target = path.join(TEST_DIR, 'project.yaml');

    atomicWriteFileSync(target, 'version: 3', 'utf-8');

    expect(readFileSync(target, 'utf-8')).toBe('version: 3');
    expect(renameState.calls).toBe(3);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('EBUSY 抛一次后成功：同属瞬态占用族，同样重试', () => {
    renameState.failures.push('EBUSY');
    const target = path.join(TEST_DIR, 'project.yaml');

    atomicWriteFileSync(target, 'ok', 'utf-8');

    expect(readFileSync(target, 'utf-8')).toBe('ok');
    expect(renameState.calls).toBe(2);
  });

  it('#106 EPERM ×4 后第 5 次过：外部持柄 >200ms（旧预算耗尽点之后）仍跨过，落盘成功', () => {
    renameState.failures.push('EPERM', 'EPERM', 'EPERM', 'EPERM');
    const target = path.join(TEST_DIR, 'project.yaml');

    atomicWriteFileSync(target, 'version: 3', 'utf-8');

    expect(readFileSync(target, 'utf-8')).toBe('version: 3');
    expect(renameState.calls).toBe(5);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('EPERM 五次全败（预算耗尽）：抛原错（保旧文件 + 清 tmp），不再做第 6 次尝试', () => {
    renameState.failures.push('EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM');
    const target = path.join(TEST_DIR, 'project.yaml');
    writeFileSync(target, 'old content', 'utf-8');

    expect(() => atomicWriteFileSync(target, 'new content', 'utf-8')).toThrowError(
      expect.objectContaining({ code: 'EPERM' }),
    );

    expect(renameState.calls).toBe(5);
    expect(readFileSync(target, 'utf-8')).toBe('old content');
    expect(tmpLeftovers()).toEqual([]);
  });

  it('ENOENT（真错）：不重试直抛，tmp 照常清理', () => {
    renameState.failures.push('ENOENT');
    const target = path.join(TEST_DIR, 'project.yaml');

    expect(() => atomicWriteFileSync(target, 'x', 'utf-8')).toThrowError(
      expect.objectContaining({ code: 'ENOENT' }),
    );

    expect(renameState.calls).toBe(1);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('EACCES（真权限错，EPERM/EBUSY 族之外）：不重试直抛', () => {
    renameState.failures.push('EACCES');
    const target = path.join(TEST_DIR, 'project.yaml');

    expect(() => atomicWriteFileSync(target, 'x', 'utf-8')).toThrowError(
      expect.objectContaining({ code: 'EACCES' }),
    );

    expect(renameState.calls).toBe(1);
  });
});
