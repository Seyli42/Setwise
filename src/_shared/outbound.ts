// Campagnes sortantes : avis Google, relance après absence, réactivation (Neon).
//
// Différence structurante avec l'agent de qualification : ici c'est nous qui
// initions le contact. Trois conséquences que tout ce fichier applique.
//
// 1. La fenêtre Meta de 24 h est fermée par construction → le premier message
//    passe obligatoirement par un modèle approuvé.
// 2. La personne n'a rien demandé → une seule sollicitation par sujet, jamais
//    de rejeu automatique en cas d'échec.
// 3. Un abonnement suspendu ne doit rien envoyer : facturer l'institut zéro
//    euro et lui consommer sa réputation WhatsApp serait le pire des deux.

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { DatabaseError } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { getBillingState } from "./billing.ts";
import { findWhatsAppConnection } from "./channels/connection.ts";
import { sendWhatsAppTemplate, toWhatsAppNumber } from "./channels/whatsapp.ts";
import { ensureWhatsAppConversation, recordOutbound, resolveAgentContext } from "./agent/memory.ts";
import { formatFrench } from "./calendar/timezone.ts";
import type { AgentType } from "./types.ts";

/** Rôles déclenchés par l'état de la base, pas par un message entrant. */
export const OUTBOUND_AGENT_TYPES: AgentType[] = ["avis_google", "relance", "reactivation"];

/** Clé de `agents.config` portant le nom du modèle WhatsApp, par rôle. */
const TEMPLATE_CONFIG_KEY: Record<string, string> = {
  avis_google: "whatsapp_review_template",
  relance: "whatsapp_followup_template",
  reactivation: "whatsapp_reactivation_template",
};

export interface OutboundRun {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
}

interface ClaimedTarget {
  touch_id: string;
  tenant_id: string;
  location_id: string | null;
  agent_id: string;
  lead_id: string;
  subject_id: string;
  lead_name: string | null;
  lead_phone: string | null;
  service_type: string | null;
  reference_at: string;
}

export async function runOutboundCampaigns(limitPerType = 50): Promise<OutboundRun> {
  const total: OutboundRun = { claimed: 0, sent: 0, skipped: 0, failed: 0 };

  // Clôture des rendez-vous passés d'abord : c'est elle qui crée les cibles de
  // l'agent « avis Google ». Sans cette étape, `completed` ne serait jamais
  // atteint et la campagne n'aurait jamais rien à envoyer.
  try {
    const settled = await sql`select settle_past_appointments(4) as count;`;
    const count = Number(settled[0]?.count ?? 0);
    if (count > 0) log.info("outbound.settled", { appointments: count });
  } catch (err) {
    log.error("outbound.settle_failed", { error: String(err) });
  }

  for (const agentType of OUTBOUND_AGENT_TYPES) {
    const run = await runCampaign(agentType, limitPerType);
    total.claimed += run.claimed;
    total.sent += run.sent;
    total.skipped += run.skipped;
    total.failed += run.failed;
  }

  log.info("outbound.run", { ...total });
  return total;
}

async function runCampaign(agentType: AgentType, limit: number): Promise<OutboundRun> {
  let targets: ClaimedTarget[] = [];
  try {
    const rows = await sql`
      select touch_id, tenant_id, location_id, agent_id, lead_id, subject_id,
             lead_name, lead_phone, service_type, reference_at
        from claim_outbound_targets(${agentType}, ${limit});
    `;
    targets = rows as unknown as ClaimedTarget[];
  } catch (err) {
    throw new DatabaseError(`Sélection des cibles ${agentType} échouée`, { cause: err });
  }

  const run: OutboundRun = { claimed: targets.length, sent: 0, skipped: 0, failed: 0 };
  const billingCache = new Map<string, boolean>();

  for (const target of targets) {
    const logger = scopedLogger({
      tenantId: target.tenant_id,
      agentType,
      leadId: target.lead_id,
      touchId: target.touch_id,
    });

    try {
      if (!billingCache.has(target.tenant_id)) {
        const billing = await getBillingState(target.tenant_id);
        billingCache.set(target.tenant_id, billing.active);
      }

      if (!billingCache.get(target.tenant_id)) {
        await markTouch(target.touch_id, "skipped", "abonnement inactif");
        logger.info("outbound.skipped", { reason: "abonnement inactif" });
        run.skipped++;
        continue;
      }

      const outcome = await sendTouch(agentType, target, logger);
      if (outcome === "sent") run.sent++;
      else run.skipped++;
    } catch (error) {
      await markTouch(target.touch_id, "failed", String(error));
      logger.error("outbound.failed", { error: String(error) });
      run.failed++;
    }
  }

  return run;
}

