// Configuration du tableau de bord Setwise (Neon + Backend REST).
// Copier en `config.js` et renseigner les valeurs de votre environnement.
// `config.js` est ignoré par git.

export const CONFIG = {
  // URL de l'API backend Setwise (Deno + Neon)
  API_URL: "http://localhost:8000",

  // URL de redirection déclarée dans la console Google Cloud, pour la connexion
  // du calendrier. Doit correspondre exactement, à la barre finale près.
  GOOGLE_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/google",
  GOOGLE_CLIENT_ID: "VOTRE_CLIENT_ID.apps.googleusercontent.com",

  // URI de retour déclarée dans les paramètres de l'application Meta, pour la
  // connexion d'Instagram. Doit correspondre exactement, à la barre finale près.
  META_REDIRECT_URI: "https://dashboard.votre-domaine.fr/oauth/meta",
  META_APP_ID: "VOTRE_APP_ID",

  // Site vitrine, où sont publiées les CGV et la politique de confidentialité.
  SITE_URL: "https://votre-domaine.fr",

  // Version des CGV en vigueur : la date de mise à jour affichée en haut de
  // `cgv.html`, au format ISO. Elle est enregistrée avec l'acceptation.
  TERMS_VERSION: "2026-08-17",
};
