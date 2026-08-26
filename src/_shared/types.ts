// Types partagés — moteur d'agent, indépendant du canal.

export type Channel = "instagram" | "whatsapp";

/**
 * Rôles métier. Un rôle = un prompt de mission + un jeu d'outils ; le moteur
 * d'exécution est le même pour tous.
 */
export type AgentType = "qualification_rdv" | "avis_google" | "relance" | "reactivation";

export interface NormalizedInboundMessage {
  tenantId: string;
  /** `unsupported` : photo, audio, document — non exploitable par l'agent. */
  kind?: "text" | "unsupported";
  unsupportedType?: string;
  locationId: string | null;
  channel: Channel;
  externalThreadId: string;   // id conversation côté Meta (IGSID / wa_id thread)
  externalContactId: string;  // IGSID ou numéro WhatsApp
  externalMessageId: string;  // pour dédup
  text: string;
  contactDisplayName?: string;
  receivedAt: string; // ISO
}

export interface ChannelSender {
  channel: Channel;
  send(params: { externalThreadId: string; externalContactId: string; text: string }): Promise<{ externalMessageId: string }>;
}

export interface EngineResult {
  conversationId: string;
  leadId: string;
  escalated: boolean;
  escalationReason?: string;
  replyText?: string;
  skippedReason?: string; // ex: "duplicate_message", "conversation_escalated"
  /** Renseigné quand un RDV vient d'être confirmé pendant ce tour. */
  bookedAppointmentId?: string;
}

export interface CalendarSlot {
  startsAt: string; // ISO
  endsAt: string;   // ISO
}

/** Intervalle horaire local `["09:00", "12:30"]`. */
export type OpeningInterval = [string, string];

export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

/**
 * Règles de planification de l'institut, stockées dans `agents.config`.
 * Modifiables depuis le dashboard sans redéploiement.
 */
export interface SchedulingConfig {
  /** Horaires d'ouverture en heure locale de l'établissement. */
  businessHours: Partial<Record<WeekdayKey, OpeningInterval[]>>;
  /** Durée par prestation. La correspondance se fait par inclusion de libellé. */
  services: Array<{ name: string; durationMin: number }>;
  defaultDurationMin: number;
  /** Pas de proposition des créneaux (30 → :00 et :30). */
  slotGranularityMin: number;
  /** Délai minimum entre maintenant et le début d'un créneau proposé. */
  minNoticeHours: number;
  maxDaysAhead: number;
}

export interface AvailabilityRequest {
  calendarExternalId: string;
  credentialsEncrypted: string;
  serviceType: string;
  fromDate: string; // ISO
  toDate: string;   // ISO
  timezone: string;
  scheduling: SchedulingConfig;
}

export interface BookingRequest {
  calendarExternalId: string;
  credentialsEncrypted: string;
  slot: CalendarSlot;
  serviceType: string;
  leadName: string;
  leadPhone?: string | null;
  timezone: string;
  /**
   * Clé d'idempotence propagée jusqu'à l'API calendrier : un retry après
   * timeout ne doit pas créer deux événements pour le même rendez-vous.
   */
  idempotencyKey: string;
}

export interface CalendarCapabilities {
  /**
   * `false` = lecture seule (flux ICS d'un logiciel tiers). L'agent propose des
   * créneaux réellement libres mais ne réserve pas : l'outil de réservation ne
   * lui est alors pas exposé, et le prompt lui dit de transmettre à l'équipe.
   */
  canBook: boolean;
}

export interface CalendarProvider {
  /** Par défaut : lecture et écriture. */
  capabilities?: CalendarCapabilities;
  checkAvailability(params: AvailabilityRequest): Promise<CalendarSlot[]>;
  bookAppointment(params: BookingRequest): Promise<{ externalEventId: string }>;
  cancelEvent(params: {
    calendarExternalId: string;
    credentialsEncrypted: string;
    externalEventId: string;
  }): Promise<void>;
}

export interface QualificationQuestion {
  id: string;
  prompt: string;
  field: string; // clé dans leads.qualification_data
}
