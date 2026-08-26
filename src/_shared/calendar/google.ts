// Provider Google Calendar.
//
// Ne contient que ce qui touche au réseau : jetons OAuth, plages occupées,
// création et annulation d'événements. Toute la logique de créneaux vit dans
// `slots.ts` (pure, testée).
//
// Modèle d'authentification : une seule application Google Cloud pour Setwise
// (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`), et un refresh token par
// institut, chiffré dans `calendar_integrations.credentials_encrypted`.

import { requireEnv } from "../env.ts";
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
import { formatFrench } from "./timezone.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Cache de jetons d'accès, par refresh token. Vit le temps de l'instance. */
const tokenCache = new Map<string, { accessToken: string; expiresAt: number }>();

interface GoogleCredentials {
  refresh_token: string;
}

function parseCredentials(decrypted: string): GoogleCredentials {
  try {
    const parsed = JSON.parse(decrypted);
    if (typeof parsed?.refresh_token !== "string" || !parsed.refresh_token) {
      throw new Error("refresh_token absent");
    }
    return parsed as GoogleCredentials;
  } catch (cause) {
    throw new ValidationError(
      "Credentials Google invalides. Attendu : {\"refresh_token\": \"...\"} chiffré.",
      { cause: String(cause) },
    );
  }
}

async function getAccessToken(credentialsEncrypted: string): Promise<string> {
  const { refresh_token } = parseCredentials(await decryptSecret(credentialsEncrypted));

  const cached = tokenCache.get(refresh_token);
  // Marge de 60 s : un jeton qui expire pendant la requête en vol produirait
  // un 401 alors que tout est correct.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.accessToken;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      refresh_token,
      grant_type: "refresh_token",
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    // `invalid_grant` = l'institut a révoqué l'accès ou changé de mot de passe.
    // Aucun retry ne réglera ça : il faut reconnecter le calendrier.
    const permanent = text.includes("invalid_grant") || response.status === 400;
    throw new ExternalApiError("google-oauth", `échec du rafraîchissement du jeton: ${text}`, {
      status: response.status,
      retryable: !permanent,
    });
  }

  const payload = JSON.parse(text) as { access_token: string; expires_in: number };
  tokenCache.set(refresh_token, {
    accessToken: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  });

  return payload.access_token;
}

/**
 * Échange le code d'autorisation OAuth contre un refresh token, à la connexion
 * du calendrier depuis le dashboard.
 *
 * Google ne renvoie un `refresh_token` que si la demande d'autorisation portait
 * `access_type=offline` ET `prompt=consent`. Sans lui, l'intégration marcherait
 * une heure puis tomberait — d'où l'échec explicite ici plutôt qu'un stockage
 * de credentials inutilisables.
 */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<{ refreshToken: string }> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: requireEnv("GOOGLE_CLIENT_ID"),
      client_secret: requireEnv("GOOGLE_CLIENT_SECRET"),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ExternalApiError("google-oauth", `échange du code échoué: ${text.slice(0, 300)}`, {
      status: response.status,
      retryable: false,
    });
  }

  const payload = JSON.parse(text) as { refresh_token?: string };
  if (!payload.refresh_token) {
    throw new ValidationError(
      "Google n'a pas renvoyé de refresh token. Relancer l'autorisation avec " +
        "access_type=offline et prompt=consent.",
    );
  }

  return { refreshToken: payload.refresh_token };
}

async function googleFetch(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok && response.status !== 409) {
    const detail = await response.text();
    throw new ExternalApiError("google-calendar", detail.slice(0, 500), {
      status: response.status,
      context: { path },
    });
  }

  return response;
}

async function fetchBusyIntervals(params: {
  calendarExternalId: string;
  accessToken: string;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}): Promise<BusyInterval[]> {
  const response = await googleFetch("/freeBusy", params.accessToken, {
    method: "POST",
    body: JSON.stringify({
      timeMin: params.timeMin,
      timeMax: params.timeMax,
      timeZone: params.timeZone,
      items: [{ id: params.calendarExternalId }],
    }),
  });

  const payload = await response.json() as {
    calendars?: Record<string, { busy?: BusyInterval[]; errors?: Array<{ reason: string }> }>;
  };

  const calendar = payload.calendars?.[params.calendarExternalId];

  if (calendar?.errors?.length) {
    // Typiquement `notFound` (mauvais id) ou `forbidden` (droit retiré) :
    // proposer des créneaux serait pire que ne rien proposer, car on
    // réserverait par-dessus des rendez-vous existants.
    throw new ExternalApiError(
      "google-calendar",
      `calendrier inaccessible: ${calendar.errors.map((e) => e.reason).join(", ")}`,
      { status: 403, retryable: false },
    );
  }

  return calendar?.busy ?? [];
}

