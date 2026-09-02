-- ============================================================
-- 0007 — Policies RLS
-- ============================================================
-- L'ISOLATION MULTI-INSTITUT DEVIENT UNE PROPRIÉTÉ DE LA BASE, PAS DU CODE.
--
-- Jusqu'ici, chaque requête devait porter son propre `where tenant_id = ...` —
-- exactement le filtre qui manquait sur l'écriture du script de qualification
-- corrigée en début de session. Cette migration ferme cette classe entière de
-- bug : une requête qui oublierait le filtre échoue désormais au niveau de la
-- base, pas seulement au niveau de la relecture de code.
--
-- PRÉREQUIS ABSOLU AVANT D'APPLIQUER CETTE MIGRATION :
-- `DATABASE_URL_WORKER` doit pointer vers `setwise_worker` (BYPASSRLS), et le
-- code déployé doit déjà utiliser `sqlWorker` pour tout le chemin worker
-- (`src/db.ts`, migration `0006`). Si ce n'est pas le cas, cette migration
-- interrompt IMMÉDIATEMENT tous les webhooks, crons et le moteur d'agent —
-- ils cesseraient de voir la moindre ligne sur toute table protégée
-- ci-dessous. Vérifier avant d'appliquer :
--
--   select rolname, rolbypassrls from pg_roles where rolname = 'setwise_worker';
--   -- attendu : rolbypassrls = true
--
-- FORCE ROW LEVEL SECURITY est essentiel : sans elle, le PROPRIÉTAIRE des
-- tables (le rôle qui a exécuté `0001_initial_schema.sql`) continuerait de
-- contourner la RLS par défaut, quelles que soient les policies posées —
-- activer des policies sans FORCE donnerait un sentiment de sécurité sans la
-- sécurité, le pire des états possibles.
--
-- `current_setting('app.tenant_id')` SANS troisième argument `true` : la
-- forme stricte lève une erreur si `app.tenant_id` n'a jamais été posé dans
-- la transaction en cours, plutôt que de renvoyer NULL et donc silencieusement
-- zéro ligne. Une requête du rôle applicatif exécutée hors de `withTenant`
-- doit échouer bruyamment, pas ressembler à un institut qui n'a aucune
-- donnée.

-- ------------------------------------------------------------
-- Tables scindées directement par tenant_id
-- ------------------------------------------------------------

alter table tenants enable row level security;
alter table tenants force row level security;
drop policy if exists tenants_isolation on tenants;
create policy tenants_isolation on tenants for all
  using (id = current_setting('app.tenant_id')::uuid)
  with check (id = current_setting('app.tenant_id')::uuid);

alter table tenant_users enable row level security;
alter table tenant_users force row level security;
drop policy if exists tenant_users_isolation on tenant_users;
create policy tenant_users_isolation on tenant_users for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table tenant_invitations enable row level security;
alter table tenant_invitations force row level security;
drop policy if exists tenant_invitations_isolation on tenant_invitations;
create policy tenant_invitations_isolation on tenant_invitations for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table agents enable row level security;
alter table agents force row level security;
drop policy if exists agents_isolation on agents;
create policy agents_isolation on agents for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table channel_connections enable row level security;
alter table channel_connections force row level security;
drop policy if exists channel_connections_isolation on channel_connections;
create policy channel_connections_isolation on channel_connections for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table calendar_integrations enable row level security;
alter table calendar_integrations force row level security;
drop policy if exists calendar_integrations_isolation on calendar_integrations;
create policy calendar_integrations_isolation on calendar_integrations for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table leads enable row level security;
alter table leads force row level security;
drop policy if exists leads_isolation on leads;
create policy leads_isolation on leads for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table conversations enable row level security;
alter table conversations force row level security;
drop policy if exists conversations_isolation on conversations;
create policy conversations_isolation on conversations for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table appointments enable row level security;
alter table appointments force row level security;
drop policy if exists appointments_isolation on appointments;
create policy appointments_isolation on appointments for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table escalations enable row level security;
alter table escalations force row level security;
drop policy if exists escalations_isolation on escalations;
create policy escalations_isolation on escalations for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table subscriptions enable row level security;
alter table subscriptions force row level security;
drop policy if exists subscriptions_isolation on subscriptions;
create policy subscriptions_isolation on subscriptions for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table outbound_touches enable row level security;
alter table outbound_touches force row level security;
drop policy if exists outbound_touches_isolation on outbound_touches;
create policy outbound_touches_isolation on outbound_touches for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table notifications enable row level security;
alter table notifications force row level security;
drop policy if exists notifications_isolation on notifications;
create policy notifications_isolation on notifications for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

alter table audit_logs enable row level security;
alter table audit_logs force row level security;
drop policy if exists audit_logs_isolation on audit_logs;
create policy audit_logs_isolation on audit_logs for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- Protégée par anticipation : aucune requête du rôle applicatif ne la touche
-- encore aujourd'hui (pas d'écran de quota dans le tableau de bord), mais la
-- colonne tenant_id existe et la donnée est sensible (coût réel par
-- institut). Coût nul tant qu'inutilisée, protection immédiate le jour où un
-- écran l'exploitera.
alter table llm_usage enable row level security;
alter table llm_usage force row level security;
drop policy if exists llm_usage_isolation on llm_usage;
create policy llm_usage_isolation on llm_usage for all
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);

-- ------------------------------------------------------------
-- Tables scindées indirectement, via une table parente
-- ------------------------------------------------------------
-- `messages` et `qualification_scripts` n'ont pas de colonne `tenant_id` —
-- leur appartenance se déduit de `conversations`/`agents`. La sous-requête
-- s'exécute SOUS LA MÊME RLS que sa table parente : impossible de l'utiliser
-- pour élargir l'accès, seulement pour le restreindre davantage.

alter table messages enable row level security;
alter table messages force row level security;
drop policy if exists messages_isolation on messages;
create policy messages_isolation on messages for all
  using (
    conversation_id in (
      select id from conversations where tenant_id = current_setting('app.tenant_id')::uuid
    )
  )
  with check (
    conversation_id in (
      select id from conversations where tenant_id = current_setting('app.tenant_id')::uuid
    )
  );

alter table qualification_scripts enable row level security;
alter table qualification_scripts force row level security;
drop policy if exists qualification_scripts_isolation on qualification_scripts;
create policy qualification_scripts_isolation on qualification_scripts for all
  using (
    agent_id in (
      select id from agents where tenant_id = current_setting('app.tenant_id')::uuid
    )
  )
  with check (
    agent_id in (
      select id from agents where tenant_id = current_setting('app.tenant_id')::uuid
    )
  );

-- ------------------------------------------------------------
-- Volontairement SANS RLS
-- ------------------------------------------------------------
-- `plans`      catalogue global, identique pour tous les instituts.
-- `users`      identité partagée entre instituts (une adresse peut être
--              invitée par plusieurs) ; la portée correcte vient du JOIN
--              avec `tenant_users`, déjà protégé ci-dessus.
-- `rate_limits`, `webhook_events`, `auth_tokens`
--              infrastructure interne, jamais lues par le rôle applicatif.
