// Fabrique de handler de webhook Meta, partagée par Instagram et WhatsApp.
//
// Contrat avec Meta :
//   GET  → handshake de vérification (renvoyer `hub.challenge` en clair)
//   POST → accuser réception en 200 le plus vite possible. Meta rejoue tout
//          webhook dont la réponse dépasse ~20 s ou renvoie une erreur, donc on
//          ne fait ici que : vérifier la signature, parser, mettre en queue.
//
// Le traitement réel part en tâche de fond APRÈS la réponse. S'il échoue,
// l'event reste `pending` et le cron le rattrape — rien n'est perdu.

import { handleVerificationHandshake, parseWebhookBody, verifyMetaSignature } from "./meta.ts";
import { enqueueInboundEvents, type WebhookSource } from "./queue.ts";
import { processQueue } from "./dispatcher.ts";
import { log } from "./logger.ts";
import { enforceRateLimit, RateLimitError } from "./rateLimit.ts";
import type { ParsedInbound } from "./channels/types.ts";

interface EdgeRuntimeLike {
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Prolonge la vie de la fonction après l'envoi de la réponse. Sur Supabase
 * Edge Runtime c'est `EdgeRuntime.waitUntil` ; en local (`deno run`) l'API
 * n'existe pas et la promesse est simplement laissée courir.
 */
function runAfterResponse(promise: Promise<unknown>): void {
  const guarded = promise.catch((error) => {
    log.error("webhook.background_failed", { error: String(error) });
  });

  const runtime = (globalThis as { EdgeRuntime?: EdgeRuntimeLike }).EdgeRuntime;
  if (typeof runtime?.waitUntil === "function") runtime.waitUntil(guarded);
}

export interface MetaWebhookOptions {
  source: WebhookSource;
  parse: (payload: Record<string, unknown>) => ParsedInbound[];
}

export function createMetaWebhookHandler(
  options: MetaWebhookOptions,
): (req: Request) => Promise<Response> {
  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET") {
      return handleVerificationHandshake(url) ?? new Response("Bad Request", { status: 400 });
    }

    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // Corps BRUT : la signature Meta porte sur ces octets exacts. Reparser puis
    // re-sérialiser invaliderait la vérification.
    const rawBody = await req.text();

    const signatureValid = await verifyMetaSignature(
      rawBody,
      req.headers.get("x-hub-signature-256"),
    );
    if (!signatureValid) {
      log.warn("webhook.invalid_signature", { source: options.source });
      return new Response("Unauthorized", { status: 401 });
    }

    let parsed: ParsedInbound[];
    try {
      parsed = options.parse(parseWebhookBody(rawBody));
    } catch (error) {
      // Payload illisible : renvoyer une erreur ferait rejouer Meta en boucle
      // sur un corps qui ne deviendra jamais valide. On accuse réception et on
      // loggue pour investigation.
      log.error("webhook.unparsable", { source: options.source, error: String(error) });
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    if (parsed.length === 0) {
      // Cas normal et fréquent : accusés de lecture, statuts de livraison,
      // échos de nos propres messages, pièces jointes sans texte.
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    // Plafond par compte Meta expéditeur : la signature HMAC prouve que le
    // POST vient bien de Meta, mais ne borne pas le volume qu'UN compte
    // particulier peut envoyer — un flot de DM sur un seul institut consomme
    // la queue et la facture du modèle pour tous les autres. Vérifié après le
    // parse : c'est le seul moment où l'identifiant du compte est connu.
    //
    // Échec OUVERT : Meta rejoue un webhook en échec, une panne du compteur ne
    // doit jamais transformer une simple limitation en avalanche de retries.
    const comptesExpediteurs = [...new Set(parsed.map((p) => p.event.externalAccountId))];
    const comptesAcceptes = new Set<string>();

    for (const compteId of comptesExpediteurs) {
      try {
        await enforceRateLimit({
          bucket: `webhook:${options.source}:${compteId}`,
          limit: 600,
          windowSeconds: 60,
        });
        comptesAcceptes.add(compteId);
      } catch (error) {
        if (error instanceof RateLimitError) {
          log.warn("webhook.rate_limited", { source: options.source, account: compteId });
          continue;
        }
        throw error;
      }
    }

    const accepted = parsed.filter((p) => comptesAcceptes.has(p.event.externalAccountId));
    if (accepted.length === 0) {
      // Tous les comptes de ce POST sont au plafond : 200 quand même, sinon
      // Meta rejoue le même flot excessif indéfiniment.
      return new Response("EVENT_RECEIVED", { status: 200 });
    }

    try {
      const { enqueued, duplicates } = await enqueueInboundEvents(options.source, accepted);
      log.info("webhook.enqueued", { source: options.source, enqueued, duplicates });

      if (enqueued > 0) {
        runAfterResponse(processQueue(Math.min(enqueued, 10)));
      }
    } catch (error) {
      // La mise en queue a échoué : on renvoie 500 pour que Meta rejoue —
      // c'est le seul cas où l'on veut être rejoué.
      log.error("webhook.enqueue_failed", { source: options.source, error: String(error) });
      return new Response("Internal Error", { status: 500 });
    }

    return new Response("EVENT_RECEIVED", { status: 200 });
  };
}
