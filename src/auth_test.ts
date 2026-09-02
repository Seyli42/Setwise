// Tests unitaires pour l'authentification autonome (JWT & Magic Link).

import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.11";
import * as jose from "npm:jose@^5.9.6";

const TEST_SECRET = new TextEncoder().encode("setwise_test_secret_key_32bytes_!");

Deno.test("Auth JWT : génération et vérification de session", async () => {
  const payload = {
    userId: "123e4567-e89b-12d3-a456-426614174000",
    email: "test@institut.fr",
    tenantId: "223e4567-e89b-12d3-a456-426614174000",
    role: "owner",
  };

  const jwt = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(TEST_SECRET);

  const { payload: verified } = await jose.jwtVerify(jwt, TEST_SECRET);
  assertEquals(verified.userId, payload.userId);
  assertEquals(verified.email, payload.email);
  assertEquals(verified.tenantId, payload.tenantId);
  assertEquals(verified.role, payload.role);
});

Deno.test("Auth JWT : rejet d'un token signé avec une autre clé", async () => {
  const payload = { userId: "user-1", email: "test@institut.fr" };
  const wrongSecret = new TextEncoder().encode("wrong_secret_key_32bytes_minimum!");

  const jwt = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .sign(wrongSecret);

  await assertRejects(
    async () => {
      await jose.jwtVerify(jwt, TEST_SECRET);
    },
    Error,
  );
});

Deno.test("Auth JWT : rejet d'un token expiré", async () => {
  const payload = { userId: "user-1", email: "test@institut.fr" };

  const jwt = await new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 1800) // expiré il y a 30 min
    .sign(TEST_SECRET);

  await assertRejects(
    async () => {
      await jose.jwtVerify(jwt, TEST_SECRET);
    },
    Error,
  );
});

// ============================================================
// resolveOrigin — faille corrigée : prise de contrôle de compte
// ============================================================
//
// `sendMagicLink` construisait le lien de connexion à partir de l'en-tête
// `Origin` (ou `Referer`) de la requête, sans aucune vérification. Un
// attaquant demandait un lien pour l'adresse d'une victime avec
// `Origin: https://evil.example` : Setwise envoyait, depuis son propre
// domaine vérifié (SPF/DKIM valides), un e-mail légitime dont le lien menait
// chez l'attaquant avec le jeton de session dans le fragment. Un clic
// suffisait à voler la session — sans rien de suspect à voir dans l'e-mail.
//
// `resolveOrigin` doit ignorer toute origine hors de l'allowlist et retomber
// silencieusement sur l'origine canonique — un refus explicite renseignerait
// l'attaquant sur ce qui a été filtré.

import { resolveOrigin } from "./auth.ts";

Deno.test("resolveOrigin : une origine hors allowlist est ignorée", () => {
  Deno.env.set("APP_ORIGINS", "https://dashboard.setwise.fr");
  try {
    assertEquals(resolveOrigin("https://evil.example"), "https://dashboard.setwise.fr");
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("resolveOrigin : une origine de l'allowlist est acceptée", () => {
  Deno.env.set("APP_ORIGINS", "https://a.setwise.fr,https://b.setwise.fr");
  try {
    assertEquals(resolveOrigin("https://b.setwise.fr"), "https://b.setwise.fr");
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("resolveOrigin : aucune origine fournie -> origine canonique", () => {
  Deno.env.set("APP_ORIGINS", "https://dashboard.setwise.fr,https://autre.fr");
  try {
    assertEquals(resolveOrigin(null), "https://dashboard.setwise.fr");
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("resolveOrigin : barre finale ignorée dans la comparaison", () => {
  // Un attaquant ne doit pas pouvoir contourner l'allowlist avec un `/` de
  // trop — et un utilisateur légitime ne doit pas être bloqué pour ça.
  Deno.env.set("APP_ORIGINS", "https://dashboard.setwise.fr");
  try {
    assertEquals(resolveOrigin("https://dashboard.setwise.fr/"), "https://dashboard.setwise.fr");
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("resolveOrigin : sans APP_ORIGINS, repli sur DASHBOARD_ORIGIN", () => {
  Deno.env.delete("APP_ORIGINS");
  Deno.env.set("DASHBOARD_ORIGIN", "https://legacy.setwise.fr");
  try {
    assertEquals(resolveOrigin("https://evil.example"), "https://legacy.setwise.fr");
    assertEquals(resolveOrigin(null), "https://legacy.setwise.fr");
  } finally {
    Deno.env.delete("DASHBOARD_ORIGIN");
  }
});
