-- 0008 — Deux trous découverts à la mise en production.
--
-- A. `locations` portait un `tenant_id` mais avait été oubliée par 0007 : elle
--    était la seule table métier sans RLS. Aucune fuite constatée (seul le
--    rôle worker l'interroge aujourd'hui, via `agent/memory.ts`), mais le
--    principe tenu partout ailleurs est que l'isolation vit dans la base et
--    pas dans la discipline du code appelant. Le jour où le tableau de bord
--    listera les établissements, l'oubli deviendrait une fuite.
--
-- B. `tenant_billing_state` calculait l'essai d'un institut SANS abonnement
--    avec `min(trial_days)` sur les formules actives. Depuis que Light est à
--    0 jour, ce minimum vaut 0 : tout nouvel institut naissait `trial_expired`
--    et son agent était coupé à la seconde de son inscription. Plus aucun
--    prospect ne pouvait essayer le produit.
--
--    `max` est le bon opérateur ici : tant qu'aucune formule n'est choisie, on
--    ne peut pas appliquer la durée d'essai d'une formule en particulier — on
--    offre la plus généreuse, et Stripe reprend la main dès l'abonnement créé
--    (branche `v_subscription.id is not null`, inchangée).

-- ============================================================
-- A. Row-Level Security sur `locations`
-- ============================================================

alter table locations enable row level security;
alter table locations force row level security;

drop policy if exists locations_isolation on locations;
create policy locations_isolation on locations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- ============================================================
-- B. Durée d'essai avant tout abonnement
-- ============================================================

create or replace function public.tenant_billing_state(p_tenant_id uuid)
returns jsonb
language plpgsql
stable
as $function$
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
    -- `max` et non `min` : voir l'en-tête de cette migration.
    select coalesce(max(trial_days), 14) into v_trial_days from plans where is_active;
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
$function$;
