// Outils exposés au modèle + dispatcher.
//
// Le jeu d'outils est construit dynamiquement : tant qu'aucun provider
// calendrier n'est enregistré pour l'établissement, les outils de réservation ne
// sont pas exposés du tout. Un modèle qui ne voit pas l'outil ne peut pas
// promettre un créneau qu'on serait incapable d'honorer.

import { sql } from "../../db.ts";
import { getCalendarProvider } from "../calendar.ts";
import { spreadSlots } from "../calendar/slots.ts";
import { formatFrench } from "../calendar/timezone.ts";
import { AppError, DatabaseError, withRetry } from "../errors.ts";
import type { LlmTool } from "../llm.ts";
import type { ScopedLogger } from "../logger.ts";
import type { CalendarSlot } from "../types.ts";
import {
  type AgentContext,
  mergeQualificationData,
  openEscalation,
  updateLeadStatus,
} from "./memory.ts";

export const TOOL_SAVE_ANSWER = "save_qualification_answer";
export const TOOL_LIST_SLOTS = "list_available_slots";
export const TOOL_BOOK = "book_appointment";
export const TOOL_ESCALATE = "escalate_to_human";
export const TOOL_OUTCOME = "record_outcome";

export interface ToolContext {
  agent: AgentContext;
  conversationId: string;
  leadId: string;
  logger: ScopedLogger;
  /** Muté par le dispatcher — lu par le moteur après la boucle. */
  state: {
    qualificationData: Record<string, unknown>;
    escalated: boolean;
    escalationReason?: string;
    bookedAppointmentId?: string;
    /** Issue consignée par un agent sortant (`record_outcome`). */
    outcome?: string;
    /** Créneaux réellement retournés par le calendrier, pour vérifier la réservation. */
    offeredSlots: CalendarSlot[];
  };
}

/** Un calendrier est-il connecté et joignable ? */
export function calendarAvailable(agent: AgentContext): boolean {
  return Boolean(
    agent.calendarProvider &&
      agent.calendarExternalId &&
      agent.calendarCredentialsEncrypted &&
      getCalendarProvider(agent.calendarProvider),
  );
}

/**
 * Le calendrier permet-il d'écrire ?
 *
 * Un flux ICS (Planity et consorts) donne les disponibilités sans permettre de
 * réserver. Dans ce cas l'agent propose de vrais créneaux et transmet le choix
 * à l'équipe — au lieu d'annoncer une réservation qui n'existe pas.
 */
export function bookingAvailable(agent: AgentContext): boolean {
  if (!calendarAvailable(agent)) return false;
  const provider = getCalendarProvider(agent.calendarProvider!);
  return provider?.capabilities?.canBook !== false;
}

/**
 * Jeu d'outils du rôle.
 *
 * C'est ici que se joue la promesse « ajouter un agent V2 sans refonte » : le
 * moteur exécute la même boucle pour les quatre rôles, seuls le prompt de
 * mission et cette liste changent. Un rôle qui ne doit pas réserver ne voit pas
 * les outils de réservation, et ne peut donc pas promettre de créneau.
 */
