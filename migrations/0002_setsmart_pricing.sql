-- Mise à jour de la grille tarifaire (modèle SetSmart : Light 25€, Pro 97€, Scale 297€).

-- 1. Supprime les anciens plans s'ils ne sont pas liés à des abonnements existants
delete from plans where id in ('starter', 'multi');

-- 2. Insère ou met à jour les 3 plans SetSmart
insert into plans (
  id,
  name,
  description,
  stripe_price_id,
  monthly_price_cents,
  trial_days,
  max_locations,
  sort_order
) values
  (
    'light',
    'Light',
    'Pour tester l''IA en DM à petit prix. 250 messages IA inclus / mois.',
    'price_REMPLACER_LIGHT',
    2500,
    0,
    1,
    1
  ),
  (
    'pro',
    'Pro',
    'L''IA complète — 1 000 messages IA inclus / mois (top-ups auto).',
    'price_REMPLACER_PRO',
    9700,
    7,
    3,
    2
  ),
  (
    'scale',
    'Scale',
    'Pour les entreprises en croissance — 4 000 messages IA inclus / mois.',
    'price_REMPLACER_SCALE',
    29700,
    7,
    null,
    3
  )
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  monthly_price_cents = excluded.monthly_price_cents,
  trial_days = excluded.trial_days,
  max_locations = excluded.max_locations,
  sort_order = excluded.sort_order;
