# Checklist de mise en production (Neon + Deno Deploy)

> **État au 2 septembre 2026.** La base Neon est en place : les 8 migrations
> sont appliquées, les rôles `setwise_app` / `setwise_worker` ont leurs mots de
> passe, la RLS est forcée sur 18 tables et vérifiée. Les clés DeepSeek, Meta,
> Google, Stripe (Live) et Resend répondent. Il reste **trois** choses :
> déployer le serveur (§4), brancher le webhook Stripe (§5) et vérifier le
> domaine d'envoi Resend (§7).

---

## 0. Les trois rôles de connexion, et lequel sert à quoi

| Variable | Rôle Postgres | Utilisée par | Droits |
|---|---|---|---|
| `DATABASE_URL` | `setwise_app` | API du tableau de bord, via `withTenant` | soumis à la RLS, **pas de DDL** |
| `DATABASE_URL_WORKER` | `setwise_worker` | webhooks, crons, moteur d'agent | `BYPASSRLS` |
| `DATABASE_URL_ADMIN` | propriétaire du schéma | `deno task migrate`, depuis ton poste | DDL complet |

`DATABASE_URL_ADMIN` ne doit **jamais** être déployée sur le serveur : le
serveur n'a aucune raison de pouvoir modifier le schéma. C'est aussi pour ça
que `deno task migrate` a sa propre variable — sous RLS, le rôle applicatif
échoue sur `permission denied for schema public`, ce qui est le comportement
voulu, pas un bug à contourner.

---

## 1. Prérequis & Comptes de production

- [ ] **Base Neon** : Projet créé sur Neon (région EU `eu-central-1` ou `eu-west-1` pour conformité RGPD).
- [ ] **Compte Anthropic** : Clé d'API avec accès à Claude 3.5 Sonnet / Opus.
- [ ] **Compte Meta for Developers** : App d'entreprise vérifiée avec autorisations WhatsApp Cloud API et Instagram Graph API.
- [ ] **Google Cloud Console** : Projet avec API Google Calendar activée et identifiants OAuth Web.
- [ ] **Compte Stripe** : Mode Live avec clés `sk_live_...` et secret de webhook `whsec_...`.
- [ ] **Compte Resend** : Domaine vérifié avec enregistrements DNS SPF / DKIM / DMARC.

---

## 2. Variables d'environnement de production

```bash
# Base de données Neon (avec pooler transactionnel) — DEUX rôles, voir §3.
DATABASE_URL=postgresql://setwise_app:password@ep-xyz-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
DATABASE_URL_WORKER=postgresql://setwise_worker:password@ep-xyz-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require

# Origines autorisées pour les liens de connexion (magic link), séparées par
# des virgules — la première est l'origine canonique. Sans elle, repli sur
# DASHBOARD_ORIGIN ci-dessous. Une origine absente de cette liste est
# silencieusement ignorée (jamais utilisée pour construire un lien envoyé par
# e-mail) : c'est le correctif d'une prise de contrôle de compte par en-tête
# Origin forgé.
APP_ORIGINS=https://dashboard.votre-domaine.fr

# Sécurité & Chiffrement (généré via: openssl rand -base64 32)
ENCRYPTION_KEY=votre_cle_de_chiffrement_aes_256_bits
JWT_SECRET=votre_secret_signature_jwt_sessions
CRON_SECRET=votre_cle_secrete_pour_declencher_les_crons

# Intelligence Artificielle
ANTHROPIC_API_KEY=sk-ant-api03-...

# Meta (Instagram & WhatsApp)
META_APP_ID=123456789012345
META_APP_SECRET=abcdef0123456789abcdef0123456789
META_WEBHOOK_VERIFY_TOKEN=votre_token_aleatoire_verification

# Google Calendar OAuth
GOOGLE_CLIENT_ID=votre-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-votre-secret

# Stripe Billing
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Notifications & Magic Link (Resend)
RESEND_API_KEY=re_123456789
NOTIFICATION_FROM="Setwise <connexion@votre-domaine.fr>"
WHATSAPP_ALERT_TEMPLATE=setwise_escalade

# Dashboard & Domaines autorisés
DASHBOARD_ORIGIN=https://dashboard.votre-domaine.fr
PORT=8000
```

---

## 3. Déploiement de la base de données

### 3.1. Schéma et données

```bash
MIGRATE_UNTIL=0005_llm_usage.sql deno task migrate
```

Applique `migrations/0001` à `0005` (schéma, tarifs, bornes de rétention,
limitation de débit, quotas IA) et s'arrête là — aucune n'exige de rôle
particulier, la connexion habituelle (propriétaire du projet Neon) suffit.
`MIGRATE_UNTIL` borne l'exécution à ce fichier ; les deux migrations
suivantes (rôles et RLS) ont leurs propres étapes manuelles entre les deux,
ci-dessous.

Vérifier la création des tables :
```sql
select table_name from information_schema.tables where table_schema = 'public';
```

### 3.2. Rôles applicatifs et RLS — `[bloquant, à faire dans cet ordre exact]`

`migrations/0006_rls_roles.sql` et `0007_rls_policies.sql` mettent en place
l'isolation multi-institut **dans la base** : le rôle du tableau de bord ne
peut plus lire ni écrire les données d'un autre institut, même en cas de bug
applicatif. Un mauvais ordre casse tout le service — suivre exactement ces
étapes.

