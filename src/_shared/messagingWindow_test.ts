// Fenêtre de messagerie Meta. Une erreur ici se voit soit en messages refusés
// par Meta, soit en zone de saisie ouverte au gérant alors qu'elle ne devrait
// pas l'être.
//
// Lancer : deno test supabase/functions/_shared/messagingWindow_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import {
  isWindowOpen,
  MESSAGING_WINDOW_HOURS,
  minutesLeftInWindow,
  windowExpiryFrom,
} from "./messagingWindow.ts";

const RECEIVED = "2026-08-16T10:00:00.000Z";
const EXPIRES = "2026-08-17T10:00:00.000Z";

Deno.test("l'expiration est 24 h après le message entrant", () => {
  assertEquals(MESSAGING_WINDOW_HOURS, 24);
  assertEquals(windowExpiryFrom(RECEIVED), EXPIRES);
});

Deno.test("un horodatage illisible retombe sur maintenant + 24 h", () => {
  // Plutôt que de produire `Invalid Date` et de casser l'insertion en base.
  const before = Date.now();
  const expiry = Date.parse(windowExpiryFrom("pas une date"));
  const expected = before + MESSAGING_WINDOW_HOURS * 3_600_000;

  assertEquals(Math.abs(expiry - expected) < 5000, true);
});

Deno.test("fenêtre ouverte pendant les 24 h", () => {
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-16T10:01:00Z")), true);
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-17T05:00:00Z")), true);
});

Deno.test("fenêtre fermée après expiration", () => {
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-17T10:00:01Z")), false);
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-20T00:00:00Z")), false);
});

Deno.test("marge de sécurité : fermée deux minutes avant l'heure réelle", () => {
  // Un envoi décidé à 23 h 59 min 50 s peut atteindre Meta après la fermeture.
  // Mieux vaut refuser côté Setwise que se faire refuser côté Meta.
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-17T09:57:00Z")), true);
  assertEquals(isWindowOpen(EXPIRES, new Date("2026-08-17T09:59:00Z")), false);
});

Deno.test("aucune expiration connue = fenêtre fermée", () => {
  // Cas réel : conversation WhatsApp ouverte par un modèle après qualification
  // sur Instagram. Un modèle n'ouvre pas de fenêtre de service ; seule une
  // réponse du client le fait. Traiter `null` comme « ouverte » ferait envoyer
  // un message libre que Meta refuserait.
  assertEquals(isWindowOpen(null), false);
  assertEquals(isWindowOpen(undefined), false);
  assertEquals(isWindowOpen(""), false);
  assertEquals(isWindowOpen("pas une date"), false);
});

Deno.test("minutesLeftInWindow décompte le temps restant", () => {
  assertEquals(minutesLeftInWindow(EXPIRES, new Date("2026-08-17T09:00:00Z")), 58);
  assertEquals(minutesLeftInWindow(EXPIRES, new Date("2026-08-16T10:00:00Z")), 1438);
});

Deno.test("minutesLeftInWindow renvoie 0 quand la fenêtre est fermée", () => {
  assertEquals(minutesLeftInWindow(EXPIRES, new Date("2026-08-18T00:00:00Z")), 0);
  assertEquals(minutesLeftInWindow(null), 0);
});
