// Canal WhatsApp Business (Cloud API).
//
// Entrant : webhook `object: "whatsapp_business_account"` → entry[].changes[].value.messages[]
// Sortant : POST /{phone_number_id}/messages
//
// Règle Meta structurante : un message libre (`type: "text"`) n'est autorisé que
// dans les 24 h suivant le dernier message du client. Hors fenêtre, seul un
// modèle (`template`) pré-approuvé passe. Les deux chemins sont exposés
// séparément — jamais de bascule implicite.

import { graphPost } from "../meta.ts";
import { ValidationError } from "../errors.ts";
import type { ChannelSender } from "../types.ts";
import type { ChannelConnection } from "./connection.ts";
import type { ParsedInbound } from "./types.ts";

export function parseWhatsAppWebhook(payload: Record<string, unknown>): ParsedInbound[] {
  if (payload.object !== "whatsapp_business_account") return [];

  const events: ParsedInbound[] = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries as Array<Record<string, unknown>>) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes as Array<Record<string, unknown>>) {
      if (change.field !== "messages") continue;

      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;

      // Les mises à jour de statut (`sent`/`delivered`/`read`) arrivent sur le
      // même webhook et ne portent pas de message : rien à traiter.
      const messages = Array.isArray(value.messages) ? value.messages : [];
      if (messages.length === 0) continue;

      const metadata = value.metadata as Record<string, unknown> | undefined;
      const phoneNumberId = typeof metadata?.phone_number_id === "string"
        ? metadata.phone_number_id
        : null;
      if (!phoneNumberId) continue;

      // `contacts[]` porte le nom de profil WhatsApp, indexé par wa_id.
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const nameByWaId = new Map<string, string>();
      for (const contact of contacts as Array<Record<string, unknown>>) {
        const waId = typeof contact.wa_id === "string" ? contact.wa_id : null;
        const profile = contact.profile as Record<string, unknown> | undefined;
        const name = typeof profile?.name === "string" ? profile.name : null;
        if (waId && name) nameByWaId.set(waId, name);
      }

      for (const message of messages as Array<Record<string, unknown>>) {
        const from = typeof message.from === "string" ? message.from : null;
        const id = typeof message.id === "string" ? message.id : null;
        const type = String(message.type ?? "");

        if (!from || !id || !type) continue;

        const body = (message.text as Record<string, unknown> | undefined)?.body;
        const text = type === "text" && typeof body === "string" ? body.trim() : "";

        // Un message texte vide n'existe pas côté Meta ; s'il arrive, il n'y a
        // rien à traiter. Les autres types (image, audio, document, location)
        // sont conservés et escaladés plutôt qu'ignorés.
        if (type === "text" && !text) continue;

        const seconds = Number.parseInt(String(message.timestamp ?? ""), 10);
        const receivedAt = Number.isFinite(seconds)
          ? new Date(seconds * 1000).toISOString()
          : new Date().toISOString();

        events.push({
          event: {
            channel: "whatsapp",
            kind: type === "text" ? "text" : "unsupported",
            unsupportedType: type === "text" ? undefined : type,
            externalAccountId: phoneNumberId,
            externalThreadId: from,
            externalContactId: from,
            externalMessageId: id,
            text,
            contactDisplayName: nameByWaId.get(from),
            receivedAt,
          },
          // Fragment minimal : le message + les métadonnées du compte, sans les
          // messages des autres leads présents dans le même appel.
          raw: { metadata, message },
        });
      }
    }
  }

  return events;
}

export function createWhatsAppSender(connection: ChannelConnection): ChannelSender {
  return {
    channel: "whatsapp",
    async send({ externalContactId, text }) {
      const result = await graphPost<{ messages?: Array<{ id: string }> }>({
        service: "whatsapp",
        path: `${connection.externalAccountId}/messages`,
        accessToken: connection.accessToken,
        body: {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: externalContactId,
          type: "text",
          text: { preview_url: false, body: text },
        },
      });

      return { externalMessageId: result.messages?.[0]?.id ?? "" };
    },
  };
}

export interface TemplateParams {
  connection: ChannelConnection;
  to: string;
  templateName: string;
  languageCode?: string;
  /** Variables positionnelles {{1}}, {{2}}… du corps du modèle. */
  bodyParameters?: string[];
}

/**
 * Envoi d'un modèle approuvé. Seul chemin légal pour :
 * - ouvrir une conversation WhatsApp (relais depuis Instagram) ;
 * - recontacter un lead hors fenêtre de 24 h (rappels de RDV).
 *
 * Le nom du modèle est paramétrable par institut : chaque compte WhatsApp
 * Business fait approuver ses propres modèles par Meta.
 */
export async function sendWhatsAppTemplate(
  params: TemplateParams,
): Promise<{ externalMessageId: string }> {
  if (!params.templateName.trim()) {
    throw new ValidationError("Nom de modèle WhatsApp vide.", { to: params.to });
  }

  const components = params.bodyParameters && params.bodyParameters.length > 0
    ? [{
      type: "body",
      parameters: params.bodyParameters.map((text) => ({ type: "text", text })),
    }]
    : undefined;

  const result = await graphPost<{ messages?: Array<{ id: string }> }>({
    service: "whatsapp",
    path: `${params.connection.externalAccountId}/messages`,
    accessToken: params.connection.accessToken,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "template",
      template: {
        name: params.templateName,
        language: { code: params.languageCode ?? "fr" },
        ...(components ? { components } : {}),
      },
    },
  });

  return { externalMessageId: result.messages?.[0]?.id ?? "" };
}

/** Normalise un numéro FR saisi librement vers le format E.164 sans `+` attendu par Meta. */
export function toWhatsAppNumber(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) return digits.slice(1) || null;
  if (digits.startsWith("00")) return digits.slice(2) || null;
  // 0X XX XX XX XX → 33XXXXXXXXX
  if (digits.startsWith("0") && digits.length === 10) return `33${digits.slice(1)}`;
  if (digits.length >= 10) return digits;

  return null;
}
