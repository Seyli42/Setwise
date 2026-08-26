// Client Stripe.
//
// `createFetchHttpClient()` est indispensable en Deno : le client HTTP par
// défaut du SDK cible Node et son module `http`. Sans ça, chaque appel échoue
// au démarrage de la fonction.
//
// De même, la vérification de signature doit passer par `constructEventAsync`
// (WebCrypto, asynchrone) et non `constructEvent` (crypto Node, synchrone).

import Stripe from "npm:stripe@^18";
import { requireEnv, optionalEnv } from "./env.ts";
import { ExternalApiError, ValidationError } from "./errors.ts";

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!client) {
    client = new Stripe(requireEnv("STRIPE_SECRET_KEY"), {
      httpClient: Stripe.createFetchHttpClient(),
      apiVersion: optionalEnv("STRIPE_API_VERSION", "2025-05-28.basil") as Stripe.LatestApiVersion,
    });
  }
  return client;
}

/**
 * Vérifie la signature d'un webhook Stripe et renvoie l'event typé.
 *
 * Le corps doit être le texte BRUT reçu : Stripe signe `timestamp.payload`, et
 * un JSON re-sérialisé ne correspondrait plus. La tolérance temporelle (5 min
 * par défaut) bloque le rejeu d'un ancien webhook capté sur le réseau.
 */
export async function verifyStripeEvent(
  rawBody: string,
  signature: string | null,
): Promise<Stripe.Event> {
  if (!signature) throw new ValidationError("En-tête `stripe-signature` absent.");

  try {
    return await stripe().webhooks.constructEventAsync(
      rawBody,
      signature,
      requireEnv("STRIPE_WEBHOOK_SECRET"),
    );
  } catch (cause) {
    throw new ValidationError("Signature Stripe invalide.", { cause: String(cause) });
  }
}

export function stripeError(operation: string, cause: unknown): ExternalApiError {
  const status = (cause as { statusCode?: number })?.statusCode;
  return new ExternalApiError("stripe", `${operation}: ${(cause as Error)?.message ?? cause}`, {
    status,
    cause,
  });
}

export type { Stripe };
