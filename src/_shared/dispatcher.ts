// Consommateur de la queue : transforme un event en tour d'agent (Neon).
//
// Appelé depuis deux endroits :
//   - `queue-dispatcher` (cron / worker) — filet de sécurité ;
//   - les webhooks eux-mêmes, en tâche de fond après la réponse 200 — c'est ce
//     chemin qui donne la réactivité (le lead reçoit une réponse en quelques
//     secondes, pas à la minute suivante).
//
// Les deux peuvent tourner en même temps sans risque : le claim SQL est atomique.

import "./bootstrap.ts";

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { isRetryable } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { attachTenant, claimEvents, completeEvent, failEvent, type QueuedEvent } from "./queue.ts";
import { runAgentTurn } from "./agent/engine.ts";
import { getBillingState } from "./billing.ts";
import {
  ensureWhatsAppConversation,
  openEscalation,
  recordOutbound,
  resolveAgentContext,
} from "./agent/memory.ts";
import { findWhatsAppConnection, resolveConnection } from "./channels/connection.ts";
import { createInstagramSender } from "./channels/instagram.ts";
import { createWhatsAppSender, sendWhatsAppTemplate, toWhatsAppNumber } from "./channels/whatsapp.ts";
import type { ChannelConnection } from "./channels/connection.ts";
import type { ChannelSender, NormalizedInboundMessage } from "./types.ts";

export interface ProcessResult {
  claimed: number;
  processed: number;
  failed: number;
}

function createSender(connection: ChannelConnection): ChannelSender {
  return connection.channel === "instagram"
    ? createInstagramSender(connection)
    : createWhatsAppSender(connection);
}

export async function processQueue(limit = 10): Promise<ProcessResult> {
  const events = await claimEvents(limit);
  let processed = 0;
  let failed = 0;

  for (const event of events) {
    try {
      await processEvent(event);
      await completeEvent(event.id);
      processed++;
    } catch (error) {
      const retryable = isRetryable(error);
      log.error("queue.event_failed", {
        eventId: event.id,
        attempts: event.attempts,
        retryable,
        error: String(error),
      });
      await failEvent(event.id, String(error), retryable);
      if (!retryable) await alerterEchecDefinitif(event, error);
      failed++;
    }
  }

  return { claimed: events.length, processed, failed };
}

/**
 * Ouvre une escalade quand un message meurt pour de bon.
 *
 * Sans cela, un échec définitif ne laissait qu'une ligne `failed` dans
 * `webhook_events` et une ligne de log. Personne n'était prévenu. Le cas qui
 * fait mal n'est pas théorique : un jeton Meta expire tous les 60 jours. Le
 * jour où il expire, l'agent continue de raisonner, consomme des jetons de
 * modèle, puis échoue à l'envoi — et l'institut perd ses leads sans rien
 * remarquer, parfois pendant des jours. Le schéma prévoyait déjà ce cas
 * (`escalation_trigger` a une valeur `external_error`, avec son index) : il
 * n'était simplement jamais écrit.
 *
 * Cette alerte est un chemin de secours : elle ne doit jamais faire tomber le
 * traitement de l'event suivant, d'où le try/catch qui avale tout.
 */
async function alerterEchecDefinitif(event: QueuedEvent, cause: unknown): Promise<void> {
  try {
    const raw = event.payload?.event;
    if (!raw?.externalThreadId) return;

    // La conversation n'existe que si l'échec est survenu APRÈS sa création
    // (typiquement à l'envoi). Un échec plus tôt — compte inconnu, institut
    // introuvable — n'a pas d'institut à prévenir : le laisser en `failed`
    // visible est la bonne réponse, alerter un gérant au hasard ne l'est pas.
    const rows = await sql`
      select id, tenant_id
        from conversations
       where channel = ${raw.channel}
         and external_thread_id = ${raw.externalThreadId}
       limit 1;
    `;
    if (rows.length === 0) return;

    await openEscalation({
      tenantId: rows[0].tenant_id,
      conversationId: rows[0].id,
      reason: `Message non délivré au client : ${String(cause)}`,
      triggeredBy: "external_error",
    });
  } catch (error) {
    log.warn("queue.failure_alert_failed", { eventId: event.id, error: String(error) });
  }
}

