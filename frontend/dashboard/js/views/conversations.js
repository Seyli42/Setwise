// Conversations : lecture du fil, reprise en main humaine, clôture d'escalade.

import { fetchConversations, fetchMessages, fetchOpenEscalation } from "../api.js";
import { callApi } from "../client.js";
import {
  asyncButton,
  badge,
  card,
  el,
  empty,
  errorBox,
  formatDateTime,
  formatRelative,
  mount,
  successBox,
} from "../dom.js";

const STATUS_TONE = {
  active: "info",
  qualified: "ok",
  escalated: "warn",
  closed: "neutral",
  expired: "neutral",
};

function contactLabel(lead) {
  if (!lead) return "Contact inconnu";
  return lead.full_name || lead.instagram_handle || lead.phone || "Contact inconnu";
}

function selectedId() {
  return location.hash.split("/")[2] ?? null;
}

export async function renderConversations() {
  const conversations = await fetchConversations();
  const detail = el("div", { class: "detail" });

  const list = el(
    "ul",
    { class: "conv-list" },
    conversations.map((conversation) =>
      el("li", { class: "conv-list__item" }, [
        el("a", {
          class: "conv-list__link",
          href: `#/conversations/${conversation.id}`,
          data: { id: conversation.id },
        }, [
          el("span", { class: "conv-list__name", text: contactLabel(conversation.leads) }),
          el("span", { class: "conv-list__meta" }, [
            badge(conversation.status, STATUS_TONE[conversation.status] ?? "neutral"),
            el("span", {
              class: "muted",
              text: ` ${conversation.channel === "instagram" ? "Instagram" : "WhatsApp"} · ${
                formatRelative(conversation.last_message_at)
              }`,
            }),
          ]),
        ]),
      ])
    ),
  );

  async function showDetail() {
    const id = selectedId();
    if (!id) {
      mount(detail, empty("Sélectionnez une conversation."));
      return;
    }

    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) {
      mount(detail, errorBox("Conversation introuvable."));
      return;
    }

    mount(detail, el("p", { class: "loading", text: "Chargement…" }));

    const [messages, escalation] = await Promise.all([
      fetchMessages(id),
      fetchOpenEscalation(id),
    ]);

    mount(detail, buildDetail(conversation, messages, escalation, showDetail));
  }

  globalThis.addEventListener("hashchange", showDetail, { once: true });
  await showDetail();

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Conversations" }),
    el("div", { class: "split" }, [
      el("div", { class: "split__side" }, [
        conversations.length === 0 ? empty("Aucune conversation.") : list,
      ]),
      el("div", { class: "split__main" }, [detail]),
    ]),
  ]);
}

function buildDetail(conversation, messages, escalation, refresh) {
  const feedback = el("div", { class: "feedback" });

  const thread = el(
    "div",
    { class: "thread" },
    messages.length === 0 ? [empty("Aucun message.")] : messages.map((message) =>
      el("div", {
        class: `bubble bubble--${message.direction === "inbound" ? "in" : "out"}`,
      }, [
        // `text` passe par textContent : un lead qui envoie du HTML voit son
        // message affiché tel quel, il n'est jamais interprété.
        el("p", { class: "bubble__text", text: message.content }),
        el("span", {
          class: "bubble__meta",
          text: `${senderLabel(message.sender_type)} · ${formatDateTime(message.created_at)}`,
        }),
      ])
    ),
  );

  const windowOpen = !conversation.messaging_window_expires_at ||
    Date.parse(conversation.messaging_window_expires_at) > Date.now();

  const input = el("textarea", {
    rows: 3,
    placeholder: windowOpen
      ? "Votre message…"
      : "Fenêtre de 24 h fermée : cette personne doit d'abord vous répondre.",
    disabled: !windowOpen,
  });

  const send = asyncButton("Envoyer", async () => {
    mount(feedback);
    const text = input.value.trim();
    if (!text) {
      mount(feedback, errorBox("Le message est vide."));
      return;
    }

    try {
      await callApi("send_human_message", { conversation_id: conversation.id, text });
      input.value = "";
      await refresh();
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Envoi…" });

  if (!windowOpen) send.disabled = true;

  return el("div", {}, [
    card(
      contactLabel(conversation.leads),
      el("p", { class: "muted" }, [
        badge(conversation.status, STATUS_TONE[conversation.status] ?? "neutral"),
        el("span", {
          text: ` ${conversation.channel === "instagram" ? "Instagram" : "WhatsApp"}`,
        }),
      ]),

      escalation
        ? el("div", { class: "alert alert--warn" }, [
          el("span", { text: `Reprise demandée : ${escalation.reason}` }),
          asyncButton("Rendre la main à l'agent", async () => {
            mount(feedback);
            try {
              await callApi("resolve_escalation", { escalation_id: escalation.id });
              mount(feedback, successBox("L'agent reprend cette conversation."));
              await refresh();
            } catch (error) {
              mount(feedback, errorBox(error.message));
            }
          }, { class: "btn btn--small", busyLabel: "…" }),
        ])
        : null,

      thread,
      el("div", { class: "composer" }, [input, send]),
      feedback,
    ),
  ]);
}

function senderLabel(senderType) {
  if (senderType === "lead") return "Client";
  if (senderType === "human") return "Vous";
  return "Agent";
}
