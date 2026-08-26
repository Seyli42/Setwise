# Dashboard institut Setwise

HTML/CSS/JS vanilla autonome, aucun build, aucun framework, zéro dépendance externe.

## Modèle d'accès et sécurité

Le dashboard communique exclusivement avec l'API REST sécurisée de Setwise (`/api/*`).

```
Navigateur (Dashboard) ──Bearer JWT (Session)──▶ Serveur Deno (src/server.ts) ──▶ Neon Postgres
```

- **Authentification sans mot de passe** : Magic link envoyé par email via Resend, vérification d'un jeton éphémère à usage unique, émission d'un token JWT de session (durée 30 jours).
- **Contrôle d'accès strict** : Toutes les routes `/api/*` vérifient cryptographiquement le JWT et isolent strictement les données par `tenant_id`. Les actions d'administration (équipe, facturation, connexions) sont réservées au rôle `owner`.
- **Protection XSS & CSP** :
  - `dom.js` n'utilise jamais `innerHTML` : toutes les insertions textuelles passent par `textContent`.
  - Pas de script inline, pas de CDN externe.

## Installation & Configuration

1. Copier le fichier de configuration :
   ```bash
   cp config.example.js config.js
   ```
2. Renseigner l'URL de votre API backend :
   ```javascript
   export const CONFIG = {
     API_URL: "http://localhost:8000",
     GOOGLE_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/google",
     GOOGLE_CLIENT_ID: "VOTRE_CLIENT_ID.apps.googleusercontent.com",
     META_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/meta",
     META_APP_ID: "VOTRE_APP_ID",
     SITE_URL: "https://votre-domaine.fr",
     TERMS_VERSION: "2026-08-17",
   };
   ```

## Structure

```
index.html          Coquille HTML
styles.css          Feuille de style CSS responsive
config.example.js   Modèle de configuration
config.js           Configuration active
oauth/
├── google/         Page de retour OAuth Google Calendar
└── meta/           Page de retour OAuth Instagram / WhatsApp
js/
├── client.js       Authentification Magic Link, session, requêtes API
├── api.js          Fonctions d'accès aux données métier
├── dom.js          Constructeur d'éléments DOM sécurisés
├── parse.js        Parseurs et validateurs de saisie
├── app.js          Routage par hash & cycle de vie
└── views/          Vues : overview, conversations, leads, appointments, agent, connections, billing, team, settings, auth
```

## Vues disponibles

| Page | Contenu |
|---|---|
| **Vue d'ensemble** | Résumé de l'activité, alertes d'escalade, prochains rendez-vous, état de facturation |
| **Conversations** | Fil de discussion complet, reprise en main humaine en un clic, clôture d'escalade |
| **Leads** | Filtres par statut, historique des réponses de qualification, droit à l'oubli RGPD |
| **Rendez-vous** | Liste des créneaux, statuts, signalement des absences (no-show) pour déclencher l'agent de relance |
| **Mon agent** | Personnalisation du prompt, questions de qualification, horaires d'ouverture et durées |
| **Connexions** | Connexion 1-clic Instagram & WhatsApp via Meta OAuth, synchronisation Google Calendar |
| **Abonnement** | Choix de formule Stripe Checkout, accès au portail de facturation client Stripe |
| **Équipe** | Gestion des collaborateurs et envoi d'invitations par e-mail |
| **Réglages** | Fuseau horaire, informations de contact pour les alertes, durée de rétention RGPD |
