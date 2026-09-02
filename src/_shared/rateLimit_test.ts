// Tests unitaires pour la limitation de débit.
//
// `enforceRateLimit` dépend de la base (Neon) et n'est donc pas testé ici en
// isolation — sa logique de comptage vit dans `rate_limit_hit` (migration
// 0004), en SQL, où elle est vérifiable par `explain`/exécution directe. Ce
// fichier couvre ce qui est pur : l'extraction d'IP et la forme de l'erreur,
// deux points qui cassent silencieusement s'ils régressent (une IP mal lue
// fait pointer tous les appelants vers le même bucket, ce qui bloque un
// visiteur légitime à la place d'un autre).

import { assertEquals } from "jsr:@std/assert@^1.0.11";
import { clientIp, RateLimitError } from "./rateLimit.ts";

Deno.test("clientIp : lit x-forwarded-for, garde la première adresse", () => {
  // Vercel (et tout proxy en chaîne) ajoute les IP en tête ; la première est
  // celle du client d'origine, les suivantes sont les relais traversés.
  const req = new Request("https://x", {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" },
  });
  assertEquals(clientIp(req), "203.0.113.7");
});

Deno.test("clientIp : repli sur x-real-ip si x-forwarded-for absent", () => {
  const req = new Request("https://x", { headers: { "x-real-ip": "198.51.100.4" } });
  assertEquals(clientIp(req), "198.51.100.4");
});

Deno.test("clientIp : aucun en-tête connu -> 'unknown', jamais une exception", () => {
  const req = new Request("https://x");
  assertEquals(clientIp(req), "unknown");
});

Deno.test("RateLimitError : porte le délai d'attente pour l'en-tête Retry-After", () => {
  const err = new RateLimitError("Trop de tentatives.", 900);
  assertEquals(err.retryAfterSeconds, 900);
  assertEquals(err.retryable, false);
});
