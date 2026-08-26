// Configuration visuelle et interactive de l'agent IA (Générateur automatique de Prompt).

import { fetchAgent, saveAgent, saveScript } from "../api.js";
import { asyncButton, badge, card, el, errorBox, field, mount, successBox } from "../dom.js";

const TONES = [
  {
    id: "chaleureux",
    title: "🌸 Chaleureux & Doux",
    desc: "Vouvoiement bienveillant, ton cocooning et attentionné. Idéal spas et instituts de beauté.",
    promptPart: "Adopte un ton très chaleureux, doux et bienveillant, comme une esthéticienne passionnée et accueillante.",
  },
  {
    id: "prestige",
    title: "💎 Prestige & Élégant",
    desc: "Vouvoiement raffiné, vocabulaire soigné et prestigieux. Idéal cliniques et centres VIP.",
    promptPart: "Adopte un ton élégant, courtois et prestigieux, digne d'un établissement haut de gamme.",
  },
  {
    id: "dynamique",
    title: "⚡ Direct & Efficace",
    desc: "Court, dynamique et va droit au but vers la réservation. Idéal centres d'épilation et minceur.",
    promptPart: "Sois concise, directe et dynamique. Réponds en 1 à 2 phrases percutantes et oriente vite vers le créneau.",
  },
  {
    id: "expert",
    title: "🩺 Expert & Rassurant",
    desc: "Professionnel, précis sur les soins et très rassurant. Idéal dermatologie et soins experts.",
    promptPart: "Adopte une posture d'experte bienveillante, précise sur les protocoles et rassurante.",
  },
];

const DEFAULT_QUESTIONS = [
  { field: "prestation", prompt: "Quelle prestation souhaitez-vous réaliser ?", enabled: true },
  { field: "zone", prompt: "Pour quelle zone du corps ou du visage ?", enabled: true },
  { field: "disponibilite", prompt: "Quels sont vos jours et créneaux horaires préférés ?", enabled: true },
  { field: "premiere_visite", prompt: "Est-ce votre première visite dans notre institut ?", enabled: false },
  { field: "contre_indications", prompt: "Avez-vous une contre-indication particulière (grossesse, traitement en cours) ?", enabled: true },
];

