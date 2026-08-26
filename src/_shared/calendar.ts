import type { CalendarProvider } from "./types.ts";

// Registre providers calendrier — abstraction pour supporter Google (MVP) + Planity (V2)
// sans changer le moteur d'agent. Étape 4 enregistre l'implémentation Google réelle ici.
// Tant qu'un provider n'est pas enregistré, le moteur ne propose PAS l'outil de réservation
// au lead — il qualifie puis escalade pour prise de RDV manuelle (aucune fausse promesse).

const registry = new Map<string, CalendarProvider>();

export function registerCalendarProvider(provider: string, impl: CalendarProvider): void {
  registry.set(provider, impl);
}

export function getCalendarProvider(provider: string): CalendarProvider | undefined {
  return registry.get(provider);
}