export function buildTools(agent: AgentContext): LlmTool[] {
  const escalate: LlmTool = {
    name: TOOL_ESCALATE,
    description:
      "Transfère la conversation à l'équipe humaine de l'établissement et arrête toute réponse " +
      "automatique. À appeler pour toute question médicale, réclamation, demande RGPD, demande " +
      "explicite de parler à quelqu'un, ou tout sujet hors de ta mission.",
    input_schema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Raison du transfert, en une phrase, pour que le gérant sache quoi faire en reprenant la main.",
        },
      },
      required: ["reason"],
    },
  };

  // Deux niveaux : lire les créneaux, et réserver. Un calendrier en lecture
  // seule expose le premier sans le second.
  const booking: LlmTool[] = calendarAvailable(agent)
    ? (bookingAvailable(agent) ? buildBookingTools() : [buildBookingTools()[0]])
    : [];

  switch (agent.type) {
    // Demande d'avis : aucun outil de réservation. Un agent qui peut réserver
    // finirait par proposer un rendez-vous à quelqu'un qui sort de séance.
    case "avis_google":
      return [escalate, {
        name: TOOL_OUTCOME,
        description:
          "Consigne l'issue de la sollicitation, une fois l'échange terminé. " +
          "À appeler en dernier, juste avant ton message de clôture.",
        input_schema: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: ["satisfied", "dissatisfied", "declined", "no_response"],
              description:
                "satisfied = retour positif et avis proposé ; dissatisfied = retour négatif ; " +
                "declined = refus de laisser un avis ; no_response = pas de retour exploitable.",
            },
            note: { type: "string", description: "Résumé en une phrase, pour le gérant." },
          },
          required: ["outcome"],
        },
      }];

    // Relance après absence : replanifier, rien d'autre. Pas de requalification,
    // la personne a déjà donné ces informations.
    case "relance":
      return [escalate, ...booking];

    // Réactivation : requalifier ce qui a pu changer, puis réserver.
    case "reactivation":
      return [escalate, buildSaveAnswerTool(agent), ...booking];

    case "qualification_rdv":
    default:
      return [escalate, buildSaveAnswerTool(agent), ...booking];
  }
}

function buildSaveAnswerTool(agent: AgentContext): LlmTool {
  return {
    name: TOOL_SAVE_ANSWER,
      description:
        "Enregistre la réponse de la personne à une question du script de qualification. " +
        "À appeler dès qu'une réponse est obtenue, avant de poser la question suivante. " +
        "Le champ doit être l'un de ceux listés dans le script.",
    input_schema: {
      type: "object",
      properties: {
        field: {
          type: "string",
          description: "Clé du champ, telle qu'indiquée entre crochets dans le script.",
          enum: agent.questions.map((q) => q.field),
        },
        value: {
          type: "string",
          description: "La réponse de la personne, reformulée de façon concise et exploitable.",
        },
      },
      required: ["field", "value"],
    },
  };
}

function buildBookingTools(): LlmTool[] {
  return [
      {
        name: TOOL_LIST_SLOTS,
        description:
          "Récupère les créneaux réellement disponibles dans le calendrier de l'établissement. " +
          "Obligatoire avant de proposer le moindre horaire : ne jamais inventer un créneau.",
        input_schema: {
          type: "object",
          properties: {
            service_type: {
              type: "string",
              description: "Prestation souhaitée (ex: épilation laser jambes, soin du visage).",
            },
            from_date: {
              type: "string",
              description:
                "Date ISO 8601 à partir de laquelle chercher (facultatif, défaut : maintenant).",
            },
          },
          required: ["service_type"],
        },
      },
      {
        name: TOOL_BOOK,
        description:
          "Réserve définitivement un créneau retourné par " + TOOL_LIST_SLOTS +
          ". À n'appeler qu'après confirmation explicite de la personne sur un créneau précis.",
        input_schema: {
          type: "object",
          properties: {
            starts_at: { type: "string", description: "Début du créneau, ISO 8601, tel que retourné." },
            ends_at: { type: "string", description: "Fin du créneau, ISO 8601, tel que retourné." },
            service_type: { type: "string", description: "Prestation réservée." },
            lead_name: { type: "string", description: "Nom et prénom de la personne." },
            lead_phone: {
              type: "string",
              description: "Numéro de téléphone pour la confirmation WhatsApp et les rappels.",
            },
          },
          required: ["starts_at", "ends_at", "service_type", "lead_name"],
        },
      },
  ];
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  ctx.logger.info("tool.call", { tool: name });

  try {
    switch (name) {
      case TOOL_SAVE_ANSWER:
        return await handleSaveAnswer(input, ctx);
      case TOOL_LIST_SLOTS:
        return await handleListSlots(input, ctx);
      case TOOL_BOOK:
        return await handleBook(input, ctx);
      case TOOL_ESCALATE:
        return await handleEscalate(input, ctx);
      case TOOL_OUTCOME:
        return await handleOutcome(input, ctx);
      default:
        return { content: `Outil inconnu: ${name}`, isError: true };
    }
  } catch (error) {
    // Une erreur d'outil ne doit jamais faire échouer le tour entier : on la
    // renvoie au modèle pour qu'il s'adapte (et on la loggue pour le gérant).
    ctx.logger.error("tool.failed", { tool: name, error: String(error) });
    return {
      content: error instanceof AppError
        ? `Échec de l'outil (${error.code}) : ${error.message}`
        : "Échec technique de l'outil. N'annonce rien à la personne comme confirmé.",
      isError: true,
    };
  }
}

