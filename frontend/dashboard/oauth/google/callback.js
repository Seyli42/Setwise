// Retour d'autorisation Google.
//
// Fichier séparé et non script en ligne : la politique de sécurité du
// dashboard est `script-src 'self'`, qui bloque tout code inline. Un
// `<script>` dans la page ne s'exécuterait jamais en production.

import { auth, callApi } from "../../js/client.js";
import { CONFIG } from "../../config.js";

const box = document.getElementById("etat");

function show(className, text, withLink = true) {
  while (box.childNodes.length > 1) box.removeChild(box.lastChild);

  const message = document.createElement("p");
  message.className = className;
  message.textContent = text;
  box.append(message);

  if (withLink) {
    const link = document.createElement("a");
    link.className = "link";
    link.href = "../../index.html#/connections";
    link.textContent = "Retour aux connexions";
    box.append(link);
  }
}

async function run() {
  const params = new URLSearchParams(location.search);

  // Google renvoie `error=access_denied` quand le gérant refuse l'écran de
  // consentement. Ce n'est pas une panne : le dire clairement évite un
  // ticket de support.
  const error = params.get("error");
  if (error) {
    show(
      "alert alert--error",
      error === "access_denied"
        ? "Autorisation refusée. L'agenda n'a pas été connecté."
        : `Google a refusé l'autorisation (${error}).`,
    );
    return;
  }

  const code = params.get("code");
  if (!code) {
    show("alert alert--error", "Aucun code d'autorisation reçu.");
    return;
  }

  // CSRF : sans cette vérification, un tiers pourrait faire aboutir SON code
  // d'autorisation dans la session du gérant, et brancher l'agent sur SON
  // agenda. Le jeton est posé juste avant la redirection vers Google.
  const expected = sessionStorage.getItem("setwise_oauth_state");
  if (!expected || params.get("state") !== expected) {
    show(
      "alert alert--error",
      "Jeton de sécurité invalide. Relancez la connexion depuis l'écran Connexions.",
    );
    return;
  }
  sessionStorage.removeItem("setwise_oauth_state");

  const { data: { session: authSession } } = await auth.getSession();
  if (!authSession) {
    show("alert alert--error", "Session expirée. Reconnectez-vous, puis recommencez.");
    return;
  }

  try {
    await callApi("connect_google_calendar", {
      code,
      // Rigoureusement la même valeur que dans la demande d'autorisation :
      // Google compare les deux chaînes et rejette le code au moindre écart,
      // y compris sur la barre finale. D'où `CONFIG` plutôt que `location`.
      redirect_uri: CONFIG.GOOGLE_REDIRECT_URI,
      calendar_external_id: sessionStorage.getItem("setwise_calendar_id") || "primary",
    });

    sessionStorage.removeItem("setwise_calendar_id");
    show("alert alert--ok", "Agenda connecté. Redirection…");
    setTimeout(() => {
      location.href = "../../index.html#/connections";
    }, 1200);
  } catch (exception) {
    show("alert alert--error", exception.message);
  }
}

run();
