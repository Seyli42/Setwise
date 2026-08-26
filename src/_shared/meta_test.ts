// Vérification de la signature des webhooks Meta — le seul rempart entre
// internet et la file de traitement. Aucun réseau, aucune base.
// Lancer : deno test --allow-env supabase/functions/_shared/meta_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";

const APP_SECRET = "secret_de_test_meta";
Deno.env.set("META_APP_SECRET", APP_SECRET);
Deno.env.set("META_WEBHOOK_VERIFY_TOKEN", "jeton_de_verification");

const { verifyMetaSignature, handleVerificationHandshake } = await import("./meta.ts");

async function sign(body: string, secret = APP_SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const hex = Array.from(mac).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256=${hex}`;
}

Deno.test("signature valide acceptée", async () => {
  const body = '{"object":"instagram","entry":[]}';
  assert(await verifyMetaSignature(body, await sign(body)));
});

Deno.test("corps modifié rejeté", async () => {
  const body = '{"object":"instagram","entry":[]}';
  const signature = await sign(body);
  assertEquals(await verifyMetaSignature(body + " ", signature), false);
});

Deno.test("signature d'un autre secret rejetée", async () => {
  const body = '{"object":"instagram"}';
  assertEquals(await verifyMetaSignature(body, await sign(body, "mauvais_secret")), false);
});

Deno.test("en-tête absent ou malformé rejeté", async () => {
  const body = "{}";
  assertEquals(await verifyMetaSignature(body, null), false);
  assertEquals(await verifyMetaSignature(body, "pas-de-schema"), false);
  assertEquals(await verifyMetaSignature(body, "sha1=abcdef"), false);
  assertEquals(await verifyMetaSignature(body, "sha256=zzzz"), false);
  assertEquals(await verifyMetaSignature(body, "sha256="), false);
});

Deno.test("re-sérialiser le JSON casse la signature", async () => {
  // Rappel de la raison pour laquelle le handler signe le corps BRUT : la
  // moindre différence d'octets (espaces, échappement unicode) invalide le MAC,
  // alors que l'objet JSON est identique.
  for (const body of ['{ "a" : 1 }', '{"nom":"Cl\\u00e9mence"}']) {
    const signature = await sign(body);
    const reserialized = JSON.stringify(JSON.parse(body));

    assertEquals(reserialized === body, false, `cas non discriminant: ${body}`);
    assert(await verifyMetaSignature(body, signature));
    assertEquals(await verifyMetaSignature(reserialized, signature), false);
  }
});

Deno.test("handshake : bon jeton renvoie le challenge", () => {
  const url = new URL(
    "https://x/functions/v1/webhook-instagram?hub.mode=subscribe&hub.verify_token=jeton_de_verification&hub.challenge=123456",
  );
  const response = handleVerificationHandshake(url)!;
  assertEquals(response.status, 200);
});

Deno.test("handshake : mauvais jeton renvoie 403", () => {
  const url = new URL(
    "https://x/functions/v1/webhook-instagram?hub.mode=subscribe&hub.verify_token=faux&hub.challenge=123456",
  );
  assertEquals(handleVerificationHandshake(url)!.status, 403);
});

Deno.test("handshake : mode inconnu non traité", () => {
  const url = new URL("https://x/functions/v1/webhook-instagram?hub.mode=unsubscribe");
  assertEquals(handleVerificationHandshake(url), null);
});
