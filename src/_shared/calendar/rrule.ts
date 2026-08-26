// Expansion des règles de récurrence RFC 5545.
//
// POURQUOI CE MODULE EXISTE.
// Le parseur ICS ignorait purement et simplement les événements récurrents. Une
// plage récurrente comptée libre alors qu'elle est prise, c'est l'agent qui
// propose un créneau déjà occupé, et deux clientes devant la même cabine. Un
// institut a presque toujours des récurrences : réunion d'équipe hebdomadaire,
// fermeture du lundi, ménage du soir.
//
// CE QUI EST COUVERT : FREQ (DAILY, WEEKLY, MONTHLY, YEARLY), INTERVAL, COUNT,
// UNTIL, BYDAY (avec position ordinale : `3TU`, `-1FR`), BYMONTHDAY, BYMONTH,
// plus EXDATE et RDATE côté appelant.
//
// CE QUI NE L'EST PAS : BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR et suivants. Ces
// parties sont IGNORÉES, ce qui produit PLUS d'occurrences que la règle réelle.
// Le choix est délibéré : sur-occuper fait perdre un créneau proposable,
// sous-occuper fait perdre une cliente. `unsupportedParts` remonte le cas pour
// que ce soit visible dans les journaux plutôt que deviné.
//
// L'expansion travaille en HEURE MURALE LOCALE, pas en durée absolue. Un
// événement de 9 h qui se répète chaque semaine reste à 9 h après le passage à
// l'heure d'été ; ajouter 7 × 24 h le décalerait d'une heure deux fois par an.

import { timeZoneOffsetMs, zonedTimeToUtc } from "./timezone.ts";

const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** Parties de RRULE que ce module sait honorer. */
const SUPPORTED_PARTS = new Set([
  "FREQ",
  "INTERVAL",
  "COUNT",
  "UNTIL",
  "BYDAY",
  "BYMONTHDAY",
  "BYMONTH",
  "WKST",
]);

export interface ExpandOptions {
  /** Première occurrence, telle que déclarée par DTSTART. */
  dtstart: Date;
  /** Fuseau de l'événement (TZID, ou celui de l'établissement à défaut). */
  timeZone: string;
  /** Corps de la propriété RRULE, sans le nom. */
  rrule: string;
  from: Date;
  to: Date;
  /** Filet anti-explosion : une règle sans COUNT ni UNTIL est infinie. */
  maxOccurrences?: number;
}

export interface Expansion {
  /** Débuts d'occurrence chevauchant la fenêtre, triés. */
  starts: Date[];
  /** Parties de la règle non honorées, pour journalisation. */
  unsupportedParts: string[];
  /** Vrai si le plafond a été atteint : la fenêtre peut être incomplète. */
  truncated: boolean;
}

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hhmm: string;
}

/** Composantes murales d'un instant dans un fuseau donné. */
function localParts(instant: Date, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) parts[part.type] = part.value;

  // `hour12: false` peut rendre « 24 » pour minuit selon l'implémentation.
  const hour = Number(parts.hour) % 24;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hhmm: `${String(hour).padStart(2, "0")}:${parts.minute}`,
  };
}

function parseRule(rrule: string): { parts: Map<string, string>; unsupported: string[] } {
  const parts = new Map<string, string>();
  const unsupported: string[] = [];

  for (const chunk of rrule.split(";")) {
    const eq = chunk.indexOf("=");
    if (eq <= 0) continue;

    const name = chunk.slice(0, eq).trim().toUpperCase();
    parts.set(name, chunk.slice(eq + 1).trim());
    if (!SUPPORTED_PARTS.has(name)) unsupported.push(name);
  }

  return { parts, unsupported };
}

