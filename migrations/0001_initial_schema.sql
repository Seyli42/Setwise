-- ============================================================
-- Setwise — Schéma initial PostgreSQL pour Neon
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- ENUMS & TYPES
-- ============================================================
create type tenant_role as enum ('owner', 'staff');
create type agent_type as enum ('qualification_rdv', 'avis_google', 'relance', 'reactivation');
create type channel_type as enum ('instagram', 'whatsapp');
create type conversation_status as enum ('active', 'qualified', 'escalated', 'closed', 'expired');
create type message_direction as enum ('inbound', 'outbound');
create type message_sender as enum ('lead', 'agent', 'human');
create type lead_status as enum ('new', 'qualified', 'disqualified', 'booked');
create type calendar_provider as enum ('google', 'planity', 'ics');
create type appointment_status as enum ('pending', 'confirmed', 'cancelled', 'no_show', 'completed');
create type escalation_trigger as enum ('keyword', 'sentiment', 'manual', 'external_error');
create type escalation_status as enum ('open', 'acknowledged', 'resolved');
create type webhook_source as enum ('instagram', 'whatsapp', 'stripe');
create type webhook_status as enum ('pending', 'processing', 'processed', 'failed');
create type outbound_touch_status as enum ('pending', 'processing', 'sent', 'skipped', 'failed');
create type notification_status as enum ('pending', 'processing', 'sent', 'skipped', 'failed');
create type notification_channel as enum ('email', 'whatsapp');

-- ============================================================
-- AUTHENTIFICATION & UTILISATEURS
-- ============================================================
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists users_email_idx on users (lower(email));

create table if not exists auth_tokens (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_tokens_lookup_idx on auth_tokens (lower(email), token_hash) where used_at is null;

-- ============================================================
-- CORE TENANCY
-- ============================================================
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  siret text,
  timezone text not null default 'Europe/Paris',
  stripe_customer_id text unique,
  plan text not null default 'trial',
  notification_email text,
  notification_phone text,
  escalation_reminder_hours int not null default 4,
  data_retention_days int not null default 1095,
  terms_accepted_at timestamptz,
  terms_version text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists tenant_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role tenant_role not null default 'staff',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table if not exists tenant_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('owner', 'member')),
  invited_by uuid references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_by uuid references users(id)
);
create unique index if not exists tenant_invitations_pending_idx
  on tenant_invitations (tenant_id, lower(email))
  where accepted_at is null;
create index if not exists tenant_invitations_email_idx
  on tenant_invitations (lower(email))
  where accepted_at is null;

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  address text,
  phone text,
  timezone text not null default 'Europe/Paris',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ============================================================
-- AGENTS & SCRIPTS
-- ============================================================
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  type agent_type not null,
  name text not null,
  system_prompt_template text not null,
  config jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists qualification_scripts (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  version int not null default 1,
  questions jsonb not null default '[]'::jsonb,
  budget_rules jsonb not null default '{}'::jsonb,
  escalation_keywords text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists qualification_scripts_agent_idx on qualification_scripts (agent_id) where is_active;

-- ============================================================
-- CANAUX & CONNEXIONS
-- ============================================================
create table if not exists channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  channel channel_type not null,
  external_account_id text not null,
  access_token_encrypted text not null,
  token_expires_at timestamptz,
  last_refreshed_at timestamptz,
  refresh_error text,
  webhook_verify_token text not null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  unique (channel, external_account_id)
);

-- ============================================================
-- LEADS / CONVERSATIONS / MESSAGES
-- ============================================================
create table if not exists leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  full_name text,
  phone text,
  instagram_handle text,
  source text,
  qualification_data jsonb not null default '{}'::jsonb,
  status lead_status not null default 'new',
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists leads_tenant_created_idx on leads (tenant_id, created_at desc);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  lead_id uuid references leads(id) on delete set null,
  channel channel_type not null,
  external_thread_id text not null,
  status conversation_status not null default 'active',
  last_message_at timestamptz not null default now(),
  messaging_window_expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (channel, external_thread_id)
);
create index if not exists conversations_tenant_last_msg_idx on conversations (tenant_id, last_message_at desc);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction message_direction not null,
  sender_type message_sender not null,
  content text not null,
  raw_payload jsonb,
  external_message_id text,
  created_at timestamptz not null default now(),
  unique (external_message_id)
);
create index if not exists messages_conversation_created_idx on messages (conversation_id, created_at);

