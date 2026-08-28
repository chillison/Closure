/**
 * CR-017（8.6 BMad CR）：`creative.tabs.*` i18n label 无穷尽守卫。
 *
 * PatchReviewPanel 以 `t(\`creative.tabs.${entry.field}\`)` 渲染 field label——creativeFieldKeys
 * 加键而 i18n 漏登时，缺键回落裸键名（用户看到 "arc_registry" 而非「弧节拍」）。实证教训：
 * arc_registry 漏键三年 + 8.6 又漏 creative_preferences 两例（zh-CN/en-US 两 locale 都漏过）。
 * 本测试穷尽断言 creativeFieldKeys ⊆ 两 locale 的 tabs 键全集——加 field 漏登即红。
 *
 * 走 `translate`（useI18n 的非 hook 通道，同一 locale cache——eager glob 解析的真 yaml）；
 * 缺键时 translate 回落**键本身**，故 `label !== key` 即「有 label」。
 */
import { describe, expect, it } from 'vitest';
import { creativeFieldKeys } from '@orison/shared-contracts';
import { translate } from '../src/shared/i18n/useI18n';

describe('CR-017：creative.tabs i18n label 穷尽守卫（creativeFieldKeys ⊆ 两 locale tabs 键全集）', () => {
  for (const locale of ['zh-CN', 'en-US']) {
    it(`${locale}：每个 creativeFieldKey 都有 creative.tabs.* label（非裸键名、非空）`, () => {
      expect(creativeFieldKeys.length).toBeGreaterThan(0);
      for (const key of creativeFieldKeys) {
        const label = translate(locale, `creative.tabs.${key}`);
        // 缺键回落裸键名（translate 的 fallback 契约）——等于键即漏登。
        expect(label, `${locale} 缺 creative.tabs.${key}（PatchReview 会显裸键名）`).not.toBe(`creative.tabs.${key}`);
        expect(label.trim().length, `${locale} creative.tabs.${key} label 不得为空白`).toBeGreaterThan(0);
      }
    });
  }
});
