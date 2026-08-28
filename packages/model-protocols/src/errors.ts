/**
 * Errors raised by the model-protocols layer. Callers (desktop main IPC) map
 * these to renderer-friendly messages; agent maps them to run warnings.
 */

export class ProtocolHttpError extends Error {
  readonly status: number;
  readonly bodyExcerpt?: string;
  constructor(message: string, status: number, bodyExcerpt?: string) {
    super(message);
    this.name = 'ProtocolHttpError';
    this.status = status;
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class ProtocolSchemaError extends Error {
  readonly issues: unknown;
  constructor(message: string, issues?: unknown) {
    super(message);
    this.name = 'ProtocolSchemaError';
    this.issues = issues;
  }
}

export class ProtocolCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolCapabilityError';
  }
}

/**
 * Raised when a streaming request never produced its first event within the
 * first-event timeout window (dogfood T1 D2 hardening). Classified as a
 * connection-window failure: callers may retry it, but must NOT fall back to
 * an unbounded non-streaming call (that would reintroduce the #50 hang).
 */
export class ProtocolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolTimeoutError';
  }
}

/**
 * Raised when an established stream died after content had already been
 * produced (dogfood T1 design §1.3). Carries the accumulated text/reasoning so
 * the caller (runLoop) can persist partial output instead of silently losing
 * everything the user already saw streamed.
 */
export class StreamInterruptedError extends ProtocolHttpError {
  readonly accumulatedText: string;
  readonly accumulatedReasoning?: string;
  constructor(details: {
    message: string;
    accumulatedText: string;
    accumulatedReasoning?: string;
    status?: number;
    bodyExcerpt?: string;
  }) {
    super(details.message, details.status ?? 502, details.bodyExcerpt);
    this.name = 'StreamInterruptedError';
    this.accumulatedText = details.accumulatedText;
    this.accumulatedReasoning = details.accumulatedReasoning;
  }
}

/**
 * Context-window overflow (thinking adapters task, design §4.1): a 4xx whose
 * report names the context limit ("context length" / "context window" /
 * "prompt is too long" family — snake-case codes like `context_length_exceeded`
 * normalize to the same matches). Carries the stable `code` marker so the
 * agent layer can trigger one compaction retry instead of surfacing a raw 400;
 * subclasses ProtocolHttpError so existing status-based classification keeps
 * working.
 */
export class ProtocolContextOverflowError extends ProtocolHttpError {
  readonly code = 'CONTEXT_OVERFLOW' as const;
  constructor(message: string, status: number, bodyExcerpt?: string) {
    super(message, status, bodyExcerpt);
    this.name = 'ProtocolContextOverflowError';
  }
}

/**
 * Predicate form (belt to the class marking): recognizes both marked errors
 * AND raw ProtocolHttpErrors whose report matches the overflow family — the
 * compat-retry paths can surface the raw shape without re-marking.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof ProtocolContextOverflowError) return true;
  if (!(err instanceof ProtocolHttpError)) return false;
  const haystack = `${err.message}\n${err.bodyExcerpt ?? ''}`.toLowerCase().replace(/[_-]/g, ' ');
  return (
    haystack.includes('context length') ||
    haystack.includes('context window') ||
    haystack.includes('prompt is too long') ||
    haystack.includes('input is too long')
  );
}

export class ProtocolNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolNotImplementedError';
  }
}
