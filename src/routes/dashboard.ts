// API REST et actions du tableau de bord Setwise (Neon).
//
// `sql` est ici le rôle applicatif (`setwise_app`), soumis à la RLS depuis
// `migrations/0007_rls_policies.sql`. Toute requête touchant une table
// métier doit passer par `withTenant(caller.tenantId, ...)` : hors
// transaction, `app.tenant_id` n'est pas posé et la policy ne renvoie rien
// (ou lève, selon l'opération) — c'est le filet qui remplace le filtre
// manuel que chaque requête devait porter jusqu'ici.
//
// `sqlWorker` reste utilisé pour les requêtes qui n'ont PAS encore de tenant
// connu : la création d'un institut, l'acceptation d'une invitation, la
// résolution du tenant dans `authenticateCaller`/`handleGetMe`. Ce sont
// exactement les cas déjà annotés `tenant-ok` avant cette migration.
//
// Aucune transaction n'est jamais tenue ouverte pendant un appel réseau
// externe (Stripe, Meta, Google) : les lectures/écritures qui encadrent ces
// appels sont scindées en blocs `withTenant` courts, l'appel externe se
// plaçant toujours à l'extérieur.

import { sql, sqlWorker, withTenant } from "../db.ts";
import {
  audit,
  authenticateCaller,
  authenticateUserOnly,
  requireOwner,
} from "../auth.ts";
import { ValidationError } from "../_shared/errors.ts";
import { enforceRateLimit } from "../_shared/rateLimit.ts";
import { encryptSecret } from "../_shared/crypto.ts";
import { isWindowOpen } from "../_shared/messagingWindow.ts";
import { findWhatsAppConnection, resolveConnection } from "../_shared/channels/connection.ts";
import { createInstagramSender } from "../_shared/channels/instagram.ts";
import { createWhatsAppSender } from "../_shared/channels/whatsapp.ts";
import { recordOutbound } from "../_shared/agent/memory.ts";
import { exchangeAuthorizationCode } from "../_shared/calendar/google.ts";
import { ensureStripeCustomer, getBillingState } from "../_shared/billing.ts";
import { stripe, stripeError } from "../_shared/stripe.ts";
import { discoverAssets, exchangeOAuthCode } from "../_shared/channels/metaOauth.ts";
import type { Channel } from "../_shared/types.ts";

