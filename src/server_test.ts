// Tests unitaires pour le serveur HTTP unifié et les routes de base.

import { assertEquals } from "jsr:@std/assert@^1.0.11";
import { requestHandler } from "./server.ts";

Deno.test("Serveur HTTP : /health renvoie le JSON de diagnostic", async () => {
  const req = new Request("http://localhost:8000/health", { method: "GET" });
  const res = await requestHandler(req);

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.ok, true);
  assertEquals(data.service, "setwise-backend");
  assertEquals(data.database, "neon-postgres");
});

Deno.test("Serveur HTTP : la pré-requête CORS renvoie l'origine si elle est autorisée", async () => {
  Deno.env.set("APP_ORIGINS", "https://dashboard.setwise.fr,http://localhost:8000");
  try {
    const req = new Request("http://localhost:8000/api/overview", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:8000" },
    });
    const res = await requestHandler(req);

    assertEquals(res.status, 204);
    assertEquals(res.headers.get("access-control-allow-origin"), "http://localhost:8000");
    assertEquals(res.headers.get("vary"), "origin");
    assertEquals(
      res.headers.get("access-control-allow-methods"),
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("Serveur HTTP : une origine étrangère n'est jamais autorisée (plus de `*`)", async () => {
  // Régression : l'API renvoyait `access-control-allow-origin: *`, ce qui
  // laissait n'importe quel site appeler le tableau de bord depuis le
  // navigateur d'un gérant connecté. On renvoie désormais l'origine canonique,
  // que le navigateur refuse de faire correspondre à `https://evil.example`.
  Deno.env.set("APP_ORIGINS", "https://dashboard.setwise.fr");
  try {
    const req = new Request("http://localhost:8000/api/overview", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    const res = await requestHandler(req);

    const autorisee = res.headers.get("access-control-allow-origin");
    assertEquals(autorisee, "https://dashboard.setwise.fr");
    assertEquals(autorisee === "*", false);
    assertEquals(autorisee === "https://evil.example", false);
  } finally {
    Deno.env.delete("APP_ORIGINS");
  }
});

Deno.test("Serveur HTTP : 404 pour une route inconnue", async () => {
  const req = new Request("http://localhost:8000/api/route-inexistante-xyz", {
    method: "GET",
    headers: { authorization: "Bearer invalid_token" },
  });
  const res = await requestHandler(req);

  // Soit 401 (non authentifié) soit 404
  assertEquals(res.status >= 400, true);
});
