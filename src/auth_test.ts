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
