// Résolution d'une connexion de canal : c'est ici que le tenant est déterminé.
//
// Point de sécurité multi-tenant : le tenant_id ne vient JAMAIS du payload du
// webhook (qu'un tiers pourrait forger) — il est lu en base à partir de
// l'identifiant de compte Meta, lui-même authentifié par la signature du webhook.

import { sql } from "../../db.ts";
import { decryptSecret } from "../crypto.ts";
import { DatabaseError, ValidationError } from "../errors.ts";
import type { Channel } from "../types.ts";

export interface ChannelConnection {
  id: string;
  tenantId: string;
  locationId: string | null;
  channel: Channel;
  externalAccountId: string;
  /** Token déchiffré — ne jamais logger, ne jamais renvoyer au front. */
  accessToken: string;
  tokenExpiresAt: string | null;
}

export async function resolveConnection(
  channel: Channel,
  externalAccountId: string,
): Promise<ChannelConnection> {
  try {
    const rows = await sql`
      select id, tenant_id, location_id, channel, external_account_id, access_token_encrypted, token_expires_at, status
        from channel_connections
       where channel = ${channel}
         and external_account_id = ${externalAccountId}
       limit 1;
    `;

    if (rows.length === 0) {
      // Meta peut envoyer des events pour un compte désabonné côté Setwise :
      // on rejette sans réessayer, l'event sera marqué `failed` et visible.
      throw new ValidationError(
        `Aucune connexion ${channel} pour le compte ${externalAccountId}.`,
        { channel, externalAccountId },
      );
    }

    const row = rows[0];

    if (row.status !== "active") {
      throw new ValidationError(`Connexion ${channel} inactive (statut: ${row.status}).`, {
        connectionId: row.id,
      });
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      locationId: row.location_id,
      channel: row.channel as Channel,
      externalAccountId: row.external_account_id,
      accessToken: await decryptSecret(row.access_token_encrypted),
      tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
    };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new DatabaseError("Lecture connexion canal échouée", { cause: err });
  }
}

/** Connexion WhatsApp d'un tenant, pour le relais depuis Instagram et les rappels. */
export async function findWhatsAppConnection(
  tenantId: string,
  locationId: string | null,
): Promise<ChannelConnection | null> {
  try {
    const rows = await sql`
      select id, tenant_id, location_id, channel, external_account_id, access_token_encrypted, token_expires_at
        from channel_connections
       where tenant_id = ${tenantId}::uuid
         and channel = 'whatsapp'
         and status = 'active';
    `;

    const row = rows.find((r) => r.location_id === locationId) ??
      rows.find((r) => r.location_id === null) ?? null;
    if (!row) return null;

    return {
      id: row.id,
      tenantId: row.tenant_id,
      locationId: row.location_id,
      channel: "whatsapp",
      externalAccountId: row.external_account_id,
      accessToken: await decryptSecret(row.access_token_encrypted),
      tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).toISOString() : null,
    };
  } catch (err) {
    throw new DatabaseError("Lecture connexion WhatsApp échouée", { cause: err });
  }
}
