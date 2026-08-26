// Tests des briques pures du moteur : aucun secret, aucun réseau, aucune base.
// Lancer : deno test supabase/functions/_shared/agent/prompt_test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { buildSystemPrompt, matchEscalationKeyword, type PromptContext } from "./prompt.ts";

function baseContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    tenantName: "Belle Époque",
    locationName: "Belle Époque Lyon 6",
    timezone: "Europe/Paris",
    systemPromptTemplate: "Nous sommes spécialisés en épilation laser chez {{etablissement}}.",
    questions: [
      { id: "q1", prompt: "Quelle zone souhaitez-vous traiter ?", field: "zone" },
      { id: "q2", prompt: "Quel est votre budget ?", field: "budget" },
    ],
    budgetRules: {},
    collected: {},
    bookingEnabled: true,
    leadDisplayName: null,
    ...overrides,
  };
}

Deno.test("le prompt injecte le template du gérant et résout les variables", () => {
  const prompt = buildSystemPrompt(baseContext());
  assertStringIncludes(prompt, "spécialisés en épilation laser chez Belle Époque Lyon 6");
});

Deno.test("le prompt marque les questions déjà répondues", () => {
  const prompt = buildSystemPrompt(baseContext({ collected: { zone: "jambes entières" } }));
  assertStringIncludes(prompt, "déjà répondu");
  assertStringIncludes(prompt, "jambes entières");
  assertStringIncludes(prompt, "Questions restantes : 1.");
});

Deno.test("sans calendrier connecté, le prompt interdit d'annoncer un créneau", () => {
  const prompt = buildSystemPrompt(baseContext({ bookingEnabled: false }));
  assertStringIncludes(prompt, "N'invente jamais de créneau");
  assert(!prompt.includes("appelle `list_available_slots` pour obtenir les créneaux réels"));
});

Deno.test("avec calendrier connecté, le prompt impose de passer par l'outil", () => {
  const prompt = buildSystemPrompt(baseContext({ bookingEnabled: true }));
  assertStringIncludes(prompt, "list_available_slots");
  assertStringIncludes(prompt, "N'annonce jamais un créneau que");
});

Deno.test("le prompt contient toujours les règles d'escalade et l'interdit médical", () => {
  const prompt = buildSystemPrompt(baseContext());
  assertStringIncludes(prompt, "escalate_to_human");
  assertStringIncludes(prompt, "aucun conseil médical");
});

Deno.test("les règles de budget ne sont incluses que si configurées", () => {
  assert(!buildSystemPrompt(baseContext()).includes("Règles de budget"));
  const withRules = buildSystemPrompt(baseContext({ budgetRules: { min_eur: 300 } }));
  assertStringIncludes(withRules, "Règles de budget");
  assertStringIncludes(withRules, "300");
});

Deno.test("matchEscalationKeyword ignore casse et accents", () => {
  const keywords = ["grossesse", "remboursement"];
  assertEquals(matchEscalationKeyword("Je suis enceinte", keywords), null);
  assertEquals(matchEscalationKeyword("Et en cas de GROSSESSE ?", keywords), "grossesse");
  assertEquals(matchEscalationKeyword("je veux un rémboursement", keywords), "remboursement");
});

Deno.test("matchEscalationKeyword renvoie null sans mots-clés configurés", () => {
  assertEquals(matchEscalationKeyword("n'importe quoi", []), null);
});
