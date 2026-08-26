import type { Channel } from "../types.ts";

/**
 * Message entrant extrait d'un webhook, AVANT résolution du tenant.
 *
 * Le tenant est ajouté ensuite par le dispatcher via `resolveConnection()` :
 * il n'est jamais lu depuis le payload, qui n'est pas une source de confiance
 * pour l'isolation multi-tenant.
 */
export interface RawInboundEvent {
  channel: Channel;
  /**
   * `unsupported` = message reçu mais non exploitable par l'agent (photo,
   * audio, document, localisation).
   *
   * Ces messages étaient auparavant écartés par les parseurs. Un lead qui
   * envoie la photo de la zone à traiter — cas très courant en esthétique —
   * n'obtenait alors aucune réponse, et l'institut n'en savait rien. Ils sont
   * désormais enregistrés et escaladés.
   */
  kind: "text" | "unsupported";
  /** Type Meta du message non exploité, pour l'expliquer au gérant. */
  unsupportedType?: string;
  externalAccountId: string;
  externalThreadId: string;
  externalContactId: string;
  externalMessageId: string;
  text: string;
  contactDisplayName?: string;
  receivedAt: string;
}

/**
 * Un message extrait + le fragment de payload d'origine dont il vient.
 *
 * On ne conserve que le fragment, jamais le corps complet du webhook : un même
 * appel Meta peut porter les messages de plusieurs leads, et les stocker en
 * bloc sous chaque message mélangerait les données personnelles de personnes
 * différentes dans la même ligne (droit à l'oubli impossible à honorer).
 */
export interface ParsedInbound {
  event: RawInboundEvent;
  raw: unknown;
}
