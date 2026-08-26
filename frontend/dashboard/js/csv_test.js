// Tests de l'export CSV.
//
// Ce qui est testé ici est ce dont l'échec serait invisible : un fichier
// s'ouvre, les colonnes sont là, et pourtant une formule s'exécute ou les
// accents sont illisibles. Personne ne s'en aperçoit avant l'incident.
//
// Lancer : deno test frontend/dashboard/js/csv_test.js

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { csvFilename, escapeCell, toCsv } from "./csv.js";

// ============================================================
// Injection de formule
// ============================================================

Deno.test("injection : les quatre caractères de tête sont neutralisés", () => {
  // Le scénario réel : un lead Instagram choisit son nom d'affichage.
  assertEquals(escapeCell("=cmd|'/c calc'!A1"), `"'=cmd|'/c calc'!A1"`);
  assertEquals(escapeCell("+1234"), `"'+1234"`);
  assertEquals(escapeCell("-1+1"), `"'-1+1"`);
  assertEquals(escapeCell("@SUM(A1:A9)"), `"'@SUM(A1:A9)"`);
});

Deno.test("injection : tabulation et retour chariot en tête aussi", () => {
  // Excel ignore un \t ou un \r de tête et évalue ce qui suit : sans cette
  // règle, "\t=1+1" passe à travers la protection ci-dessus.
  assertEquals(escapeCell("\t=1+1"), `"'\t=1+1"`);
  assertEquals(escapeCell("\r=1+1"), `"'\r=1+1"`);
});

Deno.test("injection : un texte ordinaire n'est pas altéré", () => {
  // Une protection qui déforme les données légitimes est un bug, pas une
  // protection. Un tiret au milieu, un plus au milieu : rien à neutraliser.
  assertEquals(escapeCell("Clémence Dubois"), `"Clémence Dubois"`);
  assertEquals(escapeCell("Épilation - jambes"), `"Épilation - jambes"`);
  assertEquals(escapeCell("06 12 34 56 78"), `"06 12 34 56 78"`);
});

Deno.test("injection : un numéro au format international garde son plus", () => {
  // +33612345678 est un vrai numéro, pas une formule — mais Excel le traite
  // comme telle. Le préfixe est donc correct ET le numéro reste lisible.
  assertEquals(escapeCell("+33612345678"), `"'+33612345678"`);
});

// ============================================================
// Guillemetage
// ============================================================

Deno.test("guillemets : doublés, virgules et sauts de ligne préservés", () => {
  assertEquals(escapeCell('Elle a dit "oui"'), `"Elle a dit ""oui"""`);
  assertEquals(escapeCell("Paris, France"), `"Paris, France"`);
  assertEquals(escapeCell("ligne 1\nligne 2"), `"ligne 1\nligne 2"`);
});

Deno.test("vide : null et undefined donnent une cellule vide, pas 'null'", () => {
  assertEquals(escapeCell(null), "");
  assertEquals(escapeCell(undefined), "");
  assertEquals(escapeCell(""), `""`);
});

Deno.test("nombres et booléens sont sérialisés sans surprise", () => {
  assertEquals(escapeCell(0), `"0"`);
  assertEquals(escapeCell(false), `"false"`);
});

// ============================================================
// Document complet
// ============================================================

Deno.test("csv : BOM en tête, CRLF entre les lignes", () => {
  const csv = toCsv(["Nom", "Statut"], [["Camille", "qualified"]]);

  assert(csv.startsWith("﻿"), "le BOM UTF-8 manque : Excel affichera ClÃ©mence");
  assertEquals(csv, '﻿"Nom","Statut"\r\n"Camille","qualified"\r\n');
});

Deno.test("csv : un export sans ligne garde ses en-têtes", () => {
  // Un fichier vide laisserait croire à un échec de l'export.
  assertEquals(toCsv(["Nom"], []), '﻿"Nom"\r\n');
});

Deno.test("csv : une ligne hostile ne casse pas la structure", () => {
  const csv = toCsv(
    ["Contact", "Note"],
    [["=1+1", 'Dit "non", puis part']],
  );
  const lines = csv.split("\r\n");

  assertEquals(lines.length, 3); // en-tête, donnée, ligne finale vide
  assertStringIncludes(lines[1], `"'=1+1"`);
  assertStringIncludes(lines[1], `"Dit ""non"", puis part"`);
});

// ============================================================
// Nom de fichier
// ============================================================

Deno.test("nom de fichier : daté, triable, sans espace", () => {
  assertEquals(
    csvFilename("leads", new Date("2026-08-17T22:30:00Z")),
    "leads-2026-08-17.csv",
  );
});
