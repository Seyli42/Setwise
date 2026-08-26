// État de facturation d'un institut et synchronisation depuis Stripe (Neon).
//
// La décision « l'agent tourne ou non » vient d'une seule fonction SQL
// (`tenant_billing_state`), partagée avec le dashboard. Rien n'est recalculé
// ici : une seconde implémentation finirait par diverger, et la divergence se
// paierait soit en service rendu gratuitement, soit en institut coupé à tort.

import { sql } from "../db.ts";
import { DatabaseError } from "./errors.ts";
import { log } from "./logger.ts";
import { stripe, stripeError, type Stripe } from "./stripe.ts";

export interface BillingState {
  active: boolean;
  status: string;
  plan: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  reason: string;
}

export async function getBillingState(tenantId: string): Promise<BillingState> {
  try {
    const rows = await sql`
      select tenant_billing_state(${tenantId}::uuid) as state;
    `;

    if (rows.length === 0) {
      throw new DatabaseError("Lecture de l'état de facturation échouée : aucune ligne retournée");
    }

    const state = (rows[0].state ?? {}) as Record<string, unknown>;
    return {
      active: state.active === true,
      status: String(state.status ?? "unknown"),
      plan: (state.plan as string) ?? null,
      trialEndsAt: (state.trial_ends_at as string) ?? null,
      currentPeriodEnd: (state.current_period_end as string) ?? null,
      cancelAtPeriodEnd: state.cancel_at_period_end === true,
      reason: String(state.reason ?? ""),
    };
  } catch (error) {
    throw new DatabaseError("Lecture de l'état de facturation échouée", { cause: error });
  }
}

// ============================================================
// Synchronisation depuis Stripe
// ============================================================

/**
 * Reflète un abonnement Stripe dans la base.
 *
 * Stripe est la source de vérité : on ne déduit jamais un statut d'un
 * enchaînement d'events (ils arrivent dans le désordre et peuvent être rejoués).
 * On lit l'objet `subscription` tel que Stripe le donne, et on l'écrit tel quel.
 */
export async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id;
  if (!tenantId) {
    // Sans `tenant_id` dans les métadonnées, l'abonnement n'est rattachable à
    // aucun institut. On le signale plutôt que de le rattacher au hasard.
    log.error("billing.subscription_without_tenant", { subscriptionId: subscription.id });
    return;
  }

  const item = subscription.items?.data?.[0];
  const priceId = item?.price?.id ?? null;

  try {
    let planId = subscription.metadata?.plan ?? "inconnu";
    if (priceId) {
      const planRows = await sql`select id from plans where stripe_price_id = ${priceId} limit 1;`;
      if (planRows.length > 0) planId = planRows[0].id;
    }

    const currentPeriodEnd = toIso(item?.current_period_end ?? null);
    const trialEnd = toIso(subscription.trial_end);
    const cancelAtPeriodEnd = subscription.cancel_at_period_end === true;
    const terminatedAt = ["canceled", "incomplete_expired"].includes(subscription.status)
      ? new Date().toISOString()
      : null;

    await sql`
      insert into subscriptions (
        tenant_id,
        stripe_subscription_id,
        stripe_price_id,
        plan,
        status,
        current_period_end,
        trial_end,
        cancel_at_period_end,
        terminated_at,
        updated_at
      ) values (
        ${tenantId}::uuid,
        ${subscription.id},
        ${priceId},
        ${planId},
        ${subscription.status},
        ${currentPeriodEnd},
        ${trialEnd},
        ${cancelAtPeriodEnd},
        ${terminatedAt},
        now()
      )
      on conflict (tenant_id) do update set
        stripe_subscription_id = excluded.stripe_subscription_id,
        stripe_price_id = excluded.stripe_price_id,
        plan = excluded.plan,
        status = excluded.status,
        current_period_end = excluded.current_period_end,
        trial_end = excluded.trial_end,
        cancel_at_period_end = excluded.cancel_at_period_end,
        terminated_at = case
          when excluded.status in ('canceled', 'incomplete_expired') then coalesce(subscriptions.terminated_at, now())
          else null
        end,
        updated_at = now();
    `;

    await sql`
      update tenants
         set plan = ${planId}
       where id = ${tenantId}::uuid;
    `;

    log.info("billing.subscription_synced", {
      tenantId,
      status: subscription.status,
      plan: planId,
    });
  } catch (error) {
    throw new DatabaseError("Synchronisation de l'abonnement échouée", { cause: error });
  }
}

function toIso(unixSeconds: number | null | undefined): string | null {
  return typeof unixSeconds === "number" ? new Date(unixSeconds * 1000).toISOString() : null;
}

/**
 * Rattache un identifiant client Stripe à l'institut, ou renvoie celui déjà
 * enregistré. Créer un second client pour le même institut dupliquerait ses
 * moyens de paiement et son historique de factures.
 */
export async function ensureStripeCustomer(params: {
  tenantId: string;
  email: string;
  tenantName: string;
}): Promise<string> {
  try {
    const existing = await sql`
      select stripe_customer_id from tenants where id = ${params.tenantId}::uuid limit 1;
    `;

    if (existing.length > 0 && existing[0].stripe_customer_id) {
      return existing[0].stripe_customer_id;
    }

    const customer = await stripe().customers.create({
      email: params.email,
      name: params.tenantName,
      metadata: { tenant_id: params.tenantId },
    });

    await sql`
      update tenants
         set stripe_customer_id = ${customer.id}
       where id = ${params.tenantId}::uuid;
    `;

    return customer.id;
  } catch (cause) {
    if (cause instanceof DatabaseError) throw cause;
    throw stripeError("création du client", cause);
  }
}
