// Réglages de l'institut : alertes et conservation des données.
//
// Deux réglages que la politique de confidentialité et les CGV promettent au
// client. Tant qu'ils n'étaient réglables nulle part, ces documents décrivaient
// un produit qui n'existait pas.

import { fetchTenantSettings, saveTenantSettings } from "../api.js";
import { isOwner } from "../client.js";
import { describeRetention } from "../parse.js";
import { asyncButton, card, el, errorBox, field, mount, successBox } from "../dom.js";

function buildAlertForm(settings, feedback) {
  const emailInput = el("input", {
    type: "email",
    value: settings?.notification_email ?? "",
    placeholder: "gerante@institut.fr",
  });
  const phoneInput = el("input", {
    type: "tel",
    value: settings?.notification_phone ?? "",
    placeholder: "06 12 34 56 78",
  });
  const delayInput = el("input", {
    type: "number",
    value: String(settings?.escalation_reminder_hours ?? 3),
  });

  const save = asyncButton("Enregistrer les alertes", async () => {
    mount(feedback);

    const email = emailInput.value.trim();
    const phone = phoneInput.value.trim();
    if (email && !email.includes("@")) {
      mount(feedback, errorBox("Adresse e-mail invalide."));
      return;
    }

    const hours = Number.parseInt(delayInput.value, 10);
    if (!Number.isFinite(hours) || hours < 1 || hours > 48) {
      mount(feedback, errorBox("Le délai de relance doit être compris entre 1 et 48 heures."));
      return;
    }

    try {
      await saveTenantSettings(settings.id, {
        notification_email: email || null,
        notification_phone: phone || null,
        escalation_reminder_hours: hours,
      });
      mount(
        feedback,
        email || phone
          ? successBox("Alertes enregistrées.")
          : errorBox("Enregistré, mais aucun canal : vous ne serez prévenue de rien."),
      );
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  });

  // Sans canal, l'escalade reste une ligne en base que personne ne voit avant
  // le lendemain. L'avertissement est rouge parce que le risque est réel.
  const configured = Boolean(settings?.notification_email || settings?.notification_phone);

  return card(
    "Alertes",
    el("p", {
      class: configured ? "muted" : "alert alert--error",
      text: configured
        ? "Quand votre agent transfère une conversation, vous êtes prévenue ici. " +
          "Sans réponse de votre part, une relance est envoyée."
        : "Aucun canal d'alerte. Quand votre agent transfère une conversation — " +
          "question médicale, réclamation — personne ne sera prévenu.",
    }),
    field("Adresse e-mail", emailInput, "Laisser vide pour désactiver ce canal."),
    field(
      "Numéro WhatsApp",
      phoneInput,
      "Alerte envoyée depuis votre propre compte WhatsApp Business. Laisser vide pour désactiver.",
    ),
    field(
      "Relancer après (heures)",
      delayInput,
      "Délai au bout duquel une conversation transférée sans réponse déclenche une seconde alerte.",
    ),
    save,
  );
}

function buildRetentionForm(settings, feedback) {
  const current = settings?.data_retention_days ?? 1095;
  const daysInput = el("input", { type: "number", value: String(current) });
  const echo = el("p", { class: "field__hint", text: describeRetention(current) });

  daysInput.addEventListener("input", () => {
    const parsed = Number.parseInt(daysInput.value, 10);
    echo.textContent = Number.isFinite(parsed) ? describeRetention(parsed) : "—";
  });

  const save = asyncButton("Enregistrer la durée", async () => {
    mount(feedback);

    const days = Number.parseInt(daysInput.value, 10);
    if (!Number.isFinite(days) || days < 30 || days > 3650) {
      mount(feedback, errorBox("La durée doit être comprise entre 30 et 3650 jours."));
      return;
    }

    // Réduire la durée déclenche une suppression irréversible dès la nuit
    // suivante : la confirmation n'est pas une politesse.
    if (days < current && !globalThis.confirm(
      `Réduire la conservation de ${current} à ${days} jours ?\n\n` +
        "Les fiches dont le dernier contact est plus ancien seront anonymisées " +
        "dès la prochaine purge, cette nuit. Cette action est irréversible.",
    )) return;

    try {
      await saveTenantSettings(settings.id, { data_retention_days: days });
      mount(feedback, successBox("Durée de conservation enregistrée."));
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  });

  return card(
    "Conservation des données",
    el("p", {
      class: "muted",
      text: "Vos fiches clientes sont anonymisées automatiquement passé ce délai, " +
        "compté à partir du dernier contact — pas de la création de la fiche. " +
        "Les statistiques de l'institut sont conservées.",
    }),
    field(
      "Durée (jours)",
      daysInput,
      "1095 jours par défaut, soit trois ans : la recommandation de la CNIL en " +
        "matière de prospection commerciale.",
    ),
    echo,
    save,
  );
}

export async function renderSettings() {
  const settings = await fetchTenantSettings();

  if (!isOwner()) {
    return el("div", {}, [
      el("h1", { class: "page-title", text: "Réglages" }),
      card(null, el("p", { class: "muted", text: "Réservé au propriétaire du compte." })),
    ]);
  }

  // Un `feedback` par bloc : un message « Alertes enregistrées » qui apparaît
  // sous le formulaire de conservation ferait douter de ce qui a été sauvé.
  const alertFeedback = el("div", { class: "feedback" });
  const retentionFeedback = el("div", { class: "feedback" });

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Réglages" }),
    buildAlertForm(settings, alertFeedback),
    alertFeedback,
    buildRetentionForm(settings, retentionFeedback),
    retentionFeedback,
  ]);
}
