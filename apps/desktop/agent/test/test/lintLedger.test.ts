import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintChapterReportSchema } from '@orison/shared-contracts';
import type { LintEngine } from '../src/lint/lintEngine';
import {
  lintChapterLedgerPath,
  writeLintChapterLedger,
} from '../src/lint/lintLedger';

// ── C1.2 Step 6：post-settle 终稿 lint 账测试（implement.md Step 6）──
//
// 覆盖：落文件（schema 契约面）/ last-write-wins 覆写幂等 / 引擎 null 降级 skip / 载荷缺位 skip /
// 路径单源 + chapterId 消毒。临时目录 per-test mkdtemp，afterEach 清理。
//
// fs seam 口径：mirror batch-state.ts 的 `.orison/` 直写先例（atomicWriteFileSync）。

const tmpDirs: string[] = [];

function makeTmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lint-ledger-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* tmpdir best-effort：Windows 句柄竞态 EPERM 残留无害 */ }
  }
});

/** 触发文本（mirror lint-node.test：story-deslop.not-is-comparison agent 桶命中）。 */
const DIRTY_TEXT = '他不是怯懦，而是清醒。清醒得近乎冷酷。';
const CLEAN_TEXT = '他把伞收起来，雨还没有停。她转身进了门。';

describe('writeLintChapterLedger 落文件', () => {
  it('终稿重扫落 .orison/lint/<chapterId>.json（schema 契约面 + 全量桶语义）', async () => {
    const projectPath = makeTmpProject();

    const written = await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: DIRTY_TEXT });

    expect(written).toBe(true);
    const filePath = lintChapterLedgerPath(projectPath, 'ch_1');
    expect(existsSync(filePath)).toBe(true);
    const report = lintChapterReportSchema.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
    expect(report.chapterId).toBe('ch_1');
    // 全量桶（issue 自带 review 字段——终稿账非链段 agent 桶投影）
    expect(report.issues.map((i) => i.ruleId)).toContain('story-deslop.not-is-comparison');
    expect(report.issues.every((i) => typeof i.review === 'string')).toBe(true);
  });

  it('缺省引擎 = getLintEngine 单例（真实 vendored rulesets 装载）', async () => {
    const projectPath = makeTmpProject();
    // 不注入 getEngine——走缺省 getLintEngine（引擎单例装载成功路径）。
    const written = await writeLintChapterLedger({ projectPath, chapterId: 'ch_default', text: CLEAN_TEXT });
    expect(written).toBe(true);
    expect(existsSync(lintChapterLedgerPath(projectPath, 'ch_default'))).toBe(true);
  });
});

describe('writeLintChapterLedger last-write-wins 幂等', () => {
  it('重扫覆写：脏稿 → 净稿，账随终稿刷新，目录单文件', async () => {
    const projectPath = makeTmpProject();

    await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: DIRTY_TEXT });
    const first = lintChapterReportSchema.parse(
      JSON.parse(readFileSync(lintChapterLedgerPath(projectPath, 'ch_1'), 'utf-8')),
    );
    expect(first.issues.length).toBeGreaterThan(0);

    await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: CLEAN_TEXT });
    const second = lintChapterReportSchema.parse(
      JSON.parse(readFileSync(lintChapterLedgerPath(projectPath, 'ch_1'), 'utf-8')),
    );
    expect(second.issues).toEqual([]); // 覆写非追加：净稿零命中
    expect(second.chapterId).toBe('ch_1');

    const lintDir = join(projectPath, '.orison', 'lint');
    expect(readdirSync(lintDir)).toEqual(['ch_1.json']); // 单章单文件（last-write-wins）
  });

  it('不同章互不覆盖（<chapterId>.json per-chapter 隔离）', async () => {
    const projectPath = makeTmpProject();

    await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: DIRTY_TEXT });
    await writeLintChapterLedger({ projectPath, chapterId: 'ch_2', text: CLEAN_TEXT });

    const lintDir = join(projectPath, '.orison', 'lint');
    expect(readdirSync(lintDir).sort()).toEqual(['ch_1.json', 'ch_2.json']);
  });
});

