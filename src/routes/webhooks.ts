// Handlers de webhooks pour Meta (Instagram, WhatsApp) et Stripe (Neon).

import { createMetaWebhookHandler } from "../_shared/webhookHandler.ts";
import { parseInstagramWebhook } from "../_shared/channels/instagram.ts";
import { parseWhatsAppWebhook } from "../_shared/channels/whatsapp.ts";
import { syncSubscription } from "../_shared/billing.ts";
import { log } from "../_shared/logger.ts";
import { requireEnv } from "../_shared/env.ts";
import { stripe, type Stripe } from "../_shared/stripe.ts";

export const handleInstagramWebhook = createMetaWebhookHandler({
  source: "instagram",
  parse: parseInstagramWebhook,
});

export const handleWhatsAppWebhook = createMetaWebhookHandler({
  source: "whatsapp",
  parse: parseWhatsAppWebhook,
});

export async function handleStripeWebhook(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    log.warn("stripe.missing_signature", {});
    return new Response("Signature manquante", { status: 400 });
  }

  const rawBody = await req.text();
  let event: Stripe.Event;

  try {
    event = await stripe().webhooks.constructEventAsync(
      rawBody,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch (err) {
    log.warn("stripe.invalid_signature", { error: String(err) });
    return new Response("Signature Stripe invalide", { status: 400 });
  }

  log.info("stripe.event_received", { type: event.type, id: event.id });

  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed": {
        const subscription = event.data.object as Stripe.Subscription;
        await syncSubscription(subscription);
        break;
      }

      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.subscription) {
          const subId = typeof session.subscription === "string"
            ? session.subscription
            : session.subscription.id;
          const sub = await stripe().subscriptions.retrieve(subId);
          await syncSubscription(sub);
        }
        break;
      }

      case "invoice.paid":
      case "invoice.payment_failed": {
        const invoice = event.data.object as unknown as { subscription?: string | { id?: string } };
        const rawSub = invoice.subscription;
        const subId = typeof rawSub === "string" ? rawSub : rawSub?.id;
        if (subId) {
          const sub = await stripe().subscriptions.retrieve(subId);
          await syncSubscription(sub);
        }
        break;
      }

      default:
        // Types ignorés sans erreur
        break;
    }

    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    log.error("stripe.handler_failed", { type: event.type, error: String(error) });
    return new Response("Internal Server Error", { status: 500 });
  }
}
