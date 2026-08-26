// Tests unitaires pour le serveur de fichiers statiques.

import { assertEquals, assertNotEquals } from "jsr:@std/assert@^1.0.11";
import { serveStaticFile } from "./static.ts";

Deno.test("Serveur statique : sert index.html pour /dashboard", async () => {
  const req = new Request("http://localhost:8000/dashboard");
  const res = await serveStaticFile(req, "/dashboard");

  assertNotEquals(res, null);
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("Serveur statique : sert styles.css avec bon MIME type", async () => {
  const req = new Request("http://localhost:8000/dashboard/styles.css");
  const res = await serveStaticFile(req, "/dashboard/styles.css");

  assertNotEquals(res, null);
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/css; charset=utf-8");
});

Deno.test("Serveur statique : sert site vitrine pour /site", async () => {
  const req = new Request("http://localhost:8000/site");
  const res = await serveStaticFile(req, "/site");

  assertNotEquals(res, null);
  assertEquals(res?.status, 200);
  assertEquals(res?.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("Serveur statique : bloque le directory traversal (..)", async () => {
  const req = new Request("http://localhost:8000/dashboard/../../deno.json");
  const res = await serveStaticFile(req, "/dashboard/../../deno.json");

  assertEquals(res, null);
});

Deno.test("Serveur statique : renvoie null pour les routes API", async () => {
  const req = new Request("http://localhost:8000/api/overview");
  const res = await serveStaticFile(req, "/api/overview");

  assertEquals(res, null);
});
