import { describe, expect, it } from 'vitest';
import {
  worldSubjectId,
  worldSubjectMatchKey,
  worldSubjectSlug,
  worldSubjectSlugKey,
} from '../src';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #91：subject ID 单源生成器（形态规范 + 归一匹配键）。
//
// 背景：五提取器 ID 规则不一致——同一角色 `shen-yan` / `character:shen-yan` / `character:shenyan`
// 三形态并存（project 00004 落库实证）。本套覆盖：前缀剥离 / 大小写 / 空白 / 连字符 / 中文 /
// 退化输入 / 幂等性 / 匹配键归并。
// ─────────────────────────────────────────────────────────────────────────────

describe('worldSubjectSlug（slug 形态规范化）', () => {
  it('剥类型式前缀段（单段/多段）', () => {
    expect(worldSubjectSlug('character:shen-yan')).toBe('shen-yan');
    expect(worldSubjectSlug('group:archaeology-team')).toBe('archaeology-team');
    expect(worldSubjectSlug('faction:phoenix')).toBe('phoenix');
    // 多层前缀全剥
    expect(worldSubjectSlug('character:group:x')).toBe('x');
  });

  it('裸 slug 幂等（无前缀原样过）', () => {
    expect(worldSubjectSlug('shen-yan')).toBe('shen-yan');
    expect(worldSubjectSlug('cryo_pod_01')).toBe('cryo_pod_01'); // 下划线保留（id 契约 [\w-]）
    expect(worldSubjectSlug('group:archaeology-team')).toBe('archaeology-team');
  });

  it('小写化 + 空白串折叠为连字符 + 连字符叠折 + 缘剥离', () => {
    expect(worldSubjectSlug('Shen Yan')).toBe('shen-yan');
    expect(worldSubjectSlug('  Shen   Yan  ')).toBe('shen-yan');
    expect(worldSubjectSlug('shen--yan')).toBe('shen-yan');
    expect(worldSubjectSlug('Character:SHEN-YAN')).toBe('shen-yan');
    expect(worldSubjectSlug('-shen-yan-')).toBe('shen-yan');
    // 全角空格（U+3000）等 Unicode whitespace 同折
    expect(worldSubjectSlug('shen　yan')).toBe('shen-yan');
  });

  it('中文本体保留（转拼音是语义判断归提取器 LLM，纯代码不臆造）', () => {
    expect(worldSubjectSlug('character:沈砚')).toBe('沈砚');
    expect(worldSubjectSlug('沈砚')).toBe('沈砚');
  });

  it('退化输入回退固定占位（定点——再过本函数稳定不变，防叠层增长）', () => {
    // ⚠️ 不能回退原始串：`character:` 原样回退后经 worldSubjectId 组 `<type>:<slug>` 会每轮叠一层
    // 前缀（`character:` → `character:character:` → …），迁移每启动改名一次（非幂等）。
    expect(worldSubjectSlug('character:')).toBe('unnamed');
    expect(worldSubjectSlug('character: ')).toBe('unnamed');
    expect(worldSubjectSlug('a:b:')).toBe('unnamed');
    expect(worldSubjectSlug('-')).toBe('unnamed');
    expect(worldSubjectSlug('   ')).toBe('unnamed');
    expect(worldSubjectSlug('')).toBe('unnamed');
    // '::' 非退化——无字母前缀段可剥、本体 '::' 非空 → 原样保留（定点）。
    expect(worldSubjectSlug('::')).toBe('::');
  });
});

