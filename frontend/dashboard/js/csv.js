// Export CSV.
//
// L'article 8 des conditions générales promet au client de pouvoir exporter ses
// données à tout moment ; l'article 20 du RGPD le lui doit de toute façon. Ce
// module est cette promesse.
//
// Deux dangers, tous deux traités ici :
//
//   1. L'INJECTION DE FORMULE. Un nom de lead vient d'un inconnu sur Instagram.
//      Un contact appelé `=cmd|'/c calc'!A1` s'exécute à l'ouverture du fichier
//      dans Excel ou LibreOffice. Le guillemetage CSV n'y change rien : le
//      champ est correctement cité, et la formule s'exécute quand même. La
//      seule parade est de neutraliser le caractère de tête.
//
//   2. L'ENCODAGE. Excel sous Windows lit un CSV en ANSI par défaut : sans BOM,
//      « Clémence » devient « ClÃ©mence ». Le BOM UTF-8 force la bonne lecture,
//      et les autres tableurs l'ignorent.

/** Caractères qui font d'un champ une formule pour un tableur. */
const FORMULA_LEAD = new Set(["=", "+", "-", "@", "\t", "\r"]);

/**
 * Rend une valeur inoffensive puis la cite.
 *
 * L'apostrophe de tête est la neutralisation reconnue par Excel, LibreOffice et
 * Google Sheets : la cellule affiche le texte d'origine sans l'évaluer.
 */
export function escapeCell(value) {
  if (value === null || value === undefined) return "";

  let text = String(value);
  // Les sauts de ligne restent (le CSV les tolère entre guillemets), mais un
  // \r ou un \t en tête servirait à masquer le caractère dangereux qui suit.
  if (text.length > 0 && FORMULA_LEAD.has(text[0])) text = `'${text}`;

  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Construit un CSV. `rows` est un tableau de tableaux, aligné sur `headers`.
 *
 * CRLF et non LF : c'est ce qu'impose la RFC 4180, et le seul séparateur que
 * les vieux Excel acceptent sans broncher.
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(",")];
  for (const row of rows) lines.push(row.map(escapeCell).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** `leads-2026-08-17.csv` — triable, sans espace, sans collision. */
export function csvFilename(prefix, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  return `${prefix}-${day}.csv`;
}

/**
 * Déclenche le téléchargement. Isolé du reste pour que `toCsv` reste testable
 * sans DOM.
 *
 * L'URL objet est révoquée : sans cela, le contenu du fichier — noms et
 * téléphones de toutes les clientes — reste en mémoire jusqu'à la fermeture de
 * l'onglet.
 */
export function downloadCsv(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
