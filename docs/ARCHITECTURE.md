# Architecture Setwise

Document de référence des décisions techniques.

---

## 1. Vue d'ensemble et transition vers Neon

Setwise a été conçu pour allier **haute fiabilité**, **faible latence** et **autonomie opérationnelle**. L'infrastructure repose sur **Neon (Serverless Postgres)** couplé à un **serveur HTTP Deno unifié** (`src/server.ts`).

```
                    ┌─────────────────────────┐
                    │       Meta Webhook      │ (Instagram / WhatsApp)
                    └────────────┬────────────┘
                                 │ HTTP POST + HMAC SHA-256
                                 ▼
                    ┌─────────────────────────┐
                    │    Serveur Deno unifié  │ (src/server.ts)
                    │  - /webhooks/*          │
                    │  - /api/auth/*          │
                    │  - /api/* (REST)        │
                    │  - /crons/*             │
                    └────────────┬────────────┘
                                 │
                 ┌───────────────┴───────────────┐
                 ▼                               ▼
       ┌───────────────────┐           ┌───────────────────┐
       │   Neon Postgres   │           │  Moteur d'agent   │
       │ - webhook_events  │ ◀──────── │ - Claude Sonnet   │
       │ - users & tenants │  (SKIP    │ - Outils RDV/Qual │
       │ - appointments    │   LOCKED) │ - Mémoire / Rôles │
       └───────────────────┘           └───────────────────┘
```

---

## 2. Remplacement des 4 briques Supabase

| Brique d'origine | Remplacement Neon / Deno | Bénéfice |
|---|---|---|
| **Base Postgres managée** | **Neon Serverless Postgres** via `DATABASE_URL` (SSL + connection pooling) | Serverless, scaling instantané, branching de bases de données de dev/staging. |
| **Supabase Auth** (`auth.users`, OTP) | **Module d'authentification autonome** (`src/auth.ts`, tables `users` & `auth_tokens`, Resend + JWT session) | Indépendance totale vis-à-vis des vendors tiers, contrôle complet des durées de sessions et tokens. |
| **PostgREST** | **API REST structurée et sécurisée** (`src/routes/dashboard.ts`) | Validation stricte des données entrantes, requêtes SQL optimisées, élimination des failles potentielles de RLS client. |
| **Edge Functions & pg_cron** | **Serveur Deno unifié** (`src/server.ts`) + Endpoints Crons (`src/routes/crons.ts`) + Worker intégré | Déploiement unique (Deno Deploy, Docker, Fly.io, Railway), exécution locale sans émulateur lourd. |

---

## 3. Queue et traitement asynchrone

Meta impose un accusé de réception rapide (< 20 secondes) sous peine de retenter l'envoi indéfiniment. Un tour d'agent complet (qualification LLM, vérification de calendrier, écriture en base) peut prendre de 2 à 5 secondes.

1. **Ingestion immédiate** : le webhook vérifie la signature HMAC, insère le payload dans `webhook_events` avec déduplication stricte par `(source, external_event_id)`, et renvoie un `200 OK` en moins de 50 ms.
2. **Consommation concurrente** : la fonction SQL `claim_webhook_events` utilise `FOR UPDATE SKIP LOCKED` pour distribuer les messages aux workers sans aucun risque de double traitement.
3. **Idempotence garantie** : toute action externe (création d'événement Google Calendar, message WhatsApp) possède une clé d'idempotence dérivée de l'ID du message ou de la réservation.

---

## 4. Multi-tenancy et sécurité des données

- **Isolation par clé primaire** : Chaque enregistrement sensible (`conversations`, `leads`, `appointments`, `agents`, `channel_connections`) est explicitement lié à un `tenant_id`.
- **Résolution serveur inviolable** : Le `tenant_id` n'est JAMAIS extrait d'un payload client non signé.
  - Pour les messages entrants, il est déduit de `external_account_id` via `channel_connections`.
  - Pour les requêtes du dashboard, il est extrait du JWT vérifié cryptographiquement par `src/auth.ts`.
- **Chiffrement au repos** : Tous les tokens d'accès (Meta tokens, Google refresh tokens) sont chiffrés en base avec AES-GCM 256 bits (`src/_shared/crypto.ts`) avant insertion.

---

## 5. Gestion des agents et des rôles

Le moteur d'agent (`src/_shared/agent/engine.ts`) est agnostic du canal de communication et du rôle métier.

Les 4 rôles d'agents partagent le même moteur :
1. `qualification_rdv` (entrant) : Répond aux DM Instagram et WhatsApp, pose les questions de qualification, vérifie les disponibilités et confirme les rendez-vous.
2. `avis_google` (sortant) : Déclenché entre 2h et 72h après un soin honoré pour solliciter un avis Google.
3. `relance` (sortant) : Déclenché après une absence constatée (`no_show`) pour proposer de reprogrammer.
4. `reactivation` (sortant) : Reprise de contact avec les leads qualifiés n'ayant jamais réservé après un délai paramétrable.
