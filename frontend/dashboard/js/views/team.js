// Équipe : membres et invitations en attente.
//
// Un institut où une seule personne peut voir les conversations escaladées
// n'est pas tenable : c'est précisément quand elle est absente que l'escalade
// tombe. Le schéma et les policies existaient depuis le début ; il manquait le
// chemin pour ajouter quelqu'un.

import {
  fetchMembers,
  fetchPendingInvitations,
  inviteMember,
  removeMember,
  revokeInvitation,
} from "../api.js";
import { isOwner } from "../client.js";
import {
  asyncButton,
  badge,
  card,
  el,
  empty,
  errorBox,
  field,
  formatDateTime,
  mount,
  successBox,
  table,
} from "../dom.js";

const ROLE_LABEL = { owner: "propriétaire", member: "membre" };

export async function renderTeam() {
  const container = el("div", {});
  const feedback = el("div", { class: "feedback" });
  const body = el("div", {});

  async function load() {
    mount(body, el("p", { class: "loading", text: "Chargement…" }));

    const [members, invitations] = await Promise.all([
      fetchMembers(),
      isOwner() ? fetchPendingInvitations() : Promise.resolve([]),
    ]);

    const memberRows = members.map((member) => [
      member.email,
      badge(ROLE_LABEL[member.role] ?? member.role, member.role === "owner" ? "ok" : "neutral"),
      formatDateTime(member.joined_at),
      // Le propriétaire ne peut pas se retirer lui-même : l'institut resterait
      // sans personne pour connecter un canal ou résilier l'abonnement.
      isOwner() && !member.is_me
        ? asyncButton("Retirer", async () => {
          mount(feedback);
          if (!globalThis.confirm(
            `Retirer ${member.email} de l'équipe ?\n\n` +
              "Cette personne perdra l'accès aux conversations et aux rendez-vous. " +
              "Vous pourrez l'inviter de nouveau.",
          )) return;

          try {
            await removeMember(member.user_id);
            mount(feedback, successBox("Membre retiré."));
            await load();
          } catch (error) {
            mount(feedback, errorBox(error.message));
          }
        }, { class: "btn btn--small btn--danger", busyLabel: "…" })
        : el("span", { class: "muted", text: member.is_me ? "vous" : "—" }),
    ]);

    const blocks = [
      card(
        "Membres",
        memberRows.length === 0
          ? empty("Aucun membre.")
          : table(["Adresse", "Rôle", "Depuis", ""], memberRows),
      ),
    ];

    if (isOwner()) {
      const invitationRows = invitations.map((invitation) => [
        invitation.email,
        ROLE_LABEL[invitation.role] ?? invitation.role,
        formatDateTime(invitation.expires_at),
        asyncButton("Annuler", async () => {
          mount(feedback);
          try {
            await revokeInvitation(invitation.id);
            mount(feedback, successBox("Invitation annulée."));
            await load();
          } catch (error) {
            mount(feedback, errorBox(error.message));
          }
        }, { class: "btn btn--small btn--ghost", busyLabel: "…" }),
      ]);

      blocks.push(
        card(
          "Invitations en attente",
          invitationRows.length === 0
            ? empty("Aucune invitation en attente.")
            : table(["Adresse", "Rôle", "Expire le", ""], invitationRows),
        ),
        buildInviteForm(feedback, load),
      );
    }

    mount(body, ...blocks);
  }

  await load();

  mount(
    container,
    el("h1", { class: "page-title", text: "Équipe" }),
    feedback,
    body,
  );

  return container;
}

function buildInviteForm(feedback, reload) {
  const emailInput = el("input", { type: "email", placeholder: "collegue@institut.fr" });
  const roleSelect = el("select", { class: "select" });
  roleSelect.append(el("option", { value: "member", text: "Membre" }));
  roleSelect.append(el("option", { value: "owner", text: "Propriétaire" }));

  const submit = asyncButton("Inviter", async () => {
    mount(feedback);

    const email = emailInput.value.trim();
    if (!email.includes("@")) {
      mount(feedback, errorBox("Adresse e-mail invalide."));
      return;
    }

    try {
      await inviteMember(email, roleSelect.value);
      emailInput.value = "";
      mount(
        feedback,
        successBox(
          "Invitation envoyée. Elle sera aussi visible pour cette personne " +
            "dès qu'elle se connectera avec cette adresse.",
        ),
      );
      await reload();
    } catch (error) {
      mount(feedback, errorBox(error.message));
    }
  }, { busyLabel: "Envoi…" });

  return card(
    "Inviter quelqu'un",
    el("p", {
      class: "muted",
      text: "Aucun lien à transmettre : la personne se connecte au tableau de bord " +
        "avec l'adresse invitée, et l'invitation l'y attend. Un propriétaire peut " +
        "tout modifier, y compris l'abonnement.",
    }),
    field("Adresse e-mail", emailInput),
    field("Rôle", roleSelect),
    submit,
  );
}
