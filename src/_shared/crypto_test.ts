// Vérifie le chiffrement au repos des tokens. Aucun réseau, aucune base.
// Lancer : deno test --allow-env supabase/functions/_shared/crypto_test.ts

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";

// La clé doit être posée avant le premier import du module (lecture paresseuse,
// mais mise en cache dès le premier appel).
Deno.env.set("ENCRYPTION_KEY", btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));

const { encryptSecret, decryptSecret } = await import("./crypto.ts");

Deno.test("aller-retour chiffrement/déchiffrement", async () => {
  const secret = "EAAG_faux_token_meta_pour_test_1234567890";
  const encrypted = await encryptSecret(secret);

  assertNotEquals(encrypted, secret, "le ciphertext ne doit jamais contenir le clair");
  assert(!encrypted.includes(secret));
  assertEquals(await decryptSecret(encrypted), secret);
});

Deno.test("deux chiffrements du même clair donnent des ciphertexts différents", async () => {
  const secret = "token-identique";
  const a = await encryptSecret(secret);
  const b = await encryptSecret(secret);

  // IV aléatoire à chaque appel : sans ça, un observateur de la base pourrait
  // déduire que deux instituts utilisent le même token.
  assertNotEquals(a, b);
  assertEquals(await decryptSecret(a), secret);
  assertEquals(await decryptSecret(b), secret);
});

Deno.test("un ciphertext altéré est rejeté (GCM authentifié)", async () => {
  const encrypted = await encryptSecret("données sensibles");
  const bytes = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1] ^= 0xff; // corruption d'un octet du tag
  const tampered = btoa(String.fromCharCode(...bytes));

  let threw = false;
  try {
    await decryptSecret(tampered);
  } catch {
    threw = true;
  }
  assert(threw, "le déchiffrement doit échouer sur une donnée altérée");
});

Deno.test("une valeur trop courte est rejetée proprement", async () => {
  let threw = false;
  try {
    await decryptSecret(btoa("court"));
  } catch {
    threw = true;
  }
  assert(threw);
});
