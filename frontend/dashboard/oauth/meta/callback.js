// Retour d'autorisation Meta.
//
// Fichier séparé et non script en ligne : la politique de sécurité du
// dashboard est `script-src 'self'`, qui bloque tout code inline. Un
// `<script>` dans la page ne s'exécuterait jamais en production.

import { auth, callApi } from "../../js/client.js";
import { CONFIG } from "../../config.js";

const box = document.getElementById("etat");

function reset() {
  while (box.childNodes.length > 1) box.removeChild(box.lastChild);
}

function paragraph(className, text) {
  const node = document.createElement("p");
  node.className = className;
  node.textContent = text;
  return node;
}

function backLink() {
  const link = document.createElement("a");
  link.className = "link";
  link.href = "../../index.html#/connections";
  link.textContent = "Retour aux connexions";
  return link;
}

function fail(text) {
  reset();
  box.append(paragraph("alert alert--error", text), backLink());
}

async function run() {
  const params = new URLSearchParams(location.search);

  const error = params.get("error");
  if (error) {
    fail(
      error === "access_denied"
        ? "Autorisation refusée. Aucun compte n'a été connecté."
        : `Meta a refusé l'autorisation (${params.get("error_description") || error}).`,
    );
    return;
  }

  const code = params.get("code");
  if (!code) {
    fail("Aucun code d'autorisation reçu.");
    return;
  }

  // Même protection CSRF que pour Google : sans elle, un tiers pourrait faire
  // aboutir SON code dans la session du gérant et brancher l'agent sur SES
  // comptes.
  const expected = sessionStorage.getItem("setwise_meta_state");
  if (!expected || params.get("state") !== expected) {
    fail("Jeton de sécurité invalide. Relancez la connexion depuis l'écran Connexions.");
    return;
  }
  sessionStorage.removeItem("setwise_meta_state");

  const { data: { session: authSession } } = await auth.getSession();
  if (!authSession) {
    fail("Session expirée. Reconnectez-vous, puis recommencez.");
    return;
  }

  try {
    const result = await callApi("connect_meta_oauth", {
      code,
      redirect_uri: CONFIG.META_REDIRECT_URI,
    });

    reset();
    box.append(
      paragraph("alert alert--ok", `${result.connected.length} compte(s) connecté(s).`),
    );

    const list = document.createElement("ul");
    list.className = "bullets";
    for (const item of result.connected) {
      const entry = document.createElement("li");
      entry.textContent = `${item.channel === "instagram" ? "Instagram" : "WhatsApp"} — ${item.label}`;
      list.append(entry);
    }
    box.append(list);

    // Les avertissements comptent autant que le succès : une page sans compte
    // professionnel rattaché ne recevra jamais de message, et le gérant doit
    // le savoir maintenant, pas dans trois semaines.
    for (const warning of result.warnings ?? []) {
      box.append(paragraph("muted", warning));
    }

    box.append(backLink());
  } catch (exception) {
    fail(exception.message);
  }
}

run();
