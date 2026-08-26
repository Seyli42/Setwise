# Checklist de mise en production (Neon + Deno)

À dérouler dans l'ordre pour le déploiement sur Neon et le serveur de production.

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
# Base de données Neon (avec pooler transactionnel)
DATABASE_URL=postgresql://user:password@ep-xyz-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require

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

Appliquer le schéma SQL initial consolidé sur Neon :

```bash
deno task migrate
```

Vérifier la création des tables dans la console SQL Neon :
```sql
select table_name from information_schema.tables where table_schema = 'public';
```

---

## 4. Déploiement du serveur backend Deno

Le serveur `src/server.ts` peut être hébergé sur :
- **Deno Deploy** : Déploiement git direct sans conteneur.
- **Docker / Fly.io / Railway / Render / VPS** :
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