async function handleSaveAnswer(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const field = String(input.field ?? "").trim();
  const value = String(input.value ?? "").trim();

  if (!field || !value) {
    return { content: "`field` et `value` sont obligatoires et non vides.", isError: true };
  }

  const known = ctx.agent.questions.some((q) => q.field === field);
  if (!known) {
    const allowed = ctx.agent.questions.map((q) => q.field).join(", ");
    return {
      content: `Champ "${field}" absent du script. Champs autorisés : ${allowed || "(aucun)"}.`,
      isError: true,
    };
  }

  ctx.state.qualificationData = await mergeQualificationData(ctx.leadId, { [field]: value });

  const remaining = ctx.agent.questions.filter((q) => {
    const v = ctx.state.qualificationData[q.field];
    return v === undefined || v === null || v === "";
  });

  if (remaining.length === 0) {
    await updateLeadStatus(ctx.leadId, "qualified");
    ctx.logger.info("lead.qualified", { leadId: ctx.leadId });
  }

  return {
    content: remaining.length === 0
      ? "Réponse enregistrée. Qualification terminée : toutes les questions ont une réponse."
      : `Réponse enregistrée. Questions restantes : ${remaining.map((q) => q.field).join(", ")}.`,
    isError: false,
  };
}

async function handleListSlots(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const provider = getCalendarProvider(ctx.agent.calendarProvider!);
  if (!provider) {
    return {
      content: "Calendrier indisponible. Ne propose aucun créneau et transfère à l'équipe.",
      isError: true,
    };
  }

  const fromDate = typeof input.from_date === "string" && input.from_date
    ? new Date(input.from_date)
    : new Date();
  if (Number.isNaN(fromDate.getTime())) {
    return { content: "`from_date` n'est pas une date ISO 8601 valide.", isError: true };
  }

  const horizonDays = ctx.agent.scheduling.maxDaysAhead;
  const toDate = new Date(fromDate.getTime() + horizonDays * 24 * 3_600_000);

  const slots = await withRetry(
    () =>
      provider.checkAvailability({
        calendarExternalId: ctx.agent.calendarExternalId!,
        credentialsEncrypted: ctx.agent.calendarCredentialsEncrypted!,
        serviceType: String(input.service_type ?? ""),
        fromDate: fromDate.toISOString(),
        toDate: toDate.toISOString(),
        timezone: ctx.agent.timezone,
        scheduling: ctx.agent.scheduling,
      }),
    {
      attempts: 3,
      onRetry: (error, attempt, delayMs) =>
        ctx.logger.warn("calendar.availability.retry", { attempt, delayMs, error: String(error) }),
    },
  );

  // Mémorisé pour le garde-fou anti-hallucination de `book_appointment` :
  // on retient TOUS les créneaux libres, pas seulement ceux proposés, pour
  // qu'un lead qui demande "et jeudi 16 h ?" puisse être servi sans re-appel.
  ctx.state.offeredSlots = slots;

  if (slots.length === 0) {
    return {
      content: `Aucun créneau disponible sur les ${horizonDays} prochains jours. Propose à la ` +
        "personne d'être rappelée et transfère à l'équipe.",
      isError: false,
    };
  }

  // Étalés sur plusieurs jours plutôt que trois horaires d'affilée le même matin.
  const shortlist = spreadSlots(slots, ctx.agent.timezone, 6);

  return {
    content: "Créneaux disponibles :\n" +
      shortlist
        .map((s) => `- ${formatFrench(new Date(s.startsAt), ctx.agent.timezone)} (${s.startsAt})`)
        .join("\n") +
      "\n\nPropose-en 2 ou 3 en toutes lettres. Pour réserver, reprends l'horodatage ISO entre " +
      "parenthèses tel quel.",
    isError: false,
  };
}

