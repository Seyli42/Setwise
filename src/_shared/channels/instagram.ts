// Canal Instagram DM (Messenger Platform for Instagram).
//
// Entrant  : webhook `object: "instagram"` → entry[].messaging[]
// Sortant  : POST /{ig_account_id}/messages

import { graphPost } from "../meta.ts";
import type { ChannelSender } from "../types.ts";
import type { ChannelConnection } from "./connection.ts";
import type { ParsedInbound } from "./types.ts";

/**
 * Extrait les messages texte exploitables d'un payload Instagram.
 *
 * Ignore silencieusement ce dont on n'a rien à faire : les échos (`is_echo` —
 * nos propres messages nous reviennent), les accusés de lecture, les réactions.
 *
 * Les pièces jointes SANS texte ne sont pas ignorées : elles remontent avec
 * `kind: "unsupported"`. Un lead qui envoie la photo de la zone à traiter doit
 * obtenir une réponse humaine, pas le silence.
 */
export function parseInstagramWebhook(payload: Record<string, unknown>): ParsedInbound[] {
  if (payload.object !== "instagram") return [];

  const events: ParsedInbound[] = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];

  for (const entry of entries as Array<Record<string, unknown>>) {
    const accountId = typeof entry.id === "string" ? entry.id : null;
    if (!accountId) continue;

    const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];

    for (const item of messaging as Array<Record<string, unknown>>) {
      const message = item.message as Record<string, unknown> | undefined;
      if (!message || message.is_echo === true) continue;

      const text = typeof message.text === "string" ? message.text.trim() : "";
      const messageId = typeof message.mid === "string" ? message.mid : null;
      const senderId = (item.sender as Record<string, unknown> | undefined)?.id;

      if (!messageId || typeof senderId !== "string") continue;

      const attachments = Array.isArray(message.attachments) ? message.attachments : [];
      // Ni texte ni pièce jointe : accusé de lecture ou réaction, rien à traiter.
      if (!text && attachments.length === 0) continue;

      const attachmentType = attachments.length > 0
        ? String((attachments[0] as Record<string, unknown>)?.type ?? "attachment")
        : null;

      const timestamp = typeof item.timestamp === "number"
        ? new Date(item.timestamp).toISOString()
        : new Date().toISOString();

      events.push({
        event: {
          channel: "instagram",
          kind: text ? "text" : "unsupported",
          unsupportedType: text ? undefined : attachmentType ?? "attachment",
          externalAccountId: accountId,
          // Sur Instagram le thread est identifié par l'IGSID de l'interlocuteur.
          externalThreadId: senderId,
          externalContactId: senderId,
          externalMessageId: messageId,
          text,
          receivedAt: timestamp,
        },
        raw: item,
      });
    }
  }

  return events;
}

export function createInstagramSender(connection: ChannelConnection): ChannelSender {
  return {
    channel: "instagram",
    async send({ externalContactId, text }) {
      const result = await graphPost<{ message_id?: string; mid?: string }>({
        service: "instagram",
        path: `${connection.externalAccountId}/messages`,
        accessToken: connection.accessToken,
        body: {
          recipient: { id: externalContactId },
          message: { text },
          messaging_type: "RESPONSE",
        },
      });

      return { externalMessageId: result.message_id ?? result.mid ?? "" };
    },
  };
}
