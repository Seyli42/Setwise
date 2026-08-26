// Connexions : Instagram, WhatsApp, Google Calendar.
//
// Aucun secret ne transite par ce fichier au-delà de la saisie : les tokens
// partent vers `dashboard-api`, qui les chiffre avant stockage. Ils ne sont
// jamais relus par le navigateur — les colonnes correspondantes sont révoquées
// pour le rôle `authenticated` (migration 0005).

import { fetchConnections } from "../api.js";
import { callApi, isOwner } from "../client.js";
import { CONFIG } from "../../config.js";
import {
  asyncButton,
  badge,
  card,
  el,
  empty,
  errorBox,
  field,
  formatDateTime,
  mount,
  successBox,
  table,
} from "../dom.js";

const CHANNEL_LABEL = { instagram: "Instagram", whatsapp: "WhatsApp Business" };

export async function renderConnections() {
  const { channels, calendars } = await fetchConnections();
  const feedback = el("div", { class: "feedback" });

  const channelRows = channels.map((connection) => [
    CHANNEL_LABEL[connection.channel] ?? connection.channel,
    connection.external_account_id,
    badge(connection.status, connection.status === "active" ? "ok" : "warn"),
    formatDateTime(connection.created_at),
  ]);

  const calendarRows = calendars.map((integration) => [
    integration.provider === "google" ? "Google Calendar" : integration.provider,
    integration.calendar_external_id,
    badge(integration.status, integration.status === "active" ? "ok" : "warn"),
    formatDateTime(integration.created_at),
  ]);

  const sections = [
    el("h1", { class: "page-title", text: "Connexions" }),

    card(
      "Canaux de messagerie",
      channelRows.length === 0
        ? empty("Aucun canal connecté. Vos leads Instagram n'arriveront pas tant que ce n'est pas fait.")
        : table(["Canal", "Compte", "Statut", "Connecté le"], channelRows),
    ),

    card(
      "Agenda",
      calendarRows.length === 0
        ? empty("Aucun agenda connecté. L'agent qualifiera vos leads mais ne pourra pas réserver de créneau.")
        : table(["Fournisseur", "Agenda", "Statut", "Connecté le"], calendarRows),
    ),
  ];

  // La connexion d'un canal engage tout l'institut : réservée au propriétaire,
  // conformément aux policies RLS.
  if (isOwner()) {
    sections.push(
      buildMetaOauthCard(),
      buildChannelForm(feedback),
      buildCalendarSection(feedback),
    );
  } else {
    sections.push(
      el("p", {
        class: "muted",
        text: "Seul le propriétaire du compte peut modifier les connexions.",
      }),
    );
  }

  sections.push(feedback);
  return el("div", {}, sections);
}

/**
 * Connexion Instagram en un bouton.
 *
 * Le choix des pages se fait dans l'écran de consentement Meta, qui affiche
 * déjà la liste et laisse cocher. Reposer la question ici serait demander deux
 * fois la même décision.
 */
function buildMetaOauthCard() {
  const authorize = el("button", {
    class: "btn",
    type: "button",
    text: "Connecter avec Facebook",
    on: {
      click() {
        const state = crypto.randomUUID();
        sessionStorage.setItem("setwise_meta_state", state);

        const params = new URLSearchParams({
          client_id: CONFIG.META_APP_ID,
          redirect_uri: CONFIG.META_REDIRECT_URI,
          response_type: "code",
          state,
          // `pages_show_list` sert à énumérer les pages ; les deux suivantes
          // à lire et répondre aux messages. `whatsapp_business_management`
          // est facultative : sans elle, la découverte WhatsApp échoue et
          // devient un avertissement, pas une erreur.
          scope: [
            "pages_show_list",
            "pages_manage_metadata",
            "instagram_basic",
            "instagram_manage_messages",
            "whatsapp_business_management",
          ].join(","),
        });
        location.href = `https://www.facebook.com/v21.0/dialog/oauth?${params}`;
      },
    },
  });

  return card(
    "Connecter Instagram",
    el("p", {
      class: "muted",
      text: "Votre compte Instagram professionnel doit être rattaché à une page Facebook " +
        "dont vous êtes administratrice. Meta vous demandera lesquelles autoriser.",
    }),
    authorize,
  );
}