async function handleBook(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const provider = getCalendarProvider(ctx.agent.calendarProvider!);
  if (!provider) {
    return { content: "Calendrier indisponible : réservation impossible.", isError: true };
  }

  const startsAt = String(input.starts_at ?? "");
  const endsAt = String(input.ends_at ?? "");
  const serviceType = String(input.service_type ?? "");
  const leadName = String(input.lead_name ?? "").trim();
  const leadPhone = typeof input.lead_phone === "string" ? input.lead_phone.trim() : null;

  if (Number.isNaN(Date.parse(startsAt)) || Number.isNaN(Date.parse(endsAt))) {
    return { content: "`starts_at` / `ends_at` doivent être des dates ISO 8601 valides.", isError: true };
  }
  if (Date.parse(endsAt) <= Date.parse(startsAt)) {
    return { content: "`ends_at` doit être postérieur à `starts_at`.", isError: true };
  }
  if (Date.parse(startsAt) < Date.now()) {
    return { content: "Ce créneau est dans le passé. Redemande les disponibilités.", isError: true };
  }

  // Garde-fou anti-hallucination : on ne réserve que ce que le calendrier a
  // effectivement proposé pendant ce tour.
  const wasOffered = ctx.state.offeredSlots.some(
    (slot) => Date.parse(slot.startsAt) === Date.parse(startsAt),
  );
  if (!wasOffered) {
    return {
      content: `Ce créneau ne fait pas partie de ceux retournés par ${TOOL_LIST_SLOTS}. ` +
        "Rappelle l'outil pour obtenir les disponibilités à jour avant de réserver.",
      isError: true,
    };
  }

  // 1. On persiste le RDV en `pending` AVANT l'appel externe : si l'appel
  //    échoue ou si la fonction meurt, le RDV existe en base et le gérant le
  //    voit dans son dashboard — jamais de rendez-vous perdu silencieusement.
  let pendingId: string;
  try {
    const pendingRows = await sql`
      insert into appointments (
        tenant_id,
        location_id,
        lead_id,
        conversation_id,
        calendar_integration_id,
        starts_at,
        ends_at,
        service_type,
        status
      ) values (
        ${ctx.agent.tenantId}::uuid,
        ${ctx.agent.locationId ? sql`${ctx.agent.locationId}::uuid` : null},
        ${ctx.leadId}::uuid,
        ${ctx.conversationId}::uuid,
        ${ctx.agent.calendarIntegrationId ? sql`${ctx.agent.calendarIntegrationId}::uuid` : null},
        ${startsAt},
        ${endsAt},
        ${serviceType},
        'pending'
      )
      returning id;
    `;
    pendingId = pendingRows[0].id;
  } catch (err) {
    throw new DatabaseError("Création rendez-vous échouée", { cause: err });
  }

  try {
    const booked = await withRetry(
      () =>
        provider.bookAppointment({
          calendarExternalId: ctx.agent.calendarExternalId!,
          credentialsEncrypted: ctx.agent.calendarCredentialsEncrypted!,
          slot: { startsAt, endsAt },
          serviceType,
          leadName: leadName || "Client",
          leadPhone,
          timezone: ctx.agent.timezone,
          // L'id du RDV créé juste avant : un retry après timeout retombe sur
          // le même événement Google au lieu d'en créer un second.
          idempotencyKey: pendingId,
        }),
      {
        attempts: 3,
        onRetry: (error, attempt, delayMs) =>
          ctx.logger.warn("calendar.book.retry", { attempt, delayMs, error: String(error) }),
      },
    );

    await sql`
      update appointments
         set status = 'confirmed',
             external_event_id = ${booked.externalEventId}
       where id = ${pendingId}::uuid;
    `;

    await updateLeadStatus(ctx.leadId, "booked", { fullName: leadName || null, phone: leadPhone });
    ctx.state.bookedAppointmentId = pendingId;

    ctx.logger.info("appointment.confirmed", {
      appointmentId: pendingId,
      startsAt,
      serviceType,
    });

    return {
      content: `Rendez-vous confirmé le ${
        formatFrench(new Date(startsAt), ctx.agent.timezone)
      } pour "${serviceType}". Confirme-le à la personne et précise qu'elle recevra la ` +
        "confirmation et un rappel sur WhatsApp.",
      isError: false,
    };
  } catch (error) {
    // 2. Échec après retries : le RDV reste `pending`, on alerte un humain.
    //    Le lead n'est jamais laissé avec une fausse confirmation.
    ctx.logger.error("appointment.failed", {
      appointmentId: pendingId,
      error: String(error),
    });

    await openEscalation({
      tenantId: ctx.agent.tenantId,
      conversationId: ctx.conversationId,
      reason: `Échec de réservation calendrier pour le créneau ${startsAt} (${serviceType}). ` +
        "Rendez-vous en attente de confirmation manuelle.",
      triggeredBy: "external_error",
    });

    ctx.state.escalated = true;
    ctx.state.escalationReason = "échec réservation calendrier";

    return {
      content:
        "La réservation a échoué côté calendrier. NE confirme PAS le rendez-vous. Dis à la personne " +
        "que l'équipe finalise la réservation et revient vers elle très vite.",
      isError: true,
    };
  }
}

