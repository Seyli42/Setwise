// Moteur d'exécution d'agent — indépendant du canal.
//
// Un « tour » = un message entrant traité de bout en bout :
//   dédup → contexte → garde-fous → boucle LLM/outils → réponse sortante.
//
// Les canaux (Instagram, WhatsApp) n'implémentent que la normalisation du
// message entrant et l'interface `ChannelSender`. Ajouter un agent V2 (avis
// Google, relance) = un nouveau `agent_type` + un jeu d'outils : le moteur ne
// change pas.

import {
  callAgentLLM,
  extractText,
  extractToolUses,
  type LlmMessage,
  type LlmToolResultBlock,
} from "../llm.ts";
import { scopedLogger } from "../logger.ts";
import { AppError, ExternalApiError, withRetry } from "../errors.ts";
import type { ChannelSender, EngineResult, NormalizedInboundMessage } from "../types.ts";
import { buildSystemPrompt, matchEscalationKeyword } from "./prompt.ts";
import {
  bookingAvailable,
  buildTools,
  calendarAvailable,
  dispatchTool,
  type ToolContext,
} from "./tools.ts";
import {
  hasReplyAfter,
  loadHistory,
  loadOrCreateConversation,
  openEscalation,
  recordInbound,
  recordOutbound,
  resolveAgentContext,
} from "./memory.ts";

const MAX_TOOL_ITERATIONS = 6;

const DEFAULT_HANDOFF_MESSAGE =
  "Je transmets votre message à l'équipe : une personne de l'institut revient vers vous très vite.";

export interface RunTurnParams {
  message: NormalizedInboundMessage;
  sender: ChannelSender;
  /** Payload brut du webhook, stocké pour audit / rejeu. */
  rawPayload?: unknown;
  /**
   * Renseigné quand l'abonnement de l'institut n'est plus actif. Le message
   * entrant est enregistré et escaladé, mais aucun appel modèle n'est fait et
   * aucune réponse n'est envoyée.
   */
  suspended?: { reason: string };
  /** Contexte du sujet pour un agent sortant (RDV concerné, lien d'avis). */
  subject?: {
    serviceType?: string | null;
    whenLabel?: string | null;
    googleReviewUrl?: string | null;
  };
}