export async function renderAgent() {
  const loaded = await fetchAgent();

  const feedback = el("div", { class: "feedback" });
  const agent = loaded?.agent ?? { id: "agt-1", name: "Assistante IA" };
  const config = agent.config ?? {};
  const scheduling = config.scheduling ?? {};

  // État local du formulaire
  let selectedTone = config.tone_id ?? "chaleureux";
  let assistantName = config.assistant_name ?? "Clara";
  let specialInstructions = config.special_instructions ?? "Mentionner que nous utilisons des cires bio et des lasers de dernière génération.";
  let handoffMessage = config.handoff_message ?? "Je transmets votre demande à notre équipe qui revient vers vous très vite !";

  let questions = (loaded?.script?.questions?.length > 0)
    ? loaded.script.questions.map((q) => ({ field: q.field, prompt: q.prompt, enabled: true }))
    : [...DEFAULT_QUESTIONS];

  let services = (scheduling.services && Object.keys(scheduling.services).length > 0)
    ? Object.entries(scheduling.services).map(([name, s]) => ({ name, duration: (typeof s === "number" ? s : s?.duration_min) || 45, price: (typeof s === "object" ? s?.price : 0) || 60 }))
    : [
      { name: "Épilation laser demi-jambes", duration: 30, price: 90 },
      { name: "Soin Hydra-Facial Éclat", duration: 45, price: 85 },
      { name: "Massage relaxant corps", duration: 60, price: 75 },
    ];

  // 1. Carte Identité & Ton
  const nameInput = el("input", {
    type: "text",
    value: assistantName,
    placeholder: "Ex: Clara, Emma, Sophie...",
    on: { input: (e) => { assistantName = e.target.value; updatePromptPreview(); } },
  });

  const toneGrid = el("div", { style: "display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-top: .75rem;" });

  function renderToneCards() {
    mount(
      toneGrid,
      TONES.map((t) => {
        const isSelected = selectedTone === t.id;
        return el("div", {
          style: `border: 2px solid ${isSelected ? "#000" : "var(--border)"}; background: ${isSelected ? "#f8fafc" : "var(--surface)"}; padding: 1rem; border-radius: 10px; cursor: pointer; transition: all .2s;`,
          on: {
            click: () => {
              selectedTone = t.id;
              renderToneCards();
              updatePromptPreview();
            },
          },
        }, [
          el("strong", { style: "display: block; font-size: 1rem; margin-bottom: .25rem;", text: t.title }),
          el("p", { class: "muted", style: "font-size: .82rem; line-height: 1.35;", text: t.desc }),
        ]);
      }),
    );
  }
  renderToneCards();

  const instructionsInput = el("textarea", {
    rows: 3,
    value: specialInstructions,
    placeholder: "Ex: Nous offrons le diagnostic de peau lors du premier RDV...",
    on: { input: (e) => { specialInstructions = e.target.value; updatePromptPreview(); } },
  });

  // 2. Carte Prestations
  const servicesContainer = el("div", { style: "display: flex; flex-direction: column; gap: .75rem;" });

  function renderServicesList() {
    mount(
      servicesContainer,
      services.map((s, idx) => {
        const nameIn = el("input", {
          type: "text",
          value: s.name,
          placeholder: "Nom de la prestation",
          style: "flex: 2;",
          on: { input: (e) => { s.name = e.target.value; updatePromptPreview(); } },
        });
        const durIn = el("input", {
          type: "number",
          value: String(s.duration),
          placeholder: "Durée (min)",
          style: "flex: 1;",
          on: { input: (e) => { s.duration = Number(e.target.value) || 30; } },
        });
        const delBtn = el("button", {
          type: "button",
          class: "btn btn--ghost btn--small",
          style: "color: #dc2626;",
          text: "Supprimer",
          on: {
            click: () => {
              services.splice(idx, 1);
              renderServicesList();
              updatePromptPreview();
            },
          },
        });
        return el("div", { style: "display: flex; gap: .5rem; align-items: center;" }, [nameIn, durIn, el("span", { class: "muted", text: "min" }), delBtn]);
      }),
    );
  }
  renderServicesList();

  const addServiceBtn = el("button", {
    type: "button",
    class: "btn btn--ghost btn--small",
    style: "margin-top: .5rem; align-self: flex-start;",
    text: "+ Ajouter une prestation",
    on: {
      click: () => {
        services.push({ name: "Nouveau soin", duration: 45, price: 60 });
        renderServicesList();
        updatePromptPreview();
      },
    },
  });

  // 3. Carte Questions de Qualification
  const questionsContainer = el("div", { style: "display: flex; flex-direction: column; gap: .75rem;" });

  function renderQuestionsList() {
    mount(
      questionsContainer,
      questions.map((q, idx) => {
        const check = el("input", {
          type: "checkbox",
          on: {
            change: (e) => {
              q.enabled = e.target.checked;
              updatePromptPreview();
            },
          },
        });
        if (q.enabled) check.checked = true;

        const promptIn = el("input", {
          type: "text",
          value: q.prompt,
          style: "flex: 1;",
          on: { input: (e) => { q.prompt = e.target.value; updatePromptPreview(); } },
        });

        return el("div", { style: "display: flex; gap: .75rem; align-items: center;" }, [
          check,
          el("strong", { style: "font-size: .85rem; width: 110px; color: var(--muted);", text: q.field }),
          promptIn,
        ]);
      }),
    );
  }
  renderQuestionsList();

  // 4. Carte Relais Humain & Sécurité Médicale
  const handoffInput = el("input", {
    type: "text",
    value: handoffMessage,
    on: { input: (e) => { handoffMessage = e.target.value; } },
  });

  // 5. Générateur & Visualiseur de Prompt
  const previewBox = el("pre", {
    style: "background: #0f172a; color: #f8fafc; padding: 1.25rem; border-radius: 8px; font-size: .82rem; line-height: 1.5; max-height: 220px; overflow-y: auto; white-space: pre-wrap; font-family: monospace;",
  });

  function generateCompiledPrompt() {
    const toneObj = TONES.find((t) => t.id === selectedTone) ?? TONES[0];
    const activeQuestions = questions.filter((q) => q.enabled);
    const servicesList = services.map((s) => `- ${s.name} (durée : ${s.duration} min)`).join("\n");

    return `Tu es ${assistantName || "l'assistante"}, l'assistante conversationnelle de {{institut}}.

## PERSONNALITÉ ET TON
${toneObj.promptPart}
${specialInstructions ? `Consignes spécifiques de l'institut : ${specialInstructions}` : ""}

## PRESTATIONS PROPOSÉES
${servicesList || "- Soins et prestations personnalisés"}

## MISSION
1. Réponds chaleureusement aux clientes qui écrivent sur Instagram DM ou WhatsApp.
2. Pose les questions de qualification nécessaires :
${activeQuestions.map((q, i) => `   ${i + 1}. ${q.prompt}`).join("\n")}
3. Propose 2 ou 3 créneaux libres disponibles dans l'agenda et confirme le rendez-vous.

## RÈGLES DE SÉCURITÉ ABSOLUES
- En cas de question médicale (grossesse, allaitement, pathologie, traitement médical lourd), transfère immédiatement à l'équipe sans donner de conseil médical.
- Messages courts (1 à 3 phrases max) adaptés à la messagerie mobile.`;
  }

  function updatePromptPreview() {
    previewBox.textContent = generateCompiledPrompt();
  }
  updatePromptPreview();

  // Bouton Enregistrer & Générer
  const saveBtn = asyncButton("✨ Générer & Enregistrer l'Agent IA", async () => {
    mount(feedback);

    const compiledPrompt = generateCompiledPrompt();
    const activeQuestions = questions.filter((q) => q.enabled).map((q) => ({ field: q.field, prompt: q.prompt }));

    const formattedServices = {};
    for (const s of services) {
      if (s.name.trim()) {
        formattedServices[s.name.trim()] = { duration_min: s.duration, price: s.price };
      }
    }

    try {
      await saveAgent(agent.id, {
        system_prompt_template: compiledPrompt,
        config: {
          ...config,
          assistant_name: assistantName,
          tone_id: selectedTone,
          special_instructions: specialInstructions,
          handoff_message: handoffMessage,
          scheduling: {
            ...scheduling,
            services: formattedServices,
          },
        },
      });

      await saveScript(agent.id, loaded?.script?.version ?? 0, {
        questions: activeQuestions,
        budget_rules: loaded?.script?.budget_rules ?? {},
        escalation_keywords: ["enceinte", "grossesse", "allergie", "traitement", "remboursement", "litige", "douleur", "brulure"],
      });

      mount(feedback, successBox("🎉 Prompt généré et enregistré ! Votre agent DeepSeek utilisera ces nouvelles consignes dès le prochain message."));
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { class: "btn btn--primary", busyLabel: "Génération en cours…" });

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Personnaliser mon Agent IA" }),
    el("p", { class: "muted", style: "margin-bottom: 2rem; margin-top: -.5rem;", text: "Renseignez vos informations ci-dessous. Setwise compile et génère automatiquement le meilleur prompt pour votre institut." }),

    card(
      "1. Identité & Personnalité de l'assistante",
      field("Prénom de l'assistante virtuelle", nameInput, "Le prénom sous lequel l'IA se présente à vos clientes."),
      el("div", { style: "margin-top: 1rem;" }, [
        el("strong", { style: "display: block; font-size: .92rem; margin-bottom: .25rem;", text: "Ton de conversation :" }),
        toneGrid,
      ]),
      field("Consignes particulières ou offres à mettre en avant", instructionsInput, "Ex: technologies utilisées, produits bio, offre découverte..."),
    ),

    card(
      "2. Vos Prestations & Durées",
      el("p", { class: "muted", style: "font-size: .88rem; margin-bottom: 1rem;", text: "L'IA utilise ces durées pour réserver les créneaux adéquats dans votre agenda." }),
      servicesContainer,
      addServiceBtn,
    ),

    card(
      "3. Questions de Qualification posées aux clientes",
      el("p", { class: "muted", style: "font-size: .88rem; margin-bottom: 1rem;", text: "Cochez les questions que l'IA doit poser avant de proposer un créneau de rendez-vous." }),
      questionsContainer,
    ),

    card(
      "4. Sécurité & Relais Humain",
      field("Message envoyé quand l'agent passe la main à l'équipe", handoffInput, "Envoyé automatiquement en cas de question médicale ou réclamation."),
    ),

    card(
      "5. Prompt Système Généré Automatiquement",
      el("p", { class: "muted", style: "font-size: .88rem; margin-bottom: .75rem;", text: "Ce prompt optimisé est injecté directement dans le modèle DeepSeek à chaque conversation." }),
      previewBox,
    ),

    el("div", { class: "sticky-actions", style: "margin-top: 1.5rem;" }, [saveBtn, feedback]),
  ]);
}
