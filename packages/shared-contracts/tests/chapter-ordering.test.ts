import { describe, expect, it } from 'vitest';
import {
  landingIndexOfChapter,
  sortChapterOrderingEntries,
  wouldChapterLandAtOrder,
  type ChapterOrderingEntry,
} from '../src/contracts/chapter-ordering';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #107 / R1.1：章序单源（原 ui chapterDiskDerivation.sortDiskChapters
// 私有逻辑逐字提取）。本套锁定提取前既有语义：
// - sort_order = 排序后位置（order 0,2,5 → 位置 0,1,2），非 order 原值；
// - hasExplicitOrder 全局开关：任一文件带 order → 全体按 order 排、缺序垫底；
// - 同分决胜 = 文件名 Intl.Collator(numeric:true, sensitivity:'base')；
// - 全无 order → 纯文件名自然序（numeric 感知：第9章 < 第10章）。
// 断言只依赖 numeric/latin 决胜（跨机器默认 locale 稳定），不断言不同 CJK 字串的相对序。
// ─────────────────────────────────────────────────────────────────────────────

function entry(id: string, fileName: string, explicitOrder: number | null): ChapterOrderingEntry {
  return { id, fileName, explicitOrder };
}

// ════════════════════════════════════════════════════════════════════════════
// sortChapterOrderingEntries
// ════════════════════════════════════════════════════════════════════════════

