// Conversions entre la saisie libre du gérant et les structures stockées en base.
//
// Module volontairement sans aucune dépendance : ce sont ces fonctions qui
// transforment du texte tapé à la main en horaires d'ouverture et en script de
// qualification. Une erreur ici ne casse pas l'affichage — elle fait travailler
// l'agent avec de mauvaises règles, en silence. D'où l'isolation, et les tests.

const TIME_PATTERN = /^\d{1,2}:\d{2}$/;

function padTime(hhmm) {
  const [hours, minutes] = hhmm.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function toMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

// ============================================================
// Horaires d'ouverture
// ============================================================

/** `[["09:00","12:00"],["14:00","19:00"]]` → `"09:00-12:00, 14:00-19:00"`. */
export function intervalsToText(intervals) {
  return (intervals ?? []).map(([start, end]) => `${start}-${end}`).join(", ");
}

/**
 * `"9:00-12:00, 14:00 - 19:00"` → `[["09:00","12:00"],["14:00","19:00"]]`.
 *
 * Écarte silencieusement ce qui n'est pas exploitable (format libre, intervalle
 * inversé) plutôt que de rejeter toute la ligne : le gérant garde ses horaires
 * valides même s'il se trompe sur un.
 */
export function textToIntervals(text) {
  return String(text ?? "")
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => chunk.split("-").map((part) => part.trim()))
    .filter((parts) => parts.length === 2 && parts.every((p) => TIME_PATTERN.test(p)))
    .map(([start, end]) => [padTime(start), padTime(end)])
    .filter(([start, end]) => toMinutes(end) > toMinutes(start));
}

// ============================================================
// Prestations
// ============================================================

/** `[{name, duration_min}]` → une ligne `"Nom : 45"` par prestation. */
export function servicesToText(services) {
  return (services ?? []).map((service) => `${service.name} : ${service.duration_min}`).join("\n");
}

/**
 * Une ligne `"Épilation laser jambes : 45"` → `{name, duration_min}`.
 *
 * Découpe sur le DERNIER `:` : un libellé peut en contenir un
 * ("Forfait : 6 séances : 45").
 */
export function textToServices(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf(":");
      if (separator === -1) return null;

      const name = line.slice(0, separator).trim();
      const duration = Number.parseInt(line.slice(separator + 1).trim(), 10);

      return name && Number.isFinite(duration) && duration > 0
        ? { name, duration_min: duration }
        : null;
    })
    .filter(Boolean);
}

// ============================================================
// Script de qualification
// ============================================================

export function questionsToText(questions) {
  return (questions ?? []).map((question) => `${question.field} | ${question.prompt}`).join("\n");
}

/**
 * Une ligne `"telephone | À quel numéro peut-on vous joindre ?"` → question.
 *
 * Le nom de champ est normalisé (minuscules, `_`) parce qu'il devient une clé
 * de `leads.qualification_data` ET une valeur d'énumération dans le schéma
 * d'outil envoyé au modèle : un espace ou un accent y poserait problème.
 */
export function textToQuestions(text) {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [rawField, ...rest] = line.split("|");
      const field = rawField
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const prompt = rest.join("|").trim();

      return field && prompt ? { id: `q${index + 1}`, field, prompt } : null;
    })
    .filter(Boolean);
}

/** Renvoie les noms de champ en double, pour bloquer l'enregistrement. */
export function duplicateFields(questions) {
  const seen = new Set();
  const duplicates = new Set();

  for (const question of questions) {
    if (seen.has(question.field)) duplicates.add(question.field);
    seen.add(question.field);
  }
  return [...duplicates];
}

export function keywordsToText(keywords) {
  return (keywords ?? []).join(", ");
}

export function textToKeywords(text) {
  return String(text ?? "")
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

// ============================================================
// Conservation
// ============================================================

/**
 * Traduit une durée en jours en repère lisible.
 *
 * « 1095 jours » ne veut rien dire à une gérante d'institut ; « environ 3 ans »
 * si. Le champ reste en jours parce que c'est l'unité stockée et purgée, mais
 * il ne doit jamais être le seul repère affiché.
 */
export function describeRetention(days) {
  if (!Number.isFinite(days)) return "—";
  if (days < 30) return "moins d'un mois";
  if (days < 365) return `environ ${Math.round(days / 30)} mois`;

  const years = days / 365;
  return years === 1 ? "environ 1 an" : `environ ${years.toFixed(1).replace(".0", "")} ans`;
}
