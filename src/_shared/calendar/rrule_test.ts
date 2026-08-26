// Tests de l'expansion des récurrences.
//
// L'erreur possible ici est la pire du produit : une occurrence manquée est une
// plage comptée libre alors qu'elle est prise, donc deux clientes convoquées
// dans la même cabine. Rien à l'écran ne le signale.
//
// Lancer : deno test supabase/functions/_shared/calendar/rrule_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { expandRecurrence } from "./rrule.ts";

const PARIS = "Europe/Paris";

function starts(rrule: string, dtstart: string, from: string, to: string, timeZone = PARIS) {
  return expandRecurrence({
    dtstart: new Date(dtstart),
    timeZone,
    rrule,
    from: new Date(from),
    to: new Date(to),
  });
}

/** Heure murale locale, pour comparer ce que voit l'institut. */
function wall(instant: Date, timeZone = PARIS): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant).replace(" ", "T");
}

// ============================================================
// Cas courants d'un institut
// ============================================================

Deno.test("hebdomadaire : réunion d'équipe tous les lundis", () => {
  const { starts: occurrences } = starts(
    "FREQ=WEEKLY;BYDAY=MO",
    "2026-08-17T07:00:00Z", // lundi 9 h à Paris
    "2026-08-17T00:00:00Z",
    "2026-09-08T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d)), [
    "2026-08-17T09:00",
    "2026-08-24T09:00",
    "2026-08-31T09:00",
    "2026-09-07T09:00",
  ]);
});

Deno.test("hebdomadaire multi-jours : ménage mardi et jeudi", () => {
  const { starts: occurrences } = starts(
    "FREQ=WEEKLY;BYDAY=TU,TH",
    "2026-08-18T17:00:00Z",
    "2026-08-18T00:00:00Z",
    "2026-08-29T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d)), [
    "2026-08-18T19:00",
    "2026-08-20T19:00",
    "2026-08-25T19:00",
    "2026-08-27T19:00",
  ]);
});

Deno.test("INTERVAL : une semaine sur deux", () => {
  const { starts: occurrences } = starts(
    "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
    "2026-08-17T07:00:00Z",
    "2026-08-17T00:00:00Z",
    "2026-09-15T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d)), [
    "2026-08-17T09:00",
    "2026-08-31T09:00",
    "2026-09-14T09:00",
  ]);
});

Deno.test("COUNT : la série s'arrête au nombre prévu", () => {
  const { starts: occurrences } = starts(
    "FREQ=DAILY;COUNT=3",
    "2026-08-17T07:00:00Z",
    "2026-08-17T00:00:00Z",
    "2026-09-30T00:00:00Z",
  );

  assertEquals(occurrences.length, 3);
  assertEquals(wall(occurrences[2]), "2026-08-19T09:00");
});

Deno.test("UNTIL : rien après la date de fin", () => {
  const { starts: occurrences } = starts(
    "FREQ=WEEKLY;BYDAY=MO;UNTIL=20260901T000000Z",
    "2026-08-17T07:00:00Z",
    "2026-08-17T00:00:00Z",
    "2026-09-30T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d)), [
    "2026-08-17T09:00",
    "2026-08-24T09:00",
    "2026-08-31T09:00",
  ]);
});

// ============================================================
// Changement d'heure
// ============================================================

Deno.test("heure d'hiver : 9 h reste 9 h de part et d'autre du changement", () => {
  // Le passage à l'heure d'hiver 2026 en France a lieu le 25 octobre. Une
  // récurrence calculée en ajoutant 7 × 24 h glisserait à 8 h après cette date,
  // et l'agent proposerait un créneau que l'institut croit occupé.
  const { starts: occurrences } = starts(
    "FREQ=WEEKLY;BYDAY=MO",
    "2026-10-19T07:00:00Z", // lundi 9 h heure d'été
    "2026-10-19T00:00:00Z",
    "2026-11-10T00:00:00Z",
  );

  for (const occurrence of occurrences) {
    assert(wall(occurrence).endsWith("T09:00"), `décalage sur ${wall(occurrence)}`);
  }
  assertEquals(occurrences.length, 4);
});

// ============================================================
// Mensuel
// ============================================================

Deno.test("mensuel par position : le troisième mardi", () => {
  const { starts: occurrences } = starts(
    "FREQ=MONTHLY;BYDAY=3TU",
    "2026-08-18T07:00:00Z",
    "2026-08-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d).slice(0, 10)), [
    "2026-08-18",
    "2026-09-15",
    "2026-10-20",
  ]);
});

Deno.test("mensuel par position négative : le dernier vendredi", () => {
  const { starts: occurrences } = starts(
    "FREQ=MONTHLY;BYDAY=-1FR",
    "2026-08-28T07:00:00Z",
    "2026-08-01T00:00:00Z",
    "2026-11-01T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d).slice(0, 10)), [
    "2026-08-28",
    "2026-09-25",
    "2026-10-30",
  ]);
});

Deno.test("mensuel le 31 : les mois courts sont sautés, pas ramenés au 30", () => {
  // La RFC est explicite. Ramener au 30 inventerait une occupation un jour où
  // l'institut est en réalité disponible.
  const { starts: occurrences } = starts(
    "FREQ=MONTHLY",
    "2026-01-31T08:00:00Z",
    "2026-01-01T00:00:00Z",
    "2026-05-01T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d).slice(0, 10)), [
    "2026-01-31",
    "2026-03-31",
  ]);
});

// ============================================================
// Bornes et robustesse
// ============================================================

Deno.test("fenêtre tardive : COUNT compte depuis DTSTART, pas depuis la fenêtre", () => {
  // Série de 5 jours à partir du 17. Une fenêtre ouverte le 20 ne doit montrer
  // que les deux dernières, pas cinq de plus.
  const { starts: occurrences } = starts(
    "FREQ=DAILY;COUNT=5",
    "2026-08-17T07:00:00Z",
    "2026-08-20T00:00:00Z",
    "2026-09-30T00:00:00Z",
  );

  assertEquals(occurrences.map((d) => wall(d).slice(0, 10)), ["2026-08-20", "2026-08-21"]);
});

Deno.test("règle infinie : bornée par la fenêtre, pas d'explosion", () => {
  const { starts: occurrences, truncated } = starts(
    "FREQ=DAILY",
    "2026-08-17T07:00:00Z",
    "2026-08-17T00:00:00Z",
    "2026-08-24T00:00:00Z",
  );

  assertEquals(occurrences.length, 7);
  assertEquals(truncated, false);
});

Deno.test("partie non gérée : signalée, et l'expansion sur-occupe plutôt que de trouer", () => {
  // BYSETPOS restreindrait à une seule occurrence par mois. En l'ignorant on en
  // produit quatre : quatre plages bloquées à tort valent mieux qu'une plage
  // libérée à tort.
  const { starts: occurrences, unsupportedParts } = starts(
    "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1",
    "2026-08-03T07:00:00Z",
    "2026-08-01T00:00:00Z",
    "2026-09-01T00:00:00Z",
  );

  assertEquals(unsupportedParts, ["BYSETPOS"]);
  assert(occurrences.length > 1);
});

Deno.test("FREQ absente ou exotique : aucune occurrence inventée", () => {
  assertEquals(starts("COUNT=3", "2026-08-17T07:00:00Z", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z").starts, []);
  assertEquals(
    starts("FREQ=HOURLY", "2026-08-17T07:00:00Z", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z").starts,
    [],
  );
});

Deno.test("règle vide : traitée comme absente", () => {
  assertEquals(starts("", "2026-08-17T07:00:00Z", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z").starts, []);
});
