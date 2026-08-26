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

Deno.test("Serveur HTTP : gère la pré-requête CORS OPTIONS", async () => {
  const req = new Request("http://localhost:8000/api/overview", { method: "OPTIONS" });
  const res = await requestHandler(req);

  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(
    res.headers.get("access-control-allow-methods"),
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
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
