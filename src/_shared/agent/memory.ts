// Persistance de la mémoire d'agent : conversation, messages, lead, escalade (Neon).
//
// L'isolation multi-tenant est garantie par le fait que chaque requête est
// filtrée sur le tenant_id résolu depuis `channel_connections`, jamais depuis
// un input externe non authentifié.

import { sql } from "../../db.ts";
import { DatabaseError, ValidationError } from "../errors.ts";
import { log } from "../logger.ts";
import { deliverPendingNotifications, queueEscalationAlert } from "../notifications.ts";
import type { LlmMessage } from "../llm.ts";
import { parseSchedulingConfig } from "../calendar/slots.ts";
import { windowExpiryFrom } from "../messagingWindow.ts";
import type {
  AgentType,
  NormalizedInboundMessage,
  QualificationQuestion,
  SchedulingConfig,
} from "../types.ts";

const UNIQUE_VIOLATION = "23505";

export interface AgentContext {
  tenantId: string;
  tenantName: string;
  timezone: string;
  locationId: string | null;
  locationName: string | null;
  agentId: string;
  /** Rôle métier : décide du prompt de mission et du jeu d'outils. */
  type: AgentType;
  systemPromptTemplate: string;
  agentConfig: Record<string, unknown>;
  scriptId: string | null;
  questions: QualificationQuestion[];
  budgetRules: Record<string, unknown>;
  escalationKeywords: string[];
  /** Horaires, durées de prestation, délai de prévenance — issus de `agents.config`. */
  scheduling: SchedulingConfig;
  calendarIntegrationId: string | null;
  calendarProvider: string | null;
  calendarExternalId: string | null;
  calendarCredentialsEncrypted: string | null;
}

/**
 * Résout agent + script + calendrier.
 * `agentId` prend le pas quand il est fourni : une conversation ouverte par un
 * agent sortant (relance, avis) doit rester servie par CE rôle si la personne répond.
 */
export async function resolveAgentContext(
  tenantId: string,
  locationId: string | null,
  agentId?: string | null,
): Promise<AgentContext> {
  try {
    const tenantPromise = sql`
      select id, name, timezone, deleted_at from tenants where id = ${tenantId}::uuid limit 1;
    `;
    const locationPromise = locationId
      ? sql`select id, name, timezone, deleted_at from locations where id = ${locationId}::uuid limit 1;`
      : Promise.resolve([]);
    const agentsPromise = agentId
      ? sql`
        select id, location_id, type, system_prompt_template, config
          from agents
         where tenant_id = ${tenantId}::uuid
           and id = ${agentId}::uuid
           and is_active = true;
      `
      : sql`
        select id, location_id, type, system_prompt_template, config
          from agents
         where tenant_id = ${tenantId}::uuid
           and type = 'qualification_rdv'
           and is_active = true;
      `;
    const calendarsPromise = sql`
      select id, location_id, provider, calendar_external_id, credentials_encrypted, status
        from calendar_integrations
       where tenant_id = ${tenantId}::uuid
         and status = 'active';
    `;

    const [tenantRows, locationRows, agentRows, calendarRows] = await Promise.all([
      tenantPromise,
      locationPromise,
      agentsPromise,
      calendarsPromise,
    ]);

    if (tenantRows.length === 0 || tenantRows[0].deleted_at) {
      throw new ValidationError("Tenant introuvable ou supprimé.", { tenantId });
    }

    const tenant = tenantRows[0];
    const location = locationRows.length > 0 ? locationRows[0] : null;

    const agents = agentRows as unknown as Array<{
      id: string;
      location_id: string | null;
      type: string;
      system_prompt_template: string;
      config: Record<string, unknown>;
    }>;

    const agent = agents.find((a) => a.location_id === locationId) ??
      agents.find((a) => a.location_id === null) ??
      (agentId ? agents[0] : undefined);

    if (!agent) {
      throw new ValidationError(
        agentId
          ? "Agent introuvable ou désactivé."
          : "Aucun agent de qualification actif pour ce tenant. Le gérant doit en créer un depuis le dashboard.",
        { tenantId, locationId, agentId },
      );
    }

    const scriptRows = await sql`
      select id, questions, budget_rules, escalation_keywords
        from qualification_scripts
       where agent_id = ${agent.id}::uuid
         and is_active = true
       order by version desc
       limit 1;
    `;

    const calendars = calendarRows as unknown as Array<{
      id: string;
      location_id: string | null;
      provider: string;
      calendar_external_id: string;
      credentials_encrypted: string;
      status: string;
    }>;

    const calendar = calendars.find((c) => c.location_id === locationId) ??
      calendars.find((c) => c.location_id === null) ?? null;

    const script = scriptRows.length > 0 ? scriptRows[0] : null;
    const agentConfig = (agent.config ?? {}) as Record<string, unknown>;

    return {
      tenantId,
      tenantName: tenant.name,
      timezone: location?.timezone ?? tenant.timezone ?? "Europe/Paris",
      locationId,
      locationName: location?.name ?? null,
      agentId: agent.id,
      type: (agent.type ?? "qualification_rdv") as AgentType,
      systemPromptTemplate: agent.system_prompt_template ?? "",
      agentConfig,
      scriptId: script?.id ?? null,
      questions: (script?.questions ?? []) as QualificationQuestion[],
      budgetRules: (script?.budget_rules ?? {}) as Record<string, unknown>,
      escalationKeywords: (script?.escalation_keywords ?? []) as string[],
      scheduling: parseSchedulingConfig(agentConfig),
      calendarIntegrationId: calendar?.id ?? null,
      calendarProvider: calendar?.provider ?? null,
      calendarExternalId: calendar?.calendar_external_id ?? null,
      calendarCredentialsEncrypted: calendar?.credentials_encrypted ?? null,
    };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new DatabaseError("Lecture du contexte agent échouée", { cause: err });
  }
}

