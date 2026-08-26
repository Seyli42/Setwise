// Rédaction des alertes au gérant.
//
// Séparé de `notifications.ts` pour une raison précise : ce dernier importe le
// client service_role, qui exige des secrets au chargement du module. Une
// fonction pure décidant de ce qui sort de l'entreprise doit rester testable
// sans environnement.
//
// Ce qui est écrit ici part vers une boîte mail que nous ne maîtrisons pas, via
// un prestataire tiers. D'où la règle : le motif d'escalade, et rien d'autre.
// Ni le nom de la cliente, ni son numéro, ni le contenu de ses messages — le
// gérant les trouvera dans le dashboard, derrière son authentification.

export interface AlertSubject {
  kind: string;
  payload: Record<string, unknown>;
}

/** Motif lisible, quel que soit l'état du payload. */
function readReason(payload: Record<string, unknown>): string {
  return typeof payload.reason === "string" && payload.reason.trim() !== ""
    ? payload.reason
    : "motif non précisé";
}

export function compose(subject: AlertSubject): { subject: string; body: string } {
  const reason = readReason(subject.payload);

  if (subject.kind === "invitation") {
    // Aucun lien porteur de secret : l'acceptation se fait en base, appariée
    // sur l'adresse vérifiée par le lien magique. Rien à voler dans cet e-mail.
    const institute = typeof subject.payload.tenant_name === "string"
      ? subject.payload.tenant_name
      : "un institut";

    return {
      subject: `Setwise — ${institute} vous invite à rejoindre son équipe`,
      body: `Vous êtes invitée à rejoindre ${institute} sur Setwise.\n\n` +
        "Connectez-vous au tableau de bord avec CETTE adresse e-mail : " +
        "l'invitation vous y attend, il suffira de l'accepter.\n\n" +
        "Elle expire dans quatorze jours.",
    };
  }

  if (subject.kind === "escalation_stale") {
    return {
      subject: "Setwise — une conversation attend toujours",
      body: "Une conversation transférée n'a pas encore de réponse.\n\n" +
        `Motif : ${reason}\n\n` +
        "Votre agent s'est tu et attend que vous repreniez la main. " +
        "Ouvrez le tableau de bord, onglet Conversations.",
    };
  }

  // Nature inconnue : alerte générique plutôt que silence. Une nature ajoutée
  // un jour sans passer ici doit réveiller le gérant, pas disparaître.
  return {
    subject: "Setwise — une conversation demande votre attention",
    body: "Votre agent vient de transférer une conversation.\n\n" +
      `Motif : ${reason}\n\n` +
      "Il ne répondra plus dans ce fil tant que vous n'aurez pas rendu la main. " +
      "Ouvrez le tableau de bord, onglet Conversations.",
  };
}

/** Variables positionnelles du modèle WhatsApp d'alerte : {{1}} état, {{2}} motif. */
export function templateParameters(subject: AlertSubject): string[] {
  return [
    subject.kind === "escalation_stale" ? "toujours en attente" : "à reprendre",
    readReason(subject.payload).slice(0, 200),
  ];
}
