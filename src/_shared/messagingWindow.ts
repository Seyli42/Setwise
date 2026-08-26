// Fenêtre de messagerie Meta (24 h).
//
// Règle : un message libre n'est autorisé que dans les 24 h suivant le dernier
// message du client. Au-delà, seul un modèle approuvé passe.
//
// Le calcul vivait à trois endroits (persistance, dashboard, rappels). Trois
// copies d'une règle imposée par un tiers finissent toujours par diverger, et
// la divergence se voit soit en messages refusés par Meta, soit en zone de
// saisie ouverte alors qu'elle ne devrait pas l'être.

/** Durée de la fenêtre, imposée par Meta. */
export const MESSAGING_WINDOW_HOURS = 24;

/**
 * Marge de sécurité : un envoi décidé à 23 h 59 min 50 s peut atteindre Meta
 * après la fermeture. On considère la fenêtre close deux minutes avant l'heure
 * réelle plutôt que de laisser Meta refuser le message.
 */
const SAFETY_MARGIN_MS = 2 * 60_000;

/** Expiration de la fenêtre, à partir de l'horodatage du message entrant. */
export function windowExpiryFrom(inboundIso: string): string {
  const receivedAt = new Date(inboundIso);
  const base = Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt;
  return new Date(base.getTime() + MESSAGING_WINDOW_HOURS * 3_600_000).toISOString();
}

/**
 * La fenêtre est-elle ouverte ?
 *
 * `null` signifie « aucun message entrant à ce jour » — typiquement une
 * conversation WhatsApp ouverte par un modèle après une qualification sur
 * Instagram. Un modèle n'ouvre pas de fenêtre de service : seule une réponse du
 * client le fait. La fenêtre est donc fermée, pas ouverte par défaut.
 */
export function isWindowOpen(expiresAtIso: string | null | undefined, now = new Date()): boolean {
  if (!expiresAtIso) return false;

  const expiresAt = Date.parse(expiresAtIso);
  if (Number.isNaN(expiresAt)) return false;

  return expiresAt - SAFETY_MARGIN_MS > now.getTime();
}

/** Temps restant en minutes, pour l'affichage au gérant. `0` si fermée. */
export function minutesLeftInWindow(
  expiresAtIso: string | null | undefined,
  now = new Date(),
): number {
  if (!isWindowOpen(expiresAtIso, now)) return 0;
  return Math.floor((Date.parse(expiresAtIso!) - SAFETY_MARGIN_MS - now.getTime()) / 60_000);
}
