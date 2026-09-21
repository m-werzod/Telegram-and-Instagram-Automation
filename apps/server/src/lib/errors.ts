/**
 * Application error hierarchy. `retryable` drives queue retry behavior:
 * non-retryable failures go straight to dead-letter/FAILED instead of
 * burning retries on errors that can never succeed.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    message: string,
    opts: { statusCode?: number; code?: string; retryable?: boolean; detail?: unknown } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = opts.statusCode ?? 500;
    this.code = opts.code ?? 'internal_error';
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, detail?: unknown) {
    super(message, { statusCode: 400, code: 'validation_error', retryable: false, detail });
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, { statusCode: 401, code: 'auth_required', retryable: false });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, { statusCode: 403, code: 'forbidden', retryable: false });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super(message, { statusCode: 404, code: 'not_found', retryable: false });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, { statusCode: 409, code: 'conflict', retryable: false });
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterMs?: number;
  constructor(message = 'Rate limited', retryAfterMs?: number) {
    super(message, { statusCode: 429, code: 'rate_limited', retryable: true });
    this.retryAfterMs = retryAfterMs;
  }
}

/** External API failure (Meta, Telegram, AI provider). */
export class ExternalApiError extends AppError {
  readonly provider: string;
  constructor(
    provider: string,
    message: string,
    opts: { statusCode?: number; retryable?: boolean; detail?: unknown } = {},
  ) {
    super(`[${provider}] ${message}`, {
      statusCode: opts.statusCode ?? 502,
      code: 'external_api_error',
      retryable: opts.retryable ?? true,
      detail: opts.detail,
    });
    this.provider = provider;
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof AppError ? err.retryable : true; // unknown errors default to retryable
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
