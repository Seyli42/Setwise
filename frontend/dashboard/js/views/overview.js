// Vue d'ensemble : les quatre chiffres qui disent si Setwise rapporte.

import { fetchOverview, fetchPerformance } from "../api.js";
import { badge, card, el, empty, formatRelative, table } from "../dom.js";

function metric(label, value, hint) {
  return el("div", { class: "metric" }, [
    el("span", { class: "metric__value", text: String(value) }),
    el("span", { class: "metric__label", text: label }),
    hint ? el("span", { class: "metric__hint", text: hint }) : null,
  ]);
}

/** `null` = pas encore mesurable. Afficher « 0 % » serait un mensonge. */
function percent(value) {
  return value === null || value === undefined ? "—" : `${value} %`;
}

function contactLabel(lead) {
  if (!lead) return "Contact inconnu";
  return lead.full_name || lead.instagram_handle || lead.phone || "Contact inconnu";
}

const STATUS_TONE = {
  active: "info",
  qualified: "ok",
  escalated: "warn",
  closed: "neutral",
  expired: "neutral",
};

export async function renderOverview() {
  const [data, perf] = await Promise.all([fetchOverview(), fetchPerformance(30)]);

  const metrics = el("div", { class: "metrics" }, [
    metric("Leads reçus", data.leads30d, "30 derniers jours"),
    metric("Leads qualifiés", data.qualified30d, `${percent(perf.taux_qualification)} des leads`),
    metric("RDV à venir", data.upcomingAppointments, "confirmés"),
    metric("À reprendre", data.openEscalations, "escalades ouvertes"),
  ]);

  // Bilan des rendez-vous passés : l'absence est le premier poste de perte
  // d'un institut, et c'est ce que l'abonnement doit faire reculer.
  const assiduite = el("div", { class: "metrics" }, [
    metric("RDV honorés", perf.rdv_honores ?? 0, "30 derniers jours"),
    metric("Absences", perf.absences ?? 0, `${percent(perf.taux_absence)} des RDV aboutis`),
    metric("RDV rappelés", perf.rdv_rappeles ?? 0, "rappel de la veille envoyé"),
    metric("Créneaux repris", perf.creneaux_repris ?? 0, "après une absence"),
  ]);

  const conversationRows = data.recentConversations.map((conversation) => [
    contactLabel(conversation.leads),
    conversation.channel === "instagram" ? "Instagram" : "WhatsApp",
    badge(conversation.status, STATUS_TONE[conversation.status] ?? "neutral"),
    formatRelative(conversation.last_message_at),
    el("a", { class: "link", href: `#/conversations/${conversation.id}`, text: "Ouvrir" }),
  ]);

  const sortants = el("div", { class: "metrics" }, [
    metric("Avis demandés", perf.avis_demandes ?? 0, "30 derniers jours"),
    metric("Relances", perf.relances_envoyees ?? 0, "après une absence"),
    metric("Réactivations", perf.reactivations_envoyees ?? 0, "leads dormants recontactés"),
  ]);

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Vue d'ensemble" }),

    // Mise en avant : une escalade non traitée est un lead qui attend une
    // réponse humaine. C'est la seule chose qui exige une action immédiate.
    data.openEscalations > 0
      ? el("div", { class: "alert alert--warn" }, [
        el("span", {
          text: `${data.openEscalations} conversation${
            data.openEscalations > 1 ? "s" : ""
          } en attente de votre réponse.`,
        }),
        el("a", { class: "link", href: "#/conversations", text: "Les traiter" }),
      ])
      : null,

    metrics,

    el("h2", { class: "section-title", text: "Assiduité" }),
    assiduite,

    el("h2", { class: "section-title", text: "Ce que l'agent a envoyé de lui-même" }),
    sortants,

    card(
      "Dernières conversations",
      conversationRows.length === 0
        ? empty("Aucune conversation pour l'instant. Connectez Instagram pour recevoir vos premiers leads.")
        : table(["Contact", "Canal", "Statut", "Dernier message", ""], conversationRows),
    ),
  ]);
}
