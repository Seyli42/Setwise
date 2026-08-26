// Client API et gestion de session autonome pour Neon.

import { CONFIG } from "../config.js";

const TOKEN_KEY = "setwise_session_token";
const listeners = new Set();

function emitAuth(event) {
  for (const fn of listeners) {
    try { fn(event); } catch (err) { console.error(err); }
  }
}

export const auth = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },

  async getSession() {
    const token = this.getToken();
    if (!token) return { data: { session: null } };

    try {
      const res = await fetch(`${CONFIG.API_URL}/api/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        this.signOut();
        return { data: { session: null } };
      }
      const data = await res.json();
      return { data: { session: { token, user: data.user } } };
    } catch (_err) {
      return { data: { session: null } };
    }
  },

  async signInWithOtp({ email }) {
    try {
      const res = await fetch(`${CONFIG.API_URL}/api/auth/magic-link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { error: new Error(data.error ?? "Erreur lors de l'envoi du lien") };
      return { data, error: null };
    } catch (err) {
      return { error: err };
    }
  },

  async verifyToken(token, email) {
    const res = await fetch(`${CONFIG.API_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Validation du jeton échouée");

    localStorage.setItem(TOKEN_KEY, data.token);
    emitAuth("SIGNED_IN");
    return data;
  },

  signOut() {
    localStorage.removeItem(TOKEN_KEY);
    session.user = null;
    session.tenantId = null;
    session.tenantName = null;
    session.role = null;
    emitAuth("SIGNED_OUT");
  },

  onAuthStateChange(cb) {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};

/** Contexte de l'utilisateur connecté, rempli au démarrage. */
export const session = {
  user: null,
  tenantId: null,
  tenantName: null,
  timezone: "Europe/Paris",
  role: null,
};

export function isOwner() {
  return session.role === "owner";
}

/**
 * Envoie une requête authentifiée à l'API backend.
 */
export async function apiFetch(path, options = {}) {
  const token = auth.getToken();
  const headers = new Headers(options.headers || {});
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${CONFIG.API_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      auth.signOut();
    }
    throw new Error(data.error ?? `Erreur HTTP ${res.status}`);
  }
  return data;
}

/**
 * Charge l'institut de l'utilisateur connecté.
 */
export async function loadTenant() {
  const data = await apiFetch("/api/auth/me");
  if (!data || !data.membership) return null;

  session.user = data.user;
  session.tenantId = data.membership.tenantId;
  session.role = data.membership.role;
  session.tenantName = data.membership.tenantName ?? "Mon institut";
  session.timezone = data.membership.timezone ?? "Europe/Paris";

  return session;
}

/**
 * Appelle une action serveur du dashboard (envoi message, résolution escalade, Stripe, OAuth).
 */
export async function callApi(action, payload = {}) {
  // Mappage des actions historiques vers les endpoints REST unifiés
  const actionRoutes = {
    send_human_message: "/api/actions/send-message",
    resolve_escalation: "/api/actions/resolve-escalation",
    connect_meta_oauth: "/api/actions/connect-meta",
    connect_google_calendar: "/api/actions/connect-google",
    create_checkout_session: "/api/billing/checkout",
    create_billing_portal: "/api/billing/portal",
    billing_state: "/api/billing/state",
  };

  const route = actionRoutes[action];
  if (!route) throw new Error(`Action inconnue : ${action}`);

  return await apiFetch(route, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