export interface ConversationState {
  conversationId: string;
  leadId: string;
  agentId: string | null;
  status: string;
  qualificationData: Record<string, unknown>;
  leadFullName: string | null;
  leadPhone: string | null;
}

export async function loadOrCreateConversation(
  msg: NormalizedInboundMessage,
  ctx: AgentContext,
): Promise<ConversationState> {
  try {
    const existing = await sql`
      select id, lead_id, agent_id, status
        from conversations
       where channel = ${msg.channel}
         and external_thread_id = ${msg.externalThreadId}
       limit 1;
    `;

    if (existing.length > 0) {
      const conv = existing[0];
      const lead = await loadLead(conv.lead_id);
      return {
        conversationId: conv.id,
        leadId: conv.lead_id,
        agentId: conv.agent_id,
        status: conv.status,
        qualificationData: lead.qualificationData,
        leadFullName: lead.fullName,
        leadPhone: lead.phone,
      };
    }

    // Nouveau lead
    const leadRows = await sql`
      insert into leads (
        tenant_id,
        location_id,
        full_name,
        phone,
        instagram_handle,
        source,
        status,
        consent_at
      ) values (
        ${ctx.tenantId}::uuid,
        ${ctx.locationId ? sql`${ctx.locationId}::uuid` : null},
        ${msg.contactDisplayName ?? null},
        ${msg.channel === "whatsapp" ? msg.externalContactId : null},
        ${msg.channel === "instagram" ? msg.externalContactId : null},
        ${msg.channel},
        'new',
        ${msg.receivedAt}
      )
      returning id, full_name, phone, qualification_data;
    `;

    const lead = leadRows[0];

    const convRows = await sql`
      insert into conversations (
        tenant_id,
        location_id,
        agent_id,
        lead_id,
        channel,
        external_thread_id,
        status,
        last_message_at,
        messaging_window_expires_at
      ) values (
        ${ctx.tenantId}::uuid,
        ${ctx.locationId ? sql`${ctx.locationId}::uuid` : null},
        ${ctx.agentId}::uuid,
        ${lead.id}::uuid,
        ${msg.channel},
        ${msg.externalThreadId},
        'active',
        ${msg.receivedAt},
        ${windowExpiryFrom(msg.receivedAt)}
      )
      returning id, lead_id, agent_id, status;
    `;

    return {
      conversationId: convRows[0].id,
      leadId: lead.id,
      agentId: convRows[0].agent_id,
      status: "active",
      qualificationData: {},
      leadFullName: lead.full_name,
      leadPhone: lead.phone,
    };
  } catch (err) {
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      return await loadOrCreateConversation(msg, ctx);
    }
    throw new DatabaseError("Chargement ou création de conversation échoué", { cause: err });
  }
}

