# Setwise

SaaS multi-agents IA pour les instituts de beauté et cliniques d'esthétique non-invasive en France.

Un lead répond à une publicité Instagram. L'agent le qualifie en DM selon le script de l'institut, propose des créneaux réels tirés de son agenda, réserve, et bascule sur WhatsApp pour la confirmation et le rappel de la veille. Sans intervention humaine — sauf quand il faut en avoir une, et là il prévient le gérant.

## Architecture

```
Meta (Instagram DM / WhatsApp) ──webhook signé──▶ Serveur Deno (src/server.ts)
                                                        │ vérifie HMAC
                                                        │ met en queue
                                                        ▼ 200 en <100 ms
                                            webhook_events (Neon Serverless Postgres)
                                                        │ claim atomique (SKIP LOCKED)
                                                        ▼
                                                   dispatcher
                                         ┌──────────────┼──────────────┐
                                         ▼              ▼              ▼
                                   facturation      moteur         relais
                                   (coupure)        d'agent        WhatsApp
                                                        │
                                           ┌────────────┼────────────┐
                                           ▼            ▼            ▼
                                     script BDD   Claude Opus 5   Google
                                                    + outils      Calendar
```

Détail des choix dans [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Un agent = un rôle métier = un prompt système + un jeu d'outils.** Le moteur (`src/_shared/agent/engine.ts`) ne connaît ni le canal, ni la facturation, ni le fournisseur de calendrier.

Quatre rôles tournent aujourd'hui sur ce même moteur : qualification et prise de RDV, demande d'avis Google, relance des absences, réactivation des leads dormants — voir [`docs/AGENTS.md`](docs/AGENTS.md).

## Stack

| Couche | Techno |
|---|---|
| Données | **Neon Serverless PostgreSQL** (`DATABASE_URL`, pooler SSL) |
| Logique serveur | **Serveur Deno unifié** (`src/server.ts` : API REST, Webhooks, Crons, Worker) |
| Authentification | **Magic Link autonome par email** (Resend) + Sessions signées JWT (`jose`) |
| Modèle LLM | Claude 3.5 Sonnet / Opus via l'API Anthropic |
| Canaux | Meta Graph API (Instagram DM), WhatsApp Cloud API |
| Agenda | Google Calendar (lecture/écriture), flux ICS / Planity (lecture seule) |
| Paiement | Stripe Billing (Checkout & Portail client) |
| Dashboard | HTML/CSS/JS vanilla autonome sans dépendance externe |
| Hébergement | Serveur Deno / Docker (Deno Deploy, Fly.io, Railway, Render) + Dashboard statique |

## Arborescence

```
migrations/
├── 0001_initial_schema.sql  Schéma consolidé PostgreSQL pour Neon
├── 0002_setsmart_pricing.sql Grille tarifaire (Light / Pro / Scale)
├── 0003_restore_bounds.sql  Bornes de rétention et de délai de relance
├── 0004_rate_limits.sql     Compteur de débit en base (rate_limit_hit)
├── 0005_llm_usage.sql       Quota de conversations IA par formule
├── 0006_rls_roles.sql       Rôles setwise_app / setwise_worker, droits DML
└── 0007_rls_policies.sql    RLS : isolation multi-institut posée par la base
scripts/
└── migrate.ts               Applique les migrations en attente (MIGRATE_UNTIL pour s'arrêter à l'une d'elles)
src/
├── server.ts                Serveur HTTP Deno unifié (/webhooks/*, /api/*, /crons/*)
├── db.ts                    Deux connexions Neon : `sql` (rôle app, RLS) et `sqlWorker` (rôle système, BYPASSRLS), plus `withTenant`
├── auth.ts                  Authentification Magic Link (Resend) & vérification JWT
├── routes/
│   ├── webhooks.ts          Webhooks Meta (Instagram, WhatsApp) et Stripe
│   ├── auth.ts              Endpoints /api/auth/magic-link, verify, me
│   ├── dashboard.ts         Endpoints REST du tableau de bord & actions serveur
│   ├── crons.ts             Endpoints sécurisés pour les tâches planifiées
│   ├── tenant_scoping_test.ts Garde-fou statique : toute requête métier doit passer par `withTenant` ou être justifiée
│   └── rls_test.ts          Vérification RLS réelle (nécessite une base Neon — ignoré sinon)
└── _shared/
    ├── agent/               Moteur LLM, prompt, outils, mémoire conversationnelle
    ├── channels/            Instagram, WhatsApp, résolutions et OAuth Meta
    ├── calendar/            Créneaux, fuseaux, providers Google, ICS, Planity
    ├── rateLimit.ts         Limitation de débit (e-mail, IP, compte Meta, institut)
    └── *.ts                 Queue, facturation, rappels, campagnes, logs, erreurs
frontend/
├── dashboard/               Tableau de bord institut (HTML/CSS/JS vanilla)
└── site/                    Vitrine + mentions légales + confidentialité + CGV
docs/
├── ARCHITECTURE.md          Décisions techniques et migration Neon
├── AGENTS.md                Les quatre rôles d'agents
├── BILLING.md               Facturation Stripe et coupure automatique
├── DEMARRAGE.md             Comptes et arbitrages préalables
└── DEPLOYMENT.md            Guide et checklist de mise en production
```

## Démarrage rapide

```bash
# 1. Variables d'environnement
export DATABASE_URL="postgresql://setwise_app:pass@ep-xyz.eu-central-1.aws.neon.tech/neondb?sslmode=require"
export DATABASE_URL_WORKER="postgresql://setwise_worker:pass@ep-xyz.eu-central-1.aws.neon.tech/neondb?sslmode=require"
export ANTHROPIC_API_KEY="sk-ant-..."
export ENCRYPTION_KEY="votre_cle_secrete_32_caracteres_min"
export RESEND_API_KEY="re_..."
export NOTIFICATION_FROM="Setwise <connexion@setwise.fr>"

# 2. Appliquer les migrations sur Neon (rôles + RLS ont leurs propres étapes
# manuelles entre deux — voir docs/DEPLOYMENT.md §3.2 avant une vraie mise en
# production ; en local, tout s'applique d'un coup sans souci)
deno task migrate

# 3. Lancer les tests et le typage
deno task test    # 213 tests unitaires (+ 3 tests RLS réels, ignorés sans base Neon dédiée)
deno task check   # vérification TypeScript

# 4. Lancer le serveur backend
deno task start   # ou deno task dev pour le mode rechargement à chaud
```

## Principes tenus dans tout le code

- **L'isolation multi-tenant est en base, pas seulement dans le code.** Depuis `migrations/0007_rls_policies.sql`, le rôle du tableau de bord (`setwise_app`) est soumis à la Row-Level Security Postgres : une requête qui oublierait de filtrer par institut échoue à l'exécution plutôt que de fuiter des données. `src/routes/tenant_scoping_test.ts` attrape l'oubli statiquement, avant même le déploiement ; `src/routes/rls_test.ts` le vérifie contre une vraie base. Les tâches de fond (webhooks, crons, moteur d'agent) tournent sous un second rôle (`setwise_worker`) qui traite plusieurs instituts par construction.
- **Rien n'est perdu en silence.** Un rendez-vous est écrit en base avant l'appel externe. Un webhook rejoué est ignoré par unicité. Un échec ouvre une escalade lisible pour l'humain.
- **L'escalade humaine est un chemin de premier ordre.** En cas de réclamation, refus du modèle, ou coupure d'abonnement, l'agent se tait et le gérant est alerté par email et/ou WhatsApp.
- **Autonomie complète sans dépendance propriétaire.** L'authentification par lien magique et l'API REST fonctionnent sans Supabase, sur tout PostgreSQL standard ou Neon.

## Ce qu'il manque pour la mise en production

1. **Clés d'API réelles et comptes de production** :
   - Deux rôles de connexion Neon (`DATABASE_URL` = `setwise_app`, `DATABASE_URL_WORKER` = `setwise_worker`) — voir `docs/DEPLOYMENT.md` §3.2 pour la bascule.
   - Compte Anthropic (`ANTHROPIC_API_KEY`).
   - Application Meta Business vérifiée avec autorisations `instagram_manage_messages` et `whatsapp_business_messaging`.
   - Projet Google Cloud avec API Google Calendar activée et écran de consentement OAuth publié.
   - Compte Stripe en mode Live (produits créés et identifiants de tarifs `price_...` injectés).
   - Clé d'envoi d'emails Resend (`RESEND_API_KEY`) avec domaine validé (SPF/DKIM).
2. **Écriture dans Planity (Limite externe)** :
   - Planity ne fournissant pas d'API publique d'écriture, les réservations passent par Google Calendar ou par notification pour confirmation manuelle.
3. **Champs légaux du site vitrine** :
   - Remplacer les placeholders `[SIRET]`, `[ADRESSE]`, `[EMAIL]` dans `frontend/site/mentions-legales.html` et `frontend/site/cgv.html`.
