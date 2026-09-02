// Configuration du tableau de bord Setwise.
//
// Le serveur Deno sert LUI-MÊME le tableau de bord et le site vitrine
// (`src/static.ts`). Quand le dashboard est ouvert depuis ce serveur, l'API
// est donc sur la même origine : rien à configurer, pas de CORS, pas de
// redirection OAuth à recopier ailleurs. C'est le mode par défaut.
//
// Le déploiement Vercel reste possible (le dashboard y est un site statique
// séparé) : dans ce cas seule la constante API_DISTANTE ci-dessous est à
// renseigner, et l'origine Vercel doit figurer dans APP_ORIGINS côté serveur,
// sinon le CORS et les liens de connexion la rejetteront.

// ⚠️ À renseigner APRÈS le déploiement du serveur, et uniquement si le
// dashboard est hébergé ailleurs que sur ce serveur (ex. Vercel).
const API_DISTANTE = "";

const origine = window.location.origin;
const memeOrigine = !/\.vercel\.app$/.test(window.location.hostname);
const api = memeOrigine ? origine : (API_DISTANTE || origine);

export const CONFIG = {
  API_URL: api,

  GOOGLE_CLIENT_ID: "427989585185-87kd86khhjv96gdjei65j8pgdb0qkumb.apps.googleusercontent.com",
  GOOGLE_REDIRECT_URI: `${origine}/oauth/google`,

  META_APP_ID: "1968603263832177",
  META_REDIRECT_URI: `${origine}/oauth/meta`,

  SITE_URL: memeOrigine ? `${origine}/site` : origine,
  TERMS_VERSION: "2026-08-17",
};
