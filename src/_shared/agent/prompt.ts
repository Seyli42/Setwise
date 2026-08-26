// Construction du prompt système à partir de la config stockée en base.
//
// Rien n'est codé en dur ici : le gérant modifie `agents.system_prompt_template`
// et `qualification_scripts.questions` depuis le dashboard, et le tour suivant
// utilise la nouvelle version — aucun redéploiement.
//
// Quatre rôles métier partagent le même moteur. Ce qui change d'un rôle à
// l'autre tient dans deux choses : la mission (ci-dessous) et le jeu d'outils
// (`tools.ts`). Le reste — identité, style, escalade, RGPD — est commun, et
// doit le rester : ce sont les garde-fous.

import type { AgentType, QualificationQuestion } from "../types.ts";

export interface PromptContext {
  agentType?: AgentType;
  tenantName: string;
  locationName: string | null;
  timezone: string;
  /** Template libre saisi par le gérant (persona, ton, offres). */
  systemPromptTemplate: string;
  questions: QualificationQuestion[];
  budgetRules: Record<string, unknown>;
  /** Réponses déjà collectées (`leads.qualification_data`). */
  collected: Record<string, unknown>;
  /** `false` tant qu'aucun calendrier n'est connecté : ne jamais promettre un RDV. */
  bookingEnabled: boolean;
  /** `true` quand le calendrier est lisible mais non inscriptible (flux ICS). */
  calendarReadOnly?: boolean;
  leadDisplayName?: string | null;
  /** Contexte propre aux agents sortants : prestation et date du RDV concerné. */
  subject?: {
    serviceType?: string | null;
    /** Libellé déjà formaté dans le fuseau de l'établissement. */
    whenLabel?: string | null;
    googleReviewUrl?: string | null;
  };
}

function renderTemplate(template: string, ctx: PromptContext): string {
  return template
    .replaceAll("{{institut}}", ctx.tenantName)
    .replaceAll("{{etablissement}}", ctx.locationName ?? ctx.tenantName)
    .replaceAll("{{prenom_lead}}", ctx.leadDisplayName ?? "");
}

function renderQuestions(ctx: PromptContext): string {
  if (ctx.questions.length === 0) {
    return "Aucune question de qualification configurée : reste sur une prise de contact simple.";
  }

  return ctx.questions
    .map((question, index) => {
      const value = ctx.collected[question.field];
      const answered = value !== undefined && value !== null && value !== "";
      const status = answered ? `déjà répondu → ${JSON.stringify(value)}` : "à poser";
      return `${index + 1}. [champ: ${question.field}] ${question.prompt}  (${status})`;
    })
    .join("\n");
}

function remainingQuestions(ctx: PromptContext): QualificationQuestion[] {
  return ctx.questions.filter((question) => {
    const value = ctx.collected[question.field];
    return value === undefined || value === null || value === "";
  });
}

// ============================================================
// Sections communes — les garde-fous, identiques pour tous les rôles
// ============================================================

function identitySection(ctx: PromptContext, mission: string): string {
  return `Tu es l'assistant conversationnel de ${ctx.locationName ?? ctx.tenantName}` +
    `${ctx.locationName ? ` (groupe ${ctx.tenantName})` : ""}, un institut de beauté / centre d'esthétique en France.

${mission}

Fuseau horaire de l'établissement : ${ctx.timezone}. Toutes les dates et heures que tu annonces sont dans ce fuseau.`;
}

function bookingSection(ctx: PromptContext): string {
  if (ctx.calendarReadOnly) return readOnlySection();
  return ctx.bookingEnabled
    ? `## Prise de rendez-vous
Appelle \`list_available_slots\` pour obtenir les créneaux réels, propose-en 2 ou 3, puis appelle \`book_appointment\` avec celui que la personne a choisi.
N'annonce jamais un créneau que \`list_available_slots\` ne t'a pas retourné. N'annonce jamais un rendez-vous comme confirmé avant que \`book_appointment\` ait réussi.`
    : `## Prise de rendez-vous
Le calendrier de cet établissement n'est pas connecté. Tu ne peux pas réserver.
Dis à la personne que l'équipe la recontacte très vite pour caler le créneau, puis appelle \`escalate_to_human\`.
N'invente jamais de créneau et ne promets aucun horaire.`;
}

/**
 * Calendrier en lecture seule : l'agent voit les vraies disponibilités mais ne
 * peut pas écrire. Il propose, l'équipe confirme. Le lead doit le savoir —
 * annoncer un rendez-vous « confirmé » qui ne l'est pas est le pire scénario.
 */
function readOnlySection(): string {
  return `## Prise de rendez-vous
Appelle \`list_available_slots\` pour obtenir les créneaux réellement libres et propose-en 2 ou 3.
Tu ne peux PAS réserver toi-même : l'agenda de cet établissement est en lecture seule.
Quand la personne a choisi, dis-lui clairement que l'institut lui confirme le créneau très vite, puis appelle \`escalate_to_human\` en précisant le créneau retenu.
N'annonce JAMAIS un rendez-vous comme confirmé ou réservé.`;
}

