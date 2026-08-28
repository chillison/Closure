import { describe, expect, it } from 'vitest';
import {
  generateTextPayloadSchema,
  generationLaneSchema,
  textGenerationRequestSchema,
} from '../src/contracts/generation';

// ─────────────────────────────────────────────────────────────────────────────
// dogfood R2 #7：TextGenerationRequest.lane 派发车道（可选字段）——schema 往返与
// 缺省零回归门。lane 是纯 additive 可选枚举：不带 lane 的既有 payload 解析不变
// （interactive 语义）；'background' 经 JSON 序列化往返后存活（agent seam → shell
// 网关 → 协议层的透传链依赖这一点）；非法值在 IPC 边界被拒。
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST = {
  model: 'test-model',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('textGenerationRequestSchema.lane (dogfood R2 #7)', () => {
  it('不带 lane 的请求解析通过且字段缺席（既有 payload 零回归门）', () => {
    const parsed = textGenerationRequestSchema.parse(BASE_REQUEST);
    expect(parsed.model).toBe('test-model');
    expect('lane' in parsed).toBe(false);
  });

  it("lane:'background' / 'dialogue' 均接受，且 JSON 序列化往返存活（seam 透传链前提）", () => {
    for (const lane of ['background', 'dialogue'] as const) {
      const parsed = textGenerationRequestSchema.parse({ ...BASE_REQUEST, lane });
      expect(parsed.lane).toBe(lane);
      // IPC 通道以 JSON 序列化传输——undefined 字段自然缺席，lane 必须存活。
      const roundTripped = JSON.parse(JSON.stringify(parsed));
      expect(textGenerationRequestSchema.parse(roundTripped).lane).toBe(lane);
    }
  });

  it('非法 lane 值被拒（IPC 边界守门）', () => {
    expect(generationLaneSchema.safeParse('bulk').success).toBe(false);
    expect(textGenerationRequestSchema.safeParse({ ...BASE_REQUEST, lane: 'urgent' }).success).toBe(false);
  });

  it('generateTextPayloadSchema 整体携带 lane 往返（agent seam → shell 网关载荷形态）', () => {
    const payload = {
      ref: { keyId: 'k1', modelId: 'm1' },
      request: { ...BASE_REQUEST, lane: 'background' as const },
    };
    const parsed = generateTextPayloadSchema.parse(JSON.parse(JSON.stringify(payload)));
    expect(parsed.request.lane).toBe('background');
  });
});
