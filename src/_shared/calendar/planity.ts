// Provider Planity.
//
// ─────────────────────────────────────────────────────────────────────────────
// CONTRAINTE À CONNAÎTRE AVANT DE LIRE CE FICHIER
//
// Planity ne publie pas d'API développeur publique. Il n'existe pas, à la date
// d'écriture, d'endpoint documenté et accessible en libre-service permettant de
// lire les disponibilités ou de créer un rendez-vous depuis un logiciel tiers.
//
// Écrire ici un client contre des URL devinées ou observées dans le trafic de
// leur application produirait trois problèmes, dans cet ordre de gravité :
//   1. un code qui PARAÎT terminé et casse en production chez un vrai institut ;
//   2. une dépendance à une interface non contractuelle, cassée sans préavis ;
//   3. une exposition juridique pour Setwise comme pour l'institut.
//
// Ce fichier ne fait donc pas semblant. Il implémente ce qui marche réellement
// aujourd'hui et échoue explicitement sur le reste.
// ─────────────────────────────────────────────────────────────────────────────
//
// CE QUI MARCHE : la lecture, via le flux de synchronisation calendrier que
// Planity expose (comme la quasi-totalité des logiciels de réservation). Cela
// suffit à connaître les plages occupées, donc à proposer des créneaux
// réellement libres. L'agent qualifie, propose, et transmet le choix à l'équipe.
//
// CE QUI NE MARCHE PAS : l'écriture. `bookAppointment` échoue avec un message
// destiné au gérant, pas une trace technique.
//
// LES DEUX VOIES POUR OBTENIR L'ÉCRITURE
//   a) Partenariat Planity : demander un accès API. Une fois le contrat obtenu,
//      seul `bookAppointment` ci-dessous est à implémenter — le reste du
//      produit ne bouge pas, c'est la raison d'être de l'interface
//      `CalendarProvider`.
//   b) Synchronisation Planity → Google Calendar, puis provider `google`. C'est
//      la voie recommandée aujourd'hui : elle donne l'écriture immédiatement,
//      sans partenariat, et beaucoup d'instituts l'utilisent déjà.

import { ValidationError } from "../errors.ts";
import type {
  AvailabilityRequest,
  BookingRequest,
  CalendarProvider,
  CalendarSlot,
} from "../types.ts";
import { icsCalendarProvider } from "./ics.ts";

export const planityCalendarProvider: CalendarProvider = {
  // Lecture seule : `buildTools` n'exposera pas l'outil de réservation, et le
  // prompt dira au lead que l'institut confirme le créneau.
  capabilities: { canBook: false },

  /**
   * Disponibilités lues depuis le flux de synchronisation Planity.
   * `credentials_encrypted` contient `{"ics_url": "https://..."}`.
   */
  checkAvailability(params: AvailabilityRequest): Promise<CalendarSlot[]> {
    return icsCalendarProvider.checkAvailability(params);
  },

  bookAppointment(_params: BookingRequest): Promise<{ externalEventId: string }> {
    return Promise.reject(
      new ValidationError(
        "Planity ne permet pas la réservation automatique : l'agent propose les créneaux, " +
          "votre équipe confirme. Pour une réservation entièrement automatique, synchronisez " +
          "Planity avec Google Agenda et connectez Google depuis vos Connexions.",
      ),
    );
  },

  cancelEvent(): Promise<void> {
    return Promise.reject(
      new ValidationError("Planity ne permet pas l'annulation automatique."),
    );
  },
};