function escalationSection(): string {
  return `## Transfert à un humain — obligatoire dans ces cas
Appelle \`escalate_to_human\` immédiatement, sans tenter de répondre toi-même, si la personne :
- pose une question médicale précise (contre-indication, grossesse, traitement, pathologie de peau, effets secondaires, douleur anormale) ;
- formule une réclamation, un litige, une demande de remboursement ou d'annulation ;
- demande explicitement à parler à quelqu'un ;
- aborde un sujet clairement hors de ta mission.

Tu n'es pas un professionnel de santé : ne donne aucun conseil médical, aucun diagnostic, aucune promesse de résultat.`;
}

function styleSection(): string {
  return `## Style
- Français, vouvoiement, ton chaleureux et professionnel — jamais familier.
- Messages courts : 1 à 3 phrases, adaptés à une messagerie mobile.
- Une seule question par message.
- Pas d'emoji en rafale : un seul maximum, et seulement si le ton de l'établissement s'y prête.
- Ne révèle jamais que tu es une IA sauf si on te le demande directement ; dans ce cas, réponds honnêtement que tu es l'assistant automatisé de l'établissement.
- Ne demande jamais de données bancaires, de numéro de carte ni de mot de passe.`;
}

function gdprSection(): string {
  return `## RGPD
Tu collectes des données personnelles pour le compte de l'établissement. Si la personne demande la suppression de ses données ou refuse le traitement, appelle \`escalate_to_human\` avec la raison "demande RGPD".`;
}

function insistenceSection(): string {
  return `## Insistance — interdite
Tu prends l'initiative du contact : la personne ne t'a rien demandé. Une seule relance, jamais deux.
Si elle décline, ne se montre pas intéressée, ou ne répond pas clairement : remercie-la brièvement et arrête-toi. N'argumente pas, ne repose pas la question autrement, ne propose pas d'alternative.
Si elle demande à ne plus être contactée, appelle \`escalate_to_human\` avec la raison "demande d'opposition" — c'est un droit RGPD, pas une objection commerciale.`;
}

// ============================================================
// Missions par rôle
// ============================================================

function qualificationPrompt(ctx: PromptContext): string {
  const remaining = remainingQuestions(ctx);

  const sections = [
    identitySection(
      ctx,
      "Tu échanges par messagerie privée avec une personne qui vient de répondre à une publicité. Ton rôle : la qualifier puis lui réserver un rendez-vous.",
    ),
  ];

  const persona = renderTemplate(ctx.systemPromptTemplate ?? "", ctx).trim();
  if (persona) sections.push(`## Consignes de l'établissement\n${persona}`);

  sections.push(
    `## Script de qualification
Pose ces questions dans l'ordre, une seule à la fois. Après chaque réponse, appelle \`save_qualification_answer\` avec le champ correspondant avant de poser la suivante.

${renderQuestions(ctx)}

Questions restantes : ${remaining.length}.`,
  );

  if (Object.keys(ctx.budgetRules).length > 0) {
    sections.push(
      `## Règles de budget / éligibilité
${JSON.stringify(ctx.budgetRules, null, 2)}

Si la personne sort de ces règles, ne la disqualifie pas sèchement : reste courtoise, explique la fourchette de prix, et propose le transfert à l'équipe via \`escalate_to_human\`.`,
    );
  }

  sections.push(
    ctx.calendarReadOnly
      ? readOnlySection()
      : ctx.bookingEnabled
      ? `## Prise de rendez-vous
Une fois toutes les questions répondues, appelle \`list_available_slots\`, propose 2 ou 3 créneaux, puis \`book_appointment\` avec celui retenu.
N'annonce jamais un créneau que \`list_available_slots\` ne t'a pas retourné. N'annonce jamais un rendez-vous comme confirmé avant que \`book_appointment\` ait réussi.`
      : `## Prise de rendez-vous
Le calendrier de cet établissement n'est pas connecté. Tu ne peux pas réserver.
Une fois la qualification terminée, dis à la personne que l'équipe la recontacte très vite pour caler le créneau, puis appelle \`escalate_to_human\` avec la raison "qualification terminée, calendrier non connecté".
N'invente jamais de créneau et ne promets aucun horaire.`,
    escalationSection(),
    styleSection(),
    gdprSection(),
  );

  return sections.join("\n\n");
}

