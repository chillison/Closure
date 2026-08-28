import { describe, expect, it } from 'vitest';
import { indexStatusSchema, isVectorArmDegraded } from '../src';

// dogfood #39（T2 Batch C，2026-08-25）：向量臂降级判定的纯谓词测试——该谓词同时驱动
// shell 启动 reconcile（自动重建触发）与 closure:index-status 状态面（UI 降级横幅），
// 语义在此钉死防两消费端漂移。
describe('isVectorArmDegraded (dogfood #39 T2)', () => {
  it('未配置模型 → 永不降级（FTS-only 是预期态，非缺陷）', () => {
    expect(
      isVectorArmDegraded({ configuredModelId: null, pending: 5, storedModels: ['other-m'] }),
    ).toBe(false);
  });

  it('已配置 + pending 积压 → 降级（台账 #39 实录形态：重建失败后全行改写为 pending、provenance 归 NULL）', () => {
    expect(
      isVectorArmDegraded({ configuredModelId: 'm-new', pending: 1, storedModels: [] }),
    ).toBe(true);
  });

  it('已配置 + 存量含其他模型 → 降级（即使零 pending——几何空间失效）', () => {
    expect(
      isVectorArmDegraded({ configuredModelId: 'm-new', pending: 0, storedModels: ['m-old'] }),
    ).toBe(true);
  });

  it('混合存量（部分已迁部分未迁）→ 降级', () => {
    expect(
      isVectorArmDegraded({ configuredModelId: 'm-new', pending: 0, storedModels: ['m-new', 'm-old'] }),
    ).toBe(true);
  });

  it('已配置 + 存量模型全部一致 + 零 pending → 健康', () => {
    expect(
      isVectorArmDegraded({ configuredModelId: 'm', pending: 0, storedModels: ['m', 'm'] }),
    ).toBe(false);
  });

  it('已配置 + 无任何存量 + 零 pending → 健康（尚无东西可索引）', () => {
    expect(isVectorArmDegraded({ configuredModelId: 'm', pending: 0, storedModels: [] })).toBe(false);
  });
});

describe('indexStatusSchema additive fields (dogfood #39 T2 C2)', () => {
  const SAMPLE = {
    embeddingConfiguredModelId: 'embed-m',
    craft: { count: 1, pending: 0, model: 'embed-m', degraded: false },
    story: {
      projectId: '00001',
      projectAssets: 1,
      assetCards: 2,
      settingMd: 0,
      chapterChunks: 3,
      chapterSummaries: 1,
      pending: 4,
      model: null,
      degraded: true,
    },
  };

  it('parses the configured-model + degraded fields', () => {
    const parsed = indexStatusSchema.parse(SAMPLE);
    expect(parsed.embeddingConfiguredModelId).toBe('embed-m');
    expect(parsed.craft.degraded).toBe(false);
    expect(parsed.story.degraded).toBe(true);
  });

  it('embeddingConfiguredModelId nullable (unconfigured state)', () => {
    const parsed = indexStatusSchema.parse({
      ...SAMPLE,
      embeddingConfiguredModelId: null,
    });
    expect(parsed.embeddingConfiguredModelId).toBeNull();
  });
});
