-- ============================================================
-- 0003 — Rétablissement des bornes perdues
-- ============================================================
-- Le schéma initial portait des contraintes `check` sur deux colonnes de
-- réglage. Elles ont disparu lors de la consolidation des migrations : les
-- colonnes sont devenues de simples `int not null default`.
--
-- Conséquence concrète : `PATCH /api/settings` accepte n'importe quel entier.
-- `data_retention_days = 0` fait anonymiser, dès la purge de la nuit suivante,
-- TOUTES les fiches dont le dernier contact est antérieur à maintenant — soit
-- l'historique client complet de l'institut, irréversiblement. Le seul garde-fou
-- restant était une vérification dans le navigateur, que `curl` contourne.
--
-- Les valeurs déjà hors bornes sont ramenées dans la plage avant la pose des
-- contraintes, sinon `alter table` échouerait sur une base existante.

update tenants
   set data_retention_days = least(greatest(data_retention_days, 30), 3650)
 where data_retention_days < 30 or data_retention_days > 3650;

update tenants
   set escalation_reminder_hours = least(greatest(escalation_reminder_hours, 1), 48)
 where escalation_reminder_hours < 1 or escalation_reminder_hours > 48;

alter table tenants
  drop constraint if exists tenants_data_retention_days_check,
  add constraint tenants_data_retention_days_check
    check (data_retention_days between 30 and 3650);

alter table tenants
  drop constraint if exists tenants_escalation_reminder_hours_check,
  add constraint tenants_escalation_reminder_hours_check
    check (escalation_reminder_hours between 1 and 48);

comment on column tenants.data_retention_days is
  'Conservation en jours depuis le dernier contact. 30 à 3650, 1095 par défaut (recommandation CNIL).';
comment on column tenants.escalation_reminder_hours is
  'Délai avant relance d''une escalade non traitée. 1 à 48 heures.';