-- ============================================================
-- CALENDRIER & RENDEZ-VOUS
-- ============================================================
create table if not exists calendar_integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  provider calendar_provider not null,
  credentials_encrypted text not null,
  calendar_external_id text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid references locations(id) on delete cascade,
  lead_id uuid references leads(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  calendar_integration_id uuid references calendar_integrations(id) on delete set null,
  external_event_id text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  service_type text,
  status appointment_status not null default 'pending',
  reminder_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists appointments_tenant_starts_idx on appointments (tenant_id, starts_at);
create index if not exists appointments_reminder_idx on appointments (status, starts_at) where reminder_sent_at is null;

-- ============================================================
-- ESCALADES
-- ============================================================
create table if not exists escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  reason text not null,
  triggered_by escalation_trigger not null,
  status escalation_status not null default 'open',
  notified_at timestamptz,
  reminder_sent_at timestamptz,
  resolved_by uuid references users(id),
  created_at timestamptz not null default now()
);
create index if not exists escalations_open_idx on escalations (tenant_id, created_at desc) where status = 'open';
create index if not exists escalations_billing_idx on escalations (tenant_id, created_at desc) where triggered_by = 'external_error';

-- ============================================================
-- FACTURATION & CATALOGUE
-- ============================================================
create table if not exists plans (
  id text primary key,
  name text not null,
  description text,
  stripe_price_id text not null unique,
  monthly_price_cents int not null check (monthly_price_cents >= 0),
  currency text not null default 'eur',
  trial_days int not null default 14 check (trial_days >= 0),
  max_locations int,
  is_active boolean not null default true,
  sort_order int not null default 0
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  stripe_subscription_id text unique,
  stripe_price_id text,
  plan text not null,
  status text not null,
  current_period_end timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  terminated_at timestamptz
);
create unique index if not exists subscriptions_tenant_unique on subscriptions (tenant_id);
create index if not exists subscriptions_status_idx on subscriptions (status, current_period_end);

-- ============================================================
-- QUEUE & IDEMPOTENCE WEBHOOKS
-- ============================================================
create table if not exists webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete set null,
  source webhook_source not null,
  external_event_id text not null,
  payload jsonb not null,
  status webhook_status not null default 'pending',
  attempts int not null default 0,
  last_error text,
  next_retry_at timestamptz not null default now(),
  locked_at timestamptz,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (source, external_event_id)
);
create index if not exists webhook_events_claim_idx on webhook_events (status, next_retry_at, received_at);
create index if not exists webhook_events_tenant_idx on webhook_events (tenant_id, received_at desc);

-- ============================================================
-- AUDIT & PURGES
-- ============================================================
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  actor uuid references users(id),
  action text not null,
  entity text not null,
  entity_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists tenant_deletions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  terminated_at timestamptz,
  purged_at timestamptz not null default now(),
  retention_days int not null
);

-- ============================================================
-- CAMPAGNES SORTANTES & NOTIFICATIONS
-- ============================================================
create table if not exists outbound_touches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  agent_type agent_type not null,
  lead_id uuid not null references leads(id) on delete cascade,
  subject_id uuid not null,
  conversation_id uuid references conversations(id) on delete set null,
  status text not null default 'claimed',   -- claimed | sent | failed | skipped
  template_name text,
  last_error text,
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (agent_type, subject_id)
);
create index if not exists outbound_touches_tenant_idx on outbound_touches (tenant_id, claimed_at desc);
create index if not exists outbound_touches_status_idx on outbound_touches (status, claimed_at) where status = 'claimed';

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,
  subject_id uuid not null,
  channel notification_channel not null,
  destination text not null,
  payload jsonb not null default '{}'::jsonb,
  status notification_status not null default 'pending',
  attempts int not null default 0,
  last_error text,
  next_retry_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  skipped_at timestamptz,
  created_at timestamptz not null default now(),
  unique (kind, subject_id, channel)
);
create index if not exists notifications_claim_idx on notifications (status, next_retry_at, created_at) where status in ('pending', 'processing');

-- ============================================================
-- TRIGGERS
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace trigger agents_set_updated_at before update on agents
  for each row execute function set_updated_at();

create or replace trigger qualification_scripts_set_updated_at before update on qualification_scripts
  for each row execute function set_updated_at();

create or replace trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

create or replace trigger subscriptions_set_updated_at before update on subscriptions
  for each row execute function set_updated_at();

-- ============================================================
-- FONCTIONS SQL MÉTIER
-- ============================================================

-- Claim atomique de la queue de webhooks
create or replace function claim_webhook_events(
  p_limit int default 10,
  p_stale_after interval default '5 minutes'
)
returns setof webhook_events
language plpgsql
as $$
begin
  return query
  update webhook_events we
     set status = 'processing',
         locked_at = now(),
         attempts = we.attempts + 1
   where we.id in (
     select id
       from webhook_events
      where (status = 'pending' and next_retry_at <= now())
         or (status = 'processing' and locked_at < now() - p_stale_after)
      order by received_at
      limit p_limit
      for update skip locked
   )
  returning we.*;
end;
$$;

