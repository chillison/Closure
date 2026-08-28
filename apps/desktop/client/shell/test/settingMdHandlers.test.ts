/**
 * setting_md_update shell handler tests (Story 2.2 WP-B, design §3).
 *
 * Covers: strict slug sanitize + explicit-id traversal rejection, create_file
 * slug derivation + conflict -2 (never overwrite), suggest-tier envelope
 * (dedicated setting_md_patch metadata, NO disk write), autoApply dual-mode
 * (withProjectLock + write + direct reindex round-trip, reindex failure never
 * un-saves), anchor-miss friendly rejection, and the accept-side persist core
 * `applyAndPersistSettingMd` — RE-APPLIES against the current file (stale
 * proposal never persisted; drifted anchor fails loudly).
 *
 * Runs on a throwaway project dir; reindexSettingMd is stubbed (its DB
 * integration has its own suite, mirror craftCurationHandlers.test.ts).
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = path.join(process.cwd(), 'test-tmp-setting-md');
const PROJECT_DIR = path.join(TEST_ROOT, 'proj');
const SETTINGS_DIR = path.join(PROJECT_DIR, 'settings');

vi.mock('electron', () => ({
  app: {
    getPath: (_: string) => TEST_ROOT,
    isPackaged: false,
  },
  ipcMain: { handle: () => undefined },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
}));
vi.mock('../main/db/settingMdIndexer', () => ({
  reindexSettingMd: vi.fn(async () => true),
}));

import { reindexSettingMd } from '../main/db/settingMdIndexer';
import {
  settingMdUpdateHandler,
  slugifySettingDoc,
  isSafeSettingSlug,
  pickConflictFreeSettingSlug,
  applyAndPersistSettingMd,
} from '../main/ipc/toolHandlers/settingMdHandlers';
import { parseSettingMd, deriveSettingId } from '../main/db/settingMd';

const ctx = (params: Record<string, unknown>) => ({
  params,
  projectDir: PROJECT_DIR,
  sessionId: 's1',
  abort: new AbortController().signal,
});

function clean() {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
}

beforeAll(() => {
  clean();
  mkdirSync(SETTINGS_DIR, { recursive: true });
});
afterEach(() => {
  vi.mocked(reindexSettingMd).mockClear();
  vi.mocked(reindexSettingMd).mockImplementation(async () => true);
});
afterAll(clean);

describe('slug sanitize（mirror 3.6 lesson）', () => {
  it('slugifySettingDoc：CJK 保留 / 路径逃逸中和 / 保留名 / 空回退 / 长度 cap', () => {
    expect(slugifySettingDoc('魔法体系 规则')).toBe('魔法体系-规则');
    expect(slugifySettingDoc('../../evil')).toBe('evil');
    expect(slugifySettingDoc('a/b\\c')).toBe('a-b-c');
    expect(slugifySettingDoc('con')).toBe('con-doc');
    expect(slugifySettingDoc('???')).toBe('untitled');
    expect(slugifySettingDoc('x'.repeat(200))).toHaveLength(80);
  });

  it('isSafeSettingSlug：显式 id 拒绝不改写（穿越/分隔符/控制字符/保留名/前导点/空白）', () => {
    expect(isSafeSettingSlug('../evil')).toBe(false);
    expect(isSafeSettingSlug('a/b')).toBe(false);
    expect(isSafeSettingSlug('a\\b')).toBe(false);
    expect(isSafeSettingSlug('a\x00b')).toBe(false);
    expect(isSafeSettingSlug('a\x1fb')).toBe(false);
    expect(isSafeSettingSlug('con')).toBe(false);
    expect(isSafeSettingSlug('.hidden')).toBe(false);
    expect(isSafeSettingSlug(' padded ')).toBe(false);
    expect(isSafeSettingSlug('x'.repeat(81))).toBe(false);
    expect(isSafeSettingSlug('magic-system')).toBe(true);
    expect(isSafeSettingSlug('魔法体系')).toBe(true);
    // CR-08-16-013：内嵌 '.' 拒绝——派生 slugify 把 '.' 折 '-'，放行会令同一 settingId 经
    // 派生/显式两路径落不同文件（magic-system.md vs magic.system.md），身份空间分叉。
    expect(isSafeSettingSlug('magic.system')).toBe(false);
  });
});

describe('suggest 档（缺省）：setting_md_patch envelope，不写盘', () => {
  it('create_file 从 title 派生 slug → envelope（before="" / after=全文 / created），文件未写', async () => {
    const res = await settingMdUpdateHandler(ctx({
      actions: [{ op: 'create_file', title: '幽冥秘境地理', content: '## 入口\n北境冰原之下。', type: 'location' }],
    }));
    expect(res.metadata?.type).toBe('setting_md_patch');
    const meta = res.metadata as Record<string, unknown>;
    expect(meta.settingId).toBe('幽冥秘境地理');
    expect(meta.before).toBe('');
    expect((meta.after as string).startsWith('---\n')).toBe(true);
    expect(meta.created).toBe(true);
    expect(existsSync(path.join(SETTINGS_DIR, '幽冥秘境地理.md'))).toBe(false);
    expect(reindexSettingMd).not.toHaveBeenCalled();
  });

  it('冲突 -2 不覆盖：既有同名文件 → 派生 slug 加后缀，原文件内容保持', async () => {
    writeFileSync(path.join(SETTINGS_DIR, '桥段笔记.md'), '---\nid: 桥段笔记\n---\n# 原内容', 'utf-8');
    const res = await settingMdUpdateHandler(ctx({
      actions: [{ op: 'create_file', title: '桥段笔记', content: '新内容' }],
    }));
    expect((res.metadata as Record<string, unknown>).settingId).toBe('桥段笔记-2');
    expect(readFileSync(path.join(SETTINGS_DIR, '桥段笔记.md'), 'utf-8')).toContain('原内容');
    expect(existsSync(path.join(SETTINGS_DIR, '桥段笔记-2.md'))).toBe(false); // suggest 不写盘
  });

  it('冲突面含 settings/ 子目录同 frontmatter id 文档（scan 面）', async () => {
    mkdirSync(path.join(SETTINGS_DIR, 'magic'), { recursive: true });
    writeFileSync(path.join(SETTINGS_DIR, 'magic', 'sub.md'), '---\nid: dup-id\n---\n# 子目录文档', 'utf-8');
    expect(pickConflictFreeSettingSlug(PROJECT_DIR, 'dup-id')).toBe('dup-id-2');
  });

  it('span 编辑既有文档 → before=原文 / after=改后，盘上文件不变', async () => {
    const file = path.join(SETTINGS_DIR, 'rules.md');
    writeFileSync(file, '---\nid: rules\n---\n# 规则\n\n第一条规则。', 'utf-8');
    const res = await settingMdUpdateHandler(ctx({
      settingId: 'rules',
      actions: [{ op: 'replace_span', anchor: { quote: '第一条规则。' }, replacement: '第一条规则（修订）。' }],
    }));
    const meta = res.metadata as Record<string, unknown>;
    expect(meta.type).toBe('setting_md_patch');
    expect(meta.before).toContain('第一条规则。');
    expect(meta.after).toContain('第一条规则（修订）。');
    expect(readFileSync(file, 'utf-8')).toContain('第一条规则。'); // 未写盘
  });

  it('定位失败（quote 不存在）→ 友好拒绝，无 envelope 无写盘', async () => {
    const res = await settingMdUpdateHandler(ctx({
      settingId: 'rules',
      actions: [{ op: 'replace_span', anchor: { quote: '不存在的原文' }, replacement: 'x' }],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('被拒');
    expect(res.output).toContain('not found');
  });

  it('span 操作缺 settingId → 拒绝并说明', async () => {
    const res = await settingMdUpdateHandler(ctx({
      actions: [{ op: 'remove_span', anchor: { quote: 'x' } }],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('必须提供 settingId');
  });

  it('显式 settingId 路径穿越 → 拒绝（不改写）', async () => {
    for (const evil of ['../evil', 'a/b', 'a\\b', 'con']) {
      const res = await settingMdUpdateHandler(ctx({
        settingId: evil,
        actions: [{ op: 'remove_span', anchor: { quote: 'x' } }],
      }));
      expect(res.metadata).toBeUndefined();
      expect(res.output).toContain('不是安全的标识符');
    }
  });

  it('空 actions / 非法 action shape → schema 面拒绝', async () => {
    const empty = await settingMdUpdateHandler(ctx({ actions: [] }));
    expect(empty.output).toContain('被拒');
    const bad = await settingMdUpdateHandler(ctx({ actions: [{ op: 'nope_op' }] }));
    expect(bad.output).toContain('被拒');
    const noMeta = await settingMdUpdateHandler(ctx({ settingId: 'rules' }));
    expect(noMeta.output).toContain('被拒');
  });

  it('settings/<id>.md 存在但读不了（目录占位 → EISDIR）→ 友好拒绝不抛穿（CR-08-16-110）', async () => {
    // 目录占位：existsSync=true + readFileSync throws EISDIR——绝不能当「不存在」放行 create_file 语义。
    mkdirSync(path.join(SETTINGS_DIR, 'not-a-file.md'), { recursive: true });
    const res = await settingMdUpdateHandler(ctx({
      settingId: 'not-a-file',
      actions: [{ op: 'replace_span', anchor: { quote: 'x' }, replacement: 'y' }],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('无法读取');
    // 不是「不存在」分支的文案（那会引导 LLM 去 create_file 覆盖）。
    expect(res.output).not.toContain('create it with create_file first');
  });
});

describe('autoApply 档：withProjectLock + 落盘 + 直接 reindex', () => {
  it('create_file autoApply → 写盘（parseSettingMd round-trip 验真）+ reindexSettingMd 调用', async () => {
    const res = await settingMdUpdateHandler(ctx({
      autoApply: true,
      actions: [{ op: 'create_file', title: '北境地理', content: '## 冰原\n终年积雪。', tags: ['地理'] }],
    }));
    expect(res.metadata).toMatchObject({ ok: true, applied: true, settingId: '北境地理', indexed: true });
    const filePath = (res.metadata as Record<string, unknown>).filePath as string;
    expect(existsSync(filePath)).toBe(true);

    // WRITE side mirrors the READ consumer (2.3 parseSettingMd).
    const { frontmatter, body } = parseSettingMd(readFileSync(filePath, 'utf-8'));
    expect(frontmatter.id).toBe('北境地理');
    expect(frontmatter.tags).toEqual(['地理']);
    expect(frontmatter.source).toBe('agent');
    expect(body).toContain('# 北境地理');
    expect(deriveSettingId(path.basename(filePath), frontmatter)).toBe('北境地理');

    expect(reindexSettingMd).toHaveBeenCalledWith(PROJECT_DIR, filePath);
  });

  it('span autoApply → 改写盘上文件（内容落定）+ reindex', async () => {
    const file = path.join(SETTINGS_DIR, 'auto-rules.md');
    writeFileSync(file, '---\nid: auto-rules\n---\n# 规则\n\n第二条规则。', 'utf-8');
    const res = await settingMdUpdateHandler(ctx({
      autoApply: true,
      settingId: 'auto-rules',
      actions: [{ op: 'replace_span', anchor: { quote: '第二条规则。' }, replacement: '第二条规则（已改）。' }],
    }));
    expect(res.metadata).toMatchObject({ ok: true, applied: true });
    expect(readFileSync(file, 'utf-8')).toContain('第二条规则（已改）。');
    expect(reindexSettingMd).toHaveBeenCalled();
  });

  it('reindex 失败 → 文档仍保存 + indexed:false + watcher 恢复提示（never un-save）', async () => {
    vi.mocked(reindexSettingMd).mockRejectedValue(new Error('db locked'));
    const res = await settingMdUpdateHandler(ctx({
      autoApply: true,
      actions: [{ op: 'create_file', title: '降级测试', content: '正文' }],
    }));
    expect(res.metadata).toMatchObject({ ok: true, applied: true, indexed: false });
    expect(res.output).toContain('监视器');
    expect(existsSync(path.join(SETTINGS_DIR, '降级测试.md'))).toBe(true);
  });

  it('reindex 返回 false（项目未注册跳过索引，非 throw）→ indexed:false + 真话文案（CR-08-16-108）', async () => {
    vi.mocked(reindexSettingMd).mockResolvedValue(false);
    const res = await settingMdUpdateHandler(ctx({
      autoApply: true,
      actions: [{ op: 'create_file', title: '未注册项目', content: '正文' }],
    }));
    expect(res.metadata).toMatchObject({ ok: true, applied: true, indexed: false });
    // 不谎称「Reindexed — query_story can retrieve it now」；真话 = 已保存未索引。
    expect(res.output).toContain('尚未同步检索');
    expect(res.output).not.toContain('现在可检索到该文档');
    expect(existsSync(path.join(SETTINGS_DIR, '未注册项目.md'))).toBe(true);
  });

  it('autoApply 定位失败 → 无写盘', async () => {
    const res = await settingMdUpdateHandler(ctx({
      autoApply: true,
      settingId: 'auto-rules',
      actions: [{ op: 'remove_span', anchor: { quote: '不存在的段落' } }],
    }));
    expect(res.metadata).toBeUndefined();
    expect(res.output).toContain('未做任何改动');
    expect(readFileSync(path.join(SETTINGS_DIR, 'auto-rules.md'), 'utf-8')).toContain('第二条规则（已改）。');
  });
});

describe('applyAndPersistSettingMd（accept IPC persist core：重放非写 stale after）', () => {
  it('提议后文件未变 → 重放成功落盘 + reindex', async () => {
    const file = path.join(SETTINGS_DIR, 'accept-fresh.md');
    writeFileSync(file, '---\nid: accept-fresh\n---\n# 文档\n\n目标段落。', 'utf-8');
    const actions = [{ op: 'replace_span' as const, anchor: { quote: '目标段落。' }, replacement: '改后段落。' }];

    const res = await applyAndPersistSettingMd(PROJECT_DIR, 'accept-fresh', actions);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(readFileSync(file, 'utf-8')).toContain('改后段落。');
    expect(res.appliedCount).toBe(1);
    expect(res.indexed).toBe(true);
  });

  it('提议后锚定段被用户改掉 → 重放定位失败 ok:false（防覆盖中间编辑）', async () => {
    const file = path.join(SETTINGS_DIR, 'accept-drift.md');
    writeFileSync(file, '---\nid: accept-drift\n---\n# 文档\n\n锚定段落。', 'utf-8');
    const actions = [{ op: 'replace_span' as const, anchor: { quote: '锚定段落。' }, replacement: 'x' }];

    // 用户在提议与接受之间编辑了锚定段（quote 漂移）。
    writeFileSync(file, '---\nid: accept-drift\n---\n# 文档\n\n锚定段落（用户手改）。', 'utf-8');

    const res = await applyAndPersistSettingMd(PROJECT_DIR, 'accept-drift', actions);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('not found');
    expect(res.reason).toContain('已发生变化');
    // 用户的手改未被覆盖。
    expect(readFileSync(file, 'utf-8')).toContain('用户手改');
  });

  it('提议后文档他处被编辑（锚未漂移）→ 重放仍成功（锚是局部的）', async () => {
    const file = path.join(SETTINGS_DIR, 'accept-unrelated.md');
    writeFileSync(file, '# 文档\n\n锚定段落。', 'utf-8');
    const actions = [{ op: 'insert_after' as const, anchor: { quote: '锚定段落。' }, insertion: '\n\n新段。' }];

    writeFileSync(file, '# 文档\n\n（用户新开头。）\n\n锚定段落。', 'utf-8');

    const res = await applyAndPersistSettingMd(PROJECT_DIR, 'accept-unrelated', actions);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const final = readFileSync(file, 'utf-8');
    expect(final).toContain('（用户新开头。）'); // 中间编辑保留
    expect(final).toContain('新段。'); // 重放成功
  });

  it('显式不安全 slug → ok:false（belt：settings/ 根外不可能触达）', async () => {
    const res = await applyAndPersistSettingMd(PROJECT_DIR, '../evil', [
      { op: 'create_file', title: 'x', content: 'y' },
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain('越出了设定文档目录');
  });
});
