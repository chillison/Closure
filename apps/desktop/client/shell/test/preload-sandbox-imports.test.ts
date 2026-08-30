import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── dogfood R2 #99：preload sandbox 值导入闭包静态守卫 ──
//
// 背景：renderer sandbox:true 的 preload 只能 require('electron')。任何**值**导入
// 把带 zod 的模块图内联进 preload bundle（zod 顶层 require("node:crypto"）都会让
// preload 整崩 → window.orisonDesktop 消失 → 全 app IPC 静默哑掉。这类崩溃 CI
// 完全不可见（不起窗口），08-30 #92 commit 实录：barrel 值导入 WORLD_CHANGED_CHANNEL
// 拖入 zod，常驻老窗口不重跑 preload 故用户当时未察，任何新启动全炸。
//
// 守卫方式：从 preload/index.ts 源码出发走值导入图（import type 视为擦除），
// 断言闭包内：① 无 zod / node:* / 任何裸包（electron 除外）；② 无未知 workspace
// 包（新增依赖必须显式扩 ALLOWED_WORKSPACE 映射）。保守方向：`import { type A }`
// 全 type-only 语句按值计（逼出叶子化写法），不做 AST 精判。
//
// 已知取舍：静态源图 ≈ bundle 图（bundlers 保守保序，源图无 zod ⇒ bundle 无
// node:crypto 顶层 require）；不做真 bundle 检查（electron-vite build 每测太重）。

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELL_ROOT = resolve(HERE, '..');
const PRELOAD_ENTRY = join(SHELL_ROOT, 'preload', 'index.ts');
const REPO_ROOT = resolve(SHELL_ROOT, '..', '..', '..', '..');

/** electron 之外唯一允许的裸包（preload 运行时可用面）。 */
const ALLOWED_BARE = new Set(['electron']);

/** @orison/* workspace 包 → 源码 src 根（preload 只该见 shared-contracts）。 */
const WORKSPACE_SRC: Record<string, string> = {
  '@orison/shared-contracts': join(REPO_ROOT, 'packages', 'shared-contracts', 'src'),
};

interface ParsedImport {
  /** true = `import type` / `export type`（擦除，不追）。 */
  typeOnly: boolean;
  specifier: string;
}

/** 解析一个 TS 模块源里的所有 import/export...from 语句。 */
function parseImports(source: string): ParsedImport[] {
  const out: ParsedImport[] = [];
  // import [type] ... from 'x' / export [type] ... from 'x'（含多行语句，s 标记跨行）
  const fromRe = /^\s*(import|export)\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/gm;
  for (const m of source.matchAll(fromRe)) {
    out.push({ typeOnly: Boolean(m[2]), specifier: m[3]! });
  }
  // 副作用导入 import 'x'（无 from）
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) {
    out.push({ typeOnly: false, specifier: m[1]! });
  }
  return out;
}

/** 把 specifier 解析成源文件路径；解析不了返回 null（裸包由调用方裁决）。 */
function resolveSpecifier(specifier: string, fromDir: string): string | null {
  if (specifier.startsWith('.')) {
    const base = resolve(fromDir, specifier);
    for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
      if (existsSync(cand) && cand.endsWith('.ts')) return cand;
    }
    return null;
  }
  for (const [pkgName, srcRoot] of Object.entries(WORKSPACE_SRC)) {
    if (specifier === pkgName) return join(srcRoot, 'index.ts');
    if (specifier.startsWith(`${pkgName}/`)) {
      const rest = specifier.slice(pkgName.length + 1);
      const base = join(srcRoot, rest);
      for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
        if (existsSync(cand) && cand.endsWith('.ts')) return cand;
      }
    }
  }
  return null;
}

/** 走值导入闭包，返回访问到的 [file, importee] 边列表（含违规裸包）。 */
function walkValueGraph(): { edges: string[]; violations: string[]; visited: string[] } {
  const queue: string[] = [PRELOAD_ENTRY];
  const visited = new Set<string>();
  const edges: string[] = [];
  const violations: string[] = [];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf-8');
    for (const imp of parseImports(source)) {
      if (imp.typeOnly) continue;
      edges.push(`${file.includes('preload') ? 'preload' : 'dep'} -> ${imp.specifier}`);
      const resolved = resolveSpecifier(imp.specifier, dirname(file));
      if (resolved) {
        queue.push(resolved);
        continue;
      }
      // 未解析 = 裸包：白名单（electron）之外全违规（zod/node:*/新包一网打尽）。
      if (!ALLOWED_BARE.has(imp.specifier)) {
        violations.push(`${file}\n  -> ${imp.specifier}`);
      }
    }
  }
  return { edges, violations, visited: [...visited] };
}

describe('preload sandbox 值导入闭包（dogfood R2 #99 守卫）', () => {
  it('preload 值导入图无 zod / node:* / 白名单外裸包（sandbox preload 崩溃面归零）', () => {
    const { violations } = walkValueGraph();
    expect(violations, `sandbox 不安全值导入（preload bundle 将含其 require）：\n${violations.join('\n')}`).toEqual([]);
  });

  it('preload 值导入仍接世界推送通道常量（#92 功能面不回退——zod-free 叶子路径）', () => {
    const source = readFileSync(PRELOAD_ENTRY, 'utf-8');
    expect(source).toContain("@orison/shared-contracts/contracts/channels");
  });

  it('channels 叶子保持零依赖（任何人给它加 import 都会炸守卫，此测试给出可读锚点）', () => {
    const channels = join(WORKSPACE_SRC['@orison/shared-contracts']!, 'contracts', 'channels.ts');
    const source = readFileSync(channels, 'utf-8');
    expect(parseImports(source)).toEqual([]);
  });
});