1. **Appliquer `0006` seule d'abord** (elle ne change rien au comportement :
   elle crée les rôles, pose les droits, n'active aucune policy) :
   ```bash
   MIGRATE_UNTIL=0006_rls_roles.sql deno task migrate
   ```
   Si la création du rôle échoue faute de privilège (`BYPASSRLS` est parfois
   restreint sur les offres managées), créer `setwise_worker` depuis la
   console Neon avec l'attribut *Bypass RLS*, puis relancer — la migration
   reprend au `GRANT` suivant sans erreur (`create role` est idempotente ici).

2. **Fixer un mot de passe pour chaque rôle**, jamais dans un fichier
   versionné :
   ```sql
   alter role setwise_app    with password '...';
   alter role setwise_worker with password '...';
   ```

3. **Renseigner `DATABASE_URL` (→ `setwise_app`) et `DATABASE_URL_WORKER`
   (→ `setwise_worker`)** dans la configuration de production, avant de
   déployer le code. `src/db.ts` échoue au démarrage si `DATABASE_URL_WORKER`
   est absente — volontairement : un serveur qui refuse de démarrer vaut
   mieux qu'un worker qui tourne silencieusement sur le mauvais rôle une fois
   la RLS active.

4. **Déployer le code** (§4) avec ces deux variables en place, et vérifier
   qu'il répond normalement — à ce stade `0007` n'a pas encore tourné, le
   comportement est identique à avant (les GRANT de `0006` seuls n'imposent
   aucune restriction de ligne).

5. **Vérifier que le worker a bien `BYPASSRLS`** avant d'aller plus loin :
   ```sql
   select rolname, rolbypassrls from pg_roles where rolname = 'setwise_worker';
   -- attendu : rolbypassrls = true
   ```

6. **Appliquer `0007`** (active et FORCE la RLS sur chaque table métier) :
   ```bash
   deno task migrate
   ```
   Sans `MIGRATE_UNTIL` cette fois : il ne reste que `0007` en attente, elle
   s'applique et le script s'arrête de lui-même faute d'autre fichier.

7. **Vérifier l'isolation réellement**, sur une branche Neon jetable si
   possible (jamais directement en production sans un premier passage sur une
   branche) :
   ```bash
   DATABASE_URL=<connexion setwise_app> \
   DATABASE_URL_WORKER=<connexion setwise_worker> \
   deno test --allow-net --allow-env src/routes/rls_test.ts
   ```
   Les trois tests doivent passer (pas `ignored` : la présence des deux
   variables les active). Le test central crée deux instituts jetables,
   vérifie qu'un institut ne voit que ses propres leads, et qu'une écriture
   au nom d'un autre institut est rejetée par la base — pas seulement filtrée
   côté code.

8. **Recette manuelle finale**, avec le rôle `setwise_app` :
   ```sql
   select set_config('app.tenant_id', '<id-institut-A>', false);
   select count(*) from leads;                              -- ceux de A uniquement
   insert into leads (tenant_id, source) values ('<id-institut-B>', 'instagram');
   -- attendu : new row violates row-level security policy
   ```

---

## 4. Déploiement du serveur backend Deno

**Chemin retenu : Deno Deploy**, depuis le dépôt GitHub `Seyli42/Setwise`.

1. Se connecter sur <https://console.deno.com> (GitHub).
2. *New Project* → dépôt `Seyli42/Setwise`, branche `main`,
   **entrypoint `src/server.ts`**, pas de build step.
3. Coller les variables de `DEPLOY_ENV.txt` (généré à la racine, hors dépôt)
   dans *Settings → Environment Variables*.
4. Déployer, puis **revenir corriger `APP_ORIGINS` et `DASHBOARD_ORIGIN`** avec
   l'URL réelle du projet (`https://<projet>.deno.dev`) et redéployer. Tant que
   ces deux variables pointent ailleurs, le tableau de bord se fait refuser par
   le CORS et les liens de connexion mènent au mauvais domaine.

Le serveur sert aussi le tableau de bord (`/dashboard`) et le site vitrine
(`/site`) : une seule origine suffit, et le déploiement Vercel devient
facultatif. `frontend/dashboard/config.js` détecte l'origine tout seul.

Alternative conteneurisée (Fly.io / Railway / Render / VPS) :
  ```dockerfile
  FROM denoland/deno:2.1.0
  WORKDIR /app
  COPY . .
  RUN deno cache src/server.ts
  EXPOSE 8000
  CMD ["run", "--allow-net", "--allow-env", "--allow-read", "src/server.ts"]
  ```

---

## 5. Configuration des Webhooks

1. **Meta (Instagram & WhatsApp)** :
   - URL de rappel : `https://api.votre-domaine.fr/webhooks/instagram` et `/webhooks/whatsapp`
   - Jeton de vérification : Valeur de `META_WEBHOOK_VERIFY_TOKEN`
   - Abonnements aux champs : `messages`, `messaging_postbacks`
2. **Stripe** :
   - URL de destination : `https://api.votre-domaine.fr/webhooks/stripe`
   - Événements écoutés : `customer.subscription.*`, `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`

---

## 6. Déploiement du Dashboard Frontend

1. Configurer `frontend/dashboard/config.js` avec :
   ```js
   export const CONFIG = {
     API_URL: "https://api.votre-domaine.fr",
     GOOGLE_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/google",
     GOOGLE_CLIENT_ID: "votre_id.apps.googleusercontent.com",
     META_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/meta",
     META_APP_ID: "votre_app_id",
     SITE_URL: "https://votre-domaine.fr",
     TERMS_VERSION: "2026-08-17",
   };
   ```
2. Déployer les fichiers de `frontend/dashboard/` sur votre hébergeur statique (Hostinger, Cloudflare Pages, Vercel, S3).
