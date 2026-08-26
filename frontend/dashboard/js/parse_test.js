// Tests des conversions saisie ⇄ base du dashboard.
//
// Ces fonctions transforment ce que le gérant tape en règles appliquées par
// l'agent. Une erreur ici est silencieuse : rien ne casse à l'écran, l'agent
// travaille simplement avec de mauvais horaires ou un mauvais script.
//
// Lancer : deno test frontend/dashboard/js/parse_test.js

import { assertEquals } from "jsr:@std/assert@1";
import {
  describeRetention,
  duplicateFields,
  intervalsToText,
  questionsToText,
  servicesToText,
  textToIntervals,
  textToKeywords,
  textToQuestions,
  textToServices,
} from "./parse.js";

// ============================================================
// Horaires
// ============================================================

Deno.test("horaires : aller-retour texte ⇄ structure", () => {
  const intervals = [["09:00", "12:00"], ["14:00", "19:00"]];
  assertEquals(intervalsToText(intervals), "09:00-12:00, 14:00-19:00");
  assertEquals(textToIntervals("09:00-12:00, 14:00-19:00"), intervals);
});

Deno.test("horaires : tolère espaces et heures sur un chiffre", () => {
  assertEquals(textToIntervals(" 9:00 - 12:00 ,  14:00-19:00 "), [
    ["09:00", "12:00"],
    ["14:00", "19:00"],
  ]);
});

Deno.test("horaires : écarte l'invalide et garde le reste", () => {
  // Le gérant se trompe sur un intervalle : il ne doit pas perdre les autres.
  assertEquals(textToIntervals("9h-12h, 14:00-19:00"), [["14:00", "19:00"]]);
  // Intervalle inversé : une plage qui finit avant de commencer génèrerait
  // zéro créneau sans que personne comprenne pourquoi.
  assertEquals(textToIntervals("19:00-09:00"), []);
  assertEquals(textToIntervals("n'importe quoi"), []);
});

Deno.test("horaires : chaîne vide = jour de fermeture", () => {
  assertEquals(textToIntervals(""), []);
  assertEquals(textToIntervals(null), []);
  assertEquals(intervalsToText(undefined), "");
});

// ============================================================
// Prestations
// ============================================================

Deno.test("prestations : aller-retour texte ⇄ structure", () => {
  const services = [
    { name: "Épilation laser jambes entières", duration_min: 45 },
    { name: "Soin du visage", duration_min: 75 },
  ];
  const text = "Épilation laser jambes entières : 45\nSoin du visage : 75";

  assertEquals(servicesToText(services), text);
  assertEquals(textToServices(text), services);
});

Deno.test("prestations : découpe sur le dernier deux-points", () => {
  // Un libellé peut contenir un « : ».
  assertEquals(textToServices("Forfait : 6 séances : 45"), [
    { name: "Forfait : 6 séances", duration_min: 45 },
  ]);
});

Deno.test("prestations : lignes incomplètes écartées", () => {
  assertEquals(
    textToServices("Sans durée\nSoin : abc\nVide : 0\nNégatif : -10\nValide : 30"),
    [{ name: "Valide", duration_min: 30 }],
  );
});

// ============================================================
// Script de qualification
// ============================================================

Deno.test("questions : aller-retour texte ⇄ structure", () => {
  const text = "prestation | Quelle prestation vous intéresse ?\ntelephone | Votre numéro ?";
  const questions = textToQuestions(text);

  assertEquals(questions, [
    { id: "q1", field: "prestation", prompt: "Quelle prestation vous intéresse ?" },
    { id: "q2", field: "telephone", prompt: "Votre numéro ?" },
  ]);
  assertEquals(questionsToText(questions), text);
});

Deno.test("questions : le nom de champ est normalisé", () => {
  // Le champ devient une clé JSON ET une valeur d'énumération dans le schéma
  // d'outil envoyé au modèle : ni accent, ni espace, ni majuscule.
  assertEquals(
    textToQuestions("Disponibilité Souhaitée | Quand êtes-vous libre ?")[0].field,
    "disponibilite_souhaitee",
  );
  assertEquals(textToQuestions("  ZONE  | Où ?")[0].field, "zone");
});

Deno.test("questions : une question peut contenir une barre verticale", () => {
  assertEquals(
    textToQuestions("budget | Votre budget : 200 | 500 | plus ?")[0].prompt,
    "Votre budget : 200 | 500 | plus ?",
  );
});

Deno.test("questions : lignes incomplètes écartées", () => {
  assertEquals(textToQuestions("pas de séparateur"), []);
  assertEquals(textToQuestions("champ |"), []);
  assertEquals(textToQuestions("| question sans champ"), []);
  assertEquals(textToQuestions(""), []);
});

Deno.test("questions : les identifiants restent séquentiels après filtrage", () => {
  const questions = textToQuestions("a | Première ?\nligne invalide\nb | Deuxième ?");
  assertEquals(questions.map((q) => q.field), ["a", "b"]);
});

Deno.test("duplicateFields repère les champs en double", () => {
  // Deux questions sur le même champ : la seconde réponse écraserait la
  // première, sans erreur visible.
  assertEquals(
    duplicateFields(textToQuestions("zone | Où ?\nzone | Quelle zone ?\nbudget | Combien ?")),
    ["zone"],
  );
  assertEquals(duplicateFields(textToQuestions("a | A ?\nb | B ?")), []);
});

// ============================================================
// Mots-clés d'escalade
// ============================================================

Deno.test("mots-clés : séparés par virgules, espaces ignorés", () => {
  assertEquals(textToKeywords(" grossesse ,  remboursement,, avocat "), [
    "grossesse",
    "remboursement",
    "avocat",
  ]);
  assertEquals(textToKeywords(""), []);
});

// ============================================================
// Conservation
// ============================================================

Deno.test("conservation : la valeur par défaut se lit « environ 3 ans »", () => {
  // 1095 jours est la recommandation CNIL. Le champ affiche des jours ; sans
  // ce repère, personne ne sait ce qu'il vient de régler.
  assertEquals(describeRetention(1095), "environ 3 ans");
});

Deno.test("conservation : bornes du réglage", () => {
  assertEquals(describeRetention(30), "environ 1 mois");
  assertEquals(describeRetention(365), "environ 1 an");
  assertEquals(describeRetention(3650), "environ 10 ans");
});

Deno.test("conservation : la demi-année ne s'arrondit pas à l'année", () => {
  // 547 jours ≈ 1,5 an. Afficher « environ 2 ans » ferait croire à une
  // conservation plus longue que celle réellement enregistrée.
  assertEquals(describeRetention(547), "environ 1.5 ans");
});

Deno.test("conservation : saisie invalide, jamais NaN à l'écran", () => {
  assertEquals(describeRetention(Number.NaN), "—");
  assertEquals(describeRetention(undefined), "—");
});
