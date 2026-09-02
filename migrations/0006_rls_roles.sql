-- ============================================================
-- 0006 — Deux rôles de connexion
-- ============================================================
-- Première étape de la mise en place de la RLS. Cette migration ne change
-- RIEN au comportement en production : elle crée les rôles et pose les
-- droits, mais n'active aucune policy (0007 s'en charge). Le rôle actuel
-- utilisé par `DATABASE_URL` continue de fonctionner exactement comme avant
-- tant que la bascule de configuration décrite plus bas n'a pas eu lieu.
--
-- POURQUOI DEUX RÔLES.
-- Le code se divise en deux contextes fondamentalement différents :
--   - le chemin API (`routes/dashboard.ts`, `routes/auth.ts`) connaît le
--     tenant de l'appelant à chaque requête — c'est lui qui doit être
--     enfermé par la RLS ;
--   - les workers (webhooks, crons, moteur d'agent, facturation, purge RGPD)
--     traitent des lots qui balaient plusieurs instituts par construction. Le
--     dispatcher de queue ou la purge de rétention n'ont pas de sens sous
--     contrainte "un seul tenant à la fois".
-- Un seul rôle contraint par la RLS aurait cassé tous les workers. Un seul
-- rôle qui bypasse la RLS n'aurait rien protégé.
--
-- ============================================================
-- OPÉRATIONS MANUELLES REQUISES APRÈS CETTE MIGRATION (hors dépôt)
-- ============================================================
--   1. Fixer un mot de passe pour chaque rôle — jamais dans un fichier versionné :
--        alter role setwise_app    with password '...';
--        alter role setwise_worker with password '...';
--   2. Construire les deux chaînes de connexion (même hôte, même base, rôle
--      différent) et les poser comme secrets :
--        DATABASE_URL         -> setwise_app
--        DATABASE_URL_WORKER  -> setwise_worker
--   3. Ne déployer le code applicatif (`src/db.ts` à deux rôles) qu'une fois
--      les deux variables en place — `sqlWorker` échoue au démarrage
--      (`requireEnv`) si `DATABASE_URL_WORKER` est absente, volontairement :
--      un démarrage qui refuse de se lancer vaut mieux qu'un worker qui
--      croit être protégé alors qu'il tourne sur le mauvais rôle.
--   4. Si la création du rôle ci-dessous échoue faute de privilège (certains
--      fournisseurs managés restreignent `BYPASSRLS`), le créer depuis la
--      console Neon puis reprendre cette migration à partir du `GRANT`.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'setwise_app') then
    create role setwise_app with login;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'setwise_worker') then
    -- BYPASSRLS : seul le worker l'obtient. C'est l'unique différence de
    -- privilège entre les deux rôles — tout le reste (droits DML) est
    -- symétrique par construction ci-dessous.
    create role setwise_worker with login bypassrls;
  end if;
end
$$;

grant usage on schema public to setwise_app, setwise_worker;

-- ------------------------------------------------------------
-- Rôle système : accès large, borné par BYPASSRLS + les GRANT eux-mêmes
-- ------------------------------------------------------------
-- `ALL TABLES` plutôt qu'une énumération : c'est le successeur du rôle unique
-- utilisé partout aujourd'hui, il touche la quasi-totalité du schéma. Les
-- `DEFAULT PRIVILEGES` couvrent les tables créées par de futures migrations
-- sans avoir à revenir modifier cette liste.
grant select, insert, update, delete on all tables in schema public to setwise_worker;
grant usage on all sequences in schema public to setwise_worker;
grant execute on all functions in schema public to setwise_worker;

alter default privileges in schema public
  grant select, insert, update, delete on tables to setwise_worker;
alter default privileges in schema public
  grant execute on functions to setwise_worker;

-- ------------------------------------------------------------
-- Rôle applicatif : uniquement ce que `routes/dashboard.ts` et
-- `routes/auth.ts` touchent réellement, table par table.
-- ------------------------------------------------------------
-- Catalogue global, non rattaché à un institut : lecture seule.
grant select on plans to setwise_app;

-- Identité globale, jamais filtrée par tenant_id elle-même — la portée
-- correcte vient du JOIN avec tenant_users, qui lui est protégé par RLS.
grant select on users to setwise_app;

grant select, update on tenants to setwise_app;
grant select, delete on tenant_users to setwise_app;
grant select, insert, delete on tenant_invitations to setwise_app;
grant select, update on agents to setwise_app;
grant select, insert, update on qualification_scripts to setwise_app;
grant select, insert on channel_connections to setwise_app;
grant select, insert, update on calendar_integrations to setwise_app;
grant select, update on leads to setwise_app;
grant select, update on conversations to setwise_app;
grant select, update on messages to setwise_app;
grant select, update on appointments to setwise_app;
grant select, update on escalations to setwise_app;
grant select on subscriptions to setwise_app;
grant select on outbound_touches to setwise_app;
grant insert on notifications to setwise_app;

-- Trace d'audit : écriture seule, depuis `forget_lead` et `remove_member`
-- (appelées via le rôle applicatif). Aucune route ne lit `audit_logs` depuis
-- le tableau de bord — pas de SELECT accordé.
grant insert on audit_logs to setwise_app;

-- Défense en profondeur : ces deux colonnes ne sont JAMAIS lues par le code
-- applicatif (vérifié — seules des colonnes non sensibles sont sélectionnées
-- sur ces deux tables), seulement écrites à la connexion d'un canal. Un futur
-- `select *` accidentel échoue bruyamment au lieu de faire fuiter un jeton
-- déchiffrable vers le navigateur.
revoke select (access_token_encrypted) on channel_connections from setwise_app;
revoke select (credentials_encrypted) on calendar_integrations from setwise_app;

-- Fonctions appelées depuis `routes/dashboard.ts` via le rôle applicatif.
-- Aucune n'est `security definer` : elles s'exécutent avec les droits de
-- l'appelant, d'où la nécessité des GRANT ci-dessus sur les tables qu'elles
-- touchent en interne.
grant execute on function tenant_performance(uuid, int) to setwise_app;
grant execute on function forget_lead(uuid, uuid, uuid) to setwise_app;
grant execute on function remove_member(uuid, uuid, uuid) to setwise_app;
grant execute on function invite_member(uuid, uuid, text, text) to setwise_app;
grant execute on function enqueue_invitation_notification(uuid) to setwise_app;

comment on role setwise_app is
  'Rôle du tableau de bord — soumis à la RLS (migrations/0007_rls_policies.sql). DATABASE_URL.';
comment on role setwise_worker is
  'Rôle des workers — webhooks, crons, moteur d''agent. BYPASSRLS. DATABASE_URL_WORKER.';
