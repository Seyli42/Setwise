// Queue Postgres des webhooks entrants (Neon).
//
// Pourquoi une queue plutôt qu'un traitement synchrone : Meta considère un
// webhook en échec si la réponse dépasse ~20 s et le rejoue, alors qu'un tour
// d'agent (LLM + calendrier + envoi) peut dépasser ce budget. On accuse
// réception en <100 ms et on traite derrière.
//
// L'unité de queue est le MESSAGE, pas la livraison HTTP : `external_event_id`
// porte l'identifiant du message Meta, donc un rejeu du même lot n'insère rien.

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { DatabaseError } from "./errors.ts";
import type { ParsedInbound, RawInboundEvent } from "./channels/types.ts";

const UNIQUE_VIOLATION = "23505";

export type WebhookSource = "instagram" | "whatsapp" | "stripe";

export interface QueuedEvent {
  id: string;
  source: WebhookSource;
  external_event_id: string;
  payload: { event: RawInboundEvent; raw?: unknown };
  attempts: number;
  received_at: string;
}

export interface EnqueueResult {
  enqueued: number;
  duplicates: number;
}

export async function enqueueInboundEvents(
  source: WebhookSource,
  events: ParsedInbound[],
): Promise<EnqueueResult> {
  let enqueued = 0;
  let duplicates = 0;

  for (const item of events) {
    try {
      await sql`
        insert into webhook_events (
          source,
          external_event_id,
          payload,
          status,
          received_at,
          next_retry_at
        ) values (
          ${source},
          ${item.event.externalMessageId},
          ${sql.json(item as unknown as Parameters<typeof sql.json>[0])},
          'pending',
          ${item.event.receivedAt},
          now()
        );
      `;
      enqueued++;
    } catch (err) {
      if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
        duplicates++;
        continue;
      }
      throw new DatabaseError("Mise en queue du webhook échouée", { cause: err });
    }
  }

  return { enqueued, duplicates };
}

/** Réclame un lot d'events. Atomique : deux consommateurs ne peuvent pas se chevaucher. */
export async function claimEvents(limit = 10): Promise<QueuedEvent[]> {
  try {
    const rows = await sql`
      select id, source, external_event_id, payload, attempts, received_at
        from claim_webhook_events(${limit});
    `;
    return rows as unknown as QueuedEvent[];
  } catch (err) {
    throw new DatabaseError("Claim de la queue échoué", { cause: err });
  }
}

export async function completeEvent(id: string): Promise<void> {
  try {
    await sql`select complete_webhook_event(${id}::uuid);`;
  } catch (err) {
    throw new DatabaseError("Clôture d'event échouée", { cause: err });
  }
}

export async function failEvent(
  id: string,
  error: string,
  retryable: boolean,
): Promise<void> {
  try {
    await sql`select fail_webhook_event(${id}::uuid, ${error}, ${retryable});`;
  } catch (err) {
    throw new DatabaseError("Échec d'event non enregistré", { cause: err });
  }
}

export async function attachTenant(id: string, tenantId: string): Promise<void> {
  // Best effort : purement pour l'observabilité côté dashboard, ne doit jamais
  // faire échouer le traitement d'un message.
  try {
    await sql`update webhook_events set tenant_id = ${tenantId}::uuid where id = ${id}::uuid;`;
  } catch (_err) {
    // Non bloquant
  }
}
