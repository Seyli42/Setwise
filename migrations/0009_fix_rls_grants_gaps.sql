-- Corrige deux trous trouvés en revue après la bascule RLS (0006/0007/0008) :
--
-- 1. GRANTS MANQUANTS. `setwise_app` n'avait que select/insert sur
--    `channel_connections` et select/insert/delete sur `tenant_invitations` —
--    mais `POST /api/actions/connect-meta` (reconnexion d'un canal existant)
--    et `invite_member()` (réinvitation d'une personne déjà invitée) font
--    tous les deux un `insert ... on conflict ... do update`, qui exige le
--    droit UPDATE. Sans lui : `permission denied for table ...` dès qu'un
--    institut tente l'un ou l'autre sous le rôle applicatif.
--
-- 2. `tenant_deletions` (migrations/0001_initial_schema.sql) n'a jamais reçu
--    de policy RLS — le même oubli que `locations`, corrigé par 0008. Elle ne
--    reçoit aujourd'hui aucun GRANT pour `setwise_app` (c'est ce qui l'a
--    rendue sûre par accident jusqu'ici) ; la RLS est posée maintenant, avant
--    qu'un futur GRANT sur cette table ne dépende d'y penser au bon moment.

grant update on channel_connections to setwise_app;
grant update on tenant_invitations to setwise_app;

alter table tenant_deletions enable row level security;
alter table tenant_deletions force row level security;

drop policy if exists tenant_deletions_isolation on tenant_deletions;
create policy tenant_deletions_isolation on tenant_deletions
  using (tenant_id = current_setting('app.tenant_id')::uuid)
  with check (tenant_id = current_setting('app.tenant_id')::uuid);