function buildChannelForm(feedback) {
  const channelSelect = el("select", { class: "select" });
  channelSelect.append(el("option", { value: "instagram", text: "Instagram" }));
  channelSelect.append(el("option", { value: "whatsapp", text: "WhatsApp Business" }));

  const accountInput = el("input", { type: "text", placeholder: "17841400000000000" });
  const tokenInput = el("input", { type: "password", placeholder: "EAAG…" });

  const submit = asyncButton("Connecter", async () => {
    mount(feedback);

    if (!accountInput.value.trim() || !tokenInput.value.trim()) {
      mount(feedback, errorBox("Identifiant de compte et token sont obligatoires."));
      return;
    }

    try {
      await callApi("connect_channel", {
        channel: channelSelect.value,
        external_account_id: accountInput.value.trim(),
        access_token: tokenInput.value.trim(),
      });
      // Le token ne doit pas rester en mémoire du champ après l'envoi.
      tokenInput.value = "";
      mount(feedback, successBox("Canal connecté."));
      location.reload();
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Connexion…" });

  return card(
    "Connecter un canal à la main",
    el("p", {
      class: "muted",
      text: "Voie de secours : à n'utiliser que si la connexion par Facebook échoue, " +
        "ou pour un compte WhatsApp Business non détecté automatiquement.",
    }),
    field("Canal", channelSelect),
    field(
      "Identifiant du compte",
      accountInput,
      "Instagram : identifiant du compte professionnel. WhatsApp : Phone Number ID.",
    ),
    field(
      "Token d'accès longue durée",
      tokenInput,
      "Chiffré avant stockage. Il ne sera plus jamais affiché.",
    ),
    submit,
  );
}

function buildCalendarSection(feedback) {
  const calendarInput = el("input", { type: "text", value: "primary" });

  // `access_type=offline` + `prompt=consent` sont obligatoires : sans eux
  // Google ne renvoie pas de refresh token et l'intégration expire en une heure.
  const authorize = el("button", {
    class: "btn",
    type: "button",
    text: "Autoriser Google Calendar",
    on: {
      click() {
        // `state` anti-CSRF : sans lui, un tiers peut faire aboutir SON code
        // d'autorisation dans la session du gérant et brancher l'agent sur SON
        // agenda. Vérifié par la page de retour `/oauth/google`.
        const state = crypto.randomUUID();
        sessionStorage.setItem("setwise_oauth_state", state);
        sessionStorage.setItem("setwise_calendar_id", calendarInput.value.trim() || "primary");

        const params = new URLSearchParams({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          redirect_uri: CONFIG.GOOGLE_REDIRECT_URI,
          response_type: "code",
          access_type: "offline",
          prompt: "consent",
          state,
          scope: [
            "https://www.googleapis.com/auth/calendar.events",
            "https://www.googleapis.com/auth/calendar.readonly",
          ].join(" "),
        });
        location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      },
    },
  });

  const codeInput = el("input", { type: "text", placeholder: "4/0Ab…" });
  const exchange = asyncButton("Valider le code", async () => {
    mount(feedback);
    if (!codeInput.value.trim()) {
      mount(feedback, errorBox("Code d'autorisation manquant."));
      return;
    }

    try {
      await callApi("connect_google_calendar", {
        code: codeInput.value.trim(),
        redirect_uri: CONFIG.GOOGLE_REDIRECT_URI,
        calendar_external_id: sessionStorage.getItem("setwise_calendar_id") ??
          calendarInput.value.trim() ?? "primary",
      });
      codeInput.value = "";
      mount(feedback, successBox("Agenda connecté."));
      location.reload();
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Validation…" });

  return card(
    "Connecter Google Calendar",
    field(
      "Identifiant de l'agenda",
      calendarInput,
      "`primary` pour l'agenda principal, ou l'adresse d'un agenda dédié.",
    ),
    authorize,
    el("p", {
      class: "muted",
      text: "Après autorisation, la connexion se termine toute seule. " +
        "Le champ ci-dessous n'est qu'une voie de secours : si la page de retour " +
        "affiche une erreur, collez-y le paramètre `code` visible dans l'URL.",
    }),
    field("Code d'autorisation (secours)", codeInput),
    exchange,
  );
}
