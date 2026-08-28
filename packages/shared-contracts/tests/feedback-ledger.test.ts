import { describe, expect, it } from 'vitest';
import {
  deserializeFeedbackPayload,
  feedbackLedgerPayloadSchema,
  feedbackLedgerReadRequestSchema,
  feedbackLedgerWriteRequestSchema,
  FEEDBACK_LEDGER_ARTIFACT_KEYS,
  serializeFeedbackPayload,
} from '../src/contracts/feedback-ledger';

describe('feedback-ledger (Story 7.4 §2.2)', () => {
  describe('FEEDBACK_LEDGER_ARTIFACT_KEYS', () => {
    it('contains exactly the 3 chain artifacts', () => {
      expect(FEEDBACK_LEDGER_ARTIFACT_KEYS).toEqual([
        'review.latest',
        'emotion_verify_result',
        'completeness_verify_result',
      ]);
    });
  });

  describe('serializeFeedbackPayload / deserializeFeedbackPayload roundtrip', () => {
    it('serializes an artifact object to JSON and deserializes it back', () => {
      const payload = {
        verdict: 'pass',
        dimensions: [
          { name: 'ConStory', severity: 'pass', findings: [] },
        ],
        summary: '本章通过审核',
      };
      const raw = serializeFeedbackPayload(payload);
      expect(typeof raw).toBe('string');

      const restored = deserializeFeedbackPayload(raw);
      expect(restored).toEqual(payload);
    });

    it('roundtrip preserves nested objects + arrays + numbers + booleans', () => {
      const payload = {
        flags: [{ type: 'setpoint-drift', characterId: 'erina', severity: 'warn' }],
        characterArcs: [],
        readerTopology: { directions: ['rise', 'flat'], maxConsecutiveRise: 2 },
        chapterDtwDistance: 0.45,
        degraded: false,
      };
      const restored = deserializeFeedbackPayload(serializeFeedbackPayload(payload));
      expect(restored).toEqual(payload);
    });
  });

  describe('deserializeFeedbackPayload graceful (mirror patchRowToRecord CR-E6)', () => {
    it('returns undefined for malformed JSON (bad syntax)', () => {
      expect(deserializeFeedbackPayload('{not valid json')).toBeUndefined();
    });

    it('returns undefined for non-object JSON (bare string)', () => {
      expect(deserializeFeedbackPayload('"bare string"')).toBeUndefined();
    });

    it('returns undefined for non-object JSON (bare number)', () => {
      expect(deserializeFeedbackPayload('42')).toBeUndefined();
    });

    it('returns undefined for null', () => {
      expect(deserializeFeedbackPayload('null')).toBeUndefined();
    });

    it('returns undefined for array (payload contract is plain object)', () => {
      expect(deserializeFeedbackPayload('[1, 2, 3]')).toBeUndefined();
    });

    it('deserializes empty object correctly', () => {
      expect(deserializeFeedbackPayload('{}')).toEqual({});
    });
  });

  describe('feedbackLedgerPayloadSchema (lenient)', () => {
    it('accepts any plain object (lenient — ledger stores full artifact, does not validate internal)', () => {
      expect(feedbackLedgerPayloadSchema.safeParse({ any: 'shape' }).success).toBe(true);
      expect(
        feedbackLedgerPayloadSchema.safeParse({ verdict: 'pass', nested: { a: [1, 2] } }).success,
      ).toBe(true);
    });

    it('accepts empty object', () => {
      expect(feedbackLedgerPayloadSchema.safeParse({}).success).toBe(true);
    });
  });

  describe('feedbackLedgerWriteRequestSchema', () => {
    it('accepts valid write request', () => {
      const result = feedbackLedgerWriteRequestSchema.safeParse({
        episodeId: 'ep1',
        artifactKey: 'review.latest',
        payload: { verdict: 'pass' },
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty episodeId', () => {
      const result = feedbackLedgerWriteRequestSchema.safeParse({
        episodeId: '',
        artifactKey: 'review.latest',
        payload: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects unknown artifactKey', () => {
      const result = feedbackLedgerWriteRequestSchema.safeParse({
        episodeId: 'ep1',
        artifactKey: 'unknown.key',
        payload: {},
      });
      expect(result.success).toBe(false);
    });

    it('accepts all 3 known artifact keys', () => {
      for (const key of FEEDBACK_LEDGER_ARTIFACT_KEYS) {
        const result = feedbackLedgerWriteRequestSchema.safeParse({
          episodeId: 'ep1',
          artifactKey: key,
          payload: { data: true },
        });
        expect(result.success).toBe(true);
      }
    });
  });

  describe('feedbackLedgerReadRequestSchema', () => {
    it('accepts read with episodeId only (artifactKey optional)', () => {
      const result = feedbackLedgerReadRequestSchema.safeParse({ episodeId: 'ep1' });
      expect(result.success).toBe(true);
    });

    it('accepts read with episodeId + artifactKey', () => {
      const result = feedbackLedgerReadRequestSchema.safeParse({
        episodeId: 'ep1',
        artifactKey: 'emotion_verify_result',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing episodeId', () => {
      const result = feedbackLedgerReadRequestSchema.safeParse({ artifactKey: 'review.latest' });
      expect(result.success).toBe(false);
    });
  });
});
