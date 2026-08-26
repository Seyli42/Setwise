// Tests de la logique de disponibilité. Aucun réseau, aucune base.
// C'est ici que se cachent les bugs de fuseau horaire : un institut à Paris
// raisonne en heure locale, Google Calendar et la base en instants UTC.
//
// Lancer : deno test --allow-env supabase/functions/_shared/calendar/calendar_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { localDatesBetween, localWeekday, zonedTimeToUtc } from "./timezone.ts";
import {
  DEFAULT_SCHEDULING,
  generateSlots,
  parseSchedulingConfig,
  resolveDuration,
  spreadSlots,
} from "./slots.ts";
import type { SchedulingConfig } from "../types.ts";

const PARIS = "Europe/Paris";

// ============================================================
// Fuseaux horaires
// ============================================================

Deno.test("9 h à Paris en hiver = 08:00 UTC (CET, UTC+1)", () => {
  assertEquals(
    zonedTimeToUtc("2026-01-12", "09:00", PARIS).toISOString(),
    "2026-01-12T08:00:00.000Z",
  );
});

Deno.test("9 h à Paris en été = 07:00 UTC (CEST, UTC+2)", () => {
  // Même heure murale, instant différent : c'est exactement ce que la double
  // passe de `zonedTimeToUtc` existe pour gérer.
  assertEquals(
    zonedTimeToUtc("2026-07-15", "09:00", PARIS).toISOString(),
    "2026-07-15T07:00:00.000Z",
  );
});

Deno.test("passage à l'heure d'été : avant et après la bascule", () => {
  // Le 29 mars 2026 à 02:00 locale, Paris passe de UTC+1 à UTC+2.
  assertEquals(
    zonedTimeToUtc("2026-03-29", "01:30", PARIS).toISOString(),
    "2026-03-29T00:30:00.000Z", // encore CET
  );
  assertEquals(
    zonedTimeToUtc("2026-03-29", "03:00", PARIS).toISOString(),
    "2026-03-29T01:00:00.000Z", // déjà CEST
  );
});

Deno.test("heure inexistante lors du passage à l'heure d'été : décalée à l'heure suivante", () => {
  // 02:30 n'existe pas le 29 mars. Retomber sur 03:30 locale est le
  // comportement voulu pour un créneau de rendez-vous — jamais une exception.
  const resolved = zonedTimeToUtc("2026-03-29", "02:30", PARIS);
  assertEquals(resolved.toISOString(), "2026-03-29T01:30:00.000Z");
  assertEquals(
    new Intl.DateTimeFormat("fr-FR", { timeZone: PARIS, timeStyle: "short" }).format(resolved),
    "03:30",
  );
});

Deno.test("localWeekday renvoie le jour local, pas le jour UTC", () => {
  // 23:30 UTC un dimanche = déjà lundi à Paris.
  assertEquals(localWeekday(new Date("2026-01-11T23:30:00Z"), PARIS), "mon");
  assertEquals(localWeekday(new Date("2026-01-11T12:00:00Z"), PARIS), "sun");
});

Deno.test("localDatesBetween couvre les bornes sans trou", () => {
  const dates = localDatesBetween(
    new Date("2026-01-12T00:00:00Z"),
    new Date("2026-01-14T00:00:00Z"),
    PARIS,
  );
  assertEquals(dates, ["2026-01-12", "2026-01-13", "2026-01-14"]);
});

Deno.test("localDatesBetween ne saute pas le jour du changement d'heure", () => {
  const dates = localDatesBetween(
    new Date("2026-03-28T00:00:00Z"),
    new Date("2026-03-30T00:00:00Z"),
    PARIS,
  );
  assertEquals(dates, ["2026-03-28", "2026-03-29", "2026-03-30"]);
});

// ============================================================
// Génération de créneaux
// ============================================================

const scheduling: SchedulingConfig = {
  ...DEFAULT_SCHEDULING,
  businessHours: { mon: [["09:00", "19:00"]], tue: [["09:00", "19:00"]], sun: [] },
  slotGranularityMin: 60,
  minNoticeHours: 4,
  maxDaysAhead: 14,
};

// Lundi 12 janvier 2026, 07:00 heure de Paris.
const NOW = new Date("2026-01-12T06:00:00Z");

function mondaySlots(busy: Array<{ start: string; end: string }> = []) {
  return generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-01-13T00:00:00Z"),
    timezone: PARIS,
    scheduling,
    durationMin: 60,
    busy,
    now: NOW,
  });
}

Deno.test("créneaux bornés par les horaires d'ouverture et le délai de prévenance", () => {
  const slots = mondaySlots();

  // Ouverture 09:00 locale = 08:00 UTC, mais le délai de 4 h repousse le
  // premier créneau à 10:00 UTC (11:00 à Paris).
  assertEquals(slots[0].startsAt, "2026-01-12T10:00:00.000Z");
  // Fermeture 19:00 locale = 18:00 UTC : le dernier créneau d'1 h démarre à 17:00 UTC.
  assertEquals(slots[slots.length - 1].startsAt, "2026-01-12T17:00:00.000Z");
  assertEquals(slots.length, 8);
});

