// Génération de créneaux : fonctions pures, sans réseau ni base.
//
// C'est ici que vit toute la logique métier de disponibilité — horaires
// d'ouverture, durée de prestation, délai de prévenance, soustraction des
// plages occupées. Le provider calendrier n'apporte que les plages occupées.
// Découpage volontaire : cette logique est testable exhaustivement, l'appel
// réseau ne l'est pas.

import type { CalendarSlot, SchedulingConfig, WeekdayKey } from "../types.ts";
import { localDatesBetween, localWeekday, zonedTimeToUtc } from "./timezone.ts";

export interface BusyInterval {
  start: string; // ISO
  end: string; // ISO
}

export const DEFAULT_SCHEDULING: SchedulingConfig = {
  businessHours: {
    mon: [["09:00", "19:00"]],
    tue: [["09:00", "19:00"]],
    wed: [["09:00", "19:00"]],
    thu: [["09:00", "19:00"]],
    fri: [["09:00", "19:00"]],
    sat: [["09:00", "18:00"]],
    sun: [],
  },
  services: [],
  defaultDurationMin: 60,
  slotGranularityMin: 30,
  minNoticeHours: 4,
  maxDaysAhead: 14,
};

/**
 * Lit la config de planification depuis `agents.config`, en retombant sur des
 * valeurs par défaut raisonnables pour chaque champ absent ou mal formé.
 *
 * Tolérant par conception : un gérant qui saisit une valeur invalide dans le
 * dashboard ne doit pas casser la prise de RDV de tout son institut.
 */