describe('writeLintChapterLedger 降级 skip（不破章结算）', () => {
  it('引擎 null → false 不落文件（C1.3 可 full-scan 重建）', async () => {
    const projectPath = makeTmpProject();

    const written = await writeLintChapterLedger({
      projectPath,
      chapterId: 'ch_1',
      text: DIRTY_TEXT,
      getEngine: async () => null,
    });

    expect(written).toBe(false);
    expect(existsSync(join(projectPath, '.orison', 'lint'))).toBe(false);
  });

  it('引擎扫描抛错 → false 不落文件（try/catch 兜底）', async () => {
    const projectPath = makeTmpProject();
    const badEngine = {
      scanText: () => {
        throw new Error('boom');
      },
    };

    const written = await writeLintChapterLedger({
      projectPath,
      chapterId: 'ch_1',
      text: DIRTY_TEXT,
      getEngine: async () => badEngine as unknown as LintEngine,
    });

    expect(written).toBe(false);
    expect(existsSync(join(projectPath, '.orison', 'lint'))).toBe(false);
  });

  it('chapterId / text 缺位 → false（无结算载荷不落账）', async () => {
    const projectPath = makeTmpProject();

    expect(await writeLintChapterLedger({ projectPath, chapterId: undefined, text: DIRTY_TEXT })).toBe(false);
    expect(await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: undefined })).toBe(false);
    expect(await writeLintChapterLedger({ projectPath, chapterId: 'ch_1', text: '' })).toBe(false);
    expect(existsSync(join(projectPath, '.orison'))).toBe(false);
  });
});

describe('lintChapterLedgerPath 路径单源 + 消毒单射性（CR-019）', () => {
  it('percent-encode 非法字符（不再折叠为 _）：分隔符/保留字符各自独立编码', () => {
    // 非法字符 → %XX；合法字符（含中文/下划线）原样保留——常规 chapterId 文件名可读。
    expect(lintChapterLedgerPath('/p', 'a/b')).toBe(join('/p', '.orison', 'lint', 'a%2Fb.json'));
    expect(lintChapterLedgerPath('/p', 'a:b')).toBe(join('/p', '.orison', 'lint', 'a%3Ab.json'));
    // `*`：encodeURIComponent 原样透传（RFC unreserved）但 Win32 文件名非法——须显式 %2A，
    // 否则含 `*` 的 chapterId 产出永远写不成的文件名。
    expect(lintChapterLedgerPath('/p', 'a*b')).toBe(join('/p', '.orison', 'lint', 'a%2Ab.json'));
    expect(lintChapterLedgerPath('/p', 'ch_1')).toBe(join('/p', '.orison', 'lint', 'ch_1.json'));
    expect(lintChapterLedgerPath('/p', '第一章')).toBe(join('/p', '.orison', 'lint', '第一章.json'));
  });

  it('单射性：不同 chapterId 不同文件名（a/b vs a:b vs a_b 互不撞车——旧实现三方同投 a_b）', () => {
    const names = ['a/b', 'a:b', 'a_b', 'a%2Fb', 'a*b', 'a?b', 'a<b', 'a|b'].map(
      (id) => lintChapterLedgerPath('/p', id),
    );
    expect(new Set(names).size).toBe(names.length); // 两两互异（单射）
  });

  it('逃逸防御：路径分隔符被编码，文件恒落 lint 目录内（不产生额外层级）', () => {
    const p = lintChapterLedgerPath('/p', '../../etc/passwd');
    expect(p.startsWith(join('/p', '.orison', 'lint'))).toBe(true);
    expect(p.slice(join('/p', '.orison', 'lint').length + 1)).toBe(
      '..%2F..%2Fetc%2Fpasswd.json', // 分隔符全部编码 → 单层文件名，零目录穿越
    );
  });

  it('Windows 保留设备名守卫：CON/NUL/COM1-9… 加 % 前缀（大小写不敏感），普通名不加', () => {
    for (const reserved of ['CON', 'con', 'Con', 'NUL', 'COM1', 'LPT9', 'aux']) {
      const name = lintChapterLedgerPath('/p', reserved).split(pathSep()).pop()!;
      expect(name.startsWith('%'), `保留名 ${reserved} 应加 % 前缀守卫`).toBe(true);
    }
    // 带扩展基名同样保留（CON.x 基名是 CON）。
    expect(lintChapterLedgerPath('/p', 'CON.x').split(pathSep()).pop()!.startsWith('%')).toBe(true);
    // 普通名（含撞前缀形态）不加前缀——且守卫前缀不引入新撞车：'CON' → '%CON' vs '%CON' → '%%25CON'。
    expect(lintChapterLedgerPath('/p', 'console').split(pathSep()).pop()).toBe('console.json');
    const guarded = lintChapterLedgerPath('/p', 'CON').split(pathSep()).pop();
    const literalPercent = lintChapterLedgerPath('/p', '%CON').split(pathSep()).pop();
    expect(guarded).toBe('%CON.json'); // 保留名本体无非法字符 → 原样 + 前缀
    expect(literalPercent).toBe('%25CON.json'); // 字面 % 编码 → 与守卫前缀不撞
    expect(guarded).not.toBe(literalPercent);
  });

  it('同 chapterId 稳定同文件名（幂等不破）', () => {
    expect(lintChapterLedgerPath('/p', 'a/b')).toBe(lintChapterLedgerPath('/p', 'a/b'));
  });
});

/** 平台路径分隔符（join 产物切分用）。 */
function pathSep(): string {
  return lintChapterLedgerPath('x', 'y').includes('\\') ? '\\' : '/';
}
