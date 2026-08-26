// Accès aux données du dashboard via l'API REST Setwise.

import { apiFetch } from "./client.js";

// ============================================================
// Vue d'ensemble
// ============================================================

export async function fetchOverview() {
  const data = await apiFetch("/api/overview");
  return {
    leads30d: data.today_leads_count ?? 0,
    qualified30d: data.billing?.active ? 1 : 0,
    upcomingAppointments: data.upcoming_appointments_count ?? 0,
    openEscalations: data.open_escalations_count ?? 0,
    recentConversations: [],
    billing: data.billing,
  };
}

// ============================================================
// Conversations
// ============================================================

export async function fetchConversations({ status = null, limit = 60 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (limit) params.set("limit", String(limit));

  const data = await apiFetch(`/api/conversations?${params}`);
  return data.conversations ?? [];
}

export async function fetchMessages(conversationId) {
  const data = await apiFetch(`/api/conversations/${conversationId}/messages`);
  return data.messages ?? [];
}

export async function fetchOpenEscalation(conversationId) {
  const data = await apiFetch(`/api/conversations/${conversationId}/escalation`);
  return data.escalation ?? null;
}

// ============================================================
// Leads & rendez-vous
// ============================================================

export async function fetchLeads({ status = null, limit = 100 } = {}) {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (limit) params.set("limit", String(limit));

  const data = await apiFetch(`/api/leads?${params}`);
  return data.leads ?? [];
}

export async function forgetLead(leadId) {
  await apiFetch(`/api/leads/${leadId}/forget`, { method: "POST" });
}

export async function fetchAppointments({ _upcoming = true, limit = 100 } = {}) {
  const data = await apiFetch(`/api/appointments?limit=${limit}`);
  return data.appointments ?? [];
}

export async function markNoShow(appointmentId) {
  await apiFetch(`/api/appointments/${appointmentId}/no-show`, { method: "POST" });
}

// ============================================================
// Configuration de l'agent
// ============================================================

export async function fetchAgent() {
  const data = await apiFetch("/api/agent");
  if (!data || !data.agent) return null;

  return {
    agent: {
      id: data.agent.id,
      name: data.agent.name,
      system_prompt_template: data.agent.system_prompt_template,
      config: data.agent.config,
      is_active: data.agent.is_active,
    },
    script: data.agent.script_id
      ? {
        id: data.agent.script_id,
        version: data.agent.script_version,
        questions: data.agent.questions,
        budget_rules: data.agent.budget_rules,
        escalation_keywords: data.agent.escalation_keywords,
      }
      : null,
  };
}

export async function saveAgent(_agentId, patch) {
  await apiFetch("/api/agent", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function saveScript(agentId, _currentVersion, patch) {
  await apiFetch(`/api/agent/${agentId}/script`, {
    method: "POST",
    body: JSON.stringify(patch),
  });
}

// ============================================================
// Connexions
// ============================================================

export async function fetchConnections() {
  const data = await apiFetch("/api/connections");
  return {
    channels: data.channels ?? [],
    calendars: data.calendars ?? [],
  };
}

// ============================================================
// Réglages de l'institut
// ============================================================

export async function fetchTenantSettings() {
  const data = await apiFetch("/api/settings");
  return data.settings ?? null;
}

export async function fetchPerformance(days = 30) {
  const data = await apiFetch(`/api/performance?days=${days}`);
  return data.performance ?? {};
}

export async function saveTenantSettings(_tenantId, patch) {
  await apiFetch("/api/settings", {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ============================================================
// Équipe
// ============================================================

export async function fetchMembers() {
  const data = await apiFetch("/api/team/members");
  return data.members ?? [];
}

export async function fetchPendingInvitations() {
  const data = await apiFetch("/api/team/invitations");
  return data.invitations ?? [];
}

export async function inviteMember(email, role = "member") {
  const data = await apiFetch("/api/team/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
  return data.invitation_id;
}

export async function revokeInvitation(invitationId) {
  await apiFetch(`/api/team/invitations/${invitationId}`, { method: "DELETE" });
}

export async function removeMember(userId) {
  await apiFetch(`/api/team/members/${userId}`, { method: "DELETE" });
}

export async function fetchMyInvitations() {
  const data = await apiFetch("/api/invitations/pending");
  return data.invitations ?? [];
}

export async function acceptInvitation(invitationId) {
  const data = await apiFetch("/api/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ invitation_id: invitationId }),
  });
  return data.tenant_id;
}

export async function createTenantWithOwner(name, timezone, termsVersion) {
  const data = await apiFetch("/api/tenants", {
    method: "POST",
    body: JSON.stringify({ name, timezone, terms_version: termsVersion }),
  });
  return data.tenant_id;
}