Deno.test("un créneau qui dépasserait l'heure de fermeture n'est pas proposé", () => {
  const slots = generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-01-13T00:00:00Z"),
    timezone: PARIS,
    scheduling,
    durationMin: 90, // 1 h 30
    busy: [],
    now: NOW,
  });
  // Départs alignés sur le pas de 60 min depuis 08:00 UTC : le dernier tenant
  // avant 18:00 UTC (19:00 locale) est 16:00 → 17:30.
  assertEquals(slots[slots.length - 1].startsAt, "2026-01-12T16:00:00.000Z");
  assertEquals(slots[slots.length - 1].endsAt, "2026-01-12T17:30:00.000Z");
});

Deno.test("les plages occupées sont soustraites, bornes ouvertes", () => {
  const slots = mondaySlots([{
    start: "2026-01-12T11:00:00Z",
    end: "2026-01-12T12:00:00Z",
  }]);
  const starts = slots.map((s) => s.startsAt);

  // 10:00→11:00 finit quand l'occupation commence : conservé.
  assertEquals(starts.includes("2026-01-12T10:00:00.000Z"), true);
  // 11:00→12:00 chevauche : retiré.
  assertEquals(starts.includes("2026-01-12T11:00:00.000Z"), false);
  // 12:00→13:00 démarre quand l'occupation finit : conservé.
  assertEquals(starts.includes("2026-01-12T12:00:00.000Z"), true);
  assertEquals(slots.length, 7);
});

Deno.test("les plages occupées qui se chevauchent sont fusionnées", () => {
  const slots = mondaySlots([
    { start: "2026-01-12T11:00:00Z", end: "2026-01-12T13:00:00Z" },
    { start: "2026-01-12T12:00:00Z", end: "2026-01-12T14:00:00Z" },
  ]);
  const starts = slots.map((s) => s.startsAt);
  assertEquals(starts.includes("2026-01-12T11:00:00.000Z"), false);
  assertEquals(starts.includes("2026-01-12T12:00:00.000Z"), false);
  assertEquals(starts.includes("2026-01-12T13:00:00.000Z"), false);
  assertEquals(starts.includes("2026-01-12T14:00:00.000Z"), true);
});

Deno.test("un jour de fermeture ne produit aucun créneau", () => {
  const slots = generateSlots({
    from: new Date("2026-01-11T00:00:00Z"), // dimanche
    to: new Date("2026-01-11T23:59:00Z"),
    timezone: PARIS,
    scheduling,
    durationMin: 60,
    busy: [],
    now: new Date("2026-01-10T06:00:00Z"),
  });
  assertEquals(slots.length, 0);
});

Deno.test("plusieurs plages d'ouverture dans la journée (pause déjeuner)", () => {
  const slots = generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-01-13T00:00:00Z"),
    timezone: PARIS,
    scheduling: {
      ...scheduling,
      businessHours: { mon: [["09:00", "12:00"], ["14:00", "18:00"]] },
      minNoticeHours: 0,
    },
    durationMin: 60,
    busy: [],
    now: NOW,
  });

  const starts = slots.map((s) => s.startsAt);
  // Matin : 09:00–12:00 locale = 08:00–11:00 UTC. Le dernier créneau d'1 h
  // démarre à 10:00 UTC ; 11:00 UTC serait la fermeture, donc rien n'y démarre.
  assertEquals(starts.includes("2026-01-12T10:00:00.000Z"), true);
  assertEquals(starts.includes("2026-01-12T11:00:00.000Z"), false);
  // Rien pendant la pause déjeuner (12:00–14:00 locale = 11:00–13:00 UTC).
  assertEquals(starts.includes("2026-01-12T12:00:00.000Z"), false);
  // Reprise à 14:00 locale = 13:00 UTC.
  assertEquals(starts.includes("2026-01-12T13:00:00.000Z"), true);
});

Deno.test("l'horizon maxDaysAhead borne la recherche", () => {
  const slots = generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-03-01T00:00:00Z"), // demande large
    timezone: PARIS,
    scheduling: { ...scheduling, maxDaysAhead: 1 },
    durationMin: 60,
    busy: [],
    now: NOW,
  });
  const last = new Date(slots[slots.length - 1].startsAt).getTime();
  assertEquals(last <= NOW.getTime() + 24 * 3_600_000, true);
});

Deno.test("aucun créneau si l'horizon est plus court que le délai de prévenance", () => {
  const slots = generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-01-12T08:00:00Z"),
    timezone: PARIS,
    scheduling: { ...scheduling, minNoticeHours: 48 },
    durationMin: 60,
    busy: [],
    now: NOW,
  });
  assertEquals(slots.length, 0);
});

// ============================================================
// Sélection proposée au lead
// ============================================================

