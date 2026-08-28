import os from 'node:os';
import path from 'node:path';
import { realpathSync } from 'node:fs';

// 内置项目根目录（2026-08-20 dogfood 拍板：Documents/OrisonSpace → Documents/Closure，品牌归一）。
// 模块加载时按 homedir/Documents 兜底（纯 node 测试环境可达）；主进程启动时经
// initProjectsRoot(app.getPath('documents')) 传入系统 Known Folder 解析出的真实
// 「文档」目录——Windows 文档重定位（属性→位置 / 组策略重定向）后 homedir/Documents
// 不再是真实落点，homedir 硬拼会把项目写进已废弃的旧路径（dogfood 2026-08-20）。
let PROJECTS_ROOT = path.join(os.homedir(), 'Documents', 'Closure');
const allowedRoots = new Set([path.resolve(PROJECTS_ROOT)]);

/** Startup hook：用 Electron 解析的 documents 路径重设项目根（换掉兜底根，不留双根）。 */
export function initProjectsRoot(documents: string): void {
  const next = path.resolve(path.join(documents, 'Closure'));
  if (next === path.resolve(PROJECTS_ROOT)) return;
  allowedRoots.delete(path.resolve(PROJECTS_ROOT));
  PROJECTS_ROOT = next;
  allowedRoots.add(next);
}

export function getProjectsRoot(): string {
  return PROJECTS_ROOT;
}

/**
 * Resolve a `project:create-directory` parent-dir pick. An absent pick falls
 * back to the projects root; a pick OUTSIDE the root is REJECTED with the root
 * in the reason — never silently swapped (dogfood 2026-08-20 实录：用户手选目录
 * 被静默丢弃，项目落错根而无任何提示).
 */
export function resolveCreateParent(
  parentDir: string | undefined,
): { ok: true; dir: string } | { ok: false; reason: string } {
  const root = getProjectsRoot();
  if (!parentDir) return { ok: true, dir: root };
  if (!isSafePath(root, parentDir)) {
    return {
      ok: false,
      reason: `Chosen location is outside the projects root — pick a folder inside: ${root}`,
    };
  }
  return { ok: true, dir: parentDir };
}

/**
 * Resolve symlinks before scope checks. A lexical `path.resolve` alone lets a
 * symlink *inside* the project point outside it and still pass the prefix test,
 * so a write would follow the link out of scope. We realpath the deepest
 * existing ancestor (realpathSync throws on a not-yet-created file) and rejoin
 * the non-existent tail, which still catches a symlinked directory in the chain.
 */
function realResolve(target: string): string {
  let current = path.resolve(target);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target); // reached root, nothing existed
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

export function isSafePath(base: string, target: string): boolean {
  const resolved = normalizeForCompare(realResolve(target));
  const resolvedBase = normalizeForCompare(realResolve(base));
  return resolved === resolvedBase || resolved.startsWith(resolvedBase + path.sep);
}

export function allowPath(target: string): string {
  const resolved = path.resolve(target);
  allowedRoots.add(resolved);
  return resolved;
}

/** 撤销已删除或回滚目录的显式授权；内置项目根目录不受影响。 */
export function revokePath(target: string): void {
  const resolved = path.resolve(target);
  if (resolved !== path.resolve(PROJECTS_ROOT)) allowedRoots.delete(resolved);
}

export function assertSafePath(target: string): void {
  const resolved = path.resolve(target);
  const safe = [...allowedRoots].some((root) => isSafePath(root, resolved));
  if (!safe) {
    throw new Error(`Path outside allowed scope: ${resolved}`);
  }
}

export function assertWithinProject(projectDir: string, target: string): void {
  if (!isSafePath(projectDir, target)) {
    throw new Error(`Path escapes project directory: ${path.resolve(target)}`);
  }
}

function normalizeForCompare(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * dogfood T1 Stage 3（D4 per-project run 闸）：projectPath → 注册表 key 的规范化——与
 * 本文件 isSafePath 同款约定（path.resolve 消尾斜杠/相对段 + win32 大小写归一），防
 * `C:\proj\a` / `c:/proj/a/` 双 key 漏闸。词法归一（不 realpath——注册表 key 只需确定性，
 * 无安全语义）。
 */
export function normalizeProjectKey(projectPath: string): string {
  return normalizeForCompare(path.resolve(projectPath));
}
