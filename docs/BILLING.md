# Facturation — Stripe Billing

## Ce qui compte ici

Encaisser est la partie facile. La partie qui décide si le produit est viable,
c'est le **downgrade automatique** : un institut qui ne paie plus doit voir son
agent s'arrêter, sans intervention.

Et « s'arrêter » demande une décision, pas un `if` :

| Option | Effet |
|---|---|
| L'agent continue de répondre | service rendu gratuitement, indéfiniment |
| L'agent se tait sans trace | les leads de l'institut restent sans réponse, il perd des clients **sans savoir pourquoi** |
| **Retenu : l'agent se tait, chaque message ouvre une escalade** | le message est conservé, le gérant voit exactement ce qu'il rate |

La troisième option est la seule qui ne fasse de tort ni au lead, ni à
l'institut, ni à nous. La page Abonnement affiche le compteur des conversations
en attente : c'est aussi le meilleur argument de réactivation.

## Où la décision est prise

Une seule fonction SQL, `tenant_billing_state(tenant_id)`, appelée par le
dashboard (affichage) **et** par le dispatcher (coupure). Deux implémentations
divergeraient tôt ou tard, et la divergence se paierait soit en service offert,
soit en institut coupé à tort.

```
webhook Meta ─▶ queue ─▶ dispatcher ─▶ tenant_billing_state()
                                            │
                             actif ─────────┴───────── inactif
                               │                          │
                          runAgentTurn()          runAgentTurn({ suspended })
                                                   message enregistré
                                                   escalade ouverte
                                                   aucun appel modèle
                                                   aucune réponse envoyée
```

Le moteur d'agent ne connaît pas la facturation : il reçoit un drapeau
`suspended`. C'est le dispatcher qui interroge l'état.

## Politique par statut

| Statut Stripe | Agent | Pourquoi |
|---|---|---|
| `trialing`, `active` | actif | |
| `past_due` | **actif** | Stripe relance le paiement pendant ~3 semaines. Couper au premier refus punirait un institut pour une carte expirée — et lui ferait perdre des clients pour 97 €. |
| `unpaid`, `canceled`, `incomplete_expired`, `paused` | suspendu | |
| aucun abonnement | essai depuis la création du compte, puis suspendu | |

L'essai n'est offert **qu'une fois** : `trial_period_days` n'est envoyé à
Checkout que si l'institut n'a jamais eu d'abonnement. Sans ce contrôle, un
cycle résiliation / réabonnement donnerait un mois gratuit à répétition.

## Stripe est la source de vérité

Aucun statut n'est déduit d'un enchaînement d'events : ils arrivent dans le
désordre et peuvent être rejoués. À chaque event pertinent, on **relit** l'objet
`subscription` complet et on l'écrit tel quel.

`invoice.payment_failed` ne fait pas passer l'abonnement en impayé de notre
propre chef — on relit l'abonnement et on prend le statut que Stripe donne.

Idempotence : l'`event.id` est inséré dans `webhook_events` sous contrainte
d'unicité. Un rejeu est acquitté sans retraitement.

## Ce qui ne touche jamais nos serveurs

Aucune donnée bancaire. Le paiement se fait sur **Stripe Checkout**, la gestion
(moyen de paiement, factures, résiliation) sur le **portail client Stripe**.

Les URL de retour passées à Stripe sont validées contre `DASHBOARD_ORIGIN` :
sans ce contrôle, un attaquant pourrait faire rediriger un gérant depuis une
page Stripe légitime vers un site qu'il contrôle.

## Configuration

### Secrets Edge Functions

| Secret | Usage |
|---|---|
| `STRIPE_SECRET_KEY` | appels API |
| `STRIPE_WEBHOOK_SECRET` | vérification de signature (`whsec_…`) |
| `STRIPE_API_VERSION` | facultatif |
| `DASHBOARD_ORIGIN` | origines autorisées pour les URL de retour, séparées par des virgules |

### Côté Stripe

1. Créer un produit et trois tarifs mensuels récurrents.
2. Reporter les `price_…` dans la table `plans` (la migration `0006` insère des
   gabarits `price_REMPLACER_*` à mettre à jour) :

```sql
update plans set stripe_price_id = 'price_1AbC…' where id = 'starter';
```

3. Endpoint webhook → `https://<ref>.supabase.co/functions/v1/webhook-stripe`,
   abonné à : `checkout.session.completed`,
   `customer.subscription.created|updated|deleted|paused|resumed`,
   `invoice.paid`, `invoice.payment_failed`.
4. Activer le portail client (Settings → Billing → Customer portal).

### Déploiement

```bash
supabase db push
supabase functions deploy webhook-stripe --no-verify-jwt
supabase functions deploy dashboard-api
```

`--no-verify-jwt` sur le webhook : Stripe n'envoie pas de JWT Supabase.
L'authentification est la signature `stripe-signature`.

## Tester

Bac à sable Stripe, avec la CLI :

```bash
stripe listen --forward-to http://localhost:54321/functions/v1/webhook-stripe
stripe trigger checkout.session.completed
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.deleted
```

Vérifier après chaque event :

```sql
select status, plan, current_period_end, cancel_at_period_end from subscriptions;
select tenant_billing_state('<tenant-id>');
```

Vérifier la coupure de bout en bout : passer l'abonnement en `canceled`, envoyer
un message Instagram de test, puis constater qu'aucune réponse n'est partie et
qu'une escalade « Agent suspendu » est ouverte.

## Limites connues

- **Rien n'est testé automatiquement ici.** Les chemins Stripe supposent un
  compte et des webhooks réels ; il n'y a pas de test unitaire pour cette
  étape, contrairement aux créneaux et aux parseurs. Le scénario CLI ci-dessus
  est la procédure de validation.
- **Migrations non exécutées** contre un Postgres réel (Docker indisponible dans
  l'environnement de développement). `supabase db reset` requis avant
  déploiement.
- **`max_locations` n'est pas appliqué.** La colonne existe, aucun contrôle
  n'empêche encore de dépasser le quota de sa formule.
- **Pas de relance avant expiration d'essai.** Un e-mail à J-3 relève de
  l'étape 7.
- **Changement de formule** passe par le portail Stripe, sans proratisation
  configurée côté Setwise — le comportement est celui par défaut de Stripe.