export async function ensureWhatsAppConversation(params: {
  tenantId: string;
  locationId: string | null;
  agentId: string;
  leadId: string;
  phoneE164: string;
}): Promise<string> {
  try {
    const existing = await sql`
      select id from conversations
       where channel = 'whatsapp'
         and external_thread_id = ${params.phoneE164}
       limit 1;
    `;

    if (existing.length > 0) return existing[0].id;

    const insert = await sql`
      insert into conversations (
        tenant_id,
        location_id,
        agent_id,
        lead_id,
        channel,
        external_thread_id,
        status,
        last_message_at,
        messaging_window_expires_at
      ) values (
        ${params.tenantId}::uuid,
        ${params.locationId ? sql`${params.locationId}::uuid` : null},
        ${params.agentId}::uuid,
        ${params.leadId}::uuid,
        'whatsapp',
        ${params.phoneE164},
        'active',
        now(),
        null
      )
      returning id;
    `;

    return insert[0].id;
  } catch (err) {
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      return await ensureWhatsAppConversation(params);
    }
    throw new DatabaseError("Création conversation WhatsApp échouée", { cause: err });
  }
}

async function loadLead(leadId: string | null) {
  if (!leadId) return { qualificationData: {}, fullName: null, phone: null };

  const rows = await sql`
    select qualification_data, full_name, phone
      from leads
     where id = ${leadId}::uuid
     limit 1;
  `;

  if (rows.length === 0) return { qualificationData: {}, fullName: null, phone: null };

  return {
    qualificationData: (rows[0].qualification_data ?? {}) as Record<string, unknown>,
    fullName: rows[0].full_name ?? null,
    phone: rows[0].phone ?? null,
  };
}

export interface InboundRecord {
  inserted: boolean;
  createdAt: string;
}

export async function recordInbound(
  conversationId: string,
  msg: NormalizedInboundMessage,
  rawPayload: unknown,
): Promise<InboundRecord> {
  const content = msg.kind === "unsupported"
    ? `[${msg.unsupportedType ?? "pièce jointe"} reçue — non lisible par l'agent]`
    : msg.text;

  try {
    const insert = await sql`
      insert into messages (
        conversation_id,
        direction,
        sender_type,
        content,
        raw_payload,
        external_message_id,
        created_at
      ) values (
        ${conversationId}::uuid,
        'inbound',
        'lead',
        ${content},
        ${rawPayload ? sql.json(rawPayload as unknown as Parameters<typeof sql.json>[0]) : null},
        ${msg.externalMessageId},
        ${msg.receivedAt}
      )
      returning created_at;
    `;

    await sql`
      update conversations
         set last_message_at = ${msg.receivedAt},
             messaging_window_expires_at = ${windowExpiryFrom(msg.receivedAt)}
       where id = ${conversationId}::uuid;
    `;

    return {
      inserted: true,
      createdAt: new Date(insert[0].created_at).toISOString(),
    };
  } catch (err) {
    if ((err as { code?: string })?.code === UNIQUE_VIOLATION) {
      const existing = await sql`
        select created_at from messages
         where external_message_id = ${msg.externalMessageId}
         limit 1;
      `;
      return {
        inserted: false,
        createdAt: existing.length > 0 ? new Date(existing[0].created_at).toISOString() : msg.receivedAt,
      };
    }
    throw new DatabaseError("Enregistrement message entrant échoué", { cause: err });
  }
}

export async function hasReplyAfter(conversationId: string, sinceIso: string): Promise<boolean> {
  try {
    const rows = await sql`
      select id from messages
       where conversation_id = ${conversationId}::uuid
         and direction = 'outbound'
         and created_at >= ${sinceIso}
       limit 1;
    `;
    return rows.length > 0;
  } catch (err) {
    throw new DatabaseError("Lecture réponses échouée", { cause: err });
  }
}

