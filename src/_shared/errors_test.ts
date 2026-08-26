// Cas limites de la couche erreurs : c'est elle qui décide si un event est
// rejoué ou abandonné. Une erreur de classification coûte soit un lead perdu
// (abandon d'une panne passagère), soit une boucle de rejeu sur une requête qui
// ne deviendra jamais valide.
//
// Lancer : deno test supabase/functions/_shared/errors_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  DatabaseError,
  ExternalApiError,
  isRetryable,
  ValidationError,
  withRetry,
} from "./errors.ts";

// ============================================================
// Classification
// ============================================================

Deno.test("une erreur de validation n'est jamais rejouée", () => {
  // Un payload invalide ne deviendra pas valide à la 6e tentative : le rejouer
  // ne fait que retarder l'alerte au gérant.
  assertEquals(isRetryable(new ValidationError("payload invalide")), false);
});

Deno.test("API tierce : 5xx et 429 rejoués, 4xx non", () => {
  assertEquals(isRetryable(new ExternalApiError("meta", "panne", { status: 500 })), true);
  assertEquals(isRetryable(new ExternalApiError("meta", "indispo", { status: 503 })), true);
  assertEquals(isRetryable(new ExternalApiError("meta", "quota", { status: 429 })), true);
  assertEquals(isRetryable(new ExternalApiError("meta", "timeout", { status: 408 })), true);

  // 400/401/403 : la requête est fautive ou le token est révoqué.
  assertEquals(isRetryable(new ExternalApiError("meta", "mauvais champ", { status: 400 })), false);
  assertEquals(isRetryable(new ExternalApiError("meta", "token révoqué", { status: 401 })), false);
  assertEquals(isRetryable(new ExternalApiError("google", "accès retiré", { status: 403 })), false);
});

Deno.test("API tierce injoignable (aucun statut) : rejouée", () => {
  // Panne réseau, DNS, TLS : rien n'indique que la requête soit fautive.
  assertEquals(isRetryable(new ExternalApiError("google", "connexion refusée")), true);
});

Deno.test("le drapeau explicite l'emporte sur le statut", () => {
  // `invalid_grant` de Google arrive en 400 mais est définitif.
  const revoked = new ExternalApiError("google-oauth", "invalid_grant", {
    status: 400,
    retryable: false,
  });
  assertEquals(isRetryable(revoked), false);
});

Deno.test("erreur base de données : rejouée (contention, timeout)", () => {
  assertEquals(isRetryable(new DatabaseError("deadlock")), true);
});

Deno.test("erreur inconnue : rejouée par défaut", () => {
  // Abandonner sur une erreur qu'on n'a pas su classer perdrait un lead ;
  // la rejouer coûte au pire quelques tentatives avant `failed`.
  assertEquals(isRetryable(new Error("inattendu")), true);
  assertEquals(isRetryable("chaîne"), true);
});

Deno.test("le contexte d'erreur est conservé pour le diagnostic", () => {
  const error = new ExternalApiError("whatsapp", "refusé", {
    status: 400,
    context: { conversationId: "abc" },
  });
  assertEquals(error.code, "external_api_error");
  assertEquals(error.context.service, "whatsapp");
  assertEquals(error.context.conversationId, "abc");
  assert(error.message.includes("[whatsapp]"));
});

// ============================================================
// withRetry
// ============================================================

Deno.test("withRetry renvoie le résultat sans réessayer si tout va bien", async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    return Promise.resolve("ok");
  });

  assertEquals(result, "ok");
  assertEquals(calls, 1);
});

Deno.test("withRetry réessaie une panne passagère puis réussit", async () => {
  let calls = 0;
  const result = await withRetry(() => {
    calls++;
    if (calls < 3) throw new ExternalApiError("meta", "panne", { status: 503 });
    return Promise.resolve("ok");
  }, { attempts: 5, baseDelayMs: 1 });

  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

Deno.test("withRetry abandonne immédiatement une erreur non rejouable", async () => {
  let calls = 0;
  let thrown: unknown = null;

  try {
    await withRetry(() => {
      calls++;
      throw new ValidationError("champ manquant");
    }, { attempts: 5, baseDelayMs: 1 });
  } catch (error) {
    thrown = error;
  }

  // Un seul appel : rejouer une requête invalide est du gaspillage pur.
  assertEquals(calls, 1);
  assert(thrown instanceof ValidationError);
});

Deno.test("withRetry respecte le plafond de tentatives et relaie la dernière erreur", async () => {
  let calls = 0;
  let thrown: unknown = null;

  try {
    await withRetry(() => {
      calls++;
      throw new ExternalApiError("google", `échec ${calls}`, { status: 500 });
    }, { attempts: 3, baseDelayMs: 1 });
  } catch (error) {
    thrown = error;
  }

  assertEquals(calls, 3);
  assert(String(thrown).includes("échec 3"));
});

Deno.test("withRetry applique un backoff croissant avec jitter", async () => {
  const delays: number[] = [];
  let calls = 0;

  await withRetry(() => {
    calls++;
    if (calls < 4) throw new ExternalApiError("meta", "panne", { status: 500 });
    return Promise.resolve("ok");
  }, {
    attempts: 5,
    baseDelayMs: 100,
    onRetry: (_error, _attempt, delayMs) => delays.push(delayMs),
  });

  assertEquals(delays.length, 3);
  // Jitter 50–100 % d'un backoff exponentiel : chaque attente reste dans sa
  // fourchette, et l'ensemble croît.
  assert(delays[0] >= 50 && delays[0] <= 100, `attente 1 hors bornes: ${delays[0]}`);
  assert(delays[1] >= 100 && delays[1] <= 200, `attente 2 hors bornes: ${delays[1]}`);
  assert(delays[2] >= 200 && delays[2] <= 400, `attente 3 hors bornes: ${delays[2]}`);
});

Deno.test("withRetry plafonne l'attente", async () => {
  const delays: number[] = [];
  let calls = 0;

  try {
    await withRetry(() => {
      calls++;
      throw new ExternalApiError("meta", "panne", { status: 500 });
    }, {
      attempts: 6,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      onRetry: (_e, _a, delayMs) => delays.push(delayMs),
    });
  } catch { /* attendu */ }

  // Sans plafond, la 6e attente dépasserait 30 s et ferait expirer la fonction.
  assert(Math.max(...delays) <= 2000, `plafond dépassé: ${Math.max(...delays)}`);
});