/**
 * Consigne l'issue d'une sollicitation sortante.
 *
 * Un retour négatif ouvre une escalade : c'est exactement le moment où un
 * humain doit reprendre la main, et surtout pas celui où on demande un avis.
 */
async function handleOutcome(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const outcome = String(input.outcome ?? "").trim();
  const note = String(input.note ?? "").trim();

  const allowed = ["satisfied", "dissatisfied", "declined", "no_response"];
  if (!allowed.includes(outcome)) {
    return { content: `\`outcome\` doit valoir : ${allowed.join(", ")}.`, isError: true };
  }

  ctx.state.outcome = outcome;
  ctx.logger.info("outbound.outcome", { outcome, agentType: ctx.agent.type });

  if (outcome === "dissatisfied") {
    await openEscalation({
      tenantId: ctx.agent.tenantId,
      conversationId: ctx.conversationId,
      reason: `Retour client négatif${note ? ` : ${note}` : ""}`,
      triggeredBy: "sentiment",
    });
    ctx.state.escalated = true;
    ctx.state.escalationReason = "retour client négatif";

    return {
      content: "Retour négatif consigné et transmis à l'équipe. Ne demande PAS d'avis. " +
        "Remercie la personne pour son retour et arrête-toi.",
      isError: false,
    };
  }

  return { content: "Issue consignée. Termine par un message court et arrête-toi.", isError: false };
}

async function handleEscalate(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const reason = String(input.reason ?? "").trim() || "Sortie de script non précisée";

  await openEscalation({
    tenantId: ctx.agent.tenantId,
    conversationId: ctx.conversationId,
    reason,
    triggeredBy: "manual",
  });

  ctx.state.escalated = true;
  ctx.state.escalationReason = reason;
  ctx.logger.info("escalation.opened", { trigger: "tool", reason });

  // Le libellé ne promet plus « l'équipe est notifiée » : l'alerte part
  // désormais vraiment (`_shared/notifications.ts`), mais elle dépend d'un
  // canal configuré par l'institut. Ce que l'on peut affirmer sans condition,
  // c'est que la conversation est passée côté humain.
  return {
    content:
      "Transfert enregistré, la conversation est passée à l'institut. Rédige un dernier message " +
      "court pour prévenir la personne qu'un membre de l'équipe la recontacte, puis arrête-toi.",
    isError: false,
  };
}
