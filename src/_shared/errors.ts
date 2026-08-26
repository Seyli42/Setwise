// Erreurs typées + retry avec backoff exponentiel.
//
// Distinction clé : `retryable` décide si la queue (`webhook_events`) doit
// reprogrammer l'event ou le marquer `failed` immédiatement. Une erreur de
// validation ne devient jamais valide en réessayant — la réessayer 6 fois ne
// fait que retarder l'alerte au gérant.

export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly context: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    opts: { retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.context = opts.context ?? {};
  }
}

/** Payload invalide, config manquante, signature webhook fausse. Jamais réessayé. */
export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, unknown>) {
    super("validation_error", message, { retryable: false, context });
  }
}

/** API tierce (Meta, Google, Anthropic, Stripe) indisponible ou en erreur. */
export class ExternalApiError extends AppError {
  readonly status?: number;

  constructor(
    service: string,
    message: string,
    opts: { status?: number; retryable?: boolean; context?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    // 4xx (hors 408/429) = requête fautive → inutile de réessayer.
    const retryable = opts.retryable ??
      (opts.status === undefined ||
        opts.status >= 500 ||
        opts.status === 408 ||
        opts.status === 429);
    super("external_api_error", `[${service}] ${message}`, {
      retryable,
      context: { service, status: opts.status, ...opts.context },
      cause: opts.cause,
    });
    this.status = opts.status;
  }
}

/** Erreur base de données. Réessayable par défaut (contention, timeout). */
export class DatabaseError extends AppError {
  constructor(message: string, opts: { context?: Record<string, unknown>; cause?: unknown } = {}) {
    super("database_error", message, { retryable: true, ...opts });
  }
}

export function isRetryable(error: unknown): boolean {
  return error instanceof AppError ? error.retryable : true; // inconnu → on retente
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Réessaie `fn` tant que l'erreur est réessayable. Backoff exponentiel + jitter
 * pour éviter que N invocations concurrentes retapent l'API tierce en phase.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 300;
  const maxDelayMs = opts.maxDelayMs ?? 8_000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;

      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(exponential * (0.5 + Math.random() * 0.5)); // jitter 50–100 %
      opts.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