create or replace function complete_webhook_event(p_id uuid)
returns void language sql as $$
  update webhook_events
     set status = 'processed',
         processed_at = now(),
         locked_at = null,
         last_error = null
   where id = p_id;
$$;

create or replace function fail_webhook_event(
  p_id uuid,
  p_error text,
  p_retryable boolean default true,
  p_max_attempts int default 6
)
returns void
language plpgsql as $$
declare
  v_attempts int;
begin
  select attempts into v_attempts from webhook_events where id = p_id;

  if not p_retryable or v_attempts >= p_max_attempts then
    update webhook_events
       set status = 'failed',
           last_error = left(p_error, 2000),
           locked_at = null,
           processed_at = now()
     where id = p_id;
  else
    update webhook_events
       set status = 'pending',
           last_error = left(p_error, 2000),
           locked_at = null,
           next_retry_at = now() + least(power(2, v_attempts) * interval '1 minute', interval '1 hour')
     where id = p_id;
  end if;
end;
$$;

-- Claim atomique des rappels RDV
create or replace function claim_appointment_reminders(
  p_limit int default 50,
  p_window_start interval default '22 hours',
  p_window_end interval default '26 hours'
)
returns setof appointments
language plpgsql as $$
begin
  return query
  update appointments a
     set reminder_sent_at = now()
   where a.id in (
     select id
       from appointments
      where status = 'confirmed'
        and reminder_sent_at is null
        and starts_at between now() + p_window_start and now() + p_window_end
      order by starts_at
      limit p_limit
      for update skip locked
   )
  returning a.*;
end;
$$;

create or replace function release_appointment_reminder(p_id uuid)
returns void language sql as $$
  update appointments set reminder_sent_at = null where id = p_id;
$$;

