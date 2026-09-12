// Routes pour les tâches planifiées (Crons) et workers (Neon).

import { optionalEnv } from "../_shared/env.ts";
import { log } from "../_shared/logger.ts";
import { processQueue } from "../_shared/dispatcher.ts";
import { sendDueReminders } from "../_shared/reminders.ts";
import { runOutboundCampaigns } from "../_shared/outbound.ts";
import { refreshExpiringTokens } from "../_shared/metaTokens.ts";
import { deliverPendingNotifications } from "../_shared/notifications.ts";
import { timingSafeEqual } from "../_shared/meta.ts";
import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS

/**
 * Comparaison à temps constant : un `===` sur une chaîne sort au premier
 * caractère différent, ce qui laisse deviner le secret octet par octet.
 * Réutilise l'implémentation de `meta.ts` (signature webhook) plutôt que
 * d'en garder une seconde copie pour ce secret-ci.
 */
function secretsEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * FAILLE CORRIGÉE : cette fonction renvoyait `true` quand `CRON_SECRET` était
 * absent. Un secret oublié en production ouvrait donc TOUTES les tâches au
 * public — dont `/crons/purge`, qui supprime définitivement jusqu'à dix
 * instituts par appel.
 *
 * Un contrôle d'authentification doit échouer fermé. Le confort de
 * développement est explicite et local : `ALLOW_UNAUTHENTICATED_CRONS=1`, une
 * variable qu'on ne pose pas par accident sur un serveur.
 */
function verifyCronSecret(req: Request): boolean {
  const secret = optionalEnv("CRON_SECRET", "");

  if (!secret) {
    if (optionalEnv("ALLOW_UNAUTHENTICATED_CRONS", "") === "1") {
      log.warn("cron.unauthenticated_allowed", {});
      return true;
    }
    log.error("cron.secret_missing", {});
    return false;
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const customHeader = req.headers.get("x-cron-secret") ?? "";

  return secretsEqual(token, secret) || secretsEqual(customHeader, secret);
}

/**
 * Tâches destructrices : POST obligatoire. En GET, un préchargement de lien,
 * un antivirus de messagerie ou un crawler suffirait à déclencher une purge.
 */
const POST_ONLY = new Set(["/crons/purge"]);

export async function handleCrons(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!verifyCronSecret(req)) {
    log.warn("cron.unauthorized", { path: url.pathname });
    return new Response("Unauthorized", { status: 401 });
  }

  const path = url.pathname;

  if (POST_ONLY.has(path) && req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    switch (path) {
      case "/crons/dispatcher": {
        const result = await processQueue();
        return Response.json({ ok: true, task: "dispatcher", ...result });
      }

      case "/crons/reminders": {
        const result = await sendDueReminders();
        return Response.json({ ok: true, task: "reminders", ...result });
      }

      case "/crons/outbound": {
        const result = await runOutboundCampaigns();
        return Response.json({ ok: true, task: "outbound", ...result });
      }

      case "/crons/tokens": {
        const result = await refreshExpiringTokens();
        return Response.json({ ok: true, task: "tokens", ...result });
      }

      case "/crons/notifications": {
        const result = await deliverPendingNotifications();
        return Response.json({ ok: true, task: "notifications", ...result });
      }

      case "/crons/purge": {
        const [purgedData, purgedTenants, purgedRateLimits] = await Promise.all([
          sql`select anonymized_leads, anonymized_messages from purge_expired_personal_data(500);`,
          sql`select tenant_id, tenant_name, action from purge_terminated_tenants(30, 10, false);`,
          // Rattachée ici plutôt qu'à une tâche dédiée : pas de nouveau secret
          // à distribuer, pas de nouvelle planification à poser.
          sql<{ purge_expired_rate_limits: number }[]>`select purge_expired_rate_limits();`,
        ]);
        return Response.json({
          ok: true,
          task: "purge",
          purged_personal_data: purgedData[0] ?? null,
          purged_tenants: purgedTenants,
          purged_rate_limits: purgedRateLimits[0]?.purge_expired_rate_limits ?? 0,
        });
      }

      default:
        return new Response("Not Found", { status: 404 });
    }
  } catch (error) {
    log.error("cron.failed", { path, error: String(error) });
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