export async function runAgentTurn(params: RunTurnParams): Promise<EngineResult> {
  const { message, sender } = params;

  // Première passe avec l'agent de qualification, nécessaire pour créer la
  // conversation si elle n'existe pas.
  let agent = await resolveAgentContext(message.tenantId, message.locationId);
  const conversation = await loadOrCreateConversation(message, agent);

  // La conversation peut avoir été ouverte par un agent sortant (relance,
  // demande d'avis). Si la personne répond, c'est CE rôle qui doit reprendre —
  // sinon l'agent de qualification se mettrait à poser des questions de
  // découverte à quelqu'un qui sort de séance.
  if (conversation.agentId && conversation.agentId !== agent.agentId) {
    agent = await resolveAgentContext(
      message.tenantId,
      message.locationId,
      conversation.agentId,
    );
  }

  const turnLogger = scopedLogger({
    tenantId: message.tenantId,
    channel: message.channel,
    agentType: agent.type,
    conversationId: conversation.conversationId,
    leadId: conversation.leadId,
  });

  // --- Idempotence ---------------------------------------------------------
  // Meta rejoue ses webhooks. On distingue le vrai doublon (déjà répondu) de la
  // reprise après crash (message enregistré, réponse jamais partie).
  const inbound = await recordInbound(conversation.conversationId, message, params.rawPayload);
  if (!inbound.inserted) {
    if (await hasReplyAfter(conversation.conversationId, inbound.createdAt)) {
      turnLogger.info("turn.skipped", { reason: "duplicate_message" });
      return {
        conversationId: conversation.conversationId,
        leadId: conversation.leadId,
        escalated: false,
        skippedReason: "duplicate_message",
      };
    }
    turnLogger.warn("turn.resumed", { reason: "reprise après échec partiel" });
  }

  // --- Garde-fou 1 : conversation déjà entre des mains humaines -------------
  if (conversation.status === "escalated") {
    turnLogger.info("turn.skipped", { reason: "conversation_escalated" });
    return {
      conversationId: conversation.conversationId,
      leadId: conversation.leadId,
      escalated: true,
      skippedReason: "conversation_escalated",
    };
  }

  // --- Garde-fou 2 : abonnement inactif ------------------------------------
  // Le message est conservé et signalé au gérant, mais rien n'est envoyé au
  // lead : continuer à répondre serait rendre le service gratuitement, se
  // taire sans trace ferait perdre le lead sans que personne le sache.
  if (params.suspended) {
    await openEscalation({
      tenantId: agent.tenantId,
      conversationId: conversation.conversationId,
      reason: `Agent suspendu — ${params.suspended.reason}`,
      triggeredBy: "external_error",
    });
    turnLogger.warn("turn.suspended", { reason: params.suspended.reason });

    return {
      conversationId: conversation.conversationId,
      leadId: conversation.leadId,
      escalated: true,
      escalationReason: params.suspended.reason,
      skippedReason: "billing_suspended",
    };
  }

  // --- Garde-fou 3 : message non exploitable (photo, audio, document) -------
  // Cas très courant en esthétique : le lead envoie la photo de la zone à
  // traiter. L'agent ne sait pas la lire ; répondre à côté serait pire que se
  // taire, et se taire sans trace ferait perdre le lead. On escalade, et on
  // prévient la personne que quelqu'un va regarder.
  if (message.kind === "unsupported") {
    const reason = `Message non exploitable par l'agent (${message.unsupportedType ?? "pièce jointe"})`;
    await openEscalation({
      tenantId: agent.tenantId,
      conversationId: conversation.conversationId,
      reason,
      triggeredBy: "manual",
    });
    turnLogger.info("escalation.opened", {
      trigger: "unsupported_message",
      type: message.unsupportedType ?? null,
    });

    const handoff = handoffMessage(agent.agentConfig);
    await deliver({ text: handoff, message, sender, conversation, logger: turnLogger });

    return {
      conversationId: conversation.conversationId,
      leadId: conversation.leadId,
      escalated: true,
      escalationReason: reason,
      replyText: handoff,
    };
  }

  // --- Garde-fou 4 : mots-clés d'escalade, avant tout appel LLM -------------
  const keyword = matchEscalationKeyword(message.text, agent.escalationKeywords);
  if (keyword) {
    const reason = `Mot-clé hors script détecté : "${keyword}"`;
    await openEscalation({
      tenantId: agent.tenantId,
      conversationId: conversation.conversationId,
      reason,
      triggeredBy: "keyword",
    });
    turnLogger.info("escalation.opened", { trigger: "keyword", keyword });

    const handoff = handoffMessage(agent.agentConfig);
    await deliver({ text: handoff, message, sender, conversation, logger: turnLogger });

    return {
      conversationId: conversation.conversationId,
      leadId: conversation.leadId,
      escalated: true,
      escalationReason: reason,
      replyText: handoff,
    };
  }

  // --- Boucle LLM / outils -------------------------------------------------
  const toolContext: ToolContext = {
    agent,
    conversationId: conversation.conversationId,
    leadId: conversation.leadId,
    logger: turnLogger,
    state: {
      qualificationData: conversation.qualificationData,
      escalated: false,
      offeredSlots: [],
    },
  };

  const tools = buildTools(agent);
  const messages: LlmMessage[] = await loadHistory(conversation.conversationId);

  if (messages.length === 0) {
    // L'historique ne peut pas être vide : le message entrant vient d'être
    // enregistré. Filet de sécurité si la troncature a tout mangé.
    messages.push({ role: "user", content: message.text });
  }

  let replyText = "";

  for (let iteration = 1; iteration <= MAX_TOOL_ITERATIONS; iteration++) {
    const systemPrompt = buildSystemPrompt({
      agentType: agent.type,
      tenantName: agent.tenantName,
      locationName: agent.locationName,
      timezone: agent.timezone,
      systemPromptTemplate: agent.systemPromptTemplate,
      questions: agent.questions,
      budgetRules: agent.budgetRules,
      collected: toolContext.state.qualificationData,
      bookingEnabled: bookingAvailable(agent),
      calendarReadOnly: calendarAvailable(agent) && !bookingAvailable(agent),
      leadDisplayName: conversation.leadFullName ?? message.contactDisplayName ?? null,
      subject: params.subject,
    });

    const response = await callAgentLLM({ systemPrompt, messages, tools, logger: turnLogger });

    turnLogger.info("llm.turn", {
      iteration,
      stopReason: response.stopReason,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
    });

    // Refus des classificateurs : contenu vide ou partiel, jamais exploitable.
    if (response.refused) {
      const reason = `Refus du modèle (${response.refusalCategory ?? "non catégorisé"})`;
      await openEscalation({
        tenantId: agent.tenantId,
        conversationId: conversation.conversationId,
        reason,
        triggeredBy: "external_error",
      });
      const handoff = handoffMessage(agent.agentConfig);
      await deliver({ text: handoff, message, sender, conversation, logger: turnLogger });
      return {
        conversationId: conversation.conversationId,
        leadId: conversation.leadId,
        escalated: true,
        escalationReason: reason,
        replyText: handoff,
      };
    }

    const toolUses = extractToolUses(response.content);
    replyText = extractText(response.content);

    if (toolUses.length === 0) break;

    // L'historique doit contenir les blocs `tool_use` tels quels, sinon l'API
    // rejette les `tool_result` du tour suivant.
    messages.push({ role: "assistant", content: response.content });

    const results: LlmToolResultBlock[] = [];
    for (const toolUse of toolUses) {
      const outcome = await dispatchTool(toolUse.name, toolUse.input, toolContext);
      results.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: outcome.content,
        is_error: outcome.isError,
      });
    }

    // Tous les résultats dans un seul message utilisateur : les découper
    // apprendrait au modèle à ne plus paralléliser ses appels d'outils.
    messages.push({ role: "user", content: results });

    if (iteration === MAX_TOOL_ITERATIONS) {
      const reason = "Boucle d'outils non convergente (limite d'itérations atteinte)";
      turnLogger.error("turn.loop_limit", { iterations: iteration });
      await openEscalation({
        tenantId: agent.tenantId,
        conversationId: conversation.conversationId,
        reason,
        triggeredBy: "external_error",
      });
      toolContext.state.escalated = true;
      toolContext.state.escalationReason = reason;
      replyText = replyText || handoffMessage(agent.agentConfig);
    }
  }

  // --- Réponse -------------------------------------------------------------
  if (!replyText) {
    // Le modèle n'a produit aucun texte : on n'invente rien, on alerte.
    turnLogger.warn("turn.empty_reply", {});
    replyText = toolContext.state.escalated ? handoffMessage(agent.agentConfig) : "";
  }

  if (replyText) {
    await deliver({ text: replyText, message, sender, conversation, logger: turnLogger });
  }

  return {
    conversationId: conversation.conversationId,
    leadId: conversation.leadId,
    escalated: toolContext.state.escalated,
    escalationReason: toolContext.state.escalationReason,
    replyText: replyText || undefined,
    bookedAppointmentId: toolContext.state.bookedAppointmentId,
  };
}

