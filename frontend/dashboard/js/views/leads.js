// Leads : consultation et droit à l'oubli.

import { fetchLeads, forgetLead } from "../api.js";
import { csvFilename, downloadCsv, toCsv } from "../csv.js";
import {
  asyncButton,
  badge,
  card,
  el,
  empty,
  errorBox,
  formatDateTime,
  mount,
  successBox,
  table,
} from "../dom.js";

const STATUS_TONE = {
  new: "info",
  qualified: "ok",
  booked: "ok",
  disqualified: "neutral",
};

const FILTERS = [
  { value: "", label: "Tous" },
  { value: "new", label: "Nouveaux" },
  { value: "qualified", label: "Qualifiés" },
  { value: "booked", label: "Avec RDV" },
  { value: "disqualified", label: "Disqualifiés" },
];

function summarize(qualificationData) {
  const entries = Object.entries(qualificationData ?? {});
  if (entries.length === 0) return "—";
  return entries.map(([key, value]) => `${key} : ${value}`).join(" · ");
}

// Colonnes de l'export. Les leads anonymisés y figurent aussi, avec leurs
// champs vides : les faire disparaître donnerait un décompte différent de celui
// affiché à l'écran, et ferait douter de l'export.
function toRow(lead) {
  const anonymized = Boolean(lead.deleted_at);
  return [
    lead.created_at,
    anonymized ? "" : (lead.full_name ?? ""),
    anonymized ? "" : (lead.phone ?? ""),
    anonymized ? "" : (lead.instagram_handle ?? ""),
    lead.source,
    lead.status,
    anonymized ? "supprimé" : summarize(lead.qualification_data),
  ];
}

export async function renderLeads() {
  const container = el("div", {});
  const feedback = el("div", { class: "feedback" });
  const body = el("div", {});
  let current = [];

  const filter = el("select", { class: "select" });
  for (const option of FILTERS) {
    filter.append(el("option", { value: option.value, text: option.label }));
  }
  filter.addEventListener("change", () => load(filter.value || null));

  async function load(status) {
    mount(body, el("p", { class: "loading", text: "Chargement…" }));
    const leads = await fetchLeads({ status });
    current = leads;

    if (leads.length === 0) {
      mount(body, empty("Aucun lead pour ce filtre."));
      return;
    }

    const rows = leads.map((lead) => {
      const anonymized = Boolean(lead.deleted_at);

      return [
        anonymized ? el("em", { class: "muted", text: "Données supprimées" })
          : (lead.full_name || lead.instagram_handle || lead.phone || "—"),
        lead.source === "instagram" ? "Instagram" : "WhatsApp",
        badge(lead.status, STATUS_TONE[lead.status] ?? "neutral"),
        summarize(lead.qualification_data),
        formatDateTime(lead.created_at),
        anonymized ? el("span", { class: "muted", text: "—" }) : asyncButton(
          "Oublier",
          async () => {
            mount(feedback);
            // Action irréversible : confirmation explicite avant d'anonymiser.
            const label = lead.full_name || lead.instagram_handle || lead.phone || "ce lead";
            if (!globalThis.confirm(
              `Supprimer définitivement les données de ${label} ?\n\n` +
                "Nom, téléphone, réponses et contenu des messages seront effacés. " +
                "Les statistiques et les rendez-vous sont conservés. Cette action est irréversible.",
            )) return;

            try {
              await forgetLead(lead.id);
              mount(feedback, successBox("Données supprimées."));
              await load(filter.value || null);
            } catch (error) {
              mount(feedback, errorBox(error.message));
            }
          },
          { class: "btn btn--small btn--danger", busyLabel: "…" },
        ),
      ];
    });

    mount(
      body,
      table(["Contact", "Source", "Statut", "Qualification", "Reçu le", "RGPD"], rows),
    );
  }

  await load(null);

  mount(
    container,
    el("h1", { class: "page-title", text: "Leads" }),
    card(
      null,
      el("div", { class: "toolbar" }, [
        el("span", { class: "muted", text: "Filtrer :" }),
        filter,
        // Exporte ce qui est affiché, filtre compris — un export qui ne
        // correspond pas à l'écran est un export dont on se méfie.
        asyncButton("Exporter en CSV", () => {
          if (current.length === 0) {
            mount(feedback, errorBox("Rien à exporter pour ce filtre."));
            return;
          }
          downloadCsv(
            csvFilename("leads"),
            toCsv(
              ["Reçu le", "Nom", "Téléphone", "Instagram", "Source", "Statut", "Qualification"],
              current.map(toRow),
            ),
          );
          mount(feedback, successBox(`${current.length} lead(s) exporté(s).`));
        }, { class: "btn btn--small btn--ghost" }),
      ]),
      feedback,
      body,
    ),
  );

  return container;
}
