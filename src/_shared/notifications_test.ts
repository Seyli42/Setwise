// Tests de la rédaction des alertes.
//
// L'alerte part vers une boîte mail que Setwise ne maîtrise pas, et transite
// par un prestataire tiers. Ce qu'elle contient est donc une décision de
// confidentialité, pas de rédaction. Ces tests verrouillent cette décision :
// le motif d'escalade, jamais l'identité de la cliente ni le contenu de ses
// messages.
//
// Lancer : deno test supabase/functions/_shared/notifications_test.ts

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { compose, templateParameters } from "./notificationMessage.ts";

Deno.test("alerte d'ouverture : porte le motif et renvoie au dashboard", () => {
  const { subject, body } = compose({
    kind: "escalation_opened",
    payload: { reason: "question médicale" },
  });

  assertStringIncludes(subject, "Setwise");
  assertStringIncludes(body, "question médicale");
  assertStringIncludes(body, "Conversations");
});

Deno.test("alerte de relance : texte distinct de l'alerte d'ouverture", () => {
  // Recevoir deux fois le même message ferait croire à un doublon technique,
  // alors que la seconde alerte signale exactement l'inverse : rien n'a bougé.
  const opened = compose({ kind: "escalation_opened", payload: { reason: "réclamation" } });
  const stale = compose({ kind: "escalation_stale", payload: { reason: "réclamation" } });

  assert(opened.subject !== stale.subject);
  assert(opened.body !== stale.body);
  assertStringIncludes(stale.body, "pas encore de réponse");
});

Deno.test("aucune donnée personnelle de la cliente ne fuit dans l'alerte", () => {
  // Un payload pollué — nom, téléphone, contenu du message — ne doit rien
  // ajouter au corps : seul `reason` est lu.
  const { body } = compose({
    kind: "escalation_opened",
    payload: {
      reason: "grossesse",
      full_name: "Camille Dubois",
      phone: "0612345678",
      last_message: "Je suis enceinte de 3 mois, est-ce compatible ?",
    },
  });

  assert(!body.includes("Camille"));
  assert(!body.includes("0612345678"));
  assert(!body.includes("enceinte de 3 mois"));
  assertStringIncludes(body, "grossesse");
});

Deno.test("motif absent ou mal typé : repli lisible, jamais 'undefined'", () => {
  // Une alerte qui affiche « Motif : undefined » fait douter de l'outil au
  // moment précis où il faut agir vite.
  for (const payload of [{}, { reason: null }, { reason: 42 }]) {
    const { body } = compose({ kind: "escalation_opened", payload });
    assertStringIncludes(body, "motif non précisé");
    assert(!body.includes("undefined"));
    assert(!body.includes("null"));
  }
});

Deno.test("nature inconnue : traitée comme une ouverture, pas ignorée", () => {
  // La base contraint déjà les valeurs possibles ; si une nouvelle nature
  // apparaît un jour, mieux vaut une alerte générique qu'aucune alerte.
  const { subject } = compose({ kind: "autre_chose", payload: { reason: "x" } });
  assertEquals(subject, "Setwise — une conversation demande votre attention");
});

Deno.test("modèle WhatsApp : deux variables, motif tronqué", () => {
  // Meta rejette un paramètre de modèle trop long : la troncature doit être
  // faite ici, pas découverte en production sur un motif verbeux.
  const long = "a".repeat(500);
  const params = templateParameters({ kind: "escalation_opened", payload: { reason: long } });

  assertEquals(params.length, 2);
  assertEquals(params[0], "à reprendre");
  assertEquals(params[1].length, 200);
});

Deno.test("modèle WhatsApp : la relance se distingue de l'ouverture", () => {
  const stale = templateParameters({ kind: "escalation_stale", payload: { reason: "plainte" } });
  assertEquals(stale[0], "toujours en attente");
});

// ============================================================
// Invitation d'équipe
// ============================================================

Deno.test("invitation : nomme l'institut, sans lien porteur de secret", () => {
  // L'acceptation est appariée en base sur l'adresse vérifiée du jeton. Rien
  // dans cet e-mail ne permet de rejoindre un institut — c'est le point.
  const { subject, body } = compose({
    kind: "invitation",
    payload: { tenant_name: "Institut Belle Époque" },
  });

  assertStringIncludes(subject, "Institut Belle Époque");
  assertStringIncludes(body, "CETTE adresse e-mail");
  assert(!body.includes("http"), "aucun lien ne doit figurer dans l'invitation");
});

Deno.test("invitation : nom d'institut manquant, repli neutre", () => {
  const { subject } = compose({ kind: "invitation", payload: {} });
  assertStringIncludes(subject, "un institut");
  assert(!subject.includes("undefined"));
});

Deno.test("invitation : le corps ne ressemble pas à une alerte d'escalade", () => {
  // Les deux natures passent par la même file ; les confondre enverrait une
  // convocation urgente à quelqu'un qui n'a rien à traiter.
  const invite = compose({ kind: "invitation", payload: { tenant_name: "X" } });
  const escalation = compose({ kind: "escalation_opened", payload: { reason: "X" } });

  assert(invite.subject !== escalation.subject);
  assert(!invite.body.includes("Conversations"));
});
