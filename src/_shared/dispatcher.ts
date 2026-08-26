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

import { sql } from "../db.ts";
import { isRetryable } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { attachTenant, claimEvents, completeEvent, failEvent, type QueuedEvent } from "./queue.ts";
import { runAgentTurn } from "./agent/engine.ts";
import { getBillingState } from "./billing.ts";
import { ensureWhatsAppConversation, recordOutbound, resolveAgentContext } from "./agent/memory.ts";
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
      failed++;
    }
  }

  return { claimed: events.length, processed, failed };
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
