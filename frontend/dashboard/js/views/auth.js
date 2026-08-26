// Connexion et création d'institut (Neon Auth).

import { auth } from "../client.js";
import { acceptInvitation, createTenantWithOwner } from "../api.js";
import { CONFIG } from "../../config.js";
import { asyncButton, card, checkbox, el, errorBox, field, mount, successBox } from "../dom.js";

/**
 * Connexion par lien magique autonome : pas de mot de passe à gérer.
 */
export function renderAuth(onSignedIn) {
  const feedback = el("div", { class: "feedback" });
  const email = el("input", { type: "email", placeholder: "vous@institut.fr" });

  const submit = asyncButton("Recevoir le lien de connexion", async () => {
    mount(feedback);

    const value = email.value.trim();
    if (!value.includes("@")) {
      mount(feedback, errorBox("Adresse e-mail invalide."));
      return;
    }

    const { error } = await auth.signInWithOtp({ email: value });

    mount(
      feedback,
      error
        ? errorBox(error.message)
        : successBox("Lien envoyé. Ouvrez votre boîte mail depuis cet appareil."),
    );
  }, { busyLabel: "Envoi…" });

  auth.onAuthStateChange((event) => {
    if (event === "SIGNED_IN") onSignedIn();
  });

  return el("div", { class: "centered" }, [
    card(
      "Setwise",
      el("p", { class: "muted", text: "Tableau de bord de votre institut." }),
      field("Adresse e-mail", email),
      submit,
      feedback,
    ),
  ]);
}

/** Lien vers une page du site vitrine, ouvert dans un nouvel onglet. */
function siteLink(path, label) {
  const base = (CONFIG.SITE_URL ?? "").replace(/\/+$/, "");
  return el("a", { href: `${base}${path}`, text: label, target: "_blank" });
}

/**
 * Invitations adressées à ce compte.
 */
function buildInvitationCard(invitations, feedback, onJoined) {
  const rows = invitations.map((invitation) =>
    el("div", { class: "invite" }, [
      el("span", { text: invitation.tenant_name }),
      asyncButton("Rejoindre", async () => {
        mount(feedback);
        try {
          await acceptInvitation(invitation.id);
          onJoined();
        } catch (error) {
          mount(feedback, errorBox(error.message));
        }
      }, { busyLabel: "…" }),
    ])
  );

  return card(
    invitations.length > 1 ? "Vous êtes attendue" : "Vous êtes attendue chez",
    el("p", {
      class: "muted",
      text: "Rejoignez cette équipe plutôt que de créer un second établissement.",
    }),
    ...rows,
  );
}

export function renderOnboarding(onCreated, pendingInvitations) {
  const feedback = el("div", { class: "feedback" });
  const name = el("input", { type: "text", placeholder: "Institut Belle Époque" });
  const timezone = el("input", { type: "text", value: "Europe/Paris" });

  const terms = checkbox(
    "J'accepte les ",
    siteLink("/cgv.html", "conditions générales"),
    " et j'ai pris connaissance de la ",
    siteLink("/confidentialite.html", "politique de confidentialité"),
    ".",
  );

  const submit = asyncButton("Créer mon institut", async () => {
    mount(feedback);

    if (!name.value.trim()) {
      mount(feedback, errorBox("Le nom de l'institut est obligatoire."));
      return;
    }
    if (!terms.input.checked) {
      mount(feedback, errorBox("L'acceptation des conditions générales est obligatoire."));
      return;
    }

    try {
      await createTenantWithOwner(
        name.value.trim(),
        timezone.value.trim() || "Europe/Paris",
        CONFIG.TERMS_VERSION,
      );
      onCreated();
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Création…" });

  const invitations = pendingInvitations ?? [];

  return el("div", { class: "centered" }, [
    invitations.length > 0 ? buildInvitationCard(invitations, feedback, onCreated) : null,
    card(
      invitations.length > 0 ? "Ou créer votre propre institut" : "Bienvenue",
      el("p", {
        class: "muted",
        text: "Dernière étape : créer votre institut. Un agent de qualification " +
          "prêt à l'emploi sera configuré automatiquement.",
      }),
      field("Nom de l'institut", name),
      field("Fuseau horaire", timezone, "Identifiant IANA, par exemple Europe/Paris."),
      terms.label,
      submit,
      feedback,
    ),
  ]);
}
