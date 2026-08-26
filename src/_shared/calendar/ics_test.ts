// Analyse des flux ICS. Aucun réseau.
//
// Une plage occupée mal lue devient une plage proposée : on donnerait un
// créneau déjà pris à un nouveau client, et l'institut découvrirait le doublon
// en salle d'attente. C'est le mode de panne le plus embarrassant du produit.
//
// Lancer : deno test supabase/functions/_shared/calendar/ics_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseIcsBusyIntervals } from "./ics.ts";

const PARIS = "Europe/Paris";

function calendar(...events: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//FR",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vevent(lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

Deno.test("lit un événement en UTC", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent(["UID:1", "DTSTART:20260816T140000Z", "DTEND:20260816T150000Z"])),
    { fallbackTimeZone: PARIS },
  );

  assertEquals(busy, [{
    start: "2026-08-16T14:00:00.000Z",
    end: "2026-08-16T15:00:00.000Z",
  }]);
});

Deno.test("convertit une heure locale déclarée par TZID", () => {
  // 14 h à Paris en août = 12 h UTC. Sans conversion, on décalerait toutes les
  // plages occupées de deux heures et proposerait des créneaux déjà pris.
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:2",
      "DTSTART;TZID=Europe/Paris:20260816T140000",
      "DTEND;TZID=Europe/Paris:20260816T153000",
    ])),
    { fallbackTimeZone: "UTC" },
  );

  assertEquals(busy[0].start, "2026-08-16T12:00:00.000Z");
  assertEquals(busy[0].end, "2026-08-16T13:30:00.000Z");
});

Deno.test("applique le fuseau de l'établissement à défaut de TZID", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent(["UID:3", "DTSTART:20260816T140000", "DTEND:20260816T150000"])),
    { fallbackTimeZone: PARIS },
  );
  assertEquals(busy[0].start, "2026-08-16T12:00:00.000Z");
});

Deno.test("tient compte de l'heure d'hiver", () => {
  // Janvier : Paris est à UTC+1, pas +2.
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:4",
      "DTSTART;TZID=Europe/Paris:20260112T090000",
      "DTEND;TZID=Europe/Paris:20260112T100000",
    ])),
    { fallbackTimeZone: "UTC" },
  );
  assertEquals(busy[0].start, "2026-01-12T08:00:00.000Z");
});

Deno.test("déplie les lignes coupées", () => {
  // RFC 5545 : au-delà de 75 octets une ligne est coupée et poursuivie après
  // une espace. Sans dépliage, la date devient illisible et la plage est
  // considérée libre.
  const folded = [
    "BEGIN:VEVENT",
    "UID:5",
    "DTSTART;TZID=Europe/",
    " Paris:20260816T140000",
    "DTEND;TZID=Europe/Paris:20260816T150000",
    "END:VEVENT",
  ].join("\r\n");

  const { busy } = parseIcsBusyIntervals(calendar(folded), { fallbackTimeZone: "UTC" });
  assertEquals(busy.length, 1);
  assertEquals(busy[0].start, "2026-08-16T12:00:00.000Z");
});

Deno.test("gère une journée entière (VALUE=DATE)", () => {
  // Une fermeture exceptionnelle est souvent saisie comme un événement journée.
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:6",
      "DTSTART;VALUE=DATE:20260816",
      "DTEND;VALUE=DATE:20260817",
    ])),
    { fallbackTimeZone: PARIS },
  );

  assertEquals(busy[0].start, "2026-08-16T00:00:00.000Z");
  assertEquals(busy[0].end, "2026-08-17T00:00:00.000Z");
});

Deno.test("un événement sans DTEND dure une heure par défaut", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent(["UID:7", "DTSTART:20260816T140000Z"])),
    { fallbackTimeZone: PARIS },
  );
  assertEquals(busy[0].end, "2026-08-16T15:00:00.000Z");
});

Deno.test("ignore les événements marqués disponibles ou annulés", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(
      vevent([
        "UID:8",
        "DTSTART:20260816T140000Z",
        "DTEND:20260816T150000Z",
        "TRANSP:TRANSPARENT",
      ]),
      vevent([
        "UID:9",
        "DTSTART:20260816T160000Z",
        "DTEND:20260816T170000Z",
        "STATUS:CANCELLED",
      ]),
      vevent(["UID:10", "DTSTART:20260816T180000Z", "DTEND:20260816T190000Z"]),
    ),
    { fallbackTimeZone: PARIS },
  );

  assertEquals(busy.length, 1);
  assertEquals(busy[0].start, "2026-08-16T18:00:00.000Z");
});

Deno.test("développe les événements récurrents", () => {
  // Le défaut historique : une plage récurrente non comptée est une plage
  // proposée à tort, donc deux clientes sur le même créneau.
  const { busy, expandedRecurring } = parseIcsBusyIntervals(
    calendar(
      vevent([
        "UID:11",
        "DTSTART:20260816T140000Z",
        "DTEND:20260816T150000Z",
        "RRULE:FREQ=WEEKLY;COUNT=10",
      ]),
      vevent(["UID:12", "DTSTART:20260816T180000Z", "DTEND:20260816T190000Z"]),
    ),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-16T00:00:00Z"),
      to: new Date("2026-10-30T00:00:00Z"),
    },
  );

  assertEquals(expandedRecurring, 1);
  assertEquals(busy.length, 11); // 10 occurrences + l'événement simple
  // La durée d'une heure est reportée sur toute la série.
  assertEquals(busy[0], { start: "2026-08-16T14:00:00.000Z", end: "2026-08-16T15:00:00.000Z" });
});

