// Rendez-vous pris par l'agent.

import { fetchAppointments, markNoShow } from "../api.js";
import { csvFilename, downloadCsv, toCsv } from "../csv.js";
import {
  asyncButton,
  badge,
  card,
  el,
  empty,
  errorBox,
  formatLong,
  mount,
  successBox,
  table,
} from "../dom.js";

const STATUS_TONE = {
  pending: "warn",
  confirmed: "ok",
  cancelled: "neutral",
  no_show: "warn",
  completed: "neutral",
};

const STATUS_LABEL = {
  pending: "à confirmer",
  confirmed: "confirmé",
  cancelled: "annulé",
  no_show: "absence",
  completed: "honoré",
};

function toRow(appointment) {
  return [
    appointment.starts_at,
    appointment.ends_at,
    appointment.leads?.full_name ?? "",
    appointment.leads?.phone ?? "",
    appointment.service_type ?? "",
    STATUS_LABEL[appointment.status] ?? appointment.status,
    appointment.reminder_sent_at ?? "",
  ];
}

export async function renderAppointments() {
  const body = el("div", {});
  const feedback = el("div", { class: "feedback" });
  let current = [];
  const toggle = el("select", { class: "select" });
  toggle.append(el("option", { value: "upcoming", text: "À venir" }));
  toggle.append(el("option", { value: "past", text: "Passés" }));
  toggle.addEventListener("change", () => load(toggle.value === "upcoming"));

  async function load(upcoming) {
    mount(body, el("p", { class: "loading", text: "Chargement…" }));
    const appointments = await fetchAppointments({ upcoming });
    current = appointments;

    if (appointments.length === 0) {
      mount(body, empty(upcoming ? "Aucun rendez-vous à venir." : "Aucun rendez-vous passé."));
      return;
    }

    const rows = appointments.map((appointment) => [
      formatLong(appointment.starts_at),
      appointment.leads?.full_name || appointment.leads?.phone || "—",
      appointment.service_type || "—",
      badge(
        STATUS_LABEL[appointment.status] ?? appointment.status,
        STATUS_TONE[appointment.status] ?? "neutral",
      ),
      appointment.reminder_sent_at ? "envoyé" : "—",
      ["confirmed", "completed"].includes(appointment.status)
        ? asyncButton("Absence", async () => {
          mount(feedback);
          const label = appointment.leads?.full_name || "cette personne";
          if (!globalThis.confirm(
            `Signaler que ${label} n'est pas venue ?\n\n` +
              "Votre agent lui proposera de reprendre un créneau.",
          )) return;

          try {
            await markNoShow(appointment.id);
            mount(feedback, successBox("Absence enregistrée. L'agent de relance prend le relais."));
            await load(upcoming);
          } catch (error) {
            mount(feedback, errorBox(error.message));
          }
        }, { class: "btn btn--small btn--danger", busyLabel: "…" })
        : el("span", { class: "muted", text: "—" }),
    ]);

    mount(body, table(["Date", "Client", "Prestation", "Statut", "Rappel", ""], rows));
  }

  await load(true);

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Rendez-vous" }),
    card(
      null,
      el("div", { class: "toolbar" }, [
        el("span", { class: "muted", text: "Afficher :" }),
        toggle,
        asyncButton("Exporter en CSV", () => {
          if (current.length === 0) {
            mount(feedback, errorBox("Rien à exporter pour cette période."));
            return;
          }
          downloadCsv(
            csvFilename("rendez-vous"),
            toCsv(
              ["Début", "Fin", "Client", "Téléphone", "Prestation", "Statut", "Rappel envoyé le"],
              current.map(toRow),
            ),
          );
          mount(feedback, successBox(`${current.length} rendez-vous exporté(s).`));
        }, { class: "btn btn--small btn--ghost" }),
      ]),
      // Un RDV « à confirmer » signale une réservation dont l'écriture dans
      // Google Calendar a échoué : il exige une action manuelle.
      el("p", {
        class: "muted",
        text: "Un rendez-vous « à confirmer » n'a pas pu être écrit dans votre agenda : " +
          "vérifiez-le manuellement. Les rendez-vous passés sont considérés honorés " +
          "automatiquement — signalez uniquement les absences.",
      }),
      feedback,
      body,
    ),
  ]);
}
