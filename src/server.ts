// Serveur HTTP unifié Setwise (Neon).
//
// Regroupe :
//   - Webhooks Meta & Stripe (/webhooks/*)
//   - Authentification autonome Magic Link (/api/auth/*)
//   - API REST du tableau de bord (/api/*)
//   - Endpoints de crons (/crons/*)
//   - Fichiers statiques du dashboard et du site vitrine
//   - Worker périodique intégré (queue & alertes)

import "./_shared/bootstrap.ts";

import { optionalEnv, optionalIntEnv } from "./_shared/env.ts";
import { log } from "./_shared/logger.ts";
import { AppError, ValidationError } from "./_shared/errors.ts";
import { AuthError } from "./auth.ts";
import { handleInstagramWebhook, handleStripeWebhook, handleWhatsAppWebhook } from "./routes/webhooks.ts";
import { handleGetMe, handleSendMagicLink, handleVerifyMagicLink } from "./routes/auth.ts";
import { handleDashboardApi } from "./routes/dashboard.ts";
import { handleCrons } from "./routes/crons.ts";
import { processQueue } from "./_shared/dispatcher.ts";
import { deliverPendingNotifications } from "./_shared/notifications.ts";
import { serveStaticFile } from "./static.ts";

const PORT = optionalIntEnv("PORT", 8000);

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": optionalEnv("DASHBOARD_ORIGIN", "*"),
  "access-control-allow-headers": "authorization, content-type, x-cron-secret",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function addCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(k)) {
      headers.set(k, v);
    }
  }
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function requestHandler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // 1. Health check API
    if (path === "/health" || (path === "/" && req.headers.get("accept")?.includes("application/json"))) {
      return addCors(Response.json({
        ok: true,
        service: "setwise-backend",
        version: "2.0.0",
        database: "neon-postgres",
        time: new Date().toISOString(),
      }));
    }

    // 2. Webhooks Meta
    if (path === "/webhooks/instagram") {
      const res = await handleInstagramWebhook(req);
      return addCors(res);
    }
    if (path === "/webhooks/whatsapp") {
      const res = await handleWhatsAppWebhook(req);
      return addCors(res);
    }

    // 3. Webhook Stripe
    if (path === "/webhooks/stripe") {
      const res = await handleStripeWebhook(req);
      return addCors(res);
    }

    // 4. Authentification
    if (path === "/api/auth/magic-link") {
      const res = await handleSendMagicLink(req);
      return addCors(res);
    }
    if (path === "/api/auth/verify") {
      const res = await handleVerifyMagicLink(req);
      return addCors(res);
    }
    if (path === "/api/auth/me") {
      const res = await handleGetMe(req);
      return addCors(res);
    }

    // 5. Crons
    if (path.startsWith("/crons/")) {
      const res = await handleCrons(req, url);
      return addCors(res);
    }

    // 6. Dashboard REST API & Actions
    if (path.startsWith("/api/")) {
      const res = await handleDashboardApi(req, url);
      return addCors(res);
    }

    // 7. Fichiers statiques (Dashboard, Site, OAuth)
    const staticRes = await serveStaticFile(req, path);
    if (staticRes) {
      return addCors(staticRes);
    }

    return addCors(new Response("Not Found", { status: 404 }));
  } catch (error) {
    if (error instanceof AuthError) {
      return addCors(Response.json({ error: error.message }, { status: error.status }));
    }
    if (error instanceof ValidationError) {
      return addCors(Response.json({ error: error.message }, { status: 400 }));
    }
    if (error instanceof AppError) {
      return addCors(Response.json({ error: error.message }, { status: 500 }));
    }

    log.error("server.unhandled_error", { path, error: String(error) });
    return addCors(Response.json({ error: "Erreur interne du serveur." }, { status: 500 }));
  }
}

// Worker d'arrière-plan intégré (queue & notifications)
function startBackgroundWorker() {
  const isWorkerDisabled = optionalEnv("DISABLE_INTERNAL_WORKER", "false") === "true";
  if (isWorkerDisabled) return;

  log.info("worker.started", { interval: "5s" });

  // Consommation de la queue webhooks toutes les 5 secondes
  setInterval(async () => {
    try {
      await processQueue(10);
    } catch (err) {
      log.error("worker.queue_error", { error: String(err) });
    }
  }, 5000);

  // Livraison des notifications (alertes gérant) toutes les 10 secondes
  setInterval(async () => {
    try {
      await deliverPendingNotifications(10);
    } catch (err) {
      log.error("worker.notifications_error", { error: String(err) });
    }
  }, 10000);
}

if (import.meta.main) {
  startBackgroundWorker();
  console.log(`\n🚀 Serveur Setwise démarré sur http://localhost:${PORT}`);
  Deno.serve({ port: PORT }, requestHandler);
}

export { requestHandler };
