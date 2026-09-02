-- ============================================================
-- 0005 — Plafond de consommation IA
-- ============================================================
-- Chaque message entrant déclenche jusqu'à MAX_TOOL_ITERATIONS appels au
-- modèle. Les jetons consommés étaient journalisés (`llm.turn`) mais jamais
-- totalisés ni plafonnés : un compte visé par un flot de DM, ou une boucle
-- d'outils qui ne converge pas, consommait sans limite — sans que rien ne
-- s'allume côté exploitant.
--
-- Effet de bord découvert en écrivant cette migration : les descriptions des
-- plans (0002_setsmart_pricing.sql) promettent déjà des quotas précis —
-- « 250 messages IA inclus / mois » (Light), « 1 000 » (Pro), « 4 000 »
-- (Scale) — sans qu'aucun code ne les applique. Cette migration ne fait donc
-- pas qu'ajouter un garde-fou technique : elle rend vraie une promesse déjà
-- écrite dans le produit.

alter table plans add column if not exists monthly_llm_calls int;

comment on column plans.monthly_llm_calls is
  'Appels au modèle inclus par mois. NULL = illimité.';

update plans set monthly_llm_calls = 250  where id = 'light' and monthly_llm_calls is null;
update plans set monthly_llm_calls = 1000 where id = 'pro'   and monthly_llm_calls is null;
update plans set monthly_llm_calls = 4000 where id = 'scale' and monthly_llm_calls is null;

-- ------------------------------------------------------------
-- Consommation, au jour le jour
-- ------------------------------------------------------------
-- Granularité journalière (et non un seul compteur mensuel) : elle permet de
-- diagnostiquer un pic ("c'est arrivé quel jour ?") et de purger sans perdre
-- l'historique du mois en cours si un jour de rétention plus fin est décidé
-- plus tard. Le total mensuel est une simple somme sur les jours du mois.
create table if not exists llm_usage (
  tenant_id uuid not null references tenants(id) on delete cascade,
  jour date not null default current_date,
  calls int not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  primary key (tenant_id, jour)
);

create or replace function record_llm_usage(
  p_tenant_id uuid,
  p_input_tokens int,
  p_output_tokens int
)
returns void
language sql
as $$
  insert into llm_usage (tenant_id, jour, calls, input_tokens, output_tokens)
  values (p_tenant_id, current_date, 1, coalesce(p_input_tokens, 0), coalesce(p_output_tokens, 0))
  on conflict (tenant_id, jour) do update
    set calls = llm_usage.calls + 1,
        input_tokens = llm_usage.input_tokens + excluded.input_tokens,
        output_tokens = llm_usage.output_tokens + excluded.output_tokens;
$$;

-- ------------------------------------------------------------
-- État du quota
-- ------------------------------------------------------------
-- Le plan effectif est celui de l'abonnement en cours, dans les mêmes statuts
-- que `tenant_billing_state` considère "actifs" (trialing / active / past_due
-- — un dernier paiement refusé ne doit pas, en plus, ouvrir un accès illimité
-- au modèle).
--
-- Sans abonnement (période d'essai avant tout choix de formule), le plafond du
-- plan Light sert de défaut : l'essai gratuit reste généreux sans être
-- illimité, ce qui est précisément le trou que cette migration ferme.
create or replace function tenant_llm_quota_state(p_tenant_id uuid)
returns jsonb
language plpgsql
stable as $$
declare
  v_limit int;
  v_used int;
begin
  select p.monthly_llm_calls into v_limit
    from subscriptions s
    join plans p on p.id = s.plan
   where s.tenant_id = p_tenant_id
     and s.status in ('trialing', 'active', 'past_due');

  if not found then
    select monthly_llm_calls into v_limit from plans where id = 'light';
  end if;

  select coalesce(sum(calls), 0) into v_used
    from llm_usage
   where tenant_id = p_tenant_id
     and jour >= date_trunc('month', now())::date;

  return jsonb_build_object(
    'used', v_used,
    'limit', v_limit,
    'exceeded', v_limit is not null and v_used >= v_limit,
    'warning', v_limit is not null and v_used >= ceil(v_limit * 0.8) and v_used < v_limit
  );
end;
$$;

comment on function tenant_llm_quota_state(uuid) is
  'Consommation du mois en cours face au plafond du plan. { used, limit, exceeded, warning }.';