async function sendTouch(
  agentType: AgentType,
  target: ClaimedTarget,
  logger: ReturnType<typeof scopedLogger>,
): Promise<"sent" | "skipped"> {
  const phone = target.lead_phone ? toWhatsAppNumber(target.lead_phone) : null;
  if (!phone) {
    await markTouch(target.touch_id, "skipped", "numéro absent ou invalide");
    logger.info("outbound.skipped", { reason: "numéro absent ou invalide" });
    return "skipped";
  }

  const connection = await findWhatsAppConnection(target.tenant_id, target.location_id);
  if (!connection) {
    await markTouch(target.touch_id, "skipped", "aucune connexion WhatsApp active");
    logger.info("outbound.skipped", { reason: "aucune connexion WhatsApp active" });
    return "skipped";
  }

  const agent = await resolveAgentContext(target.tenant_id, target.location_id, target.agent_id);
  const templateKey = TEMPLATE_CONFIG_KEY[agentType];
  const templateName = typeof agent.agentConfig[templateKey] === "string"
    ? agent.agentConfig[templateKey] as string
    : "";

  if (!templateName) {
    await markTouch(target.touch_id, "skipped", `aucun modèle configuré (${templateKey})`);
    logger.info("outbound.skipped", { reason: "modèle WhatsApp non configuré", templateKey });
    return "skipped";
  }

  const firstName = (target.lead_name ?? "").trim().split(/\s+/)[0] || "Bonjour";
  const whenLabel = formatFrench(new Date(target.reference_at), agent.timezone);
  const service = target.service_type ?? "votre soin";

  const sent = await sendWhatsAppTemplate({
    connection,
    to: phone,
    templateName,
    languageCode: "fr",
    bodyParameters: [firstName, service, whenLabel],
  });

  const conversationId = await ensureWhatsAppConversation({
    tenantId: target.tenant_id,
    locationId: target.location_id,
    agentId: target.agent_id,
    leadId: target.lead_id,
    phoneE164: phone,
  });

  await sql`
    update conversations
       set agent_id = ${target.agent_id}::uuid,
           status = 'active'
     where id = ${conversationId}::uuid;
  `;

  await recordOutbound({
    conversationId,
    text: `[modèle ${templateName}] ${describe(agentType, service, whenLabel)}`,
    externalMessageId: sent.externalMessageId || null,
  });

  await sql`
    update outbound_touches
       set status = 'sent',
           sent_at = now(),
           template_name = ${templateName},
           conversation_id = ${conversationId}::uuid,
           last_error = null
     where id = ${target.touch_id}::uuid;
  `;

  logger.info("outbound.sent", { template: templateName, conversationId });
  return "sent";
}

function describe(agentType: AgentType, service: string, whenLabel: string): string {
  switch (agentType) {
    case "avis_google":
      return `Demande d'avis après ${service} du ${whenLabel}`;
    case "relance":
      return `Relance après absence au rendez-vous du ${whenLabel}`;
    case "reactivation":
      return "Reprise de contact";
    default:
      return "Sollicitation";
  }
}

async function markTouch(touchId: string, status: string, error?: string): Promise<void> {
  try {
    await sql`
      update outbound_touches
         set status = ${status},
             last_error = ${error ? error.slice(0, 500) : null}
       where id = ${touchId}::uuid;
    `;
  } catch (_err) {
    // Non bloquant
  }
}
