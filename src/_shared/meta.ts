// Socle commun Meta : vérification de signature des webhooks + client Graph API.
// Partagé par Instagram DM et WhatsApp Cloud API (même App Secret, même Graph).

import { optionalEnv, requireEnv } from "./env.ts";
import { ExternalApiError, ValidationError } from "./errors.ts";

export const GRAPH_VERSION = optionalEnv("META_GRAPH_VERSION", "v21.0");
export const GRAPH_BASE = optionalEnv("META_GRAPH_BASE", "https://graph.facebook.com");

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Comparaison à temps constant : une comparaison naïve fuite la signature octet par octet. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Vérifie l'en-tête `X-Hub-Signature-256` de Meta.
 *
 * Le corps DOIT être le texte brut reçu, jamais un JSON re-sérialisé : Meta
 * signe les octets exacts, et `JSON.stringify(JSON.parse(body))` change
 * l'ordre des clés et l'échappement — la signature ne correspondrait plus.
 */
export async function verifyMetaSignature(rawBody: string, header: string | null): Promise<boolean> {
  if (!header) return false;

  const [scheme, signature] = header.split("=");
  if (scheme !== "sha256" || !signature) return false;

  const expected = hexToBytes(signature);
  if (!expected) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requireEnv("META_APP_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const computed = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody)));

  return timingSafeEqual(computed, expected);
}

/**
 * Handshake de vérification de webhook (GET). Meta appelle cette URL une fois à
 * la configuration et attend le `hub.challenge` en clair.
 */
export function handleVerificationHandshake(url: URL): Response | null {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (mode !== "subscribe") return null;

  if (token !== requireEnv("META_WEBHOOK_VERIFY_TOKEN")) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge ?? "", {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

export interface GraphPostParams {
  path: string;
  accessToken: string;
  body: Record<string, unknown>;
  service: string;
}

/** POST Graph API avec typage des erreurs (4xx non réessayable, 5xx/429 réessayable). */
export async function graphPost<T = Record<string, unknown>>(
  params: GraphPostParams,
): Promise<T> {
  const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.accessToken}`,
    },
    body: JSON.stringify(params.body),
  });

  const text = await response.text();

  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? text;
    } catch { /* corps non JSON : on garde le texte brut */ }

    throw new ExternalApiError(params.service, detail, {
      status: response.status,
      context: { path: params.path },
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ExternalApiError(params.service, "réponse Graph API illisible", { cause });
  }
}

/** Parse un corps de webhook en rejetant proprement un JSON invalide. */
export function parseWebhookBody(rawBody: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object") throw new Error("corps non objet");
    return parsed as Record<string, unknown>;
  } catch (cause) {
    throw new ValidationError("Corps de webhook JSON invalide.", { cause: String(cause) });
  }
}

export interface GraphGetParams {
  path: string;
  accessToken: string;
  service: string;
  /** Paramètres de requête hors `access_token`, ajouté automatiquement. */
  query?: Record<string, string>;
}

/**
 * GET Graph API. Même classification d'erreurs que `graphPost`.
 *
 * Le jeton passe par l'en-tête `Authorization` et non par la query string :
 * une URL finit dans les journaux d'accès, un en-tête beaucoup plus rarement.
 */
export async function graphGet<T = Record<string, unknown>>(
  params: GraphGetParams,
): Promise<T> {
  const query = new URLSearchParams(params.query ?? {});
  const suffix = query.toString() ? `?${query}` : "";

  const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/${params.path}${suffix}`, {
    headers: { authorization: `Bearer ${params.accessToken}` },
  });

  const text = await response.text();

  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? text;
    } catch { /* corps non JSON : on garde le texte brut */ }

    throw new ExternalApiError(params.service, detail, {
      status: response.status,
      context: { path: params.path },
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ExternalApiError(params.service, "réponse Graph API illisible", { cause });
  }
}
