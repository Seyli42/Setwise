// Limitation de débit, compteur en base.
//
// Le déploiement est multi-instance (Vercel) : un compteur en mémoire de
// processus ne verrouille rien, chaque instance repartirait de zéro. Le
// compteur vit donc en base, via `rate_limit_hit` (migration 0004),
// upsert atomique en une instruction — aucun verrou explicite à poser côté
// appelant, Postgres sérialise l'upsert lui-même.
//
// Deux modes d'échec, choisis point par point :
//   - FERMÉ (throw) : une panne du compteur bloque l'action. Réservé aux
//     points sensibles (envoi d'e-mail) où laisser passer sans limite est
//     pire que refuser temporairement.
//   - OUVERT (log + laisse passer) : une panne du compteur ne doit jamais
//     couper le service pour tout le monde. Réservé aux points à fort volume
//     (API authentifiée, webhooks) où le compteur est un filet, pas la seule
//     protection — l'authentification ou la signature HMAC le sont déjà.

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { AppError } from "./errors.ts";
import { log } from "./logger.ts";

/** Dépassement de plafond. `retryAfterSeconds` alimente l'en-tête HTTP. */
export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super("rate_limit_exceeded", message, { retryable: false });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitOptions {
  /** Identifie le compteur : préfixe + clé (adresse, IP, tenant…). */
  bucket: string;
  limit: number;
  /** Fenêtre glissante, en secondes. */
  windowSeconds: number;
  /** Échoue fermé (throw) au lieu d'ouvert (log + laisse passer) sur panne du compteur. */
  failClosed?: boolean;
}

/**
 * Vérifie et incrémente le compteur. Lève `RateLimitError` si le plafond est
 * dépassé.
 *
 * Une panne du compteur lui-même (base injoignable) suit `failClosed` :
 * fermé pour les points sensibles, ouvert partout ailleurs — mais toujours
 * journalisée, panne silencieuse ou pas.
 */
export async function enforceRateLimit(options: RateLimitOptions): Promise<void> {
  const { bucket, limit, windowSeconds, failClosed = false } = options;

  let allowed: boolean;
  try {
    const rows = await sql<{ rate_limit_hit: boolean }[]>`
      select rate_limit_hit(${bucket}, ${limit}, ${`${windowSeconds} seconds`}::interval);
    `;
    allowed = rows[0]?.rate_limit_hit ?? true;
  } catch (error) {
    log.error("rate_limit.check_failed", { bucket, failClosed, error: String(error) });
    if (failClosed) {
      throw new RateLimitError("Service temporairement indisponible. Réessayez dans un instant.", 30);
    }
    return;
  }

  if (!allowed) {
    throw new RateLimitError(
      "Trop de tentatives. Réessayez plus tard.",
      windowSeconds,
    );
  }
}

/** Adresse IP de l'appelant, en tenant compte du proxy Vercel. */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
