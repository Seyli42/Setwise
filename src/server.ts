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
import { RateLimitError } from "./_shared/rateLimit.ts";
import { allowedOrigins, AuthError } from "./auth.ts";
import { handleInstagramWebhook, handleStripeWebhook, handleWhatsAppWebhook } from "./routes/webhooks.ts";
import { handleGetMe, handleSendMagicLink, handleVerifyMagicLink } from "./routes/auth.ts";
import { handleDashboardApi } from "./routes/dashboard.ts";
import { handleCrons } from "./routes/crons.ts";
import { processQueue } from "./_shared/dispatcher.ts";
import { deliverPendingNotifications } from "./_shared/notifications.ts";
import { serveStaticFile } from "./static.ts";

const PORT = optionalIntEnv("PORT", 8000);

const CORS_BASE: Record<string, string> = {
  "access-control-allow-headers": "authorization, content-type, x-cron-secret",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  // L'origine autorisée varie selon l'appelant : sans ce `vary`, un cache
  // partagé resservirait à un domaine l'en-tête calculé pour un autre.
  "vary": "origin",
};

/**
 * CORS par allowlist — jamais `*`.
 *
 * L'ancienne valeur (`DASHBOARD_ORIGIN` avec repli `*`) autorisait n'importe
 * quel site à appeler l'API depuis le navigateur d'un gérant connecté. On
 * réutilise ici l'allowlist qui protège déjà les liens magiques
 * (`APP_ORIGINS`, cf. `auth.ts`) : l'origine de la requête n'est renvoyée que
 * si elle y figure, sinon on renvoie l'origine canonique — le navigateur
 * bloque alors la réponse de lui-même.
 */
function corsHeaders(req: Request): Record<string, string> {
  const origines = allowedOrigins();
  const demandee = (req.headers.get("origin") ?? "").replace(/\/+$/, "");
  return {
    ...CORS_BASE,
    "access-control-allow-origin": origines.includes(demandee) ? demandee : origines[0],
  };
}

function addCors(req: Request, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) {
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
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    // 1. Health check API
    if (path === "/health" || (path === "/" && req.headers.get("accept")?.includes("application/json"))) {
      return addCors(req, Response.json({
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
      return addCors(req, res);
    }
    if (path === "/webhooks/whatsapp") {
      const res = await handleWhatsAppWebhook(req);
      return addCors(req, res);
    }

    // 3. Webhook Stripe
    if (path === "/webhooks/stripe") {
      const res = await handleStripeWebhook(req);
      return addCors(req, res);
    }

    // 4. Authentification
    if (path === "/api/auth/magic-link") {
      const res = await handleSendMagicLink(req);
      return addCors(req, res);
    }
    if (path === "/api/auth/verify") {
      const res = await handleVerifyMagicLink(req);
      return addCors(req, res);
    }
    if (path === "/api/auth/me") {
      const res = await handleGetMe(req);
      return addCors(req, res);
    }

    // 5. Crons
    if (path.startsWith("/crons/")) {
      const res = await handleCrons(req, url);
      return addCors(req, res);
    }

    // 6. Dashboard REST API & Actions
    if (path.startsWith("/api/")) {
      const res = await handleDashboardApi(req, url);
      return addCors(req, res);
    }

    // 7. Fichiers statiques (Dashboard, Site, OAuth)
    const staticRes = await serveStaticFile(req, path);
    if (staticRes) {
      return addCors(req, staticRes);
    }

    return addCors(req, new Response("Not Found", { status: 404 }));
  } catch (error) {
    if (error instanceof AuthError) {
      return addCors(req, Response.json({ error: error.message }, { status: error.status }));
    }
    if (error instanceof RateLimitError) {
      const headers = new Headers({ "retry-after": String(error.retryAfterSeconds) });
      return addCors(req, 
        new Response(JSON.stringify({ error: error.message }), {
          status: 429,
          headers: { ...Object.fromEntries(headers), "content-type": "application/json" },
        }),
      );
    }
    if (error instanceof ValidationError) {
      return addCors(req, Response.json({ error: error.message }, { status: 400 }));
    }
    if (error instanceof AppError) {
      return addCors(req, Response.json({ error: error.message }, { status: 500 }));
    }

    log.error("server.unhandled_error", { path, error: String(error) });
    return addCors(req, Response.json({ error: "Erreur interne du serveur." }, { status: 500 }));
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
