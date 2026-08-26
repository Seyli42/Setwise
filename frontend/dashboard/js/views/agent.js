// Configuration de l'agent : script de qualification, horaires, prestations.
//
// C'est la page qui rend la promesse « paramétrable sans redéploiement »
// concrète. Tout ce qui est saisi ici part en base et s'applique au message
// suivant.

import { fetchAgent, saveAgent, saveScript } from "../api.js";
import {
  duplicateFields,
  intervalsToText,
  keywordsToText,
  questionsToText,
  servicesToText,
  textToIntervals,
  textToKeywords,
  textToQuestions,
  textToServices,
} from "../parse.js";
import {
  asyncButton,
  card,
  el,
  errorBox,
  field,
  mount,
  successBox,
} from "../dom.js";

const DAYS = [
  ["mon", "Lundi"],
  ["tue", "Mardi"],
  ["wed", "Mercredi"],
  ["thu", "Jeudi"],
  ["fri", "Vendredi"],
  ["sat", "Samedi"],
  ["sun", "Dimanche"],
];

export async function renderAgent() {
  const loaded = await fetchAgent();

  if (!loaded?.agent) {
    return card(
      "Agent",
      errorBox("Aucun agent de qualification trouvé pour cet institut."),
    );
  }

  const { agent, script } = loaded;
  const config = agent.config ?? {};
  const scheduling = config.scheduling ?? {};
  const feedback = el("div", { class: "feedback" });

  // --- Persona et messages ------------------------------------------------
  const promptInput = el("textarea", { rows: 5, value: agent.system_prompt_template ?? "" });
  const handoffInput = el("input", { type: "text", value: config.handoff_message ?? "" });
  const confirmTemplateInput = el("input", {
    type: "text",
    value: config.whatsapp_confirmation_template ?? "",
  });
  const reminderTemplateInput = el("input", {
    type: "text",
    value: config.whatsapp_reminder_template ?? "",
  });

  // --- Horaires -----------------------------------------------------------
  const dayInputs = new Map();
  const hoursFields = DAYS.map(([key, label]) => {
    const input = el("input", {
      type: "text",
      value: intervalsToText(scheduling.business_hours?.[key]),
      placeholder: "09:00-12:00, 14:00-19:00",
    });
    dayInputs.set(key, input);
    return field(label, input);
  });

  // --- Prestations et règles ---------------------------------------------
  const servicesInput = el("textarea", {
    rows: 6,
    value: servicesToText(scheduling.services),
    placeholder: "Épilation laser jambes entières : 45",
  });
  const defaultDurationInput = el("input", {
    type: "number",
    value: String(scheduling.default_duration_min ?? 60),
  });
  const granularityInput = el("input", {
    type: "number",
    value: String(scheduling.slot_granularity_min ?? 30),
  });
  const noticeInput = el("input", {
    type: "number",
    value: String(scheduling.min_notice_hours ?? 4),
  });
  const horizonInput = el("input", {
    type: "number",
    value: String(scheduling.max_days_ahead ?? 14),
  });

  // --- Script -------------------------------------------------------------
  const questionsInput = el("textarea", {
    rows: 8,
    value: questionsToText(script?.questions),
    placeholder: "prestation | Quelle prestation vous intéresse ?",
  });
  const keywordsInput = el("textarea", {
    rows: 4,
    value: keywordsToText(script?.escalation_keywords),
  });

  const saveButton = asyncButton("Enregistrer", async () => {
    mount(feedback);

    const questions = textToQuestions(questionsInput.value);
    if (questions.length === 0) {
      mount(feedback, errorBox("Le script doit contenir au moins une question."));
      return;
    }

    const duplicates = duplicateFields(questions);
    if (duplicates.length > 0) {
      // Deux questions sur le même champ : la seconde réponse écraserait la
      // première sans que le gérant comprenne pourquoi.
      mount(feedback, errorBox(`Champ utilisé deux fois : ${duplicates.join(", ")}.`));
      return;
    }

    const businessHours = {};
    for (const [key] of DAYS) businessHours[key] = textToIntervals(dayInputs.get(key).value);

    try {
      await saveAgent(agent.id, {
        system_prompt_template: promptInput.value,
        config: {
          ...config,
          handoff_message: handoffInput.value.trim() || undefined,
          whatsapp_confirmation_template: confirmTemplateInput.value.trim() || undefined,
          whatsapp_reminder_template: reminderTemplateInput.value.trim() || undefined,
          scheduling: {
            business_hours: businessHours,
            services: textToServices(servicesInput.value),
            default_duration_min: Number(defaultDurationInput.value) || 60,
            slot_granularity_min: Number(granularityInput.value) || 30,
            min_notice_hours: Number(noticeInput.value) || 0,
            max_days_ahead: Number(horizonInput.value) || 14,
          },
        },
      });

      await saveScript(agent.id, script?.version ?? 0, {
        questions,
        budget_rules: script?.budget_rules ?? {},
        escalation_keywords: textToKeywords(keywordsInput.value),
      });

      mount(feedback, successBox("Enregistré. La modification s'applique au prochain message."));
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Enregistrement…" });

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Mon agent" }),

    card(
      "Ton et consignes",
      field(
        "Consignes données à l'agent",
        promptInput,
        "Variables disponibles : {{institut}}, {{etablissement}}, {{prenom_lead}}.",
      ),
      field(
        "Message de transfert à l'équipe",
        handoffInput,
        "Envoyé au client au moment où l'agent passe la main. Laisser vide pour le message par défaut.",
      ),
    ),

    card(
      "Script de qualification",
      field(
        "Questions, une par ligne",
        questionsInput,
        "Format : nom_du_champ | question posée au client. L'ordre des lignes est l'ordre des questions.",
      ),
      field(
        "Mots-clés de transfert immédiat",
        keywordsInput,
        "Séparés par des virgules. Détectés avant toute réponse automatique, sans tenir compte des accents.",
      ),
      el("p", {
        class: "muted",
        text: "Chaque enregistrement crée une nouvelle version du script. Les conversations " +
          "en cours ne changent pas de règles en cours de route.",
      }),
    ),

    card(
      "Horaires d'ouverture",
      el("p", { class: "muted", text: "Heure locale de l'établissement. Laisser vide pour un jour de fermeture." }),
      ...hoursFields,
    ),

    card(
      "Prestations et créneaux",
      field(
        "Prestations et durées, une par ligne",
        servicesInput,
        "Format : nom de la prestation : durée en minutes.",
      ),
      field("Durée par défaut (min)", defaultDurationInput, "Utilisée si la prestation n'est pas reconnue."),
      field("Pas des créneaux (min)", granularityInput, "30 propose les créneaux à :00 et :30."),
      field("Délai minimum avant RDV (h)", noticeInput, "Aucun créneau proposé en deçà."),
      field("Horizon de réservation (jours)", horizonInput),
    ),

    card(
      "Modèles WhatsApp",
      el("p", {
        class: "muted",
        text: "Noms des modèles approuvés par Meta. Variables attendues : {{1}} prénom, " +
          "{{2}} date et heure, {{3}} prestation.",
      }),
      field("Modèle de confirmation", confirmTemplateInput),
      field("Modèle de rappel J-1", reminderTemplateInput),
    ),

    el("div", { class: "sticky-actions" }, [saveButton, feedback]),
  ]);
}