Deno.test("spreadSlots étale les propositions sur plusieurs jours", () => {
  const slots = generateSlots({
    from: new Date("2026-01-12T00:00:00Z"),
    to: new Date("2026-01-14T00:00:00Z"),
    timezone: PARIS,
    scheduling,
    durationMin: 60,
    busy: [],
    now: NOW,
  });

  const picked = spreadSlots(slots, PARIS, 4);
  const days = new Set(
    picked.map((s) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: PARIS, dateStyle: "short" })
        .format(new Date(s.startsAt))
    ),
  );

  assertEquals(picked.length, 4);
  // Sans étalement, les 4 seraient consécutifs le lundi matin.
  assertEquals(days.size, 2);
});

Deno.test("spreadSlots ne renvoie pas plus que ce qui existe", () => {
  assertEquals(spreadSlots(mondaySlots(), PARIS, 100).length, 8);
  assertEquals(spreadSlots([], PARIS, 5).length, 0);
});

// ============================================================
// Durées de prestation
// ============================================================

const withServices: SchedulingConfig = {
  ...DEFAULT_SCHEDULING,
  defaultDurationMin: 60,
  services: [
    { name: "Épilation laser", durationMin: 30 },
    { name: "Épilation laser jambes entières", durationMin: 45 },
    { name: "Soin du visage", durationMin: 75 },
  ],
};

Deno.test("resolveDuration : libellé exact", () => {
  assertEquals(resolveDuration("Épilation laser", withServices), 30);
});

Deno.test("resolveDuration : le lead en dit plus que le catalogue → libellé le plus long", () => {
  // "je veux une épilation laser jambes entières" contient les deux libellés :
  // le plus long exploite le plus d'information donnée.
  assertEquals(
    resolveDuration("je veux une épilation laser jambes entières", withServices),
    45,
  );
});

Deno.test("resolveDuration : le lead en dit moins → libellé le plus court", () => {
  // "laser jambes entières" n'est contenu que dans le libellé long.
  assertEquals(resolveDuration("laser jambes entières", withServices), 45);
  // Régression : "épilation laser" ne doit PAS hériter des 45 min de
  // "épilation laser jambes entières" — sinon l'institut bloque 45 min
  // d'agenda pour une prestation de 30.
  assertEquals(resolveDuration("epilation laser", withServices), 30);
});

Deno.test("resolveDuration ignore accents et casse", () => {
  assertEquals(resolveDuration("SOIN DU VISAGE", withServices), 75);
  assertEquals(resolveDuration("soin du visage", withServices), 75);
});

Deno.test("resolveDuration retombe sur la durée par défaut", () => {
  assertEquals(resolveDuration("massage balinais", withServices), 60);
  assertEquals(resolveDuration("", withServices), 60);
});

// ============================================================
// Lecture de la configuration du gérant
// ============================================================

Deno.test("parseSchedulingConfig lit une config valide", () => {
  const parsed = parseSchedulingConfig({
    scheduling: {
      business_hours: { mon: [["10:00", "18:00"]], sun: [] },
      services: [{ name: "Laser", duration_min: 30 }],
      default_duration_min: 45,
      slot_granularity_min: 15,
      min_notice_hours: 2,
      max_days_ahead: 21,
    },
  });

  assertEquals(parsed.businessHours.mon, [["10:00", "18:00"]]);
  assertEquals(parsed.services, [{ name: "Laser", durationMin: 30 }]);
  assertEquals(parsed.defaultDurationMin, 45);
  assertEquals(parsed.slotGranularityMin, 15);
  assertEquals(parsed.minNoticeHours, 2);
  assertEquals(parsed.maxDaysAhead, 21);
});

Deno.test("parseSchedulingConfig tolère une saisie invalide sans casser l'institut", () => {
  const parsed = parseSchedulingConfig({
    scheduling: {
      business_hours: {
        mon: [["9h", "18h"], ["10:00", "18:00"], ["18:00", "10:00"]],
        tue: "n'importe quoi",
      },
      services: [{ name: "Laser" }, { duration_min: 30 }, { name: "Soin", duration_min: 40 }],
      default_duration_min: -5,
      max_days_ahead: "beaucoup",
    },
  });

  // Format d'heure invalide et intervalle inversé écartés, le valide conservé.
  assertEquals(parsed.businessHours.mon, [["10:00", "18:00"]]);
  assertEquals(parsed.businessHours.tue, undefined);
  // Prestations incomplètes écartées.
  assertEquals(parsed.services, [{ name: "Soin", durationMin: 40 }]);
  // Valeurs aberrantes remplacées par les défauts.
  assertEquals(parsed.defaultDurationMin, DEFAULT_SCHEDULING.defaultDurationMin);
  assertEquals(parsed.maxDaysAhead, DEFAULT_SCHEDULING.maxDaysAhead);
});

Deno.test("parseSchedulingConfig sans config utilise les horaires par défaut", () => {
  const parsed = parseSchedulingConfig({});
  assertEquals(parsed.businessHours, DEFAULT_SCHEDULING.businessHours);
  assertEquals(parsed.minNoticeHours, DEFAULT_SCHEDULING.minNoticeHours);
});
