// Provider calendrier en LECTURE SEULE, à partir d'un flux ICS (RFC 5545).
//
// Raison d'être : la plupart des logiciels de réservation utilisés par les
// instituts — Planity le premier — n'exposent pas d'API d'écriture publique,
// mais publient tous un flux ICS de synchronisation. Ce flux suffit à connaître
// les plages occupées, donc à proposer des créneaux réellement libres.
//
// L'agent peut alors qualifier et proposer, mais pas réserver : il transmet le
// créneau retenu à l'équipe. C'est un mode dégradé assumé et annoncé comme tel
// au lead, jamais une réservation fantôme.

import { decryptSecret } from "../crypto.ts";
import { ExternalApiError, ValidationError } from "../errors.ts";
import { log } from "../logger.ts";
import type {
  AvailabilityRequest,
  BookingRequest,
  CalendarProvider,
  CalendarSlot,
} from "../types.ts";
import { type BusyInterval, generateSlots, resolveDuration } from "./slots.ts";
import { expandRecurrence } from "./rrule.ts";

/**
 * Déplie les lignes ICS.
 *
 * RFC 5545 : une ligne de plus de 75 octets est coupée, la suite étant
 * préfixée d'une espace ou d'une tabulation. Sans dépliage, une `DTSTART`
 * coupée en deux devient illisible et le créneau correspondant serait
 * silencieusement considéré comme libre.
 */
function unfold(raw: string): string[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const unfolded: string[] = [];

  for (const line of lines) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += line.slice(1);
    } else {
      unfolded.push(line);
    }
  }
  return unfolded;
}

/**
 * Analyse une valeur de date ICS.
 *
 * Trois formes admises :
 *   `20260816T140000Z`            → instant UTC
 *   `20260816T140000` + TZID      → heure locale du fuseau indiqué
 *   `20260816`                    → journée entière (VALUE=DATE)
 */
function parseIcsDate(
  value: string,
  params: Record<string, string>,
  fallbackTimeZone: string,
): { date: Date; allDay: boolean } | null {
  const raw = value.trim();

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return { date: new Date(`${y}-${m}-${d}T00:00:00Z`), allDay: true };
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(raw);
  if (!dateTime) return null;

  const [, y, m, d, hh, mm, ss, utc] = dateTime;
  const iso = `${y}-${m}-${d}T${hh}:${mm}:${ss}`;

  if (utc) return { date: new Date(`${iso}Z`), allDay: false };

  // Heure locale : on la convertit via le fuseau déclaré dans le paramètre
  // TZID, sinon celui de l'établissement.
  const timeZone = params.TZID ?? fallbackTimeZone;
  const naive = new Date(`${iso}Z`);
  const offset = zoneOffsetMs(naive, timeZone);
  const firstPass = new Date(naive.getTime() - offset);

  return { date: new Date(naive.getTime() - zoneOffsetMs(firstPass, timeZone)), allDay: false };
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;

    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    );
    return asUtc - instant.getTime();
  } catch {
    // TZID inconnu de la base tzdata : on retombe sur UTC plutôt que d'échouer.
    return 0;
  }
}

/** Sépare `DTSTART;TZID=Europe/Paris:20260816T140000` en nom, paramètres, valeur. */
function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const separator = line.indexOf(":");
  if (separator === -1) return null;

  const head = line.slice(0, separator);
  const value = line.slice(separator + 1);
  const [name, ...rawParams] = head.split(";");

  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const eq = param.indexOf("=");
    if (eq > 0) params[param.slice(0, eq).toUpperCase()] = param.slice(eq + 1).replace(/^"|"$/g, "");
  }

  return { name: name.toUpperCase(), params, value };
}

export interface ParseIcsOptions {
  /** Fuseau appliqué aux dates sans TZID ni suffixe Z. */
  fallbackTimeZone: string;
  from?: Date;
  to?: Date;
  /** Plafond d'occurrences développées par événement récurrent. */
  maxOccurrencesPerEvent?: number;
}

export interface ParseIcsResult {
  busy: BusyInterval[];
  /** Nombre d'événements récurrents effectivement développés. */
  expandedRecurring: number;
  /** Règles contenant une partie non gérée : l'occupation est surestimée. */
  partialRules: string[];
  /** Vrai si un plafond a été atteint : des occurrences peuvent manquer. */
  truncated: boolean;
}

interface RawEvent {
  uid: string | null;
  start: { date: Date; allDay: boolean } | null;
  end: { date: Date; allDay: boolean } | null;
  timeZone: string;
  transparent: boolean;
  cancelled: boolean;
  rrule: string | null;
  rdates: Date[];
  exdates: Date[];
  recurrenceId: Date | null;
}

