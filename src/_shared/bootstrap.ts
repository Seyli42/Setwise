// Amorçage : chargement du .env et enregistrement des providers concrets.

// 1. Chargement automatique du fichier .env si présent
try {
  const envPath = decodeURIComponent(new URL("../../.env", import.meta.url).pathname);
  const envText = await Deno.readTextFile(envPath).catch(() => "");
  for (const line of envText.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match && !Deno.env.get(match[1].trim())) {
      const val = match[2].trim().replace(/^["'](.*)["']$/, "$1");
      Deno.env.set(match[1].trim(), val);
    }
  }
} catch (_err) {
  // Ignorer si inaccessible
}

import { registerCalendarProvider } from "./calendar.ts";
import { googleCalendarProvider } from "./calendar/google.ts";
import { icsCalendarProvider } from "./calendar/ics.ts";
import { planityCalendarProvider } from "./calendar/planity.ts";

// Lecture et écriture.
registerCalendarProvider("google", googleCalendarProvider);

// Lecture seule : flux ICS de n'importe quel logiciel de réservation.
registerCalendarProvider("ics", icsCalendarProvider);

// Planity : lecture via son flux ICS, écriture indisponible faute d'API
// publique. Voir `calendar/planity.ts` pour le détail et les options.
registerCalendarProvider("planity", planityCalendarProvider);