-- Claim des cibles de campagnes sortantes (avis, relance, réactivation)
create or replace function claim_outbound_targets(
  p_agent_type agent_type,
  p_limit int default 50
)
returns table (
  touch_id uuid,
  tenant_id uuid,
  location_id uuid,
  agent_id uuid,
  lead_id uuid,
  subject_id uuid,
  lead_name text,
  lead_phone text,
  service_type text,
  reference_at timestamptz
)
language plpgsql as $$
begin
  return query
  with eligible as (
    -- Avis Google : rendez-vous honoré, entre 2 h et 72 h après la fin
    select
      a.tenant_id, a.location_id, ag.id as agent_id, a.lead_id,
      a.id as subject_id, l.full_name, l.phone, a.service_type, a.ends_at as reference_at
    from appointments a
    join leads l on l.id = a.lead_id
    join agents ag on ag.tenant_id = a.tenant_id
                  and ag.type = p_agent_type
                  and ag.is_active
                  and (ag.location_id = a.location_id or ag.location_id is null)
    where p_agent_type = 'avis_google'
      and a.status = 'completed'
      and a.ends_at between now() - interval '72 hours' and now() - interval '2 hours'
      and l.deleted_at is null
      and l.phone is not null

    union all

    -- Relance : absence constatée, dans les sept jours
    select
      a.tenant_id, a.location_id, ag.id, a.lead_id,
      a.id, l.full_name, l.phone, a.service_type, a.ends_at
    from appointments a
    join leads l on l.id = a.lead_id
    join agents ag on ag.tenant_id = a.tenant_id
                  and ag.type = p_agent_type
                  and ag.is_active
                  and (ag.location_id = a.location_id or ag.location_id is null)
    where p_agent_type = 'relance'
      and a.status = 'no_show'
      and a.ends_at between now() - interval '7 days' and now() - interval '1 hour'
      and l.deleted_at is null
      and l.phone is not null

    union all

    -- Réactivation : lead qualifié qui n'a jamais pris de RDV
    select
      l.tenant_id, l.location_id, ag.id, l.id,
      l.id, l.full_name, l.phone, null::text,
      coalesce((select max(c.last_message_at) from conversations c where c.lead_id = l.id), l.created_at)
    from leads l
    join agents ag on ag.tenant_id = l.tenant_id
                  and ag.type = p_agent_type
                  and ag.is_active
                  and (ag.location_id = l.location_id or ag.location_id is null)
    where p_agent_type = 'reactivation'
      and l.status = 'qualified'
      and l.deleted_at is null
      and l.phone is not null
      and not exists (select 1 from appointments a2 where a2.lead_id = l.id)
      and coalesce(
            (select max(c.last_message_at) from conversations c where c.lead_id = l.id),
            l.created_at
          ) < now() - make_interval(
            days => coalesce((ag.config #>> '{reactivation,after_days}')::int, 45)
          )
  ),
  claimed as (
    insert into outbound_touches (tenant_id, agent_id, agent_type, lead_id, subject_id)
    select e.tenant_id, e.agent_id, p_agent_type, e.lead_id, e.subject_id
      from eligible e
     order by e.reference_at
     limit p_limit
    on conflict (agent_type, subject_id) do nothing
    returning id, subject_id
  )
  select
    c.id, e.tenant_id, e.location_id, e.agent_id, e.lead_id, e.subject_id,
    e.full_name, e.phone, e.service_type, e.reference_at
  from claimed c
  join eligible e on e.subject_id = c.subject_id;
end;
$$;

-- Claim et traitement des notifications (alertes gérant)
create or replace function claim_notifications(
  p_limit int default 20,
  p_stale_after interval default '5 minutes'
)
returns setof notifications
language plpgsql as $$
begin
  return query
  update notifications n
     set status = 'processing',
         locked_at = now(),
         attempts = n.attempts + 1
   where n.id in (
     select id
       from notifications
      where (status = 'pending' and next_retry_at <= now())
         or (status = 'processing' and locked_at < now() - p_stale_after)
      order by created_at
      limit p_limit
      for update skip locked
   )
  returning n.*;
end;
$$;

create or replace function complete_notification(p_id uuid)
returns void language sql as $$
  update notifications
     set status = 'sent',
         sent_at = now(),
         locked_at = null,
         last_error = null
   where id = p_id;
$$;

create or replace function skip_notification(p_id uuid, p_reason text)
returns void language sql as $$
  update notifications
     set status = 'skipped',
         skipped_at = now(),
         locked_at = null,
         last_error = left(p_reason, 1000)
   where id = p_id;
$$;

create or replace function fail_notification(
  p_id uuid,
  p_error text,
  p_retryable boolean default true,
  p_max_attempts int default 6
)
returns void
language plpgsql as $$
declare
  v_attempts int;
begin
  select attempts into v_attempts from notifications where id = p_id;

  if not p_retryable or v_attempts >= p_max_attempts then
    update notifications
       set status = 'failed',
           last_error = left(p_error, 2000),
           locked_at = null
     where id = p_id;
  else
    update notifications
       set status = 'pending',
           last_error = left(p_error, 2000),
           locked_at = null,
           next_retry_at = now() + least(power(2, v_attempts) * interval '1 minute', interval '1 hour')
     where id = p_id;
  end if;
end;
$$;

create or replace function enqueue_escalation_notification(
  p_tenant_id uuid,
  p_escalation_id uuid,
  p_kind text default 'escalation_opened',
  p_payload jsonb default '{}'::jsonb
)
returns table (queued int, channels_configured int)
language plpgsql as $$
declare
  v_email text;
  v_phone text;
  v_channels int := 0;
  v_queued int := 0;
begin
  select notification_email, notification_phone
    into v_email, v_phone
    from tenants
   where id = p_tenant_id;

  if v_email is not null and trim(v_email) <> '' then
    v_channels := v_channels + 1;
    insert into notifications (tenant_id, kind, subject_id, channel, destination, payload)
    values (p_tenant_id, p_kind, p_escalation_id, 'email', trim(v_email), p_payload)
    on conflict (kind, subject_id, channel) do nothing;
    if found then v_queued := v_queued + 1; end if;
  end if;

  if v_phone is not null and trim(v_phone) <> '' then
    v_channels := v_channels + 1;
    insert into notifications (tenant_id, kind, subject_id, channel, destination, payload)
    values (p_tenant_id, p_kind, p_escalation_id, 'whatsapp', trim(v_phone), p_payload)
    on conflict (kind, subject_id, channel) do nothing;
    if found then v_queued := v_queued + 1; end if;
  end if;

  return query select v_queued, v_channels;
end;
$$;

create or replace function enqueue_stale_escalation_notifications(p_limit int default 50)
returns int
language plpgsql as $$
declare
  v_esc record;
  v_total int := 0;
  v_res record;
begin
  for v_esc in
    select e.id as escalation_id, e.tenant_id, e.reason, e.created_at,
           coalesce(t.escalation_reminder_hours, 4) as reminder_hours
      from escalations e
      join tenants t on t.id = e.tenant_id
     where e.status = 'open'
       and e.reminder_sent_at is null
       and e.created_at < now() - make_interval(hours => coalesce(t.escalation_reminder_hours, 4))
     order by e.created_at
     limit p_limit
  loop
    select queued into v_res from enqueue_escalation_notification(
      v_esc.tenant_id,
      v_esc.escalation_id,
      'escalation_stale',
      jsonb_build_object('reason', v_esc.reason, 'opened_at', v_esc.created_at)
    );

    update escalations set reminder_sent_at = now() where id = v_esc.escalation_id;
    v_total := v_total + coalesce(v_res.queued, 0);
  end loop;

  return v_total;
end;
$$;

-- État de facturation
create or replace function tenant_billing_state(p_tenant_id uuid)
returns jsonb
language plpgsql
stable as $$
declare
  v_subscription subscriptions%rowtype;
  v_created_at timestamptz;
  v_trial_days int;
  v_trial_ends_at timestamptz;
begin
  select created_at into v_created_at from tenants where id = p_tenant_id;
  if v_created_at is null then
    raise exception 'Institut introuvable.' using errcode = 'P0002';
  end if;

  select * into v_subscription from subscriptions where tenant_id = p_tenant_id;

  if v_subscription.id is null then
    select coalesce(min(trial_days), 14) into v_trial_days from plans where is_active;
    v_trial_ends_at := v_created_at + make_interval(days => v_trial_days);

    return jsonb_build_object(
      'active', now() < v_trial_ends_at,
      'status', case when now() < v_trial_ends_at then 'trial' else 'trial_expired' end,
      'plan', null,
      'trial_ends_at', v_trial_ends_at,
      'current_period_end', null,
      'cancel_at_period_end', false,
      'reason', case
        when now() < v_trial_ends_at then 'Période d''essai en cours.'
        else 'Période d''essai terminée. Choisissez une formule pour réactiver votre agent.'
      end
    );
  end if;

  return jsonb_build_object(
    'active', v_subscription.status in ('trialing', 'active', 'past_due'),
    'status', v_subscription.status,
    'plan', v_subscription.plan,
    'trial_ends_at', v_subscription.trial_end,
    'current_period_end', v_subscription.current_period_end,
    'cancel_at_period_end', v_subscription.cancel_at_period_end,
    'reason', case v_subscription.status
      when 'trialing' then 'Essai en cours.'
      when 'active' then 'Abonnement actif.'
      when 'past_due' then 'Dernier paiement refusé. Mettez votre moyen de paiement à jour : votre agent sera suspendu si l''échec persiste.'
      when 'unpaid' then 'Abonnement impayé. Votre agent est suspendu.'
      when 'canceled' then 'Abonnement résilié. Votre agent est suspendu.'
      when 'incomplete' then 'Paiement initial non finalisé.'
      when 'incomplete_expired' then 'Paiement initial expiré. Votre agent est suspendu.'
      when 'paused' then 'Abonnement en pause. Votre agent est suspendu.'
      else 'Statut inconnu : ' || v_subscription.status
    end
  );
end;
$$;

-- Indicateurs de performance
create or replace function tenant_performance(p_tenant_id uuid, p_days int default 30)
returns jsonb
language sql
stable as $$
  with bornes as (
    select now() - make_interval(days => greatest(coalesce(p_days, 30), 1)) as debut
  ),
  leads_periode as (
    select
      count(*) as recus,
      count(*) filter (where status in ('qualified', 'booked')) as qualifies
    from leads, bornes
    where leads.tenant_id = p_tenant_id and leads.created_at >= bornes.debut
  ),
  rdv_periode as (
    select
      count(*) as pris,
      count(*) filter (where status = 'completed') as honores,
      count(*) filter (where status = 'no_show') as absences,
      count(*) filter (where status = 'cancelled') as annules,
      count(*) filter (where reminder_sent_at is not null) as rappeles
    from appointments, bornes
    where appointments.tenant_id = p_tenant_id
      and appointments.starts_at >= bornes.debut
      and appointments.starts_at < now()
  ),
  reprises as (
    select count(distinct manque.lead_id) as creneaux_repris
    from appointments manque, bornes
    where manque.tenant_id = p_tenant_id
      and manque.status = 'no_show'
      and manque.starts_at >= bornes.debut
      and manque.lead_id is not null
      and exists (
        select 1
        from appointments suivant
        where suivant.tenant_id = p_tenant_id
          and suivant.lead_id = manque.lead_id
          and suivant.id <> manque.id
          and suivant.created_at > manque.starts_at
          and suivant.status in ('pending', 'confirmed', 'completed')
      )
  ),
  sortants as (
    select
      count(*) filter (where agent_type = 'avis_google' and status = 'sent') as avis_demandes,
      count(*) filter (where agent_type = 'relance' and status = 'sent') as relances,
      count(*) filter (where agent_type = 'reactivation' and status = 'sent') as reactivations
    from outbound_touches, bornes
    where outbound_touches.tenant_id = p_tenant_id
      and outbound_touches.created_at >= bornes.debut
  ),
  escalades as (
    select
      count(*) as ouvertes,
      count(*) filter (where status = 'open') as en_attente
    from escalations, bornes
    where escalations.tenant_id = p_tenant_id
      and escalations.created_at >= bornes.debut
  )
  select jsonb_build_object(
    'periode_jours', greatest(coalesce(p_days, 30), 1),
    'leads_recus', leads_periode.recus,
    'leads_qualifies', leads_periode.qualifies,
    'taux_qualification', case
      when leads_periode.recus = 0 then null
      else round(leads_periode.qualifies::numeric * 100 / leads_periode.recus, 1)
    end,
    'rdv_pris', rdv_periode.pris,
    'rdv_honores', rdv_periode.honores,
    'rdv_rappeles', rdv_periode.rappeles,
    'absences', rdv_periode.absences,
    'annulations', rdv_periode.annules,
    'taux_absence', case
      when (rdv_periode.honores + rdv_periode.absences) = 0 then null
      else round(
        rdv_periode.absences::numeric * 100 / (rdv_periode.honores + rdv_periode.absences), 1
      )
    end,
    'creneaux_repris', reprises.creneaux_repris,
    'avis_demandes', sortants.avis_demandes,
    'relances_envoyees', sortants.relances,
    'reactivations_envoyees', sortants.reactivations,
    'escalades_ouvertes', escalades.ouvertes,
    'escalades_en_attente', escalades.en_attente
  )
  from leads_periode, rdv_periode, reprises, sortants, escalades;
$$;

-- RGPD : Droit à l'oubli
create or replace function forget_lead(p_tenant_id uuid, p_lead_id uuid, p_user_id uuid)
returns void
language plpgsql as $$
declare
  v_lead_tenant_id uuid;
begin
  select tenant_id into v_lead_tenant_id from leads where id = p_lead_id;

  if v_lead_tenant_id is null or v_lead_tenant_id <> p_tenant_id then
    raise exception 'Lead introuvable.' using errcode = 'P0002';
  end if;

  update messages
     set content = '[contenu supprimé — droit à l''oubli]',
         raw_payload = null
   where conversation_id in (select id from conversations where lead_id = p_lead_id and tenant_id = p_tenant_id);

  update leads
     set full_name = null,
         phone = null,
         instagram_handle = null,
         qualification_data = '{}'::jsonb,
         deleted_at = now()
   where id = p_lead_id and tenant_id = p_tenant_id;

  insert into audit_logs (tenant_id, actor, action, entity, entity_id)
  values (p_tenant_id, p_user_id, 'forget_lead', 'leads', p_lead_id);
end;
$$;

-- RGPD : Purge des données expirées
create or replace function purge_expired_personal_data(p_batch_size int default 500)
returns table (anonymized_leads int, anonymized_messages int)
language plpgsql as $$
declare
  v_leads_count int := 0;
  v_msgs_count int := 0;
  v_lead_ids uuid[];
begin
  select array_agg(l.id)
    into v_lead_ids
    from leads l
    join tenants t on t.id = l.tenant_id
   where l.deleted_at is null
     and l.created_at < now() - make_interval(days => coalesce(t.data_retention_days, 1095))
   limit p_batch_size;

  if v_lead_ids is not null and array_length(v_lead_ids, 1) > 0 then
    update messages
       set content = '[contenu purgé — durée de conservation atteinte]',
           raw_payload = null
     where conversation_id in (
       select id from conversations where lead_id = any(v_lead_ids)
     )
     and content not like '[contenu purgé%';
    get diagnostics v_msgs_count = row_count;

    update leads
       set full_name = null,
           phone = null,
           instagram_handle = null,
           qualification_data = '{}'::jsonb,
           deleted_at = now()
     where id = any(v_lead_ids);
    get diagnostics v_leads_count = row_count;
  end if;

  return query select v_leads_count, v_msgs_count;
end;
$$;

-- RGPD : Purge des instituts résiliés
create or replace function purge_terminated_tenants(
  p_retention_days int default 30,
  p_limit int default 5,
  p_dry_run boolean default false
)
returns table (tenant_id uuid, tenant_name text, terminated_at timestamptz, action text)
language plpgsql as $$
declare
  v_row record;
  v_cutoff timestamptz := now() - make_interval(days => greatest(coalesce(p_retention_days, 30), 1));
begin
  for v_row in
    select t.id as t_id, t.name as t_name, s.terminated_at as s_terminated_at
      from tenants t
      join subscriptions s on s.tenant_id = t.id
     where s.status in ('canceled', 'incomplete_expired')
       and s.terminated_at is not null
       and s.terminated_at < v_cutoff
     order by s.terminated_at asc
     limit p_limit
  loop
    tenant_id := v_row.t_id;
    tenant_name := v_row.t_name;
    terminated_at := v_row.s_terminated_at;

    if p_dry_run then
      action := 'simulated';
      return next;
    else
      insert into tenant_deletions (tenant_id, name, terminated_at, retention_days)
      values (v_row.t_id, v_row.t_name, v_row.s_terminated_at, p_retention_days);

      delete from tenants where id = v_row.t_id;

      action := 'purged';
      return next;
    end if;
  end loop;
end;
$$;

-- Clôture automatique des rendez-vous passés
create or replace function settle_past_appointments(
  p_grace_hours interval default '4 hours',
  p_limit int default 200
)
returns int
language plpgsql as $$
declare
  v_count int;
begin
  update appointments
     set status = 'completed'
   where id in (
     select id
       from appointments
      where status = 'confirmed'
        and starts_at < now() - p_grace_hours
      order by starts_at asc
      limit p_limit
   );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Onboarding : création de l'institut avec propriétaire et agent initial
create or replace function create_tenant_with_owner(
  p_user_id uuid,
  p_name text,
  p_timezone text default 'Europe/Paris',
  p_terms_version text default null
)
returns uuid
language plpgsql as $$
declare
  v_tenant_id uuid;
  v_agent_id uuid;
begin
  if p_user_id is null then
    raise exception 'Utilisateur requis.' using errcode = '42501';
  end if;

  if coalesce(trim(p_name), '') = '' then
    raise exception 'Le nom de l''institut est obligatoire.' using errcode = '22023';
  end if;

  if exists (select 1 from tenant_users where user_id = p_user_id) then
    raise exception 'Ce compte est déjà rattaché à un institut.' using errcode = '23505';
  end if;

  insert into tenants (name, timezone, terms_accepted_at, terms_version)
  values (
    trim(p_name),
    coalesce(nullif(trim(p_timezone), ''), 'Europe/Paris'),
    case when p_terms_version is not null and trim(p_terms_version) <> '' then now() else null end,
    nullif(trim(p_terms_version), '')
  )
  returning id into v_tenant_id;

  insert into tenant_users (tenant_id, user_id, role)
  values (v_tenant_id, p_user_id, 'owner');

  insert into agents (tenant_id, type, name, system_prompt_template, config, is_active)
  values (
    v_tenant_id,
    'qualification_rdv',
    'Assistant prise de RDV',
    'Tu représentes {{etablissement}}. Reste chaleureuse, efficace, et oriente la conversation vers la prise de rendez-vous.',
    jsonb_build_object(
      'scheduling', jsonb_build_object(
        'business_hours', jsonb_build_object(
          'mon', jsonb_build_array(jsonb_build_array('09:00', '19:00')),
          'tue', jsonb_build_array(jsonb_build_array('09:00', '19:00')),
          'wed', jsonb_build_array(jsonb_build_array('09:00', '19:00')),
          'thu', jsonb_build_array(jsonb_build_array('09:00', '19:00')),
          'fri', jsonb_build_array(jsonb_build_array('09:00', '19:00')),
          'sat', jsonb_build_array(jsonb_build_array('09:00', '18:00')),
          'sun', jsonb_build_array()
        ),
        'services', jsonb_build_array(),
        'default_duration_min', 60,
        'slot_granularity_min', 30,
        'min_notice_hours', 4,
        'max_days_ahead', 14
      )
    ),
    true
  )
  returning id into v_agent_id;

  insert into qualification_scripts (agent_id, version, questions, budget_rules, escalation_keywords, is_active)
  values (
    v_agent_id,
    1,
    jsonb_build_array(
      jsonb_build_object('id', 'q1', 'field', 'prestation', 'prompt', 'Quelle prestation vous intéresse ?'),
      jsonb_build_object('id', 'q2', 'field', 'zone', 'prompt', 'Sur quelle zone souhaitez-vous être traitée ?'),
      jsonb_build_object('id', 'q3', 'field', 'disponibilite', 'prompt', 'Quels jours et créneaux vous arrangent le mieux ?'),
      jsonb_build_object('id', 'q4', 'field', 'telephone', 'prompt', 'À quel numéro peut-on vous envoyer la confirmation ?')
    ),
    '{}'::jsonb,
    array[
      'enceinte', 'grossesse', 'allergie', 'traitement', 'médicament', 'cancer',
      'remboursement', 'rembourser', 'plainte', 'avocat', 'litige',
      'parler à quelqu''un', 'parler a quelqu''un', 'supprimer mes données', 'rgpd'
    ],
    true
  );

  return v_tenant_id;
end;
$$;

-- Gestion d'équipe : inviter un membre
create or replace function invite_member(p_tenant_id uuid, p_user_id uuid, p_email text, p_role text default 'member')
returns uuid
language plpgsql as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
begin
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_user_id and role = 'owner') then
    raise exception 'Seul le propriétaire peut inviter.' using errcode = '42501';
  end if;

  if v_email = '' or position('@' in v_email) = 0 then
    raise exception 'Adresse e-mail invalide.' using errcode = '22023';
  end if;

  if p_role not in ('owner', 'member') then
    raise exception 'Rôle inconnu : %', p_role using errcode = '22023';
  end if;

  if exists (
    select 1 from tenant_users tu
     join users u on u.id = tu.user_id
    where tu.tenant_id = p_tenant_id and lower(u.email) = v_email
  ) then
    raise exception 'Cette personne fait déjà partie de l''équipe.' using errcode = '23505';
  end if;

  insert into tenant_invitations (tenant_id, email, role, invited_by)
  values (p_tenant_id, v_email, p_role, p_user_id)
  on conflict (tenant_id, lower(email)) where accepted_at is null
  do update set
    role = excluded.role,
    invited_by = excluded.invited_by,
    created_at = now(),
    expires_at = now() + interval '14 days'
  returning id into v_id;

  insert into audit_logs (tenant_id, actor, action, entity, entity_id)
  values (p_tenant_id, p_user_id, 'invite_member', 'tenant_invitations', v_id);

  return v_id;
end;
$$;

create or replace function accept_invitation(p_user_id uuid, p_user_email text, p_invitation_id uuid)
returns uuid
language plpgsql as $$
declare
  v_invitation tenant_invitations%rowtype;
  v_email text := lower(trim(coalesce(p_user_email, '')));
begin
  if p_user_id is null or v_email = '' then
    raise exception 'Authentification requise.' using errcode = '42501';
  end if;

  select * into v_invitation
    from tenant_invitations
   where id = p_invitation_id
   for update;

  if v_invitation.id is null then
    raise exception 'Invitation introuvable.' using errcode = '22023';
  end if;

  if lower(v_invitation.email) <> v_email then
    raise exception 'Cette invitation ne vous est pas destinée.' using errcode = '42501';
  end if;

  if v_invitation.accepted_at is not null then
    raise exception 'Invitation déjà acceptée.' using errcode = '23505';
  end if;

  if v_invitation.expires_at <= now() then
    raise exception 'Invitation expirée. Demandez-en une nouvelle.' using errcode = '22023';
  end if;

  if exists (select 1 from tenant_users where user_id = p_user_id) then
    raise exception 'Ce compte est déjà rattaché à un institut.' using errcode = '23505';
  end if;

  insert into tenant_users (tenant_id, user_id, role)
  values (v_invitation.tenant_id, p_user_id, v_invitation.role::tenant_role);

  update tenant_invitations
     set accepted_at = now(), accepted_by = p_user_id
   where id = v_invitation.id;

  insert into audit_logs (tenant_id, actor, action, entity, entity_id)
  values (v_invitation.tenant_id, p_user_id, 'accept_invitation', 'tenant_users', v_invitation.id);

  return v_invitation.tenant_id;
end;
$$;

create or replace function remove_member(p_tenant_id uuid, p_caller_user_id uuid, p_target_user_id uuid)
returns void
language plpgsql as $$
begin
  if not exists (select 1 from tenant_users where tenant_id = p_tenant_id and user_id = p_caller_user_id and role = 'owner') then
    raise exception 'Seul le propriétaire peut retirer un membre.' using errcode = '42501';
  end if;

  if p_caller_user_id = p_target_user_id then
    raise exception 'Vous ne pouvez pas vous retirer vous-même.' using errcode = '22023';
  end if;

  delete from tenant_users where tenant_id = p_tenant_id and user_id = p_target_user_id;

  insert into audit_logs (tenant_id, actor, action, entity, entity_id)
  values (p_tenant_id, p_caller_user_id, 'remove_member', 'tenant_users', null);
end;
$$;

create or replace function enqueue_invitation_notification(p_invitation_id uuid)
returns int
language plpgsql as $$
declare
  v_invitation tenant_invitations%rowtype;
  v_tenant_name text;
  v_inserted int;
begin
  select * into v_invitation from tenant_invitations where id = p_invitation_id;
  if v_invitation.id is null then
    return 0;
  end if;

  select name into v_tenant_name from tenants where id = v_invitation.tenant_id;

  insert into notifications (tenant_id, kind, subject_id, channel, destination, payload)
  values (
    v_invitation.tenant_id,
    'invitation',
    v_invitation.id,
    'email',
    v_invitation.email,
    jsonb_build_object('tenant_name', coalesce(v_tenant_name, 'un institut'))
  )
  on conflict (kind, subject_id, channel) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

-- ============================================================
-- CATALOGUE INITIAL
-- ============================================================
insert into plans (id, name, description, stripe_price_id, monthly_price_cents, trial_days, max_locations, sort_order)
values
  ('starter', 'Starter', 'Un établissement, agent de qualification et prise de RDV.', 'price_REMPLACER_STARTER', 14900, 14, 1, 1),
  ('pro', 'Pro', 'Jusqu''à trois établissements, rappels automatiques.', 'price_REMPLACER_PRO', 29900, 14, 3, 2),
  ('multi', 'Multi-sites', 'Établissements illimités.', 'price_REMPLACER_MULTI', 59900, 14, null, 3)
on conflict (id) do nothing;