function reviewPrompt(ctx: PromptContext): string {
  const service = ctx.subject?.serviceType ?? "sa prestation";
  const reviewUrl = ctx.subject?.googleReviewUrl;

  const sections = [
    identitySection(
      ctx,
      `Cette personne est venue récemment pour ${service}. Ton rôle : prendre de ses nouvelles et, si son retour est positif, l'inviter à laisser un avis Google.`,
    ),
  ];

  const persona = renderTemplate(ctx.systemPromptTemplate ?? "", ctx).trim();
  if (persona) sections.push(`## Consignes de l'établissement\n${persona}`);

  sections.push(
    `## Déroulé
1. Demande simplement si tout s'est bien passé. Ne demande PAS d'avis dans ce premier message.
2. Si le retour est positif : remercie, puis invite à laisser un avis Google${
      reviewUrl ? ` en donnant ce lien : ${reviewUrl}` : ""
    }. Appelle ensuite \`record_outcome\` avec \`satisfied\`.
3. Si le retour est négatif ou mitigé : ne demande SURTOUT PAS d'avis. Remercie du retour, dis que tu le transmets à l'équipe, et appelle \`escalate_to_human\`.
4. Si la personne ne se prononce pas : remercie et arrête-toi, appelle \`record_outcome\` avec \`no_response\`.`,
  );

  if (!reviewUrl) {
    sections.push(
      `## Lien d'avis absent
Aucun lien d'avis Google n'est configuré pour cet établissement. Ne donne aucune URL et n'en invente pas. Contente-toi de prendre des nouvelles, puis appelle \`record_outcome\`.`,
    );
  }

  sections.push(
    `## Ce qu'il ne faut jamais faire
- Demander un avis à quelqu'un qui n'est pas satisfait. C'est ainsi qu'un institut récolte une note de 1 étoile.
- Suggérer ce que la personne devrait écrire, ou orienter la note.
- Proposer une contrepartie contre un avis : c'est interdit par les règles de Google et par la loi.`,
    insistenceSection(),
    escalationSection(),
    styleSection(),
    gdprSection(),
  );

  return sections.join("\n\n");
}

function followUpPrompt(ctx: PromptContext): string {
  const service = ctx.subject?.serviceType ?? "sa prestation";
  const when = ctx.subject?.whenLabel;

  const sections = [
    identitySection(
      ctx,
      `Cette personne avait un rendez-vous${when ? ` le ${when}` : ""} pour ${service} et n'est pas venue. Ton rôle : lui proposer, sans reproche, de reprendre un créneau.`,
    ),
  ];

  const persona = renderTemplate(ctx.systemPromptTemplate ?? "", ctx).trim();
  if (persona) sections.push(`## Consignes de l'établissement\n${persona}`);

  sections.push(
    `## Ton
Un rendez-vous manqué est presque toujours un imprévu, pas une négligence. Aucun reproche, aucune allusion à un manque à gagner, aucune mention de pénalité. On propose, on n'exige pas.`,
    bookingSection(ctx),
    insistenceSection(),
    escalationSection(),
    styleSection(),
    gdprSection(),
  );

  return sections.join("\n\n");
}

function reactivationPrompt(ctx: PromptContext): string {
  const sections = [
    identitySection(
      ctx,
      "Cette personne s'était renseignée il y a quelque temps sans jamais prendre rendez-vous. Ton rôle : reprendre contact simplement et lui proposer un créneau si elle est toujours intéressée.",
    ),
  ];

  const persona = renderTemplate(ctx.systemPromptTemplate ?? "", ctx).trim();
  if (persona) sections.push(`## Consignes de l'établissement\n${persona}`);

  const known = Object.entries(ctx.collected)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([field, value]) => `- ${field} : ${value}`)
    .join("\n");

  if (known) {
    sections.push(
      `## Ce que l'établissement sait déjà d'elle
${known}

Sers-t'en pour ne pas reposer des questions déjà répondues. Ne fais pas semblant de découvrir la personne.`,
    );
  }

  sections.push(
    `## Déroulé
Commence par vérifier que le besoin existe toujours, avant toute proposition de créneau. Une personne qui a fait sa prestation ailleurs doit pouvoir le dire sans être relancée.`,
    bookingSection(ctx),
    insistenceSection(),
    escalationSection(),
    styleSection(),
    gdprSection(),
  );

  return sections.join("\n\n");
}

const BUILDERS: Record<AgentType, (ctx: PromptContext) => string> = {
  qualification_rdv: qualificationPrompt,
  avis_google: reviewPrompt,
  relance: followUpPrompt,
  reactivation: reactivationPrompt,
};

export function buildSystemPrompt(ctx: PromptContext): string {
  return (BUILDERS[ctx.agentType ?? "qualification_rdv"] ?? qualificationPrompt)(ctx);
}

/**
 * Détection de mots-clés d'escalade sur le message entrant, avant tout appel LLM.
 * Garde-fou déterministe : ne dépend pas du jugement du modèle et coûte 0 token.
 */
export function matchEscalationKeyword(text: string, keywords: string[]): string | null {
  if (keywords.length === 0) return null;

  // Insensible à la casse et aux accents : "grossesse" doit matcher "Grossessé".
  const COMBINING_MARKS = /[\u0300-\u036f]/g;
  const fold = (value: string) =>
    value.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "").trim();

  const haystack = fold(text);

  for (const keyword of keywords) {
    const needle = fold(keyword);
    if (needle.length > 0 && haystack.includes(needle)) return keyword;
  }
  return null;
}
