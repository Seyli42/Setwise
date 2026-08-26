// Point d'entrée : session, routage par hash, coquille de l'application (Neon).

import { auth, loadTenant, session } from "./client.js";
import { clear, el, errorBox, mount } from "./dom.js";
import { renderAuth, renderOnboarding } from "./views/auth.js";
import { renderOverview } from "./views/overview.js";
import { renderConversations } from "./views/conversations.js";
import { renderLeads } from "./views/leads.js";
import { renderAppointments } from "./views/appointments.js";
import { renderAgent } from "./views/agent.js";
import { renderConnections } from "./views/connections.js";
import { renderBilling } from "./views/billing.js";
import { renderSettings } from "./views/settings.js";
import { renderTeam } from "./views/team.js";
import { fetchMyInvitations } from "./api.js";

const ROUTES = [
  { path: "overview", label: "Vue d'ensemble", render: renderOverview },
  { path: "conversations", label: "Conversations", render: renderConversations },
  { path: "leads", label: "Leads", render: renderLeads },
  { path: "appointments", label: "Rendez-vous", render: renderAppointments },
  { path: "agent", label: "Mon agent", render: renderAgent },
  { path: "connections", label: "Connexions", render: renderConnections },
  { path: "billing", label: "Abonnement", render: renderBilling },
  { path: "team", label: "Équipe", render: renderTeam },
  { path: "settings", label: "Réglages", render: renderSettings },
];

const root = document.getElementById("app");
let viewContainer = null;

function currentRoute() {
  const path = (location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0] || "overview").trim();
  return ROUTES.find((route) => route.path === path) ?? ROUTES[0];
}

function renderShell() {
  const nav = el("nav", { class: "nav" }, [
    el("div", { class: "nav__brand", text: "Setwise" }),
    el(
      "ul",
      { class: "nav__links" },
      ROUTES.map((route) =>
        el("li", {}, [
          el("a", {
            class: "nav__link",
            href: `#/${route.path}`,
            text: route.label,
            data: { path: route.path },
          }),
        ])
      ),
    ),
    el("div", { class: "nav__account" }, [
      el("span", { class: "nav__tenant", text: session.tenantName ?? "" }),
      el("button", {
        class: "btn btn--ghost",
        type: "button",
        text: "Déconnexion",
        on: {
          click() {
            auth.signOut();
            location.hash = "";
            location.reload();
          },
        },
      }),
    ]),
  ]);

  viewContainer = el("main", { class: "view" });
  mount(root, el("div", { class: "layout" }, [nav, viewContainer]));
}

function highlightActiveLink(path) {
  for (const link of root.querySelectorAll(".nav__link")) {
    link.classList.toggle("nav__link--active", link.dataset.path === path);
  }
}

async function renderCurrentView() {
  if (!viewContainer) return;

  const route = currentRoute();
  highlightActiveLink(route.path);
  mount(viewContainer, el("p", { class: "loading", text: "Chargement…" }));

  try {
    const node = await route.render();
    mount(viewContainer, node);
  } catch (error) {
    mount(
      viewContainer,
      errorBox(`Impossible de charger cette page : ${error.message}`),
      el("button", {
        class: "btn",
        type: "button",
        text: "Réessayer",
        on: { click: renderCurrentView },
      }),
    );
  }
}

/**
 * Consomme un jeton de lien magique s'il est présent dans l'URL.
 */
async function consumeMagicToken() {
  const searchParams = new URLSearchParams(location.search);
  let token = searchParams.get("token");
  let email = searchParams.get("email");

  if (!token && location.hash.includes("token=")) {
    const hashParams = new URLSearchParams(location.hash.replace(/^#\/?/, ""));
    token = hashParams.get("token");
    email = hashParams.get("email");
  }

  if (token) {
    try {
      mount(root, el("p", { class: "loading", text: "Connexion en cours…" }));
      await auth.verifyToken(token, email ?? undefined);
      // Nettoie l'URL
      history.replaceState(null, "", location.pathname + "#/overview");
      return true;
    } catch (err) {
      mount(root, errorBox(`Connexion impossible : ${err.message}`));
      return false;
    }
  }
  return false;
}

async function boot() {
  // 1. Vérification si un token magique arrive dans l'URL
  if (location.search.includes("token=") || location.hash.includes("token=")) {
    const consumed = await consumeMagicToken();
    if (!consumed && !auth.getToken()) return;
  }

  // 2. Vérification session
  const { data: { session: authSession } } = await auth.getSession();

  if (!authSession) {
    mount(root, renderAuth(boot));
    return;
  }
  session.user = authSession.user;

  let tenant = null;
  try {
    tenant = await loadTenant();
  } catch (error) {
    mount(root, errorBox(`Connexion à l'API impossible : ${error.message}`));
    return;
  }

  // 3. Pas d'institut rattaché -> Onboarding
  if (!tenant) {
    const invitations = await fetchMyInvitations().catch(() => []);
    mount(root, renderOnboarding(boot, invitations));
    return;
  }

  // 4. Shell et vue active
  renderShell();
  await renderCurrentView();
}

globalThis.addEventListener("hashchange", renderCurrentView);

auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    clear(root);
    boot();
  }
});

boot();
