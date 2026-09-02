-- ============================================================
-- 0004 — Limitation de débit
-- ============================================================
-- Aucun plafond n'existait sur les points d'entrée non authentifiés.
-- `/api/auth/magic-link` accepte n'importe quelle adresse et envoie un e-mail
-- réel : une boucle permet de bombarder la boîte d'un tiers depuis le domaine
-- Setwise (avec le risque de réputation d'envoi que ça porte), d'épuiser le
-- quota Resend, et de remplir `users` / `auth_tokens` sans limite.
--
-- Compteur EN BASE, pas en mémoire du processus : le déploiement est
-- multi-instance (Vercel), un compteur local ne verrouille rien — chaque
-- instance aurait son propre plafond, contournable en variant simplement la
-- cible.

create table if not exists rate_limits (
  bucket text primary key,
  count int not null default 1,
  expires_at timestamptz not null
);

-- La colonne n'a d'utilité qu'au moment de l'expiration : un index dédié
-- accélère la purge périodique sans alourdir le chemin chaud (une seule ligne
-- lue/écrite par appel, déjà servie par la clé primaire).
create index if not exists rate_limits_expires_idx on rate_limits (expires_at);

-- ------------------------------------------------------------
-- rate_limit_hit
-- ------------------------------------------------------------
-- Upsert atomique en une instruction : deux requêtes concurrentes sur le même
-- bucket ne peuvent pas toutes les deux lire "0" et repartir à 1 — Postgres
-- sérialise l'upsert lui-même, sans verrou explicite à poser côté appelant.
--
-- Une fenêtre expirée redémarre le compteur à 1 plutôt que de l'incrémenter :
-- sans ce cas, un bucket jamais purgé resterait bloqué au plafond pour
-- toujours après sa première fenêtre pleine.
create or replace function rate_limit_hit(
  p_bucket text,
  p_limit int,
  p_window interval
)
returns boolean
language sql
as $$
  insert into rate_limits (bucket, count, expires_at)
  values (p_bucket, 1, now() + p_window)
  on conflict (bucket) do update
    set count = case
          when rate_limits.expires_at <= now() then 1
          else rate_limits.count + 1
        end,
        expires_at = case
          when rate_limits.expires_at <= now() then now() + p_window
          else rate_limits.expires_at
        end
  returning count <= p_limit;
$$;

comment on function rate_limit_hit(text, int, interval) is
  'Incrémente le compteur du bucket et renvoie true tant que p_limit n''est pas dépassé.';

-- ------------------------------------------------------------
-- Purge
-- ------------------------------------------------------------
-- Rattachée au cron `/crons/purge` déjà planifié : pas de nouvelle tâche à
-- programmer, pas de nouveau secret à distribuer.
create or replace function purge_expired_rate_limits()
returns int
language sql
as $$
  with supprimees as (
    delete from rate_limits where expires_at < now() - interval '1 hour'
    returning 1
  )
  select count(*)::int from supprimees;
$$;
