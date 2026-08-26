// Conversions heure locale ⇄ UTC pour un fuseau IANA.
//
// L'institut raisonne en heure locale ("on ouvre à 9 h"), Google Calendar et la
// base raisonnent en instants UTC. Entre les deux il y a l'heure d'été : le
// 30 mars, 9 h locale à Paris n'est pas le même instant que le 29 mars.
// Deno n'embarque pas de bibliothèque de dates, donc on s'appuie sur `Intl`,
// qui connaît la base tzdata.

export const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type WeekdayKey = typeof WEEKDAY_KEYS[number];

/** Décalage du fuseau (en ms) à un instant donné. Positif à l'est de Greenwich. */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
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

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24, // `hour12: false` peut rendre "24" à minuit
    Number(parts.minute),
    Number(parts.second),
  );

  return asIfUtc - instant.getTime();
}

/**
 * Instant UTC correspondant à une heure murale locale.
 *
 * Double passe : le décalage dépend de l'instant, qu'on ne connaît pas encore.
 * On estime avec le décalage au point naïf, puis on recalcule au point corrigé.
 * Suffisant partout sauf dans l'heure inexistante du passage à l'heure d'été,
 * où l'on retombe sur l'heure suivante — ce qui est le comportement souhaité
 * pour un créneau de rendez-vous.
 */
export function zonedTimeToUtc(
  isoDate: string, // "2026-03-29"
  hhmm: string, // "09:30"
  timeZone: string,
): Date {
  const [hours, minutes] = hhmm.split(":").map(Number);
  const naive = new Date(`${isoDate}T00:00:00Z`);
  naive.setUTCHours(hours, minutes, 0, 0);

  const firstPass = new Date(naive.getTime() - timeZoneOffsetMs(naive, timeZone));
  return new Date(naive.getTime() - timeZoneOffsetMs(firstPass, timeZone));
}

/** Date locale (`YYYY-MM-DD`) d'un instant, dans le fuseau donné. */
export function localDateKey(instant: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(instant); // en-CA formate en YYYY-MM-DD
}

/** Jour de la semaine local, dans les clés utilisées par `businessHours`. */
export function localWeekday(instant: Date, timeZone: string): WeekdayKey {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" })
    .format(instant)
    .toLowerCase();
  const key = WEEKDAY_KEYS.find((k) => k === short);
  if (!key) throw new Error(`Jour de semaine non reconnu: ${short}`);
  return key;
}

/**
 * Liste des dates locales couvertes par un intervalle d'instants, bornes
 * incluses. Itère par pas de 12 h pour ne sauter aucune journée lors d'un
 * changement d'heure.
 */
export function localDatesBetween(from: Date, to: Date, timeZone: string): string[] {
  const dates: string[] = [];
  const seen = new Set<string>();

  for (let t = from.getTime(); t <= to.getTime() + 12 * 3_600_000; t += 12 * 3_600_000) {
    const key = localDateKey(new Date(t), timeZone);
    if (!seen.has(key)) {
      seen.add(key);
      dates.push(key);
    }
  }

  return dates;
}

/** Libellé lisible en français, dans le fuseau de l'établissement. */
export function formatFrench(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(instant);
}