/** `20260901T235959Z` ou `20260901` → instant. */
function parseUntil(value: string): Date | null {
  const utc = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value.trim());
  if (utc) {
    const [, y, m, d, hh, mm, ss] = utc;
    return new Date(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`);
  }

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    // Fin de journée : UNTIL en VALUE=DATE inclut le jour entier.
    return new Date(`${y}-${m}-${d}T23:59:59Z`);
  }

  return null;
}

interface ByDay {
  /** 0 = dimanche. */
  weekday: number;
  /** Position dans le mois : 3 pour `3TU`, -1 pour `-1FR`, 0 si absente. */
  ordinal: number;
}

function parseByDay(value: string): ByDay[] {
  const days: ByDay[] = [];

  for (const token of value.split(",")) {
    const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token.trim().toUpperCase());
    if (!match) continue;

    days.push({
      weekday: WEEKDAY_CODES.indexOf(match[2] as typeof WEEKDAY_CODES[number]),
      ordinal: match[1] ? Number(match[1]) : 0,
    });
  }

  return days;
}

function parseNumbers(value: string | undefined): number[] {
  if (!value) return [];
  return value.split(",")
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isInteger(n));
}

/** Jour de la semaine d'une date civile, sans passer par un fuseau. */
function civilWeekday(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Jours du mois retenus par BYDAY et BYMONTHDAY.
 *
 * Une position négative compte depuis la fin : `-1FR` est le dernier vendredi,
 * quel que soit le nombre de semaines du mois.
 */
function monthlyDays(
  year: number,
  month: number,
  byDay: ByDay[],
  byMonthDay: number[],
  fallbackDay: number,
): number[] {
  const total = daysInMonth(year, month);
  const selected = new Set<number>();

  for (const raw of byMonthDay) {
    const day = raw > 0 ? raw : total + raw + 1;
    if (day >= 1 && day <= total) selected.add(day);
  }

  for (const rule of byDay) {
    const matching: number[] = [];
    for (let day = 1; day <= total; day++) {
      if (civilWeekday(year, month, day) === rule.weekday) matching.push(day);
    }

    if (rule.ordinal === 0) {
      for (const day of matching) selected.add(day);
    } else {
      const index = rule.ordinal > 0 ? rule.ordinal - 1 : matching.length + rule.ordinal;
      if (index >= 0 && index < matching.length) selected.add(matching[index]);
    }
  }

  // Ni BYDAY ni BYMONTHDAY : la règle reprend le jour du DTSTART. Un 31 dans un
  // mois de 30 jours est sauté, comme le prescrit la RFC — et non ramené au 30,
  // ce qui inventerait une occurrence.
  if (selected.size === 0 && fallbackDay <= total) selected.add(fallbackDay);

  return [...selected].sort((a, b) => a - b);
}

export function expandRecurrence(options: ExpandOptions): Expansion {
  const cap = options.maxOccurrences ?? 1000;
  const { parts, unsupported } = parseRule(options.rrule);

  const freq = (parts.get("FREQ") ?? "").toUpperCase();
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) {
    // FREQ absente ou exotique (SECONDLY, MINUTELY, HOURLY) : rien à étendre.
    // L'appelant conserve l'occurrence de base issue du DTSTART.
    return { starts: [], unsupportedParts: unsupported.concat(freq ? [`FREQ=${freq}`] : []), truncated: false };
  }

  const interval = Math.max(1, parseNumbers(parts.get("INTERVAL"))[0] ?? 1);
  const count = parseNumbers(parts.get("COUNT"))[0] ?? null;
  const until = parts.has("UNTIL") ? parseUntil(parts.get("UNTIL") as string) : null;
  const byDay = parseByDay(parts.get("BYDAY") ?? "");
  const byMonthDay = parseNumbers(parts.get("BYMONTHDAY"));
  const byMonth = parseNumbers(parts.get("BYMONTH"));

  const origin = localParts(options.dtstart, options.timeZone);
  const hhmm = origin.hhmm;

  const starts: Date[] = [];
  let emitted = 0;
  let truncated = false;

  /**
   * Retient une occurrence. Renvoie `false` quand l'itération doit s'arrêter :
   * COUNT atteint, UNTIL dépassé, ou fin de la fenêtre.
   */
  const emit = (date: string): boolean => {
    const instant = zonedTimeToUtc(date, hhmm, options.timeZone);

    // COUNT et UNTIL comptent depuis DTSTART, y compris les occurrences
    // antérieures à la fenêtre demandée : les ignorer donnerait une série trop
    // longue quand la fenêtre commence tard.
    if (instant < options.dtstart) return true;
    if (until && instant > until) return false;

    emitted++;
    if (count !== null && emitted > count) return false;

    if (instant >= options.from && instant <= options.to) starts.push(instant);

    // Au-delà de la fenêtre, la seule raison de continuer serait de compter :
    // c'est déjà fait ci-dessus.
    return instant <= options.to;
  };

  let guard = 0;
  const guardLimit = cap * 12;

  if (freq === "DAILY") {
    const cursor = new Date(options.dtstart.getTime());

    while (guard++ < guardLimit && starts.length < cap) {
      const local = localParts(cursor, options.timeZone);
      if (byMonth.length === 0 || byMonth.includes(local.month)) {
        if (!emit(isoDate(local.year, local.month, local.day))) break;
      }
      // Pas de `+ n × 86 400 000` : on repart de midi local pour traverser un
      // changement d'heure sans glisser d'un jour.
      cursor.setTime(cursor.getTime() + interval * 86_400_000);
    }
  } else if (freq === "WEEKLY") {
    const weekdays = byDay.length > 0
      ? byDay.map((d) => d.weekday)
      : [civilWeekday(origin.year, origin.month, origin.day)];

    // Début de la semaine (dimanche) contenant DTSTART, en jours civils.
    const startWeekday = civilWeekday(origin.year, origin.month, origin.day);
    let weekStart = Date.UTC(origin.year, origin.month - 1, origin.day - startWeekday);

    while (guard++ < guardLimit && starts.length < cap) {
      let past = false;

      for (const weekday of [...weekdays].sort((a, b) => a - b)) {
        const day = new Date(weekStart + weekday * 86_400_000);
        const month = day.getUTCMonth() + 1;
        if (byMonth.length > 0 && !byMonth.includes(month)) continue;

        if (!emit(isoDate(day.getUTCFullYear(), month, day.getUTCDate()))) {
          past = true;
          break;
        }
      }

      if (past) break;
      weekStart += interval * 7 * 86_400_000;
    }
  } else {
    // MONTHLY et YEARLY partagent la sélection des jours dans le mois ; seul le
    // pas d'avancement diffère.
    const monthStep = freq === "MONTHLY" ? interval : interval * 12;
    const months = freq === "YEARLY" && byMonth.length > 0 ? byMonth : null;

    let year = origin.year;
    let month = origin.month;
    let stopped = false;

    while (guard++ < guardLimit && starts.length < cap && !stopped) {
      const candidateMonths = months ?? [month];

      for (const candidate of candidateMonths) {
        if (freq === "MONTHLY" && byMonth.length > 0 && !byMonth.includes(candidate)) continue;

        for (const day of monthlyDays(year, candidate, byDay, byMonthDay, origin.day)) {
          if (!emit(isoDate(year, candidate, day))) {
            stopped = true;
            break;
          }
        }
        if (stopped) break;
      }

      if (months) {
        year += interval;
      } else {
        month += monthStep;
        year += Math.floor((month - 1) / 12);
        month = ((month - 1) % 12) + 1;
      }
    }
  }

  if (starts.length >= cap || guard >= guardLimit) truncated = true;

  starts.sort((a, b) => a.getTime() - b.getTime());
  return { starts, unsupportedParts: unsupported, truncated };
}

/** Exporté pour les tests : décalage local, utilisé par l'expansion. */
export const _internals = { localParts, timeZoneOffsetMs };
