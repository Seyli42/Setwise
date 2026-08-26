// Rotation des tokens d'accès Meta (Neon).
//
// Un token longue durée Meta vit ~60 jours. Sans rotation, l'agent d'un
// institut s'arrête deux mois après l'installation — silencieusement, un
// dimanche, sans que personne comprenne pourquoi les leads ne reçoivent plus
// de réponse. C'est le mode de panne le plus coûteux du produit : il frappe
// tard, quand la confiance est établie.

import { sql } from "../db.ts";
import { requireEnv, optionalIntEnv } from "./env.ts";
import { decryptSecret, encryptSecret } from "./crypto.ts";
import { ExternalApiError } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { GRAPH_BASE, GRAPH_VERSION } from "./meta.ts";

/** Marge de renouvellement : on ne joue pas la montre sur un token de 60 jours. */
const REFRESH_WINDOW_DAYS = optionalIntEnv("META_TOKEN_REFRESH_WINDOW_DAYS", 14);

export interface TokenRefreshRun {
  examined: number;
  refreshed: number;
  failed: number;
}

interface ConnectionRow {
  id: string;
  tenant_id: string;
  channel: string;
  external_account_id: string;
  access_token_encrypted: string;
  token_expires_at: string | null;
}

/**
 * Échange un token contre un token longue durée.
 */
export async function exchangeForLongLivedToken(
  currentToken: string,
): Promise<{ token: string; expiresAt: string | null }> {
  const params = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: requireEnv("META_APP_ID"),
    client_secret: requireEnv("META_APP_SECRET"),
    fb_exchange_token: currentToken,
  });

  const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${params}`);
  const text = await response.text();

  if (!response.ok) {
    throw new ExternalApiError("meta-oauth", `échange de token échoué: ${text.slice(0, 300)}`, {
      status: response.status,
      retryable: response.status >= 500,
    });
  }

  const payload = JSON.parse(text) as { access_token: string; expires_in?: number };

  return {
    token: payload.access_token,
    expiresAt: typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : null,
  };
}

/** Renouvelle les tokens arrivant à échéance. Idempotent, sûr à rejouer. */
export async function refreshExpiringTokens(limit = 50): Promise<TokenRefreshRun> {
  const threshold = new Date(Date.now() + REFRESH_WINDOW_DAYS * 24 * 3_600_000).toISOString();

  let connections: ConnectionRow[] = [];
  try {
    const rows = await sql`
      select id, tenant_id, channel, external_account_id, access_token_encrypted, token_expires_at
        from channel_connections
       where status = 'active'
         and token_expires_at is not null
         and token_expires_at < ${threshold}
       order by token_expires_at asc
       limit ${limit};
    `;
    connections = rows as unknown as ConnectionRow[];
  } catch (err) {
    throw new Error(`Lecture des connexions échouée : ${String(err)}`);
  }

  const run: TokenRefreshRun = { examined: connections.length, refreshed: 0, failed: 0 };

  for (const connection of connections) {
    const logger = scopedLogger({
      tenantId: connection.tenant_id,
      channel: connection.channel,
      connectionId: connection.id,
    });

    try {
      const current = await decryptSecret(connection.access_token_encrypted);
      const renewed = await exchangeForLongLivedToken(current);
      const encrypted = await encryptSecret(renewed.token);

      await sql`
        update channel_connections
           set access_token_encrypted = ${encrypted},
               token_expires_at = ${renewed.expiresAt},
               last_refreshed_at = now(),
               refresh_error = null
         where id = ${connection.id}::uuid;
      `;

      logger.info("token.refreshed", { expiresAt: renewed.expiresAt });
      run.refreshed++;
    } catch (cause) {
      const message = String(cause);
      const expired = connection.token_expires_at ? Date.parse(connection.token_expires_at) < Date.now() : false;

      try {
        if (expired) {
          await sql`
            update channel_connections
               set refresh_error = ${message.slice(0, 500)},
                   status = 'expired'
             where id = ${connection.id}::uuid;
          `;
        } else {
          await sql`
            update channel_connections
               set refresh_error = ${message.slice(0, 500)}
             where id = ${connection.id}::uuid;
          `;
        }
      } catch (_err) {
        // Non bloquant
      }

      logger.error("token.refresh_failed", { error: message, alreadyExpired: expired });
      run.failed++;
    }
  }

  log.info("tokens.run", { ...run });
  return run;
}