function emptyEvent(fallbackTimeZone: string): RawEvent {
  return {
    uid: null,
    start: null,
    end: null,
    timeZone: fallbackTimeZone,
    transparent: false,
    cancelled: false,
    rrule: null,
    rdates: [],
    exdates: [],
    recurrenceId: null,
  };
}

/** `EXDATE` et `RDATE` acceptent plusieurs dates séparées par des virgules. */
function parseDateList(
  value: string,
  params: Record<string, string>,
  fallbackTimeZone: string,
): Date[] {
  const dates: Date[] = [];

  for (const chunk of value.split(",")) {
    const parsed = parseIcsDate(chunk, params, fallbackTimeZone);
    if (parsed) dates.push(parsed.date);
  }

  return dates;
}

/**
 * Découpe un flux en événements bruts, sans interprétation.
 *
 * La séparation en deux temps n'est pas cosmétique : une instance déplacée
 * (`RECURRENCE-ID`) peut apparaître AVANT l'événement maître dans le flux. La
 * traiter au fil de la lecture reviendrait à bloquer l'ancien créneau et le
 * nouveau.
 */
function readEvents(ics: string, fallbackTimeZone: string): RawEvent[] {
  const events: RawEvent[] = [];
  let current: RawEvent | null = null;

  for (const line of unfold(ics)) {
    if (line === "BEGIN:VEVENT") {
      current = emptyEvent(fallbackTimeZone);
      continue;
    }

    if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = null;
      continue;
    }

    if (!current) continue;

    const property = splitProperty(line);
    if (!property) continue;

    switch (property.name) {
      case "UID":
        current.uid = property.value.trim() || null;
        break;
      case "DTSTART":
        current.start = parseIcsDate(property.value, property.params, fallbackTimeZone);
        // Le fuseau du DTSTART commande le développement de la récurrence :
        // une règle hebdomadaire se répète à heure murale constante.
        if (property.params.TZID) current.timeZone = property.params.TZID;
        break;
      case "DTEND":
        current.end = parseIcsDate(property.value, property.params, fallbackTimeZone);
        break;
      case "TRANSP":
        current.transparent = property.value.trim().toUpperCase() === "TRANSPARENT";
        break;
      case "STATUS":
        current.cancelled = property.value.trim().toUpperCase() === "CANCELLED";
        break;
      case "RRULE":
        current.rrule = property.value.trim();
        break;
      case "RDATE":
        current.rdates.push(
          ...parseDateList(property.value, property.params, fallbackTimeZone),
        );
        break;
      case "EXDATE":
        current.exdates.push(
          ...parseDateList(property.value, property.params, fallbackTimeZone),
        );
        break;
      case "RECURRENCE-ID": {
        const parsed = parseIcsDate(property.value, property.params, fallbackTimeZone);
        current.recurrenceId = parsed?.date ?? null;
        break;
      }
    }
  }

  return events;
}

/**
 * Extrait les plages occupées d'un flux ICS, récurrences comprises.
 *
 * Ignorés volontairement : les événements `TRANSP:TRANSPARENT` (marqués
 * « disponible ») et les événements annulés (`STATUS:CANCELLED`).
 *
 * Les récurrences sont développées (voir `rrule.ts`). Une règle contenant une
 * partie non gérée produit PLUS d'occurrences que la réalité : le créneau est
 * bloqué à tort plutôt que proposé à tort. Perdre un rendez-vous possible coûte
 * moins cher que d'en placer deux au même moment.
 */
