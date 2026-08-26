// La redaction des logs est la dernière barrière avant qu'un token Meta ou un
// refresh token Google se retrouve en clair dans les logs Supabase — lisibles
// par toute personne ayant accès au projet, et conservés bien après l'incident
// qui les a produits.
//
// Lancer : deno test supabase/functions/_shared/logger_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { log, scopedLogger } from "./logger.ts";

/** Capture ce qui est réellement écrit sur la sortie, et le rend en JSON. */
function capture(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };

  console.log = (line: string) => lines.push(line);
  console.warn = (line: string) => lines.push(line);
  console.error = (line: string) => lines.push(line);

  try {
    run();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  return lines.map((line) => JSON.parse(line));
}

Deno.test("chaque ligne est du JSON avec horodatage, niveau et événement", () => {
  const [entry] = capture(() => log.info("turn.started", { conversationId: "abc" }));

  assertEquals(entry.level, "info");
  assertEquals(entry.event, "turn.started");
  assertEquals(entry.conversationId, "abc");
  assert(typeof entry.ts === "string" && !Number.isNaN(Date.parse(entry.ts as string)));
});

Deno.test("les niveaux vont sur le bon flux", () => {
  const entries = capture(() => {
    log.debug("a");
    log.info("b");
    log.warn("c");
    log.error("d");
  });
  assertEquals(entries.map((e) => e.level), ["debug", "info", "warn", "error"]);
});

Deno.test("les clés sensibles sont masquées, quelle que soit la casse", () => {
  const [entry] = capture(() =>
    log.info("connexion", {
      access_token: "EAAG_secret_meta",
      refresh_token: "1//0g_secret_google",
      ACCESS_TOKEN: "majuscules",
      webhookVerifyToken: "camelCase",
      apiKey: "sk-secret",
      client_secret: "secret_oauth",
      authorization: "Bearer abc",
      password: "hunter2",
      signature: "sha256=…",
      credentials_encrypted: "base64…",
    })
  );

  for (const [key, value] of Object.entries(entry)) {
    if (["ts", "level", "event"].includes(key)) continue;
    assertEquals(value, "[redacted]", `clé non masquée : ${key}`);
  }
});

Deno.test("les clés sensibles imbriquées sont masquées aussi", () => {
  // Le cas réel : on loggue un objet de connexion entier par inadvertance.
  const [entry] = capture(() =>
    log.error("échec", {
      connection: {
        id: "conn_1",
        channel: "instagram",
        accessToken: "EAAG_secret",
        nested: [{ refreshToken: "1//0g_secret" }],
      },
    })
  );

  const connection = entry.connection as Record<string, unknown>;
  assertEquals(connection.id, "conn_1");
  assertEquals(connection.channel, "instagram");
  assertEquals(connection.accessToken, "[redacted]");
  assertEquals((connection.nested as Record<string, unknown>[])[0].refreshToken, "[redacted]");

  // Vérification directe : le secret n'apparaît nulle part dans la ligne.
  assert(!JSON.stringify(entry).includes("EAAG_secret"));
  assert(!JSON.stringify(entry).includes("1//0g_secret"));
});

Deno.test("les chaînes longues sont tronquées", () => {
  // Un message de lead de 10 000 caractères ne doit pas saturer les logs, et
  // le contenu des conversations n'a pas à y être conservé intégralement (RGPD).
  const [entry] = capture(() => log.info("message", { content: "a".repeat(5000) }));

  const content = entry.content as string;
  assert(content.length < 300, `non tronqué : ${content.length} caractères`);
  assert(content.endsWith("…[tronqué]"));
});

Deno.test("les valeurs non textuelles sont préservées", () => {
  const [entry] = capture(() => log.info("usage", { cached: true, category: null, attempt: 2 }));

  assertEquals(entry.cached, true);
  assertEquals(entry.category, null);
  assertEquals(entry.attempt, 2);
});

Deno.test("les compteurs de tokens ne sont PAS masqués", () => {
  // Régression : une détection par sous-chaîne masquait `inputTokens` parce
  // qu'il contient « token ». Résultat, toutes les métriques de coût du modèle
  // étaient illisibles et la consommation par institut intraçable.
  const [entry] = capture(() =>
    log.info("llm.turn", { inputTokens: 1234, outputTokens: 56, cacheReadTokens: 7890 })
  );

  assertEquals(entry.inputTokens, 1234);
  assertEquals(entry.outputTokens, 56);
  assertEquals(entry.cacheReadTokens, 7890);
});

Deno.test("un mot contenant un fragment sensible n'est pas masqué", () => {
  // Régression : `keyword` contient « key ». Le mot-clé ayant déclenché une
  // escalade devenait illisible, alors que c'est précisément l'information
  // que le gérant cherche dans les logs.
  const [entry] = capture(() =>
    log.info("escalation.opened", {
      trigger: "keyword",
      keyword: "grossesse",
      monkey: "faux positif",
      stripeCustomerId: "cus_123",
    })
  );

  assertEquals(entry.trigger, "keyword");
  assertEquals(entry.keyword, "grossesse");
  assertEquals(entry.monkey, "faux positif");
  assertEquals(entry.stripeCustomerId, "cus_123");
});

Deno.test("scopedLogger ajoute le contexte de corrélation à chaque ligne", () => {
  const logger = scopedLogger({ tenantId: "t1", conversationId: "c1" });
  const entries = capture(() => {
    logger.info("turn.started");
    logger.warn("llm.retry", { attempt: 2 });
  });

  for (const entry of entries) {
    assertEquals(entry.tenantId, "t1");
    assertEquals(entry.conversationId, "c1");
  }
  assertEquals(entries[1].attempt, 2);
});

Deno.test("le contexte de l'appel l'emporte sur celui du scope", () => {
  const logger = scopedLogger({ tenantId: "t1", channel: "instagram" });
  const [entry] = capture(() => logger.info("relais", { channel: "whatsapp" }));

  assertEquals(entry.channel, "whatsapp");
  assertEquals(entry.tenantId, "t1");
});
