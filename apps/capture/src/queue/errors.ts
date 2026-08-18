export type QueueTransportErrorKind =
  | "unknown_success"
  | "retryable"
  | "credential_expired"
  | "terminal";

/**
 * Metadata-only error boundary for BFF/upload adapters. Do not put response
 * bodies, URLs, tokens, object paths, or clinical values in `code`.
 */
export class QueueTransportError extends Error {
  readonly kind: QueueTransportErrorKind;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(
    kind: QueueTransportErrorKind,
    code: string,
    options: { readonly retryAfterMs?: number; readonly cause?: unknown } = {},
  ) {
    super(code, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "QueueTransportError";
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export class QueueInvariantError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "QueueInvariantError";
    this.code = code;
  }
}

export class QueueConcurrencyError extends QueueInvariantError {
  constructor() {
    super("queue_concurrent_update_limit");
    this.name = "QueueConcurrencyError";
  }
}