describe('sortChapterOrderingEntries — 派生排序规则（#107 单源）', () => {
  it('全无 order → 纯文件名自然序（numeric collation：第9章-x < 第10章-x）', () => {
    const sorted = sortChapterOrderingEntries([
      entry('第10章-x', '第10章-x.md', null),
      entry('第2章-x', '第2章-x.md', null),
      entry('第9章-x', '第9章-x.md', null),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['第2章-x', '第9章-x', '第10章-x']);
  });

  it('任一文件带 order → 全体按 explicitOrder 排，缺 order 者垫底（MAX_SAFE_INTEGER 语义）', () => {
    const sorted = sortChapterOrderingEntries([
      entry('bare-a', '第9章-bare-a.md', null),
      entry('order-5', '第5章.md', 5),
      entry('order-0', '第1章.md', 0),
      entry('bare-b', '第10章-bare-b.md', null),
    ]);
    // 全局开关：bare 文件虽文件名更小，仍按「缺序」垫底；垫底者之间按 collator。
    expect(sorted.map((e) => e.id)).toEqual(['order-0', 'order-5', 'bare-a', 'bare-b']);
  });

  it('order 有洞（0,2,5）→ 保持显式序，位置即 0,1,2（sort_order 位置语义的根）', () => {
    const sorted = sortChapterOrderingEntries([
      entry('hole-5', '第6章.md', 5),
      entry('hole-0', '第1章.md', 0),
      entry('hole-2', '第3章.md', 2),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['hole-0', 'hole-2', 'hole-5']);
    // 排序后下标即派生 sort_order（mergeDiskAndStoredChapters sortOrder:index）。
    expect(sorted.map((_, index) => index)).toEqual([0, 1, 2]);
  });

  it('同 order 平分 → 文件名 collator 决胜（-a < -b < -c）', () => {
    const sorted = sortChapterOrderingEntries([
      entry('t2', '第2章-c.md', 2),
      entry('t0', '第2章-a.md', 2),
      entry('t1', '第2章-b.md', 2),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['t0', 't1', 't2']);
  });

  it('不改入参数组（拷贝排序）；元素保留调用方扩展字段（generic）', () => {
    interface RichEntry extends ChapterOrderingEntry {
      title: string;
    }
    const input: RichEntry[] = [
      { id: 'b', fileName: 'b.md', explicitOrder: 1, title: '乙' },
      { id: 'a', fileName: 'a.md', explicitOrder: 0, title: '甲' },
    ];
    const sorted = sortChapterOrderingEntries(input);
    expect(input.map((e) => e.id)).toEqual(['b', 'a']); // 原数组顺序不变
    expect(sorted.map((e) => e.id)).toEqual(['a', 'b']);
    expect(sorted[0].title).toBe('甲'); // 扩展字段随引用保留
    expect(sorted[0]).toBe(input[1]); // 元素是原引用（非拷贝）
  });

  it('空集 → 空数组', () => {
    expect(sortChapterOrderingEntries([])).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// landingIndexOfChapter / wouldChapterLandAtOrder（R1.1d 落位守卫）
// ════════════════════════════════════════════════════════════════════════════

describe('wouldChapterLandAtOrder — 建章落位守卫（R1.1d 防 order 有洞/混排错位）', () => {
  it('空集 + order 0 → 必然落位 0（首章场景，AC1/AC2 的守卫零成本放行）', () => {
    expect(wouldChapterLandAtOrder([], entry('第01章', '第01章-挖出来的是什么.md', 0), 0)).toBe(true);
    expect(landingIndexOfChapter([], entry('第01章', '第01章-挖出来的是什么.md', 0))).toBe(0);
  });

  it('顺序密集 0..k 已占 + 新章 order k+1 → 落位 k+1（密集时位置===order）', () => {
    const existing = [
      entry('c0', '第01章.md', 0),
      entry('c1', '第02章.md', 1),
      entry('c2', '第03章.md', 2),
    ];
    expect(wouldChapterLandAtOrder(existing, entry('c3', '第04章.md', 3), 3)).toBe(true);
  });

  it('order 有洞 {0,2,5} + 新章 order 7 → 落位 3 ≠ 7 → false（AC4：不自动建错位章）', () => {
    const existing = [
      entry('c0', '第1章.md', 0),
      entry('c2', '第3章.md', 2),
      entry('c5', '第6章.md', 5),
    ];
    // 位置压缩：0,2,5 三章占位 0,1,2，新章 order 7 落位 3 而非 7。
    expect(landingIndexOfChapter(existing, entry('c7', '第8章.md', 7))).toBe(3);
    expect(wouldChapterLandAtOrder(existing, entry('c7', '第8章.md', 7), 7)).toBe(false);
  });

  it('插进洞里（{0,1,3} + 新章 order 2）→ 落位 2 → true（补洞仍正确，守卫按实际落位判）', () => {
    const existing = [
      entry('c0', '第1章.md', 0),
      entry('c1', '第2章.md', 1),
      entry('c3', '第4章.md', 3),
    ];
    expect(landingIndexOfChapter(existing, entry('c2', '第3章.md', 2))).toBe(2);
    expect(wouldChapterLandAtOrder(existing, entry('c2', '第3章.md', 2), 2)).toBe(true);
  });

  it('混排（部分带 order 部分裸）→ 裸文件垫底把新章挤前 → 落位 ≠ order 原值 → false', () => {
    const existing = [
      entry('c0', '第1章.md', 0),
      entry('c1', '第2章.md', 1),
      entry('bare', '裸章.md', null),
    ];
    // hasExplicitOrder 全局开关：裸章垫底；新章 order 5 落位 2（在裸章之前被压缩）。
    expect(landingIndexOfChapter(existing, entry('c5', '第6章.md', 5))).toBe(2);
    expect(wouldChapterLandAtOrder(existing, entry('c5', '第6章.md', 5), 5)).toBe(false);
  });

  it('全裸集 + 新章也裸 → collator 自然序决定落位', () => {
    const existing = [
      entry('第1章', '第1章.md', null),
      entry('第2章', '第2章.md', null),
    ];
    const next = entry('第3章', '第3章.md', null);
    expect(wouldChapterLandAtOrder(existing, next, 2)).toBe(true); // 第1,第2,第3
    expect(wouldChapterLandAtOrder(existing, next, 0)).toBe(false);
  });

  it('同 order 竞争（existing 与新章共 order 0）→ collator 决胜，新章落位 1 ≠ 0 → false', () => {
    const existing = [entry('a', '第1章-a.md', 0)];
    expect(landingIndexOfChapter(existing, entry('b', '第1章-b.md', 0))).toBe(1);
    expect(wouldChapterLandAtOrder(existing, entry('b', '第1章-b.md', 0), 0)).toBe(false);
  });

  it('newEntry 同引用已在 existingEntries（重跑覆盖形态）→ 不双计，落位按单一计', () => {
    const again = entry('c0', '第1章.md', 0);
    const existing = [
      again,
      entry('c5', '第6章.md', 5),
    ];
    // 覆盖语义：同一文件不算两章——落位 0（若双计 [c0,c0,c5] 首现同 0，但守卫语义显式单计）。
    expect(landingIndexOfChapter(existing, again)).toBe(0);
    expect(wouldChapterLandAtOrder(existing, again, 0)).toBe(true);
  });

  it('wouldChapterLandAtOrder 是 landingIndexOfChapter===targetIndex 的谓词（一致性抽查）', () => {
    const existing = [entry('c0', '第1章.md', 0), entry('c1', '第2章.md', 1)];
    const next = entry('c9', '第10章.md', 9);
    const landing = landingIndexOfChapter(existing, next);
    expect(landing).toBe(2);
    expect(wouldChapterLandAtOrder(existing, next, landing)).toBe(true);
    expect(wouldChapterLandAtOrder(existing, next, landing + 1)).toBe(false);
  });
});