/**
 * Identifiant d'événement Google dérivé de l'id du rendez-vous.
 *
 * Google accepte un id fourni par le client (alphabet base32hex : 0-9 et a-v).
 * Un UUID hexadécimal sans tirets est déjà dans cet alphabet. Conséquence :
 * rejouer la création après un timeout renvoie 409 au lieu de créer un doublon
 * dans l'agenda de l'institut.
 */
function toGoogleEventId(idempotencyKey: string): string {
  const normalized = idempotencyKey.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-v]{5,1024}$/.test(normalized)) {
    throw new ValidationError("Clé d'idempotence incompatible avec un id d'événement Google.");
  }
  return `setwise${normalized}`;
}

export const googleCalendarProvider: CalendarProvider = {
  capabilities: { canBook: true },

  async checkAvailability(params: AvailabilityRequest): Promise<CalendarSlot[]> {
    const accessToken = await getAccessToken(params.credentialsEncrypted);
    const durationMin = resolveDuration(params.serviceType, params.scheduling);

    const busy = await fetchBusyIntervals({
      calendarExternalId: params.calendarExternalId,
      accessToken,
      timeMin: params.fromDate,
      timeMax: params.toDate,
      timeZone: params.timezone,
    });

    const slots = generateSlots({
      from: new Date(params.fromDate),
      to: new Date(params.toDate),
      timezone: params.timezone,
      scheduling: params.scheduling,
      durationMin,
      busy,
    });

    log.info("calendar.availability", {
      calendar: params.calendarExternalId,
      durationMin,
      busyCount: busy.length,
      slotCount: slots.length,
    });

    return slots;
  },

  async bookAppointment(params: BookingRequest): Promise<{ externalEventId: string }> {
    const accessToken = await getAccessToken(params.credentialsEncrypted);
    const eventId = toGoogleEventId(params.idempotencyKey);

    const description = [
      "Rendez-vous pris automatiquement par Setwise.",
      params.leadPhone ? `Téléphone : ${params.leadPhone}` : null,
      `Prestation : ${params.serviceType}`,
    ].filter(Boolean).join("\n");

    const response = await googleFetch(
      `/calendars/${encodeURIComponent(params.calendarExternalId)}/events`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          id: eventId,
          summary: `${params.serviceType} — ${params.leadName}`,
          description,
          start: { dateTime: params.slot.startsAt, timeZone: params.timezone },
          end: { dateTime: params.slot.endsAt, timeZone: params.timezone },
          // Le calendrier de l'institut fait foi : on ne crée pas d'invitation
          // à un e-mail qu'on n'a pas collecté.
          reminders: { useDefault: true },
        }),
      },
    );

    if (response.status === 409) {
      // L'événement existe déjà : c'est un rejeu de la même réservation, pas
      // une erreur. On considère la réservation acquise.
      log.info("calendar.book.idempotent_hit", { eventId });
      return { externalEventId: eventId };
    }

    const created = await response.json() as { id?: string };

    log.info("calendar.book.created", {
      eventId: created.id ?? eventId,
      startsAt: params.slot.startsAt,
      label: formatFrench(new Date(params.slot.startsAt), params.timezone),
    });

    return { externalEventId: created.id ?? eventId };
  },

  async cancelEvent(params): Promise<void> {
    const accessToken = await getAccessToken(params.credentialsEncrypted);

    const response = await fetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(params.calendarExternalId)}/events/${
        encodeURIComponent(params.externalEventId)
      }`,
      { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
    );

    // 404/410 : l'événement a déjà été supprimé (par le gérant depuis Google,
    // ou par un rejeu). L'état voulu est atteint.
    if (response.ok || response.status === 404 || response.status === 410) return;

    throw new ExternalApiError("google-calendar", (await response.text()).slice(0, 500), {
      status: response.status,
    });
  },
};