export async function handleDashboardApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = req.method;

  // ============================================================
  // Routes ouvertes aux utilisateurs authentifiés sans institut (Onboarding & invitations)
  // ============================================================
  // Aucun tenant n'existe encore à ce stade : ces requêtes restent sur le
  // rôle système (sqlWorker), qui n'est pas soumis à la RLS.

  if (path === "/api/tenants" && method === "POST") {
    const user = await authenticateUserOnly(req);
    const body = await req.json().catch(() => ({}));
    const name = String(body.name ?? "").trim();
    const timezone = String(body.timezone ?? "Europe/Paris").trim();
    const termsVersion = body.terms_version ? String(body.terms_version).trim() : null;

    const res = await sqlWorker`
      select create_tenant_with_owner(
        ${user.userId}::uuid,
        ${name},
        ${timezone},
        ${termsVersion}
      ) as tenant_id;
    `;

    return Response.json({ ok: true, tenant_id: res[0].tenant_id });
  }

  if (path === "/api/invitations/pending" && method === "GET") {
    const user = await authenticateUserOnly(req);
    // tenant-ok: pas encore rattaché à un institut — l'appariement se fait
    // sur l'adresse vérifiée du jeton, pas sur un tenant. Rôle système.
    const invitations = await sqlWorker`
      select ti.id, ti.tenant_id, ti.role, ti.created_at, ti.expires_at, t.name as tenant_name
        from tenant_invitations ti
        join tenants t on t.id = ti.tenant_id
       where lower(ti.email) = lower(${user.email})
         and ti.accepted_at is null
         and ti.expires_at > now();
    `;
    return Response.json({ invitations });
  }

  if (path === "/api/invitations/accept" && method === "POST") {
    const user = await authenticateUserOnly(req);
    const body = await req.json().catch(() => ({}));
    const invitationId = String(body.invitation_id ?? "");

    const res = await sqlWorker`
      select accept_invitation(
        ${user.userId}::uuid,
        ${user.email},
        ${invitationId}::uuid
      ) as tenant_id;
    `;

    return Response.json({ ok: true, tenant_id: res[0].tenant_id });
  }

  // ============================================================
  // Routes protégées par l'appartenance à un institut
  // ============================================================

  const caller = await authenticateCaller(req);

  // Plafond par institut : couvre tout ce qui suit dans cette fonction, donc
  // toutes les routes protégées. Échec OUVERT — le jeton déjà vérifié est la
  // protection de fond, ce plafond n'est qu'un filet contre un client mal
  // écrit ou un script en boucle, pas la ligne de défense principale.
  await enforceRateLimit({
    bucket: `dashboard_api:tenant:${caller.tenantId}`,
    limit: 300,
    windowSeconds: 60,
  });

  // 1. Overview
  if (path === "/api/overview" && method === "GET") {
    const [rows, billing] = await Promise.all([
      withTenant(caller.tenantId, async (tx) => {
        const [tenantRows, agentRows, escalations, appointments, leadsCount] = await Promise.all([
          tx`select id, name, timezone, plan, siret, notification_email, notification_phone from tenants where id = ${caller.tenantId}::uuid;`,
          tx`select id, name, type, is_active from agents where tenant_id = ${caller.tenantId}::uuid and type = 'qualification_rdv' limit 1;`,
          tx`select count(*) as count from escalations where tenant_id = ${caller.tenantId}::uuid and status = 'open';`,
          tx`select count(*) as count from appointments where tenant_id = ${caller.tenantId}::uuid and starts_at >= now() and status in ('pending', 'confirmed');`,
          tx`select count(*) as count from leads where tenant_id = ${caller.tenantId}::uuid and created_at >= date_trunc('day', now());`,
        ]);
        return { tenantRows, agentRows, escalations, appointments, leadsCount };
      }),
      // `getBillingState` reste sur le rôle système (`_shared/billing.ts`) :
      // requête indépendante, menée en parallèle sur sa propre connexion.
      getBillingState(caller.tenantId),
    ]);

    return Response.json({
      tenant: rows.tenantRows[0] ?? null,
      agent: rows.agentRows[0] ?? null,
      open_escalations_count: Number(rows.escalations[0]?.count ?? 0),
      upcoming_appointments_count: Number(rows.appointments[0]?.count ?? 0),
      today_leads_count: Number(rows.leadsCount[0]?.count ?? 0),
      billing,
    });
  }

  // 2. Conversations
  if (path === "/api/conversations" && method === "GET") {
    const status = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 100);

    const conversations = await withTenant(caller.tenantId, (tx) =>
      status
        ? tx`
          select c.id, c.channel, c.status, c.last_message_at, c.messaging_window_expires_at,
                 l.id as lead_id, l.full_name as lead_name, l.phone as lead_phone,
                 a.name as agent_name,
                 (select content from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_message
            from conversations c
            left join leads l on l.id = c.lead_id
            left join agents a on a.id = c.agent_id
           where c.tenant_id = ${caller.tenantId}::uuid
             and c.status = ${status}
           order by c.last_message_at desc
           limit ${limit};
        `
        : tx`
          select c.id, c.channel, c.status, c.last_message_at, c.messaging_window_expires_at,
                 l.id as lead_id, l.full_name as lead_name, l.phone as lead_phone,
                 a.name as agent_name,
                 (select content from messages m where m.conversation_id = c.id order by created_at desc limit 1) as last_message
            from conversations c
            left join leads l on l.id = c.lead_id
            left join agents a on a.id = c.agent_id
           where c.tenant_id = ${caller.tenantId}::uuid
           order by c.last_message_at desc
           limit ${limit};
        `);

    return Response.json({ conversations });
  }

  // 3. Conversation Messages
  const messagesMatch = path.match(/^\/api\/conversations\/([0-9a-f-]+)\/messages$/);
  if (messagesMatch && method === "GET") {
    const conversationId = messagesMatch[1];

    const messages = await withTenant(caller.tenantId, async (tx) => {
      const conv = await tx`select id from conversations where id = ${conversationId}::uuid and tenant_id = ${caller.tenantId}::uuid limit 1;`;
      if (conv.length === 0) throw new ValidationError("Conversation introuvable.");

      return tx`
        select id, direction, sender_type, content, created_at
          from messages
         where conversation_id = ${conversationId}::uuid
         order by created_at asc;
      `;
    });

    return Response.json({ messages });
  }

  // 4. Conversation Escalation
  const escMatch = path.match(/^\/api\/conversations\/([0-9a-f-]+)\/escalation$/);
  if (escMatch && method === "GET") {
    const conversationId = escMatch[1];
    const escalations = await withTenant(caller.tenantId, (tx) =>
      tx`
        select id, reason, triggered_by, status, created_at, resolved_by
          from escalations
         where conversation_id = ${conversationId}::uuid
           and tenant_id = ${caller.tenantId}::uuid
         order by created_at desc
         limit 1;
      `);
    return Response.json({ escalation: escalations[0] ?? null });
  }

  // 5. Leads
  if (path === "/api/leads" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const leads = await withTenant(caller.tenantId, (tx) =>
      tx`
        select id, full_name, phone, instagram_handle, source, qualification_data, status, created_at, deleted_at
          from leads
         where tenant_id = ${caller.tenantId}::uuid
         order by created_at desc
         limit ${limit};
      `);
    return Response.json({ leads });
  }

  // 6. Lead Droit à l'oubli
  const forgetMatch = path.match(/^\/api\/leads\/([0-9a-f-]+)\/forget$/);
  if (forgetMatch && method === "POST") {
    const leadId = forgetMatch[1];
    await withTenant(caller.tenantId, (tx) =>
      tx`select forget_lead(${caller.tenantId}::uuid, ${leadId}::uuid, ${caller.userId}::uuid);`);
    return Response.json({ ok: true });
  }

  // 7. Appointments
  if (path === "/api/appointments" && method === "GET") {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const appointments = await withTenant(caller.tenantId, (tx) =>
      tx`
        select a.id, a.starts_at, a.ends_at, a.service_type, a.status, a.reminder_sent_at, a.created_at,
               l.id as lead_id, l.full_name as lead_name, l.phone as lead_phone
          from appointments a
          left join leads l on l.id = a.lead_id
         where a.tenant_id = ${caller.tenantId}::uuid
         order by a.starts_at desc
         limit ${limit};
      `);
    return Response.json({ appointments });
  }

  // 8. Appointment No-Show
  const noShowMatch = path.match(/^\/api\/appointments\/([0-9a-f-]+)\/no-show$/);
  if (noShowMatch && method === "POST") {
    const appointmentId = noShowMatch[1];
    await withTenant(caller.tenantId, (tx) =>
      tx`
        update appointments
           set status = 'no_show'
         where id = ${appointmentId}::uuid
           and tenant_id = ${caller.tenantId}::uuid;
      `);
    await audit({ caller, action: "mark_no_show", entity: "appointments", entityId: appointmentId });
    return Response.json({ ok: true });
  }

  // 9. Agent config
  if (path === "/api/agent" && method === "GET") {
    const agentRows = await withTenant(caller.tenantId, (tx) =>
      tx`
        select a.id, a.name, a.type, a.system_prompt_template, a.config, a.is_active,
               qs.id as script_id, qs.version as script_version, qs.questions, qs.budget_rules, qs.escalation_keywords
          from agents a
          left join qualification_scripts qs on qs.agent_id = a.id and qs.is_active = true
         where a.tenant_id = ${caller.tenantId}::uuid
           and a.type = 'qualification_rdv'
         order by qs.version desc
         limit 1;
      `);
    return Response.json({ agent: agentRows[0] ?? null });
  }

  if (path === "/api/agent" && method === "PATCH") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const name = body.name ? String(body.name).trim() : undefined;
    const systemPromptTemplate = body.system_prompt_template ? String(body.system_prompt_template) : undefined;
    const config = body.config ? body.config : undefined;

    const rows = await withTenant(caller.tenantId, (tx) =>
      tx`
        update agents
           set name = coalesce(${name ?? null}, name),
               system_prompt_template = coalesce(${systemPromptTemplate ?? null}, system_prompt_template),
               config = coalesce(${config ? tx.json(config) : null}, config)
         where tenant_id = ${caller.tenantId}::uuid
           and type = 'qualification_rdv'
         returning id;
      `);

    await audit({ caller, action: "update_agent", entity: "agents", entityId: rows[0]?.id });
    return Response.json({ ok: true });
  }

  // 10. Qualification Script Update
  const scriptMatch = path.match(/^\/api\/agent\/([0-9a-f-]+)\/script$/);
  if (scriptMatch && method === "POST") {
    requireOwner(caller);
    const agentId = scriptMatch[1];
    const body = await req.json().catch(() => ({}));
    const questions = body.questions ?? [];
    const budgetRules = body.budget_rules ?? {};
    const escalationKeywords = body.escalation_keywords ?? [];

    const scriptResult = await withTenant(caller.tenantId, async (tx) => {
      // FAILLE CORRIGÉE : `requireOwner` ne vérifie que le RÔLE de l'appelant,
      // jamais que l'agent visé lui appartient. Sans ce contrôle, le
      // propriétaire d'un institut pouvait réécrire le script de qualification
      // de n'importe quel autre — y compris vider `escalation_keywords`, ce qui
      // désactive le garde-fou sur les questions médicales chez un concurrent.
      // La RLS (policy `agents_isolation`) referme désormais ce chemin même si
      // ce contrôle explicite venait à disparaître : `agentId` hors du tenant
      // ne renvoie simplement aucune ligne, ici comme dans la policy jointe de
      // `qualification_scripts`.
      const ownedAgent = await tx`
        select id from agents
         where id = ${agentId}::uuid
           and tenant_id = ${caller.tenantId}::uuid
         limit 1;
      `;
      if (ownedAgent.length === 0) throw new ValidationError("Agent introuvable.");

      const latest = await tx`
        select version from qualification_scripts where agent_id = ${agentId}::uuid order by version desc limit 1;
      `;
      const nextVersion = (latest[0]?.version ?? 0) + 1;

      await tx`update qualification_scripts set is_active = false where agent_id = ${agentId}::uuid;`;

      const insert = await tx`
        insert into qualification_scripts (
          agent_id,
          version,
          questions,
          budget_rules,
          escalation_keywords,
          is_active
        ) values (
          ${agentId}::uuid,
          ${nextVersion},
          ${tx.json(questions)},
          ${tx.json(budgetRules)},
          ${escalationKeywords},
          true
        )
        returning id;
      `;

      return { scriptId: insert[0].id, version: nextVersion };
    });

    await audit({ caller, action: "update_script", entity: "qualification_scripts", entityId: scriptResult.scriptId });
    return Response.json({ ok: true, script_id: scriptResult.scriptId, version: scriptResult.version });
  }

  // 11. Connections
  if (path === "/api/connections" && method === "GET") {
    const { channels, calendars } = await withTenant(caller.tenantId, async (tx) => {
      const [channels, calendars] = await Promise.all([
        tx`
          select id, channel, external_account_id, status, token_expires_at, last_refreshed_at, refresh_error, created_at
            from channel_connections
           where tenant_id = ${caller.tenantId}::uuid;
        `,
        tx`
          select id, provider, calendar_external_id, status, created_at
            from calendar_integrations
           where tenant_id = ${caller.tenantId}::uuid;
        `,
      ]);
      return { channels, calendars };
    });
    return Response.json({ channels, calendars });
  }

  // 12. Settings
  if (path === "/api/settings" && method === "GET") {
    const rows = await withTenant(caller.tenantId, (tx) =>
      tx`
        select id, name, siret, timezone, plan, notification_email, notification_phone,
               escalation_reminder_hours, data_retention_days, created_at
          from tenants
         where id = ${caller.tenantId}::uuid;
      `);
    return Response.json({ settings: rows[0] ?? null });
  }

  if (path === "/api/settings" && method === "PATCH") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));

    // Les bornes sont rétablies en base (migration 0003), mais un refus SQL
    // brut n'apprend rien au gérant. On valide ici pour lui dire ce qui ne va
    // pas — la contrainte reste le filet, jamais l'unique contrôle.
    //
    // Ce qui est en jeu : `data_retention_days = 0` fait anonymiser tout
    // l'historique client dès la purge de la nuit suivante.
    if (body.data_retention_days !== undefined && body.data_retention_days !== null) {
      const jours = Number(body.data_retention_days);
      if (!Number.isInteger(jours) || jours < 30 || jours > 3650) {
        throw new ValidationError(
          "La durée de conservation doit être un nombre entier de jours compris entre 30 et 3650.",
        );
      }
    }

    if (body.escalation_reminder_hours !== undefined && body.escalation_reminder_hours !== null) {
      const heures = Number(body.escalation_reminder_hours);
      if (!Number.isInteger(heures) || heures < 1 || heures > 48) {
        throw new ValidationError(
          "Le délai de relance doit être un nombre entier d'heures compris entre 1 et 48.",
        );
      }
    }

    await withTenant(caller.tenantId, (tx) =>
      tx`
        update tenants
           set name = coalesce(${body.name ? String(body.name).trim() : null}, name),
               siret = coalesce(${body.siret ? String(body.siret).trim() : null}, siret),
               timezone = coalesce(${body.timezone ? String(body.timezone).trim() : null}, timezone),
               notification_email = coalesce(${body.notification_email ? String(body.notification_email).trim() : null}, notification_email),
               notification_phone = coalesce(${body.notification_phone ? String(body.notification_phone).trim() : null}, notification_phone),
               escalation_reminder_hours = coalesce(${typeof body.escalation_reminder_hours === "number" ? body.escalation_reminder_hours : null}, escalation_reminder_hours),
               data_retention_days = coalesce(${typeof body.data_retention_days === "number" ? body.data_retention_days : null}, data_retention_days)
         where id = ${caller.tenantId}::uuid;
      `);

    await audit({ caller, action: "update_settings", entity: "tenants", entityId: caller.tenantId });
    return Response.json({ ok: true });
  }

  // 13. Performance ROI
  if (path === "/api/performance" && method === "GET") {
    const days = Math.min(Number(url.searchParams.get("days") ?? 30), 365);
    const res = await withTenant(caller.tenantId, (tx) =>
      tx`select tenant_performance(${caller.tenantId}::uuid, ${days}) as performance;`);
    return Response.json({ performance: res[0]?.performance ?? null });
  }

  // 14. Team management
  if (path === "/api/team/members" && method === "GET") {
    const members = await withTenant(caller.tenantId, (tx) =>
      tx`
        select tu.id, tu.user_id, tu.role, tu.created_at, u.email
          from tenant_users tu
          join users u on u.id = tu.user_id
         where tu.tenant_id = ${caller.tenantId}::uuid
         order by tu.created_at asc;
      `);
    return Response.json({ members });
  }

  const removeMemberMatch = path.match(/^\/api\/team\/members\/([0-9a-f-]+)$/);
  if (removeMemberMatch && method === "DELETE") {
    requireOwner(caller);
    const targetUserId = removeMemberMatch[1];
    await withTenant(caller.tenantId, (tx) =>
      tx`select remove_member(${caller.tenantId}::uuid, ${caller.userId}::uuid, ${targetUserId}::uuid);`);
    return Response.json({ ok: true });
  }

  if (path === "/api/team/invitations" && method === "GET") {
    const invitations = await withTenant(caller.tenantId, (tx) =>
      tx`
        select id, email, role, created_at, expires_at
          from tenant_invitations
         where tenant_id = ${caller.tenantId}::uuid
           and accepted_at is null
           and expires_at > now()
         order by created_at desc;
      `);
    return Response.json({ invitations });
  }

  if (path === "/api/team/invitations" && method === "POST") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? "").trim();
    const role = String(body.role ?? "member").trim();

    const invitationId = await withTenant(caller.tenantId, async (tx) => {
      const invRows = await tx`
        select invite_member(${caller.tenantId}::uuid, ${caller.userId}::uuid, ${email}, ${role}) as id;
      `;
      const id = invRows[0].id;
      await tx`select enqueue_invitation_notification(${id}::uuid);`;
      return id;
    });

    return Response.json({ ok: true, invitation_id: invitationId });
  }

  const deleteInvMatch = path.match(/^\/api\/team\/invitations\/([0-9a-f-]+)$/);
  if (deleteInvMatch && method === "DELETE") {
    requireOwner(caller);
    const invId = deleteInvMatch[1];
    await withTenant(caller.tenantId, (tx) =>
      tx`
        delete from tenant_invitations
         where id = ${invId}::uuid
           and tenant_id = ${caller.tenantId}::uuid;
      `);
    return Response.json({ ok: true });
  }

  // 15. Facturation & Stripe
  if (path === "/api/billing/state" && method === "GET") {
    const [billing, plans] = await Promise.all([
      // Rôle système : requête indépendante du tenant courant (catalogue).
      getBillingState(caller.tenantId),
      // Catalogue global, non protégé par RLS : pas besoin de `withTenant`.
      sql`select id, name, description, stripe_price_id, monthly_price_cents, trial_days, max_locations from plans where is_active order by sort_order;`,
    ]);
    return Response.json({ billing, plans });
  }

  if (path === "/api/billing/checkout" && method === "POST") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const planId = String(body.plan_id ?? "").trim();
    const successUrl = String(body.success_url ?? "").trim();
    const cancelUrl = String(body.cancel_url ?? "").trim();

    if (!planId) throw new ValidationError("`plan_id` manquant.");
    if (!isSafeUrl(successUrl) || !isSafeUrl(cancelUrl)) throw new ValidationError("URL de retour invalide.");

    // Catalogue global : pas de tenant à poser.
    const planRows = await sql`select id, stripe_price_id, trial_days, is_active from plans where id = ${planId} limit 1;`;
    if (planRows.length === 0 || !planRows[0].is_active) throw new ValidationError("Formule inconnue ou indisponible.");

    // Lecture groupée AVANT l'appel Stripe : la transaction ne doit jamais
    // rester ouverte pendant un appel réseau externe. `previousSub` ne dépend
    // pas du résultat de `ensureStripeCustomer`, la réorganiser ici ne change
    // rien au comportement.
    const { tenantName, hasExistingSubscription } = await withTenant(caller.tenantId, async (tx) => {
      const [tenantRows, previousSub] = await Promise.all([
        tx`select name from tenants where id = ${caller.tenantId}::uuid limit 1;`,
        tx`select id from subscriptions where tenant_id = ${caller.tenantId}::uuid limit 1;`,
      ]);
      return {
        tenantName: tenantRows[0]?.name ?? "Institut",
        hasExistingSubscription: previousSub.length > 0,
      };
    });

    // Rôle système : écrit `tenants.stripe_customer_id`, appelle Stripe.
    const customerId = await ensureStripeCustomer({
      tenantId: caller.tenantId,
      email: caller.email,
      tenantName,
    });

    try {
      const session = await stripe().checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: planRows[0].stripe_price_id, quantity: 1 }],
        success_url: successUrl,
        cancel_url: cancelUrl,
        locale: "fr",
        subscription_data: {
          metadata: { tenant_id: caller.tenantId, plan: planRows[0].id },
          ...(hasExistingSubscription ? {} : { trial_period_days: planRows[0].trial_days }),
        },
        metadata: { tenant_id: caller.tenantId, plan: planRows[0].id },
      });

      await audit({ caller, action: "create_checkout_session", entity: "subscriptions" });
      return Response.json({ ok: true, url: session.url });
    } catch (cause) {
      throw stripeError("création de la session de paiement", cause);
    }
  }

  if (path === "/api/billing/portal" && method === "POST") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const returnUrl = String(body.return_url ?? "").trim();
    if (!isSafeUrl(returnUrl)) throw new ValidationError("URL de retour invalide.");

    const stripeCustomerId = await withTenant(caller.tenantId, async (tx) => {
      const tenantRows = await tx`select stripe_customer_id from tenants where id = ${caller.tenantId}::uuid limit 1;`;
      return tenantRows[0]?.stripe_customer_id as string | undefined;
    });
    if (!stripeCustomerId) throw new ValidationError("Aucun abonnement à gérer pour cet institut.");

    try {
      const session = await stripe().billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: returnUrl,
        locale: "fr",
      });
      return Response.json({ ok: true, url: session.url });
    } catch (cause) {
      throw stripeError("ouverture du portail de facturation", cause);
    }
  }

  // 16. Server Actions
  if (path === "/api/actions/send-message" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const conversationId = String(body.conversation_id ?? "");
    const text = String(body.text ?? "").trim();

    if (!conversationId) throw new ValidationError("`conversation_id` manquant.");
    if (!text) throw new ValidationError("Le message est vide.");

    const conv = await withTenant(caller.tenantId, async (tx) => {
      const convRows = await tx`
        select id, tenant_id, location_id, channel, external_thread_id, messaging_window_expires_at
          from conversations
         where id = ${conversationId}::uuid
           and tenant_id = ${caller.tenantId}::uuid
         limit 1;
      `;
      if (convRows.length === 0) throw new ValidationError("Conversation introuvable.");
      return convRows[0];
    });

    if (!isWindowOpen(conv.messaging_window_expires_at)) {
      throw new ValidationError("La fenêtre de 24 h est fermée.");
    }

    // Rôle système à partir d'ici : résolution de connexion (lit un jeton
    // chiffré, colonne inaccessible au rôle applicatif) puis appel réseau
    // externe — aucun des deux n'a sa place dans la transaction ci-dessus.
    const channel = conv.channel as Channel;
    const connection = channel === "whatsapp"
      ? await findWhatsAppConnection(caller.tenantId, conv.location_id)
      : await resolveConnectionForTenant(caller.tenantId, channel, conv.location_id);

    if (!connection) throw new ValidationError(`Aucune connexion ${channel} active.`);

    const sender = channel === "instagram"
      ? createInstagramSender(connection)
      : createWhatsAppSender(connection);

    const sent = await sender.send({
      externalThreadId: conv.external_thread_id,
      externalContactId: conv.external_thread_id,
      text,
    });

    await recordOutbound({
      conversationId,
      text,
      externalMessageId: sent.externalMessageId || null,
      senderType: "human",
    });

    await audit({ caller, action: "send_human_message", entity: "conversations", entityId: conversationId });
    return Response.json({ ok: true });
  }

  if (path === "/api/actions/resolve-escalation" && method === "POST") {
    const body = await req.json().catch(() => ({}));
    const escalationId = String(body.escalation_id ?? "");
    const reactivate = body.reactivate_agent !== false;

    if (!escalationId) throw new ValidationError("`escalation_id` manquant.");

    await withTenant(caller.tenantId, async (tx) => {
      const escRows = await tx`
        select id, tenant_id, conversation_id
          from escalations
         where id = ${escalationId}::uuid
           and tenant_id = ${caller.tenantId}::uuid
         limit 1;
      `;
      if (escRows.length === 0) throw new ValidationError("Escalade introuvable.");

      await tx`
        update escalations
           set status = 'resolved',
               resolved_by = ${caller.userId}::uuid
         where id = ${escalationId}::uuid;
      `;

      if (reactivate) {
        await tx`
          update conversations
             set status = 'active'
           where id = ${escRows[0].conversation_id}::uuid;
        `;
      }
    });

    await audit({ caller, action: "resolve_escalation", entity: "escalations", entityId: escalationId });
    return Response.json({ ok: true, agent_reactivated: reactivate });
  }

  if (path === "/api/actions/connect-meta" && method === "POST") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const code = String(body.code ?? "").trim();
    const redirectUri = String(body.redirect_uri ?? "").trim();
    const locationId = body.location_id ? String(body.location_id) : null;

    if (!code) throw new ValidationError("Code d'autorisation Meta manquant.");
    if (!redirectUri) throw new ValidationError("`redirect_uri` manquant.");

    // Appels externes D'ABORD, aucune transaction ouverte pendant ce temps.
    const user = await exchangeOAuthCode(code, redirectUri);
    const { assets, warnings } = await discoverAssets(user.token);

    if (assets.length === 0) {
      throw new ValidationError(
        warnings[0] ?? "Aucun compte exploitable dans cette autorisation.",
      );
    }

    const connected: Array<{ id: string; channel: string; label: string }> = [];

    await withTenant(caller.tenantId, async (tx) => {
      for (const asset of assets) {
        const encrypted = await encryptSecret(asset.accessToken);
        const verifyToken = crypto.randomUUID();

        const insertRows = await tx`
          insert into channel_connections (
            tenant_id,
            location_id,
            channel,
            external_account_id,
            access_token_encrypted,
            token_expires_at,
            last_refreshed_at,
            refresh_error,
            webhook_verify_token,
            status
          ) values (
            ${caller.tenantId}::uuid,
            ${locationId ? tx`${locationId}::uuid` : null},
            ${asset.channel},
            ${asset.externalAccountId},
            ${encrypted},
            ${asset.expiresAt},
            now(),
            null,
            ${verifyToken},
            'active'
          )
          on conflict (channel, external_account_id) do update set
            tenant_id = excluded.tenant_id,
            location_id = excluded.location_id,
            access_token_encrypted = excluded.access_token_encrypted,
            token_expires_at = excluded.token_expires_at,
            last_refreshed_at = now(),
            refresh_error = null,
            status = 'active'
          returning id;
        `;

        connected.push({ id: insertRows[0].id, channel: asset.channel, label: asset.label });
      }
    });

    for (const item of connected) {
      await audit({ caller, action: "connect_channel_oauth", entity: "channel_connections", entityId: item.id });
    }

    return Response.json({
      ok: true,
      connected: connected.map(({ channel, label }) => ({ channel, label })),
      warnings,
    });
  }

  if (path === "/api/actions/connect-google" && method === "POST") {
    requireOwner(caller);
    const body = await req.json().catch(() => ({}));
    const code = String(body.code ?? "").trim();
    const redirectUri = String(body.redirect_uri ?? "").trim();
    const calendarExternalId = String(body.calendar_external_id ?? "primary").trim();
    const locationId = body.location_id ? String(body.location_id) : null;

    if (!code) throw new ValidationError("Code d'autorisation Google manquant.");
    if (!redirectUri) throw new ValidationError("`redirect_uri` manquant.");

    // Appel externe D'ABORD.
    const { refreshToken } = await exchangeAuthorizationCode(code, redirectUri);
    const encrypted = await encryptSecret(JSON.stringify({ refresh_token: refreshToken }));

    const integrationId = await withTenant(caller.tenantId, async (tx) => {
      const insert = await tx`
        insert into calendar_integrations (
          tenant_id,
          location_id,
          provider,
          credentials_encrypted,
          calendar_external_id,
          status
        ) values (
          ${caller.tenantId}::uuid,
          ${locationId ? tx`${locationId}::uuid` : null},
          'google',
          ${encrypted},
          ${calendarExternalId},
          'active'
        )
        returning id;
      `;

      // Désactive les anciens sur le même établissement
      await tx`
        update calendar_integrations
           set status = 'revoked'
         where tenant_id = ${caller.tenantId}::uuid
           and status = 'active'
           and id <> ${insert[0].id}::uuid
           and (location_id = ${locationId ? tx`${locationId}::uuid` : null} or (location_id is null and ${locationId === null}));
      `;

      return insert[0].id;
    });

    await audit({ caller, action: "connect_calendar", entity: "calendar_integrations", entityId: integrationId });
    return Response.json({ ok: true, integration_id: integrationId });
  }

  return new Response("Not Found", { status: 404 });
}

/**
 * Reste sur le rôle système : `channel_connections.access_token_encrypted`
 * n'est pas lisible par le rôle applicatif (revoke défensif,
 * `migrations/0006_rls_roles.sql`), et `resolveConnection` en a besoin pour
 * déchiffrer le jeton. `tenantId` est un paramètre de fonction, jamais lu
 * depuis une entrée utilisateur non vérifiée.
 */
async function resolveConnectionForTenant(
  tenantId: string,
  channel: Channel,
  locationId: string | null,
) {
  const list = await sqlWorker`
    select external_account_id, location_id
      from channel_connections
     where tenant_id = ${tenantId}::uuid
       and channel = ${channel}
       and status = 'active';
  `;

  const row = list.find((r) => r.location_id === locationId) ??
    list.find((r) => r.location_id === null);

  return row ? await resolveConnection(channel, row.external_account_id) : null;
}

function isSafeUrl(candidate: string): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
