# Les quatre rôles

Un rôle = **un prompt de mission + un jeu d'outils**. Le moteur d'exécution
(`_shared/agent/engine.ts`) est le même pour les quatre : même boucle, même
dédup, mêmes garde-fous, même persistance.

C'était la promesse de l'architecture initiale. Ajouter les trois rôles V2 n'a
demandé aucune modification du moteur — seulement `prompt.ts` (missions),
`tools.ts` (jeux d'outils) et un déclencheur.

| Rôle | Déclencheur | Réserve ? | Requalifie ? |
|---|---|---|---|
| `qualification_rdv` | message entrant | ✅ | ✅ |
| `avis_google` | RDV honoré, 2 h à 72 h après | ❌ | ❌ |
| `relance` | absence signalée, ≤ 7 jours | ✅ | ❌ |
| `reactivation` | lead qualifié sans RDV, délai configuré | ✅ | ✅ |

## Entrant contre sortant

`qualification_rdv` répond. Les trois autres **initient**. Trois conséquences,
appliquées dans `_shared/outbound.ts`.

**La fenêtre Meta de 24 h est fermée par construction.** Le premier message
passe donc obligatoirement par un modèle approuvé. Si la personne répond, la
fenêtre s'ouvre et l'agent reprend en conversation libre.

**La personne n'a rien demandé.** Une seule sollicitation par sujet
(`outbound_touches`, contrainte d'unicité sur `agent_type` + `subject_id`), et
aucun rejeu automatique en cas d'échec : pour un message non sollicité, ne rien
envoyer vaut mieux qu'envoyer deux fois. Le prompt de chaque rôle sortant porte
une clause d'insistance explicite — une relance, jamais deux.

**Un abonnement suspendu n'envoie rien.** Consommer la réputation WhatsApp d'un
institut qui ne paie plus serait le pire des deux mondes.

## Routage des réponses

Une conversation ouverte par un agent sortant reste servie par **ce** rôle.
`conversations.agent_id` porte l'information, `runAgentTurn` re-résout l'agent
si la conversation en désigne un autre que celui par défaut.

Sans ce routage, une réponse à une demande d'avis retomberait sur l'agent de
qualification, qui se mettrait à poser des questions de découverte à quelqu'un
qui sort de séance.

## Cycle de vie d'un rendez-vous

```
confirmed ──(passé + 4 h, automatique)──▶ completed ──▶ cible « avis Google »
    │
    └──(le gérant signale)──────────────▶ no_show ────▶ cible « relance »
```

**Un rendez-vous passé est réputé honoré.** Aucun institut ne va pointer ses
rendez-vous un par un : demander au gérant de signaler l'exception (l'absence)
plutôt que la règle est le seul protocole qu'il suivra. Le bouton « Absence »
de la page Rendez-vous est donc ce qui alimente l'agent de relance.

## `avis_google` — le rôle le plus risqué

Un agent qui demande un avis au mauvais moment fait perdre des étoiles à
l'institut. Quatre garde-fous, tous verrouillés par des tests
(`agent/roles_test.ts`) :

1. **Pas d'outil de réservation.** Avec, il finirait par proposer un créneau à
   quelqu'un qui sort tout juste de séance.
2. **Demander d'abord si tout s'est bien passé**, jamais l'avis dans le premier
   message.
3. **Retour négatif → escalade, pas d'avis.** C'est ainsi qu'on récolte une
   note de 1 étoile.
4. **Aucune contrepartie** contre un avis : interdit par Google et par la loi.

Sans `agents.config.google_review_url`, l'agent a interdiction d'inventer une
URL — il prend simplement des nouvelles.

## Configuration

Dans `agents.config` de chaque agent :

```json
{
  "whatsapp_review_template": "setwise_avis",
  "whatsapp_followup_template": "setwise_relance",
  "whatsapp_reactivation_template": "setwise_reactivation",
  "google_review_url": "https://g.page/r/…/review",
  "reactivation": { "after_days": 45 }
}
```

Tous les modèles portent trois variables : `{{1}}` prénom, `{{2}}` prestation,
`{{3}}` date de référence. Sans modèle configuré, la campagne est **sautée** et
tracée comme telle — Meta refuserait un message libre hors fenêtre, et échouer
en silence à chaque passage du cron n'aiderait personne.

## Créer un agent V2

Aucun code à écrire pour un institut : insérer une ligne `agents` avec le
`type` voulu, un `system_prompt_template` et la config ci-dessus. Le cron
`outbound-cron` le prend en compte au passage suivant.

```sql
insert into agents (tenant_id, type, name, system_prompt_template, config, is_active)
values (
  '<tenant-id>',
  'avis_google',
  'Demande d''avis',
  'Reste chaleureuse et brève.',
  jsonb_build_object(
    'whatsapp_review_template', 'setwise_avis',
    'google_review_url', 'https://g.page/r/…/review'
  ),
  true
);
```

## Ajouter un cinquième rôle

1. Ajouter la valeur à l'enum `agent_type` (migration).
2. Écrire la mission dans `prompt.ts` et l'inscrire dans `BUILDERS`.
3. Choisir son jeu d'outils dans le `switch` de `buildTools`.
4. Pour un rôle sortant : une branche dans `claim_outbound_targets` et une
   entrée dans `TEMPLATE_CONFIG_KEY`.

Le moteur, la queue, la dédup, la facturation, l'escalade et la persistance ne
bougent pas.

## Tester

```bash
deno test --allow-env supabase/functions/_shared/agent/roles_test.ts
```

17 tests verrouillent ce qui distingue les rôles et, surtout, ce qu'ils ont en
commun : interdit médical, transfert humain, RGPD, refus d'annoncer un créneau
sans calendrier. Une régression sur ces points ne se voit pas à l'exécution —
elle se voit trois semaines plus tard, dans un avis Google à une étoile.

## Limites connues

- **Aucune campagne n'a été exécutée pour de vrai.** Les cibles, l'anti-doublon
  et les prompts sont testés ; l'envoi effectif suppose des modèles WhatsApp
  approuvés et un compte Meta en production.
- **`settle_past_appointments` ne distingue pas une annulation d'un no-show.**
  Un rendez-vous annulé à l'avance doit être passé en `cancelled` à la main,
  sinon il est réputé honoré et déclenche une demande d'avis.
- **Pas de fenêtre horaire par institut** : le cron tourne de 9 h à 19 h, heure
  serveur, pour tout le monde.
