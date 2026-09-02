// Branchement (ou rebranchement) du webhook Stripe sur l'URL du serveur.
//
// Stripe ne devine pas où joindre le service : sans cet endpoint, un
// abonnement payé n'atteint jamais la base et l'institut reste coupé alors
// qu'il a payé. Le script est rejouable : s'il retrouve un endpoint Setwise
// existant, il en corrige l'URL et la liste d'événements au lieu d'en créer
// un second qui doublerait chaque notification.
//
// Le secret de signature (`whsec_...`) n'est renvoyé en clair QU'À LA
// CRÉATION. Sur une mise à jour, Stripe ne le redonne pas : le script le dit
// franchement plutôt que d'écrire un secret faux dans la configuration.
//
// Usage :
//   deno task stripe:webhook -- --url=https://xxx.deno.dev

import Stripe from "npm:stripe@^17.6.0";

const ÉVÉNEMENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "checkout.session.completed",
  "invoice.paid",
  "invoice.payment_failed",
] as const;

function arg(nom: string): string | undefined {
  const p = `--${nom}=`;
  return Deno.args.find((a) => a.startsWith(p))?.slice(p.length);
}

const base = (arg("url") ?? "").replace(/\/+$/, "");
if (!/^https:\/\/.+/.test(base)) {
  console.error("❌ --url=https://... est obligatoire (URL publique du serveur).");
  Deno.exit(1);
}
const cible = `${base}/webhooks/stripe`;

const clé = Deno.env.get("STRIPE_SECRET_KEY");
if (!clé) {
  console.error("❌ STRIPE_SECRET_KEY manquante.");
  Deno.exit(1);
}

const stripe = new Stripe(clé, { apiVersion: "2025-01-27.acacia" as Stripe.LatestApiVersion });

try {
  const existants = await stripe.webhookEndpoints.list({ limit: 100 });
  const ancien = existants.data.find((e) => e.url.includes("/webhooks/stripe"));

  if (ancien) {
    await stripe.webhookEndpoints.update(ancien.id, {
      url: cible,
      enabled_events: [...ÉVÉNEMENTS] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[],
      description: "Setwise — abonnements et paiements",
    });
    console.log(`✅ Endpoint existant mis à jour : ${ancien.id}`);
    console.log(`   URL : ${cible}`);
    console.log(`\n⚠️  Stripe ne redonne pas le secret de signature d'un endpoint existant.`);
    console.log(`   Si STRIPE_WEBHOOK_SECRET n'est pas déjà le bon, récupère-le ici :`);
    console.log(`   https://dashboard.stripe.com/webhooks/${ancien.id}`);
  } else {
    const créé = await stripe.webhookEndpoints.create({
      url: cible,
      enabled_events: [...ÉVÉNEMENTS] as Stripe.WebhookEndpointCreateParams.EnabledEvent[],
      description: "Setwise — abonnements et paiements",
    });
    console.log(`✅ Endpoint créé : ${créé.id}`);
    console.log(`   URL : ${cible}`);
    console.log(`\n🔑 STRIPE_WEBHOOK_SECRET="${créé.secret}"`);
    console.log(`   (à copier dans .env ET dans les variables du serveur déployé)`);
  }

  console.log(`\n📋 Événements écoutés :\n   ${ÉVÉNEMENTS.join("\n   ")}`);
} catch (error) {
  console.error("❌ Échec :", error instanceof Error ? error.message : error);
  Deno.exit(1);
}