async function processEvent(event: QueuedEvent): Promise<void> {
  const raw = event.payload?.event;
  if (!raw) throw new Error("Payload d'event sans message normalisé.");

  const connection = await resolveConnection(raw.channel, raw.externalAccountId);
  await attachTenant(event.id, connection.tenantId);

  const message: NormalizedInboundMessage = {
    tenantId: connection.tenantId,
    kind: raw.kind ?? "text",
    unsupportedType: raw.unsupportedType,
    locationId: connection.locationId,
    channel: raw.channel,
    externalThreadId: raw.externalThreadId,
    externalContactId: raw.externalContactId,
    externalMessageId: raw.externalMessageId,
    text: raw.text,
    contactDisplayName: raw.contactDisplayName,
    receivedAt: raw.receivedAt,
  };

  const billing = await getBillingState(connection.tenantId);

  const result = await runAgentTurn({
    message,
    sender: createSender(connection),
    rawPayload: event.payload?.raw ?? null,
    suspended: billing.active ? undefined : { reason: billing.reason },
  });

  if (!billing.active) return;

  if (result.bookedAppointmentId && raw.channel !== "whatsapp") {
    try {
      await relayBookingToWhatsApp({
        tenantId: connection.tenantId,
        locationId: connection.locationId,
        leadId: result.leadId,
        appointmentId: result.bookedAppointmentId,
      });
    } catch (error) {
      log.warn("relay.whatsapp_failed", {
        appointmentId: result.bookedAppointmentId,
        error: String(error),
      });
    }
  }
}

export async function relayBookingToWhatsApp(params: {
  tenantId: string;
  locationId: string | null;
  leadId: string;
  appointmentId: string;
}): Promise<void> {
  const logger = scopedLogger({
    tenantId: params.tenantId,
    leadId: params.leadId,
    appointmentId: params.appointmentId,
  });

  const [appointmentRows, leadRows] = await Promise.all([
    sql`select starts_at, service_type, status from appointments where id = ${params.appointmentId}::uuid limit 1;`,
    sql`select full_name, phone from leads where id = ${params.leadId}::uuid limit 1;`,
  ]);

  const appointment = appointmentRows[0];
  const lead = leadRows[0];

  if (!appointment || appointment.status !== "confirmed") {
    logger.info("relay.skipped", { reason: "rendez-vous non confirmé" });
    return;
  }

  const phone = lead?.phone ? toWhatsAppNumber(lead.phone) : null;
  if (!phone) {
    logger.info("relay.skipped", { reason: "numéro de téléphone absent ou invalide" });
    return;
  }

  const connection = await findWhatsAppConnection(params.tenantId, params.locationId);
  if (!connection) {
    logger.info("relay.skipped", { reason: "aucune connexion WhatsApp active" });
    return;
  }

  const agent = await resolveAgentContext(params.tenantId, params.locationId);
  const templateName = typeof agent.agentConfig["whatsapp_confirmation_template"] === "string"
    ? agent.agentConfig["whatsapp_confirmation_template"] as string
    : "";

  if (!templateName) {
    logger.info("relay.skipped", { reason: "aucun modèle WhatsApp configuré pour cet agent" });
    return;
  }

  const firstName = (lead?.full_name ?? "").trim().split(/\s+/)[0] || "Bonjour";
  const whenLabel = new Intl.DateTimeFormat("fr-FR", {
    timeZone: agent.timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(appointment.starts_at));

  const sent = await sendWhatsAppTemplate({
    connection,
    to: phone,
    templateName,
    languageCode: "fr",
    bodyParameters: [firstName, whenLabel, appointment.service_type ?? "votre soin"],
  });

  const conversationId = await ensureWhatsAppConversation({
    tenantId: params.tenantId,
    locationId: params.locationId,
    agentId: agent.agentId,
    leadId: params.leadId,
    phoneE164: phone,
  });

  await recordOutbound({
    conversationId,
    text: `[modèle ${templateName}] Confirmation ${whenLabel} — ${appointment.service_type ?? ""}`,
    externalMessageId: sent.externalMessageId || null,
  });

  logger.info("relay.sent", { template: templateName, conversationId });
}
