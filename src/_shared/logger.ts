// Logs structurés JSON — exploitables tels quels dans les logs Supabase
// (filtrage par tenant_id / conversation_id / event).
//
// Redaction obligatoire : aucun secret, token ou contenu de message brut ne
// doit atterrir dans les logs (RGPD + sécurité).

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

const MAX_STRING = 200;

/**
 * Segments de nom considérés comme sensibles.
 *
 * La détection se fait par SEGMENT et non par sous-chaîne : un simple
 * `/token|key/i` masquait `inputTokens` (toutes les métriques de coût du modèle
 * devenaient illisibles) et `keyword` (impossible de savoir quel mot-clé avait
 * déclenché une escalade). Masquer trop est un bug silencieux : on ne s'en
 * aperçoit qu'en cherchant une information qui n'est jamais là.
 */
const SENSITIVE_SEGMENTS = new Set([
  "token",
  "tokens",
  "secret",
  "secrets",
  "key",
  "keys",
  "apikey",
  "authorization",
  "auth",
  "credential",
  "credentials",
  "password",
  "passwd",
  "signature",
  "jwt",
  "bearer",
  "cookie",
]);

/** Compteurs dont le nom contient `tokens` sans être un secret. */
const COUNTER_KEYS = new Set([
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "max_tokens",
  "budget_tokens",
  "thinking_tokens",
  "cache_read_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

/** `accessToken` / `ACCESS_TOKEN` / `access-token` → `access_token`. */
function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (COUNTER_KEYS.has(normalized)) return false;
  return normalized.split("_").some((segment) => SENSITIVE_SEGMENTS.has(segment));
}

function redact(value: unknown, key?: string): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[tronqué]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

function emit(level: LogLevel, event: string, context: LogContext = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(context) as LogContext),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, ctx?: LogContext) => emit("debug", event, ctx),
  info: (event: string, ctx?: LogContext) => emit("info", event, ctx),
  warn: (event: string, ctx?: LogContext) => emit("warn", event, ctx),
  error: (event: string, ctx?: LogContext) => emit("error", event, ctx),
};

/** Logger pré-rempli avec les identifiants de corrélation d'un tour d'agent. */
export function scopedLogger(base: LogContext) {
  return {
    debug: (event: string, ctx?: LogContext) => emit("debug", event, { ...base, ...ctx }),
    info: (event: string, ctx?: LogContext) => emit("info", event, { ...base, ...ctx }),
    warn: (event: string, ctx?: LogContext) => emit("warn", event, { ...base, ...ctx }),
    error: (event: string, ctx?: LogContext) => emit("error", event, { ...base, ...ctx }),
  };
}

export type ScopedLogger = ReturnType<typeof scopedLogger>;
