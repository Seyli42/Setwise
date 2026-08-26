// Routes pour les tâches planifiées (Crons) et workers (Neon).

import { optionalEnv } from "../_shared/env.ts";
import { log } from "../_shared/logger.ts";
import { processQueue } from "../_shared/dispatcher.ts";
import { sendDueReminders } from "../_shared/reminders.ts";
import { runOutboundCampaigns } from "../_shared/outbound.ts";
import { refreshExpiringTokens } from "../_shared/metaTokens.ts";
import { deliverPendingNotifications } from "../_shared/notifications.ts";
import { sql } from "../db.ts";

function verifyCronSecret(req: Request): boolean {
  const secret = optionalEnv("CRON_SECRET", "");
  if (!secret) return true; // En local / dev, ouvert si non configuré

  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
  const customHeader = req.headers.get("x-cron-secret") ?? "";

  return token === secret || customHeader === secret;
}

export async function handleCrons(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!verifyCronSecret(req)) {
    log.warn("cron.unauthorized", { path: url.pathname });
    return new Response("Unauthorized", { status: 401 });
  }

  const path = url.pathname;

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
        const [purgedData, purgedTenants] = await Promise.all([
          sql`select anonymized_leads, anonymized_messages from purge_expired_personal_data(500);`,
          sql`select tenant_id, tenant_name, action from purge_terminated_tenants(30, 10, false);`,
        ]);
        return Response.json({
          ok: true,
          task: "purge",
          purged_personal_data: purgedData[0] ?? null,
          purged_tenants: purgedTenants,
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