export function parseIcsBusyIntervals(
  ics: string,
  options: ParseIcsOptions,
): ParseIcsResult {
  const busy: BusyInterval[] = [];
  const partialRules: string[] = [];
  let expandedRecurring = 0;
  let truncated = false;

  // Sans fenêtre explicite, on borne à un an : une règle infinie développée
  // sans limite ferait tourner la fonction jusqu'au plafond pour rien.
  const from = options.from ?? new Date(0);
  const to = options.to ?? new Date(Date.now() + 366 * 86_400_000);

  const events = readEvents(ics, options.fallbackTimeZone);

  // Instances déplacées : leur `RECURRENCE-ID` désigne l'occurrence d'origine,
  // qui ne doit plus compter. L'instance elle-même est ajoutée normalement.
  const overridden = new Set<string>();
  for (const event of events) {
    if (event.recurrenceId && event.uid) {
      overridden.add(`${event.uid}|${event.recurrenceId.toISOString()}`);
    }
  }

  for (const event of events) {
    if (!event.start || event.transparent || event.cancelled) continue;

    // Durée de l'occurrence, reportée telle quelle sur toute la série.
    const baseEnd = event.end?.date ??
      new Date(event.start.date.getTime() + (event.start.allDay ? 86_400_000 : 3_600_000));
    const durationMs = baseEnd.getTime() - event.start.date.getTime();
    if (durationMs <= 0) continue;

    const occurrences: Date[] = [];

    if (event.rrule) {
      const expansion = expandRecurrence({
        dtstart: event.start.date,
        timeZone: event.timeZone,
        rrule: event.rrule,
        from,
        to,
        maxOccurrences: options.maxOccurrencesPerEvent ?? 500,
      });

      if (expansion.starts.length > 0) expandedRecurring++;
      if (expansion.truncated) truncated = true;
      if (expansion.unsupportedParts.length > 0) {
        partialRules.push(...expansion.unsupportedParts);
      }

      occurrences.push(...expansion.starts);

      // Règle illisible ou fréquence non gérée : l'occurrence de base reste
      // comptée, sans quoi le flux perdrait aussi le premier rendez-vous.
      if (expansion.starts.length === 0) occurrences.push(event.start.date);
    } else {
      occurrences.push(event.start.date);
    }

    occurrences.push(...event.rdates);

    const excluded = new Set(event.exdates.map((d) => d.getTime()));

    for (const occurrence of occurrences) {
      if (excluded.has(occurrence.getTime())) continue;
      if (event.uid && overridden.has(`${event.uid}|${occurrence.toISOString()}`)) continue;

      const occurrenceEnd = new Date(occurrence.getTime() + durationMs);
      if (occurrence < to && occurrenceEnd > from) {
        busy.push({ start: occurrence.toISOString(), end: occurrenceEnd.toISOString() });
      }
    }
  }

  busy.sort((a, b) => a.start.localeCompare(b.start));

  return { busy, expandedRecurring, partialRules: [...new Set(partialRules)], truncated };
}

/**
 * Provider ICS. `credentialsEncrypted` contient `{"ics_url": "https://..."}`.
 *
 * L'URL est chiffrée comme un secret parce qu'elle en est un : un flux ICS
 * n'est protégé que par le caractère imprévisible de son adresse, et il expose
 * l'agenda complet de l'institut.
 */
export const icsCalendarProvider: CalendarProvider = {
  capabilities: { canBook: false },

  async checkAvailability(params: AvailabilityRequest): Promise<CalendarSlot[]> {
    const decrypted = await decryptSecret(params.credentialsEncrypted);

    let icsUrl: string;
    try {
      const parsed = JSON.parse(decrypted);
      icsUrl = String(parsed.ics_url ?? "");
    } catch {
      icsUrl = decrypted.trim();
    }

    if (!/^https:\/\//.test(icsUrl)) {
      throw new ValidationError(
        "URL du flux ICS absente ou non sécurisée. Attendu : une adresse https.",
      );
    }

    const response = await fetch(icsUrl, { headers: { accept: "text/calendar" } });
    if (!response.ok) {
      throw new ExternalApiError("ics", `flux inaccessible (${response.status})`, {
        status: response.status,
      });
    }

    const from = new Date(params.fromDate);
    const to = new Date(params.toDate);
    const { busy, expandedRecurring, partialRules, truncated } = parseIcsBusyIntervals(
      await response.text(),
      { fallbackTimeZone: params.timezone, from, to },
    );

    if (partialRules.length > 0) {
      // L'occupation est surestimée sur ces règles : des créneaux réellement
      // libres sont bloqués. Moins grave que l'inverse, mais visible.
      log.warn("ics.rule_partially_supported", { parts: partialRules.join(",") });
    }
    if (truncated) {
      // Plafond atteint : au-delà, des occurrences manquent et la plage
      // correspondante sera proposée à tort.
      log.warn("ics.expansion_truncated", { expandedRecurring });
    }

    return generateSlots({
      from,
      to,
      timezone: params.timezone,
      scheduling: params.scheduling,
      durationMin: resolveDuration(params.serviceType, params.scheduling),
      busy,
    });
  },

  bookAppointment(_params: BookingRequest): Promise<{ externalEventId: string }> {
    // Jamais atteint en pratique : `buildTools` n'expose pas l'outil de
    // réservation quand le provider ne sait pas écrire. Le garde-fou est ici
    // au cas où un appel arriverait par un autre chemin.
    return Promise.reject(
      new ValidationError(
        "Ce calendrier est en lecture seule : la réservation doit être faite par l'établissement.",
      ),
    );
  },

  cancelEvent(): Promise<void> {
    return Promise.reject(new ValidationError("Ce calendrier est en lecture seule."));
  },
};