Deno.test("EXDATE : l'occurrence supprimée libère le créneau", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:21",
      "DTSTART:20260816T140000Z",
      "DTEND:20260816T150000Z",
      "RRULE:FREQ=DAILY;COUNT=3",
      "EXDATE:20260817T140000Z",
    ])),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-16T00:00:00Z"),
      to: new Date("2026-08-20T00:00:00Z"),
    },
  );

  assertEquals(busy.map((b) => b.start), [
    "2026-08-16T14:00:00.000Z",
    "2026-08-18T14:00:00.000Z",
  ]);
});

Deno.test("RECURRENCE-ID : une occurrence déplacée ne bloque pas les deux créneaux", () => {
  // L'instance modifiée apparaît AVANT l'événement maître, comme le font
  // certains exports : la lecture en deux temps est ce qui rend ce cas correct.
  const { busy } = parseIcsBusyIntervals(
    calendar(
      vevent([
        "UID:31",
        "RECURRENCE-ID:20260817T140000Z",
        "DTSTART:20260817T160000Z",
        "DTEND:20260817T170000Z",
      ]),
      vevent([
        "UID:31",
        "DTSTART:20260816T140000Z",
        "DTEND:20260816T150000Z",
        "RRULE:FREQ=DAILY;COUNT=2",
      ]),
    ),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-16T00:00:00Z"),
      to: new Date("2026-08-20T00:00:00Z"),
    },
  );

  assertEquals(busy.map((b) => b.start), [
    "2026-08-16T14:00:00.000Z",
    "2026-08-17T16:00:00.000Z", // déplacée, l'ancienne n'est plus comptée
  ]);
});

Deno.test("RDATE : une occurrence ajoutée hors règle est comptée", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:41",
      "DTSTART:20260816T140000Z",
      "DTEND:20260816T150000Z",
      "RDATE:20260820T140000Z",
    ])),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-16T00:00:00Z"),
      to: new Date("2026-08-25T00:00:00Z"),
    },
  );

  assertEquals(busy.map((b) => b.start), [
    "2026-08-16T14:00:00.000Z",
    "2026-08-20T14:00:00.000Z",
  ]);
});

Deno.test("récurrence annulée : aucune occurrence développée", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent([
      "UID:51",
      "DTSTART:20260816T140000Z",
      "DTEND:20260816T150000Z",
      "RRULE:FREQ=DAILY;COUNT=5",
      "STATUS:CANCELLED",
    ])),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-16T00:00:00Z"),
      to: new Date("2026-08-25T00:00:00Z"),
    },
  );

  assertEquals(busy.length, 0);
});

Deno.test("filtre sur la fenêtre demandée", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(
      vevent(["UID:13", "DTSTART:20260101T140000Z", "DTEND:20260101T150000Z"]),
      vevent(["UID:14", "DTSTART:20260816T140000Z", "DTEND:20260816T150000Z"]),
      vevent(["UID:15", "DTSTART:20271201T140000Z", "DTEND:20271201T150000Z"]),
    ),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-09-01T00:00:00Z"),
    },
  );

  assertEquals(busy.length, 1);
  assertEquals(busy[0].start, "2026-08-16T14:00:00.000Z");
});

Deno.test("un événement à cheval sur la borne est conservé", () => {
  // Un rendez-vous commencé avant la fenêtre et fini dedans occupe bien le
  // début de la fenêtre : l'exclure libérerait un créneau déjà pris.
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent(["UID:16", "DTSTART:20260731T230000Z", "DTEND:20260801T010000Z"])),
    {
      fallbackTimeZone: PARIS,
      from: new Date("2026-08-01T00:00:00Z"),
      to: new Date("2026-09-01T00:00:00Z"),
    },
  );
  assertEquals(busy.length, 1);
});

Deno.test("un flux vide ou illisible ne produit aucune plage", () => {
  assertEquals(parseIcsBusyIntervals("", { fallbackTimeZone: PARIS }).busy.length, 0);
  assertEquals(parseIcsBusyIntervals("n'importe quoi", { fallbackTimeZone: PARIS }).busy.length, 0);
  assertEquals(
    parseIcsBusyIntervals(
      calendar(vevent(["UID:17", "DTSTART:pas-une-date", "DTEND:20260816T150000Z"])),
      { fallbackTimeZone: PARIS },
    ).busy.length,
    0,
  );
});

Deno.test("un intervalle inversé est écarté", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(vevent(["UID:18", "DTSTART:20260816T150000Z", "DTEND:20260816T140000Z"])),
    { fallbackTimeZone: PARIS },
  );
  assertEquals(busy.length, 0);
});

Deno.test("plusieurs événements sont tous relevés", () => {
  const { busy } = parseIcsBusyIntervals(
    calendar(
      vevent(["UID:19", "DTSTART:20260816T090000Z", "DTEND:20260816T100000Z"]),
      vevent(["UID:20", "DTSTART:20260816T110000Z", "DTEND:20260816T120000Z"]),
      vevent(["UID:21", "DTSTART:20260816T140000Z", "DTEND:20260816T153000Z"]),
    ),
    { fallbackTimeZone: PARIS },
  );

  assertEquals(busy.length, 3);
  assert(busy.every((interval) => Date.parse(interval.end) > Date.parse(interval.start)));
});