export async function loadHistory(conversationId: string, limit = 40): Promise<LlmMessage[]> {
  try {
    const rows = await sql`
      select direction, content, created_at
        from messages
       where conversation_id = ${conversationId}::uuid
       order by created_at desc
       limit ${limit};
    `;

    const chronological = rows.slice().reverse();
    const history: LlmMessage[] = chronological
      .filter((row) => typeof row.content === "string" && row.content.trim().length > 0)
      .map((row) => ({
        role: row.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: row.content as string,
      }));

    while (history.length > 0 && history[0].role === "assistant") history.shift();
    return history;
  } catch (err) {
    throw new DatabaseError("Lecture historique échouée", { cause: err });
  }
}

export async function recordOutbound(params: {
  conversationId: string;
  text: string;
  externalMessageId: string | null;
  senderType?: "agent" | "human";
}): Promise<void> {
  try {
    await sql`
      insert into messages (
        conversation_id,
        direction,
        sender_type,
        content,
        external_message_id,
        created_at
      ) values (
        ${params.conversationId}::uuid,
        'outbound',
        ${params.senderType ?? "agent"},
        ${params.text},
        ${params.externalMessageId},
        now()
      )
      on conflict (external_message_id) do nothing;
    `;

    await sql`
      update conversations
         set last_message_at = now()
       where id = ${params.conversationId}::uuid;
    `;
  } catch (err) {
    throw new DatabaseError("Enregistrement message sortant échoué", { cause: err });
  }
}

export async function mergeQualificationData(
  leadId: string,
  patch: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const current = await loadLead(leadId);
    const merged = { ...current.qualificationData, ...patch };

    await sql`
      update leads
         set qualification_data = ${sql.json(merged as unknown as Parameters<typeof sql.json>[0])}
       where id = ${leadId}::uuid;
    `;

    return merged;
  } catch (err) {
    throw new DatabaseError("Mise à jour qualification échouée", { cause: err });
  }
}

export async function updateLeadStatus(
  leadId: string,
  status: "new" | "qualified" | "disqualified" | "booked",
  fields: { fullName?: string | null; phone?: string | null } = {},
): Promise<void> {
  try {
    await sql`
      update leads
         set status = ${status},
             full_name = coalesce(${fields.fullName ?? null}, full_name),
             phone = coalesce(${fields.phone ?? null}, phone)
       where id = ${leadId}::uuid;
    `;
  } catch (err) {
    throw new DatabaseError("Mise à jour lead échouée", { cause: err });
  }
}

export async function setConversationStatus(
  conversationId: string,
  status: "active" | "qualified" | "escalated" | "closed" | "expired",
): Promise<void> {
  try {
    await sql`
      update conversations
         set status = ${status}
       where id = ${conversationId}::uuid;
    `;
  } catch (err) {
    throw new DatabaseError("Mise à jour conversation échouée", { cause: err });
  }
}

export async function openEscalation(params: {
  tenantId: string;
  conversationId: string;
  reason: string;
  triggeredBy: "keyword" | "sentiment" | "manual" | "external_error";
}): Promise<{ escalationId: string; alreadyOpen: boolean }> {
  try {
    const existing = await sql`
      select id from escalations
       where conversation_id = ${params.conversationId}::uuid
         and status = 'open'
       limit 1;
    `;

    if (existing.length > 0) {
      await setConversationStatus(params.conversationId, "escalated");
      return { escalationId: existing[0].id, alreadyOpen: true };
    }

    const insert = await sql`
      insert into escalations (
        tenant_id,
        conversation_id,
        reason,
        triggered_by,
        status
      ) values (
        ${params.tenantId}::uuid,
        ${params.conversationId}::uuid,
        ${params.reason},
        ${params.triggeredBy},
        'open'
      )
      returning id;
    `;

    const escalationId = insert[0].id;
    await setConversationStatus(params.conversationId, "escalated");

    const queued = await queueEscalationAlert({
      tenantId: params.tenantId,
      escalationId,
      reason: params.reason,
    });

    if (queued) {
      deliverPendingNotifications(5).catch((error: unknown) => {
        log.warn("escalation.alert_immediate_failed", { error: String(error) });
      });
    }

    return { escalationId, alreadyOpen: false };
  } catch (err) {
    throw new DatabaseError("Création escalade échouée", { cause: err });
  }
}