export function parseSchedulingConfig(config: Record<string, unknown>): SchedulingConfig {
  const raw = (config["scheduling"] ?? {}) as Record<string, unknown>;

  const businessHours: SchedulingConfig["businessHours"] = {};
  const rawHours = (raw["business_hours"] ?? {}) as Record<string, unknown>;
  let hasAnyDay = false;

  for (const day of ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as WeekdayKey[]) {
    const intervals = rawHours[day];
    if (!Array.isArray(intervals)) continue;
    hasAnyDay = true;

    businessHours[day] = intervals
      .filter((i): i is [string, string] =>
        Array.isArray(i) && i.length === 2 && i.every((v) => /^\d{2}:\d{2}$/.test(String(v)))
      )
      .map(([start, end]) => [String(start), String(end)] as [string, string])
      .filter(([start, end]) => toMinutes(end) > toMinutes(start));
  }

  const services = Array.isArray(raw["services"])
    ? (raw["services"] as Array<Record<string, unknown>>)
      .filter((s) => typeof s?.name === "string" && Number.isFinite(Number(s?.duration_min)))
      .map((s) => ({ name: String(s.name), durationMin: Math.max(5, Number(s.duration_min)) }))
    : [];

  return {
    businessHours: hasAnyDay ? businessHours : DEFAULT_SCHEDULING.businessHours,
    services,
    defaultDurationMin: positiveInt(raw["default_duration_min"], DEFAULT_SCHEDULING.defaultDurationMin),
    slotGranularityMin: positiveInt(raw["slot_granularity_min"], DEFAULT_SCHEDULING.slotGranularityMin),
    minNoticeHours: nonNegativeInt(raw["min_notice_hours"], DEFAULT_SCHEDULING.minNoticeHours),
    maxDaysAhead: positiveInt(raw["max_days_ahead"], DEFAULT_SCHEDULING.maxDaysAhead),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

/**
 * Durée d'une prestation, à partir de ce que le lead a écrit.
 *
 * Le lead donne rarement le libellé exact du catalogue : il écrit « laser
 * jambes » pour « Épilation laser jambes entières », ou « épilation laser »
 * tout court. Trois passes, de la plus sûre à la plus permissive :
 *
 *   1. libellé identique ;
 *   2. un libellé du catalogue est contenu dans ce qu'a écrit le lead — le
 *      plus long l'emporte, car il utilise le plus d'information fournie ;
 *   3. ce qu'a écrit le lead est contenu dans un libellé du catalogue — le
 *      plus COURT l'emporte, car allonger le libellé revient à supposer une
 *      prestation que le lead n'a pas demandée.
 *
 * L'inversion entre 2 et 3 est le cœur du sujet : sans elle, « épilation
 * laser » se voit attribuer la durée de « épilation laser jambes entières »,
 * et l'institut bloque 45 min d'agenda pour une prestation de 30.
 */
export function resolveDuration(serviceType: string, scheduling: SchedulingConfig): number {
  const needle = fold(serviceType);
  if (!needle) return scheduling.defaultDurationMin;

  const candidates = scheduling.services
    .map((service) => ({ service, label: fold(service.name) }))
    .filter(({ label }) => label.length > 0);

  const exact = candidates.find(({ label }) => label === needle);
  if (exact) return exact.service.durationMin;

  const contained = candidates.filter(({ label }) => needle.includes(label));
  if (contained.length > 0) {
    return contained.reduce((a, b) => (b.label.length > a.label.length ? b : a)).service.durationMin;
  }

  const containing = candidates.filter(({ label }) => label.includes(needle));
  if (containing.length > 0) {
    return containing.reduce((a, b) => (b.label.length < a.label.length ? b : a)).service.durationMin;
  }

  return scheduling.defaultDurationMin;
}

export interface GenerateSlotsParams {
  from: Date;
  to: Date;
  timezone: string;
  scheduling: SchedulingConfig;
  durationMin: number;
  busy: BusyInterval[];
  now?: Date;
}

/**
 * Créneaux libres, ordonnés chronologiquement.
 *
 * Un créneau n'est retenu que s'il tient entièrement dans une plage d'ouverture,
 * ne chevauche aucune plage occupée, et respecte le délai de prévenance.
 */
export function generateSlots(params: GenerateSlotsParams): CalendarSlot[] {
  const now = params.now ?? new Date();
  const durationMs = params.durationMin * 60_000;
  const stepMs = Math.max(5, params.scheduling.slotGranularityMin) * 60_000;

  const earliest = now.getTime() + params.scheduling.minNoticeHours * 3_600_000;
  const horizon = Math.min(
    params.to.getTime(),
    now.getTime() + params.scheduling.maxDaysAhead * 24 * 3_600_000,
  );
  if (horizon <= earliest) return [];

  const busy = normalizeBusy(params.busy);
  const slots: CalendarSlot[] = [];

  for (const dateKey of localDatesBetween(params.from, new Date(horizon), params.timezone)) {
    // Le jour de la semaine est celui du milieu de journée locale : à minuit
    // pile, un décalage de fuseau pourrait renvoyer la veille.
    const noon = zonedTimeToUtc(dateKey, "12:00", params.timezone);
    const weekday = localWeekday(noon, params.timezone);
    const intervals = params.scheduling.businessHours[weekday] ?? [];

    for (const [openAt, closeAt] of intervals) {
      const opens = zonedTimeToUtc(dateKey, openAt, params.timezone).getTime();
      const closes = zonedTimeToUtc(dateKey, closeAt, params.timezone).getTime();

      for (let start = opens; start + durationMs <= closes; start += stepMs) {
        const end = start + durationMs;

        if (start < earliest) continue;
        if (start >= horizon) break;
        if (overlapsBusy(start, end, busy)) continue;

        slots.push({
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
        });
      }
    }
  }

  return slots.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

/** Fusionne et trie les plages occupées pour rendre le test de chevauchement linéaire. */
function normalizeBusy(busy: BusyInterval[]): Array<[number, number]> {
  const ranges = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as [number, number])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((a, b) => a[0] - b[0]);

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function overlapsBusy(start: number, end: number, busy: Array<[number, number]>): boolean {
  // Bornes ouvertes : un rendez-vous qui finit à 10 h n'empêche pas d'en
  // commencer un à 10 h.
  return busy.some(([busyStart, busyEnd]) => start < busyEnd && end > busyStart);
}

/**
 * Sélection de créneaux à proposer au lead : étalés sur des jours différents
 * plutôt que trois horaires consécutifs le même matin.
 */
export function spreadSlots(slots: CalendarSlot[], timezone: string, max = 6): CalendarSlot[] {
  const perDay = new Map<string, CalendarSlot[]>();

  for (const slot of slots) {
    const key = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(slot.startsAt));
    const bucket = perDay.get(key) ?? [];
    bucket.push(slot);
    perDay.set(key, bucket);
  }

  const picked: CalendarSlot[] = [];
  let round = 0;

  // Tourniquet : un créneau par jour, puis un deuxième, etc.
  while (picked.length < max) {
    let addedThisRound = false;
    for (const bucket of perDay.values()) {
      if (round >= bucket.length) continue;
      picked.push(bucket[round]);
      addedThisRound = true;
      if (picked.length >= max) break;
    }
    if (!addedThisRound) break;
    round++;
  }

  return picked.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}
