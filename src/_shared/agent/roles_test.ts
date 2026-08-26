// Garde-fous par rôle : prompt de mission et jeu d'outils.
//
// Ce fichier verrouille ce qui distingue les quatre rôles et, surtout, ce
// qu'ils ont en commun. Une régression ici ne se voit pas à l'exécution — elle
// se voit trois semaines plus tard, quand un institut reçoit un avis Google
// d'une cliente mécontente qu'on avait sollicitée.
//
// Lancer : deno test --allow-env supabase/functions/_shared/agent/roles_test.ts

import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildSystemPrompt, type PromptContext } from "./prompt.ts";
import type { AgentType } from "../types.ts";

// `tools.ts` importe la couche de persistance : ces valeurs évitent l'échec au
// chargement du module. Aucun appel réseau n'est fait par les tests.
Deno.env.set("SUPABASE_URL", "https://exemple.supabase.co");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "cle-de-test");

const { buildTools, TOOL_BOOK, TOOL_ESCALATE, TOOL_LIST_SLOTS, TOOL_OUTCOME, TOOL_SAVE_ANSWER } =
  await import("./tools.ts");
const { registerCalendarProvider } = await import("../calendar.ts");
const { googleCalendarProvider } = await import("../calendar/google.ts");

registerCalendarProvider("google", googleCalendarProvider);

const ROLES: AgentType[] = ["qualification_rdv", "avis_google", "relance", "reactivation"];
const OUTBOUND: AgentType[] = ["avis_google", "relance", "reactivation"];

function promptFor(agentType: AgentType, overrides: Partial<PromptContext> = {}): string {
  return buildSystemPrompt({
    agentType,
    tenantName: "Belle Époque",
    locationName: "Belle Époque Lyon 6",
    timezone: "Europe/Paris",
    systemPromptTemplate: "Spécialistes du laser chez {{etablissement}}.",
    questions: [{ id: "q1", prompt: "Quelle zone ?", field: "zone" }],
    budgetRules: {},
    collected: {},
    bookingEnabled: true,
    ...overrides,
  });
}

// deno-lint-ignore no-explicit-any
function agentContext(type: AgentType, withCalendar = true): any {
  return {
    tenantId: "t1",
    tenantName: "Belle Époque",
    timezone: "Europe/Paris",
    locationId: null,
    locationName: null,
    agentId: "a1",
    type,
    systemPromptTemplate: "",
    agentConfig: {},
    scriptId: null,
    questions: [{ id: "q1", prompt: "Quelle zone ?", field: "zone" }],
    budgetRules: {},
    escalationKeywords: [],
    scheduling: {
      businessHours: {},
      services: [],
      defaultDurationMin: 60,
      slotGranularityMin: 30,
      minNoticeHours: 4,
      maxDaysAhead: 14,
    },
    calendarIntegrationId: withCalendar ? "cal1" : null,
    calendarProvider: withCalendar ? "google" : null,
    calendarExternalId: withCalendar ? "primary" : null,
    calendarCredentialsEncrypted: withCalendar ? "chiffré" : null,
  };
}

const toolNames = (type: AgentType, withCalendar = true) =>
  buildTools(agentContext(type, withCalendar)).map((tool) => tool.name);

// ============================================================
// Garde-fous communs — valables pour les quatre rôles
// ============================================================

Deno.test("tous les rôles portent l'interdit médical et le transfert humain", () => {
  for (const role of ROLES) {
    const prompt = promptFor(role);
    assert(prompt.includes("escalate_to_human"), `${role} : transfert absent`);
    assert(prompt.includes("aucun conseil médical"), `${role} : interdit médical absent`);
    assert(prompt.includes("RGPD"), `${role} : section RGPD absente`);
  }
});

Deno.test("tous les rôles disposent du transfert humain", () => {
  for (const role of ROLES) {
    assert(toolNames(role).includes(TOOL_ESCALATE), `${role} : outil de transfert absent`);
  }
});

Deno.test("tous les rôles annoncent le fuseau de l'établissement", () => {
  for (const role of ROLES) {
    assert(promptFor(role).includes("Europe/Paris"), `${role} : fuseau absent`);
  }
});

// ============================================================
// Agents sortants — la personne n'a rien demandé
// ============================================================

Deno.test("les rôles sortants interdisent l'insistance", () => {
  for (const role of OUTBOUND) {
    const prompt = promptFor(role);
    assert(prompt.includes("Une seule relance, jamais deux"), `${role} : insistance non bornée`);
    assert(prompt.includes("demande d'opposition"), `${role} : droit d'opposition absent`);
  }
});

