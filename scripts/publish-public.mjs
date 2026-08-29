#!/usr/bin/env node
// publish-public.mjs — 双仓出仓同步（M2：私仓 dev → 公仓 main，快照 commit 形态）。
//
// 用法：
//   node scripts/publish-public.mjs            # 交互模式（push 前人肉过目变更清单）
//   node scripts/publish-public.mjs --yes      # 跳过确认（CI/熟练后用）
//   node scripts/publish-public.mjs --dry-run  # 只打印同步集，不动任何东西
//
// 流程（design.md §1）：
//   1. fetch public
//   2. 公栖清单（scripts/publish-paths.json）展开两树文件集（HEAD vs public/main）
//   3. blob 哈希对比 → copy 集（新增/变更）+ delete 集（公仓有而 dev 无）
//   4. 空集 → 「已是最新」exit 0（幂等保证）
//   5. git worktree（public/main 起 publish-sync 分支）→ 逐路径原子应用（内容自
//      `git show HEAD:<path>` 取 blob——只认已提交内容，工作树脏物不外泄）
//   6. 变更清单人肉过目（--yes 跳过）→ commit `sync: dev@<hash>` → push public HEAD:main
//   7. 推后再 fetch 复算同步集，应空——不空即报错（自校验）
//
// 事故防（08-29 实录两起）：不做目录级 cp（嵌套风险）——全部文件级；
// 删除只删 delete 集内路径；push 只推 main。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_REMOTE = 'public';
const PUBLIC_REF = `${PUBLIC_REMOTE}/main`;
const BRANCH = 'publish-sync';

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const dryRun = args.includes('--dry-run');

function git(...gitArgs) {
  return execFileSync('git', gitArgs, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ── 0. 前置 ──────────────────────────────────────────────────────────────────
const manifestPath = path.join(REPO_ROOT, 'scripts', 'publish-paths.json');
if (!existsSync(manifestPath)) die('scripts/publish-paths.json 不存在');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const wlPaths = [...(manifest.dirs ?? []), ...(manifest.files ?? [])];
if (wlPaths.length === 0) die('公栖清单为空');

// 工作树必须干净（同步只认 HEAD；脏树状态下人容易误判「已同步」）
if (git('status', '--porcelain') !== '') die('工作树不干净——先 commit 或 stash（同步只认 HEAD）');

console.log('· fetch public …');
git('fetch', PUBLIC_REMOTE, 'main');

// ── 1. 两树文件集（只认提交树，含 .gitattributes 归一——两仓一致归一 = 哈希可比） ──
const devFiles = new Set(git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...wlPaths).split('\n').filter(Boolean));
const pubFiles = new Set(git('ls-tree', '-r', '--name-only', PUBLIC_REF, '--', ...wlPaths).split('\n').filter(Boolean));

// ── 2. blob 哈希对比 → copy / delete 集 ─────────────────────────────────────
const copySet = [];
const deleteSet = [];
for (const f of devFiles) {
  const devBlob = git('rev-parse', `HEAD:${f}`);
  const pubBlob = pubFiles.has(f) ? git('rev-parse', `${PUBLIC_REF}:${f}`) : null;
  if (devBlob !== pubBlob) copySet.push(f);
}
for (const f of pubFiles) if (!devFiles.has(f)) deleteSet.push(f);

if (copySet.length === 0 && deleteSet.length === 0) {
  console.log('✓ 已是最新（公栖路径零差异）——无需同步');
  process.exit(0);
}

copySet.sort();
deleteSet.sort();
console.log(`\n同步集：copy ${copySet.length} / delete ${deleteSet.length}`);
for (const f of deleteSet) console.log(`  - ${f}（公仓删除）`);
const sample = copySet.slice(0, 40);
for (const f of sample) console.log(`  + ${f}`);
if (copySet.length > sample.length) console.log(`  …另 ${copySet.length - sample.length} 项`);

if (dryRun) {
  console.log('\n（dry-run：未做任何改动）');
  process.exit(0);
}

// ── 3. worktree：public/main 起 publish-sync 分支 ────────────────────────────
const wt = path.join(os.tmpdir(), `closure-publish-${process.pid}`);
rmSync(wt, { recursive: true, force: true });
console.log(`\n· worktree ${wt} …`);
git('worktree', 'add', '-b', BRANCH, wt, PUBLIC_REF);
try {
  // 3a. 应用 copy 集：内容取 HEAD blob（文件级，无目录拷贝）
  for (const f of copySet) {
    const target = path.join(wt, f);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(git('show', `HEAD:${f}`), 'utf8'));
  }
  // 3b. 应用 delete 集：只删清单算出的路径
  for (const f of deleteSet) {
    rmSync(path.join(wt, f), { force: true });
  }
  // 3c. 暂存并核对
  git('-C', wt, 'add', '-A');
  const staged = git('-C', wt, 'diff', '--cached', '--name-status', '-M');
  console.log('\n· 暂存变更：');
  console.log(staged);

  // 3d. 人肉过目门
  if (!yes) {
    process.stdout.write('\n推上公仓 main？[y/N] ');
    const answer = readFileSync(0, 'utf8').trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') die('已中止（worktree 已保留可人工检查后删除）');
  }

  // 3e. 快照 commit + push
  const devHash = git('rev-parse', '--short', 'HEAD');
  git('-C', wt, 'commit', '-m', `sync: dev@${devHash}`);
  console.log(`\n· push ${PUBLIC_REMOTE} HEAD:main …`);
  git('-C', wt, 'push', PUBLIC_REMOTE, 'HEAD:main');
} finally {
  git('worktree', 'remove', '--force', wt);
  git('branch', '-D', BRANCH, '--quiet');
}

// ── 4. 推后自校验：重算同步集应空 ────────────────────────────────────────────
git('fetch', PUBLIC_REMOTE, 'main');
const devFiles2 = new Set(git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...wlPaths).split('\n').filter(Boolean));
const pubFiles2 = new Set(git('ls-tree', '-r', '--name-only', PUBLIC_REF, '--', ...wlPaths).split('\n').filter(Boolean));
let residue = 0;
for (const f of devFiles2) {
  if (git('rev-parse', `HEAD:${f}`) !== git('rev-parse', `${PUBLIC_REF}:${f}`)) residue++;
}
for (const f of pubFiles2) if (!devFiles2.has(f)) residue++;
if (residue > 0) die(`推后复验仍有 ${residue} 项差异——人工检查 public/main 与清单`);
console.log('✓ 同步完成且推后复验归零（幂等达成）');