describe('幂等性（canonical 定点：id(id(x)) == id(x)）', () => {
  // #91 验收锚：迁移 + 写入门都假设「已规范形态再过单源稳定不变」——退化输入若非定点，
  // 迁移会每启动重改名（重写 patch/checkpoint 引用），违幂等契约。中文 / 连字符变体 /
  // 退化占位 / 多层前缀全数覆盖。
  const inputs = [
    'shen-yan',
    'character:shen-yan',
    'character:shenyan',
    'Shen Yan',
    '沈砚',
    'character:沈砚',
    'cryo_pod_01',
    'group:archaeology-team',
    'character:',
    '-',
    '::',
    'entity:unnamed',
  ];
  const types = ['character', 'item', 'group', '', 'Character'];

  it('worldSubjectId：canonical(canonical(x)) == canonical(x)（全输入 × 类型电池）', () => {
    for (const t of types) {
      for (const x of inputs) {
        const once = worldSubjectId(t, x);
        expect(worldSubjectId(t, once)).toBe(once);
      }
    }
  });

  it('worldSubjectSlug：slug(slug(x)) == slug(x)', () => {
    for (const x of inputs) {
      const once = worldSubjectSlug(x);
      expect(worldSubjectSlug(once)).toBe(once);
    }
  });

  it('worldSubjectMatchKey：canonical 化不改键（matchKey(t, id(t,x)) == matchKey(t,x)）', () => {
    for (const t of types) {
      for (const x of inputs) {
        expect(worldSubjectMatchKey(t, worldSubjectId(t, x))).toBe(worldSubjectMatchKey(t, x));
      }
    }
  });

  it('worldSubjectSlugKey：再过自身稳定', () => {
    for (const x of inputs) {
      const sk = worldSubjectSlugKey(x);
      expect(worldSubjectSlugKey(sk)).toBe(sk);
    }
  });
});

describe('worldSubjectId（规范 id = `<type>:<slug>`）', () => {
  it('canonical 生产（dogfood R2 #91 实证三形态 → 统一形态）', () => {
    // project 00004 实际分身三形态：前缀有无 + 连字符差异
    expect(worldSubjectId('character', 'shen-yan')).toBe('character:shen-yan');
    expect(worldSubjectId('character', 'character:shen-yan')).toBe('character:shen-yan');
    // ⚠️ 无连字符变体 canonical 后仍无连字符（连字符位置不可机械推断）——归并靠 matchKey，非 canonical 幂等
    expect(worldSubjectId('character', 'character:shenyan')).toBe('character:shenyan');
  });

  it('幂等：已规范形态返回自身', () => {
    expect(worldSubjectId('character', 'character:shen-yan')).toBe('character:shen-yan');
    expect(worldSubjectId('item', 'item:cryo-pod-01')).toBe('item:cryo-pod-01');
    expect(worldSubjectId('group', 'group:archaeology-team')).toBe('group:archaeology-team');
  });

  it('type 小写化 + 空串 entity 兜底', () => {
    expect(worldSubjectId('Character', 'shen-yan')).toBe('character:shen-yan');
    expect(worldSubjectId('', 'x')).toBe('entity:x');
  });

  it('裸 id 补前缀（形态收敛——xiao-guan → character:xiao-guan）', () => {
    expect(worldSubjectId('character', 'xiao-guan')).toBe('character:xiao-guan');
    expect(worldSubjectId('item', 'cryo-pod-01')).toBe('item:cryo-pod-01');
  });
});

describe('worldSubjectMatchKey（归一匹配键——分身归并/查重复用）', () => {
  it('dogfood R2 #91 实证三形态同键（前缀有无 + 连字符）', () => {
    const k1 = worldSubjectMatchKey('character', 'shen-yan');
    const k2 = worldSubjectMatchKey('character', 'character:shen-yan');
    const k3 = worldSubjectMatchKey('character', 'character:shenyan');
    expect(k1).toBe('character:shenyan');
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
  });

  it('大小写 / 空白 / 下划线变体同键', () => {
    const base = worldSubjectMatchKey('character', 'shen-yan');
    expect(worldSubjectMatchKey('character', 'Shen Yan')).toBe(base);
    expect(worldSubjectMatchKey('Character', 'SHEN-YAN')).toBe(base);
    expect(worldSubjectMatchKey('character', 'shen_yan')).toBe(base);
  });

  it('type 参与键（同 slug 异 type 不归并）', () => {
    expect(worldSubjectMatchKey('character', 'phoenix')).not.toBe(worldSubjectMatchKey('faction', 'phoenix'));
  });

  it('空 type → entity 兜底（mirror worldSubjectId）', () => {
    expect(worldSubjectMatchKey('', 'x')).toBe('entity:x');
  });
});

describe('worldSubjectSlugKey（无 type 语境 slug-only 键——ref 解析用）', () => {
  it('去连字符/下划线（与 matchKey 的 slug 段同规则）', () => {
    expect(worldSubjectSlugKey('character:shen-yan')).toBe('shenyan');
    expect(worldSubjectSlugKey('shenyan')).toBe('shenyan');
    expect(worldSubjectSlugKey('shen_yan')).toBe('shenyan');
  });
});