function handoffMessage(agentConfig: Record<string, unknown>): string {
  const custom = agentConfig["handoff_message"];
  return typeof custom === "string" && custom.trim() ? custom.trim() : DEFAULT_HANDOFF_MESSAGE;
}

/**
 * Envoi + persistance. L'envoi est retenté (API Meta), et le message n'est
 * enregistré comme sortant qu'une fois réellement parti — l'historique ne
 * contient jamais un message que le lead n'a pas reçu.
 */
async function deliver(params: {
  text: string;
  message: NormalizedInboundMessage;
  sender: ChannelSender;
  conversation: { conversationId: string };
  logger: ReturnType<typeof scopedLogger>;
}): Promise<void> {
  const { text, message, sender, conversation, logger } = params;

  try {
    const sent = await withRetry(
      () =>
        sender.send({
          externalThreadId: message.externalThreadId,
          externalContactId: message.externalContactId,
          text,
        }),
      {
        attempts: 3,
        onRetry: (error, attempt, delayMs) =>
          logger.warn("channel.send.retry", { attempt, delayMs, error: String(error) }),
      },
    );

    await recordOutbound({
      conversationId: conversation.conversationId,
      text,
      externalMessageId: sent.externalMessageId,
    });

    logger.info("message.sent", { length: text.length });
  } catch (error) {
    logger.error("message.send_failed", { error: String(error) });
    // Remonté à l'appelant (webhook / dispatcher) : l'event repasse en `pending`
    // et sera rejoué avec backoff plutôt que perdu.
    throw error instanceof AppError
      ? error
      : new ExternalApiError(sender.channel, "envoi du message échoué", { cause: error });
  }
}
