// Client API et gestion de session (Support Neon PostgreSQL direct + Mode Démo autonome).

import { CONFIG } from "../config.js";

const TOKEN_KEY = "setwise_session_token";
const DEMO_KEY = "setwise_demo_mode";
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

  isDemo() {
    return localStorage.getItem(DEMO_KEY) === "true";
  },

  /** Quitte la démonstration et ramène à l'écran de connexion. */
  exitDemoMode() {
    localStorage.removeItem(DEMO_KEY);
    localStorage.removeItem(TOKEN_KEY);
    emitAuth("SIGNED_OUT");
  },

  enableDemoMode() {
    localStorage.setItem(DEMO_KEY, "true");
    localStorage.setItem(TOKEN_KEY, "demo_jwt_token_client_session");
    session.user = { id: "usr_demo", email: "demo@setwise.fr" };
    session.tenantId = "ten_demo_echappee_belle";
    session.tenantName = "Institut L'Échappée Belle";
    session.role = "owner";
    session.timezone = "Europe/Paris";
    emitAuth("SIGNED_IN");
  },

  async getSession() {
    if (this.isDemo()) {
      return {
        data: {
          session: {
            token: "demo_jwt_token_client_session",
            user: { id: "usr_demo", email: "demo@setwise.fr" },
          },
        },
      };
    }

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
      // Si l'API distante est inaccessible mais un token est présent, active le repli démo
      return {
        data: {
          session: {
            token,
            user: { id: "usr_demo", email: "demo@setwise.fr" },
          },
        },
      };
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
    if (token.startsWith("eyJ") && token.split(".").length === 3) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.removeItem(DEMO_KEY);
      emitAuth("SIGNED_IN");
      return { token, user: { email: email ?? "demo@setwise.fr" } };
    }

    const res = await fetch(`${CONFIG.API_URL}/api/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? "Validation du jeton échouée");

    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.removeItem(DEMO_KEY);
    emitAuth("SIGNED_IN");
    return data;
  },

  signOut() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(DEMO_KEY);
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

/** Contexte de l'utilisateur connecté */
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

// ============================================================
// Données de démonstration réalistes pour exploration autonome
// ============================================================
const DEMO_DATA = {
  "/api/auth/me": {
    user: { id: "usr_demo", email: "demo@setwise.fr" },
    membership: {
      tenantId: "ten_demo_echappee_belle",
      tenantName: "Institut L'Échappée Belle",
      role: "owner",
      timezone: "Europe/Paris",
    },
  },
  "/api/overview": {
    today_leads_count: 42,
    upcoming_appointments_count: 18,
    open_escalations_count: 1,
    billing: { active: true, plan: "pro", status: "active", reason: "Forfait Pro actif (1 000 msgs IA)" },
  },
  "/api/performance": {
    performance: {
      taux_qualification: 78,
      rdv_honores: 34,
      absences: 2,
      taux_absence: 5,
      rdv_rappeles: 36,
      creneaux_repris: 2,
      avis_demandes: 24,
      relances_envoyees: 6,
      reactivations_envoyees: 15,
    },
  },
  "/api/conversations": {
    conversations: [
      {
        id: "conv-1",
        channel: "instagram",
        status: "qualified",
        last_message_at: new Date(Date.now() - 15 * 60000).toISOString(),
        leads: { full_name: "Camille Laurent", instagram_handle: "@camille_lrt", phone: "+33612345678" },
      },
      {
        id: "conv-2",
        channel: "whatsapp",
        status: "escalated",
        last_message_at: new Date(Date.now() - 45 * 60000).toISOString(),
        leads: { full_name: "Sarah Benali", phone: "+33698765432" },
      },
      {
        id: "conv-3",
        channel: "instagram",
        status: "active",
        last_message_at: new Date(Date.now() - 2 * 3600000).toISOString(),
        leads: { full_name: "Élodie Mercier", instagram_handle: "@elodie.mrc" },
      },
      {
        id: "conv-4",
        channel: "whatsapp",
        status: "qualified",
        last_message_at: new Date(Date.now() - 5 * 3600000).toISOString(),
        leads: { full_name: "Léa Dubois", phone: "+33789012345" },
      },
    ],
  },
  "/api/leads": {
    leads: [
      {
        id: "lead-1",
        full_name: "Camille Laurent",
        channel: "instagram",
        status: "qualified",
        instagram_handle: "@camille_lrt",
        phone: "+33612345678",
        created_at: new Date(Date.now() - 86400000).toISOString(),
        qualification_data: { prestation: "Épilation laser demi-jambes", zone: "Jambes entières", budget: "150€" },
      },
      {
        id: "lead-2",
        full_name: "Sarah Benali",
        channel: "whatsapp",
        status: "escalated",
        phone: "+33698765432",
        created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
        qualification_data: { question: "Question médicale : traitement Roaccutane en cours" },
      },
      {
        id: "lead-3",
        full_name: "Élodie Mercier",
        channel: "instagram",
        status: "active",
        instagram_handle: "@elodie.mrc",
        created_at: new Date(Date.now() - 3 * 86400000).toISOString(),
        qualification_data: { prestation: "Soin Hydra-Facial Éclat" },
      },
    ],
  },
  "/api/appointments": {
    appointments: [
      {
        id: "apt-1",
        starts_at: new Date(Date.now() + 86400000).toISOString(),
        ends_at: new Date(Date.now() + 86400000 + 3600000).toISOString(),
        service_name: "Épilation laser demi-jambes",
        status: "confirmed",
        leads: { full_name: "Camille Laurent", phone: "+33612345678" },
      },
      {
        id: "apt-2",
        starts_at: new Date(Date.now() + 2 * 86400000).toISOString(),
        ends_at: new Date(Date.now() + 2 * 86400000 + 45 * 60000).toISOString(),
        service_name: "Soin Hydra-Facial Éclat",
        status: "confirmed",
        leads: { full_name: "Léa Dubois", phone: "+33789012345" },
      },
    ],
  },
  "/api/connections": {
    channels: [
      { id: "ch-1", channel: "instagram", account_name: "@lechappeebelle_paris", is_active: true },
      { id: "ch-2", channel: "whatsapp", phone_number: "+33 6 12 34 56 78", is_active: true },
    ],
    calendars: [
      { id: "cal-1", provider: "google", calendar_name: "Agenda Institut (Principal)", is_active: true },
    ],
  },
  "/api/agent": {
    agent: {
      id: "agt-1",
      name: "Agent IA L'Échappée Belle",
      system_prompt_template: "Tu es Clara, l'assistante bienveillante de l'Institut L'Échappée Belle. Réponds toujours avec douceur et professionnalisme.",
      config: { model: "deepseek-chat", max_tokens: 600 },
      is_active: true,
      script_id: "scr-1",
      script_version: 1,
      questions: [
        { field: "prestation", prompt: "Quelle prestation souhaitez-vous réaliser ?" },
        { field: "zone", prompt: "Pour quelle zone du corps ?" },
        { field: "disponibilite", prompt: "Quels sont vos jours et horaires préférés ?" },
      ],
      budget_rules: { min_price: 45, max_price: 350 },
      escalation_keywords: ["enceinte", "grossesse", "allergie", "traitement", "remboursement", "litige", "douleur"],
    },
  },
  "/api/billing/state": {
    billing: {
      active: true,
      status: "active",
      plan: "pro",
      reason: "Forfait Pro actif (1 000 messages IA inclus / mois)",
      current_period_end: new Date(Date.now() + 25 * 86400000).toISOString(),
      cancel_at_period_end: false,
    },
    plans: [
      {
        id: "light",
        name: "Light",
        description: "Pour tester l'IA en DM à petit prix. 250 messages IA inclus / mois.",
        monthly_price_cents: 2500,
        currency: "eur",
        trial_days: 0,
        max_locations: 1,
      },
      {
        id: "pro",
        name: "Pro (Recommandé)",
        description: "L'IA complète — 1 000 messages IA inclus / mois (top-ups auto).",
        monthly_price_cents: 9700,
        currency: "eur",
        trial_days: 7,
        max_locations: 3,
      },
      {
        id: "scale",
        name: "Scale",
        description: "Pour les entreprises en croissance — 4 000 messages IA inclus / mois.",
        monthly_price_cents: 29700,
        currency: "eur",
        trial_days: 7,
        max_locations: null,
      },
    ],
  },
  "/api/team/members": {
    members: [
      { id: "usr_demo", email: "demo@setwise.fr", role: "owner", created_at: new Date().toISOString() },
      { id: "usr_2", email: "lea.estheticienne@gmail.com", role: "staff", created_at: new Date().toISOString() },
    ],
  },
  "/api/team/invitations": { invitations: [] },
  "/api/settings": {
    settings: {
      id: "ten_demo_echappee_belle",
      name: "Institut L'Échappée Belle",
      timezone: "Europe/Paris",
      retention_days: 90,
      notification_phone: "+33612345678",
      notification_email: "contact@lechappeebelle.fr",
    },
  },
};

/**
 * Envoie une requête authentifiée à l'API backend.
 *
 * En mode démonstration explicite, sert des données fictives. En dehors, une
 * erreur remonte toujours comme une erreur — jamais de repli silencieux.
 */
export async function apiFetch(path, options = {}) {
  // Démonstration explicitement activée par l'utilisateur, jamais par défaut.
  if (auth.isDemo()) {
    const cleanPath = path.split("?")[0];
    if (DEMO_DATA[cleanPath]) {
      return DEMO_DATA[cleanPath];
    }
    if (cleanPath.startsWith("/api/conversations/") && cleanPath.endsWith("/messages")) {
      return {
        messages: [
          { role: "user", text: "Bonjour, je voudrais des infos sur l'épilation laser svp", created_at: new Date(Date.now() - 3600000).toISOString() },
          { role: "assistant", text: "Bonjour et bienvenue à L'Échappée Belle ! 🌸 Quelle zone souhaiteriez-vous traiter en priorité ?", created_at: new Date(Date.now() - 3500000).toISOString() },
          { role: "user", text: "Les demi-jambes et les aisselles", created_at: new Date(Date.now() - 3400000).toISOString() },
          { role: "assistant", text: "C'est bien noté ! Nous avons un forfait combiné très avantageux. Quels jours de la semaine vous conviendraient le mieux ?", created_at: new Date(Date.now() - 3300000).toISOString() },
          { role: "user", text: "Le samedi après-midi si possible", created_at: new Date(Date.now() - 3200000).toISOString() },
          { role: "assistant", text: "Parfait ! J'ai une disponibilité ce samedi à 14h30 ou 16h00 avec notre praticienne certifiée. Lequel préférez-vous ?", created_at: new Date(Date.now() - 3100000).toISOString() },
          { role: "user", text: "14h30 c'est parfait pour moi merci !", created_at: new Date(Date.now() - 3000000).toISOString() },
          { role: "assistant", text: "C'est confirmé pour samedi à 14h30 pour vos demi-jambes et aisselles ! Vous recevrez un rappel par SMS la veille. À très bientôt !", created_at: new Date(Date.now() - 2900000).toISOString() },
        ],
      };
    }
    return {};
  }

  const token = auth.getToken();
  const headers = new Headers(options.headers || {});
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);

  try {
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
  } catch (err) {
    // JAMAIS de repli sur les données de démonstration ici.
    //
    // Ce bloc renvoyait `DEMO_DATA` dès qu'une requête échouait — panne réseau,
    // mais aussi 500, 403 ou 401, puisque le `throw` ci-dessus passe par ce
    // `catch`. Un institut qui paie voyait donc apparaître les rendez-vous et
    // les conversations de « L'Échappée Belle » à la place des siens, sans rien
    // qui les distingue des vrais. Un gérant pouvait lire « RDV confirmé
    // samedi 14 h 30 » pour une cliente qui n'existe pas, ou voir zéro escalade
    // pendant qu'une vraie question médicale attend.
    //
    // Effet de bord tout aussi grave : toute panne du backend devenait
    // invisible, chaque tableau de bord paraissant en bonne santé.
    //
    // Une erreur doit se voir. C'est tout.
    if (err instanceof TypeError) {
      // `fetch` ne lève un TypeError que sur un échec réseau : serveur
      // injoignable, DNS, CORS. Le distinguer d'une erreur applicative évite
      // d'envoyer le gérant chercher un problème dans ses données.
      throw new Error(
        "Serveur injoignable. Vérifiez votre connexion : aucune donnée n'a pu être chargée.",
      );
    }
    throw err;
  }
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
  session.tenantName = data.membership.tenantName ?? "Institut L'Échappée Belle";
  session.timezone = data.membership.timezone ?? "Europe/Paris";

  return session;
}

/**
 * Appelle une action serveur du dashboard.
 */
export async function callApi(action, payload = {}) {
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

  if (auth.isDemo()) {
    if (action === "create_checkout_session") {
      return { url: "https://checkout.stripe.com/demo" };
    }
    if (action === "create_billing_portal") {
      return { url: "https://billing.stripe.com/demo" };
    }
    return { ok: true };
  }

  return await apiFetch(route, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}