Deno.test("le rôle de qualification ne porte PAS la clause d'insistance", () => {
  // Là, c'est la personne qui a écrit la première : lui dire de ne pas insister
  // la ferait abandonner la qualification au premier silence.
  assert(!promptFor("qualification_rdv").includes("Une seule relance"));
});

// ============================================================
// Avis Google — le rôle le plus risqué du produit
// ============================================================

Deno.test("l'agent d'avis ne peut pas réserver de rendez-vous", () => {
  // Avec les outils de réservation, il finirait par proposer un créneau à
  // quelqu'un qui sort tout juste de séance.
  const names = toolNames("avis_google");
  assertEquals(names.includes(TOOL_BOOK), false);
  assertEquals(names.includes(TOOL_LIST_SLOTS), false);
  assertEquals(names.includes(TOOL_SAVE_ANSWER), false);
  assert(names.includes(TOOL_OUTCOME));
});

Deno.test("l'agent d'avis interdit de solliciter un client mécontent", () => {
  const prompt = promptFor("avis_google");
  assert(prompt.includes("ne demande SURTOUT PAS d'avis"));
  assert(prompt.includes("note de 1 étoile"));
});

Deno.test("l'agent d'avis interdit la contrepartie", () => {
  // Interdit par les règles de Google et par la loi (pratique commerciale
  // trompeuse). Un institut ne doit pas pouvoir s'y exposer par notre faute.
  assert(promptFor("avis_google").includes("contrepartie"));
});

Deno.test("sans lien d'avis configuré, l'agent a interdiction d'en inventer un", () => {
  const prompt = promptFor("avis_google");
  assert(prompt.includes("Ne donne aucune URL et n'en invente pas"));

  const withUrl = promptFor("avis_google", {
    subject: { googleReviewUrl: "https://g.page/r/exemple/review" },
  });
  assert(withUrl.includes("https://g.page/r/exemple/review"));
  assert(!withUrl.includes("n'en invente pas"));
});

// ============================================================
// Relance après absence
// ============================================================

Deno.test("la relance peut replanifier mais ne requalifie pas", () => {
  const names = toolNames("relance");
  assert(names.includes(TOOL_LIST_SLOTS));
  assert(names.includes(TOOL_BOOK));
  // La personne a déjà répondu à ces questions : les reposer serait vexant.
  assertEquals(names.includes(TOOL_SAVE_ANSWER), false);
});

Deno.test("la relance exclut tout reproche", () => {
  const prompt = promptFor("relance");
  assert(prompt.includes("Aucun reproche"));
  assert(prompt.includes("manque à gagner"));
});

// ============================================================
// Réactivation
// ============================================================

Deno.test("la réactivation peut requalifier et réserver", () => {
  const names = toolNames("reactivation");
  assert(names.includes(TOOL_SAVE_ANSWER));
  assert(names.includes(TOOL_BOOK));
});

Deno.test("la réactivation réutilise ce qui est déjà connu du lead", () => {
  const prompt = promptFor("reactivation", { collected: { zone: "jambes", budget: "500€" } });
  assert(prompt.includes("jambes"));
  assert(prompt.includes("Ne fais pas semblant de découvrir la personne"));
});

Deno.test("la réactivation vérifie que le besoin existe avant de proposer", () => {
  assert(promptFor("reactivation").includes("vérifier que le besoin existe toujours"));
});

// ============================================================
// Calendrier absent — aucun rôle ne doit promettre de créneau
// ============================================================

Deno.test("sans calendrier, aucun rôle n'expose les outils de réservation", () => {
  for (const role of ROLES) {
    const names = toolNames(role, false);
    assertEquals(names.includes(TOOL_BOOK), false, `${role} : réservation exposée sans calendrier`);
    assertEquals(names.includes(TOOL_LIST_SLOTS), false, `${role} : créneaux exposés sans calendrier`);
  }
});

Deno.test("sans calendrier, les rôles concernés interdisent d'annoncer un horaire", () => {
  for (const role of ["qualification_rdv", "relance", "reactivation"] as AgentType[]) {
    const prompt = promptFor(role, { bookingEnabled: false });
    assert(prompt.includes("N'invente jamais de créneau"), `${role} : garde-fou absent`);
  }
});

// ============================================================
// Consignes du gérant
// ============================================================

Deno.test("le template du gérant est injecté dans tous les rôles", () => {
  for (const role of ROLES) {
    assert(
      promptFor(role).includes("Spécialistes du laser chez Belle Époque Lyon 6"),
      `${role} : consignes de l'établissement absentes`,
    );
  }
});
