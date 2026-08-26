// Abonnement : état, choix de formule SetSmart, portail Stripe (Neon).

import { apiFetch, callApi, isOwner } from "../client.js";
import {
  asyncButton,
  badge,
  card,
  el,
  errorBox,
  formatDateTime,
  mount,
  table,
} from "../dom.js";

const STATUS_TONE = {
  trial: "info",
  trialing: "info",
  active: "ok",
  past_due: "warn",
  trial_expired: "warn",
  unpaid: "warn",
  canceled: "warn",
  paused: "warn",
};

const STATUS_LABEL = {
  trial: "essai gratuit",
  trialing: "essai en cours",
  active: "actif",
  past_due: "paiement en attente",
  trial_expired: "essai terminé",
  unpaid: "impayé",
  canceled: "résilié",
  incomplete: "paiement non finalisé",
  incomplete_expired: "paiement expiré",
  paused: "en pause",
};

function formatPrice(cents, currency) {
  return new Intl.NumberFormat("fr-FR", {
    style: "currency",
    currency: (currency ?? "eur").toUpperCase(),
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export async function renderBilling() {
  const feedback = el("div", { class: "feedback" });

  const billingData = await apiFetch("/api/billing/state");
  const billing = billingData.billing ?? {};
  const plans = billingData.plans ?? [];

  const returnUrl = location.origin + location.pathname;

  const statusCard = card(
    "Votre abonnement",
    el("p", {}, [
      badge(STATUS_LABEL[billing.status] ?? billing.status, STATUS_TONE[billing.status] ?? "neutral"),
      billing.plan ? el("span", { text: ` Formule ${billing.plan.toUpperCase()}` }) : null,
    ]),
    el("p", { class: "muted", text: billing.reason }),

    billing.trial_ends_at && !billing.current_period_end
      ? el("p", { class: "muted", text: `Essai jusqu'au ${formatDateTime(billing.trial_ends_at)}.` })
      : null,
    billing.current_period_end
      ? el("p", {
        class: "muted",
        text: billing.cancel_at_period_end
          ? `Prend fin le ${formatDateTime(billing.current_period_end)}.`
          : `Prochain prélèvement le ${formatDateTime(billing.current_period_end)}.`,
      })
      : null,

    isOwner()
      ? asyncButton("Gérer mon abonnement (Factures, CB)", async () => {
        mount(feedback);
        try {
          const { url } = await callApi("create_billing_portal", { return_url: returnUrl });
          location.href = url;
        } catch (error) {
          mount(feedback, errorBox(error.message));
        }
      }, { class: "btn btn--ghost", busyLabel: "Ouverture…" })
      : el("p", { class: "muted", text: "Seul le propriétaire du compte gère l'abonnement." }),
  );

  const suspensionAlert = !billing.active
    ? el("div", { class: "alert alert--warn" }, [
      el("span", {
        text: "Votre agent est suspendu : les nouveaux messages ne recevront aucune réponse automatique. Choisissez une formule ci-dessous pour le réactiver.",
      }),
    ])
    : null;

  const planRows = plans.map((plan) => [
    el("div", {}, [
      el("strong", { text: plan.name }),
      plan.trial_days > 0 ? el("span", { class: "badge badge--info", text: ` ${plan.trial_days}j d'essai` }) : null,
      plan.description ? el("p", { class: "muted", text: plan.description }) : null,
    ]),
    `${formatPrice(plan.monthly_price_cents, plan.currency)} / mois`,
    isOwner()
      ? asyncButton(
        billing.plan === plan.id ? "Formule actuelle" : (plan.trial_days > 0 ? "Essai gratuit 7j" : "Choisir"),
        async () => {
          mount(feedback);
          try {
            const { url } = await callApi("create_checkout_session", {
              plan_id: plan.id,
              success_url: `${returnUrl}#/billing`,
              cancel_url: `${returnUrl}#/billing`,
            });
            location.href = url;
          } catch (error) {
            mount(feedback, errorBox(error.message));
          }
        },
        { class: billing.plan === plan.id ? "btn btn--ghost btn--small" : "btn btn--small", busyLabel: "…" },
      )
      : el("span", { class: "muted", text: "—" }),
  ]);

  return el("div", {}, [
    el("h1", { class: "page-title", text: "Abonnement" }),
    suspensionAlert,
    statusCard,
    card(
      "Formules d'abonnement",
      table(["Formule & Quota", "Tarif", ""], planRows),
      el("p", {
        class: "muted",
        text: "Paiement sécurisé par Stripe. Sans engagement, annulable à tout moment en 1 clic.",
      }),
    ),
    feedback,
  ]);
}
