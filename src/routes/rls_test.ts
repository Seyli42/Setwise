// Test d'isolation RLS réel — contre une vraie base Neon.
//
// TOUS LES AUTRES TESTS DE CE DÉPÔT SONT PURS : ils ne touchent ni le réseau
// ni la base (voir le README). Celui-ci est l'exception assumée, parce que
// c'est le SEUL moyen de vérifier ce que garantit réellement
// `migrations/0007_rls_policies.sql` : que le rôle applicatif, à l'exécution,
// ne peut ni lire ni écrire les données d'un autre institut — pas seulement
// que le code semble correct.
//
// IGNORÉ PAR DÉFAUT. Ce test exige `DATABASE_URL` (rôle `setwise_app`) et
// `DATABASE_URL_WORKER` (rôle `setwise_worker`) pointant vers une VRAIE base
// Neon où les migrations 0001 à 0007 ont été appliquées — de préférence une
// branche Neon jetable, jamais la production. Sans ces deux variables, le
// test est marqué `ignored`, pas silencieusement absent : `deno task test`
// l'affiche clairement plutôt que de laisser croire que la RLS a été
// vérifiée alors qu'elle ne l'a jamais été dans cet environnement.
//
// Lancer, contre une branche Neon de test :
//   DATABASE_URL=postgresql://setwise_app:...@.../neondb \
//   DATABASE_URL_WORKER=postgresql://setwise_worker:...@.../neondb \
//   deno test --allow-net --allow-env src/routes/rls_test.ts

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";

const CONFIGURED = Boolean(Deno.env.get("DATABASE_URL")) && Boolean(Deno.env.get("DATABASE_URL_WORKER"));

Deno.test({
  name: "RLS : le rôle applicatif ne voit et n'écrit que les données de son tenant",
  ignore: !CONFIGURED,
  async fn() {
    // Import dynamique : `db.ts` lit `DATABASE_URL`/`DATABASE_URL_WORKER` au
    // premier appel réel (connexion paresseuse). Les importer statiquement
    // en tête de fichier ferait échouer TOUS les autres fichiers de test au
    // chargement du module, y compris ceux qui n'ont besoin d'aucune base.
    const { sqlWorker, withTenant, closeDb } = await import("../db.ts");

    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();

    try {
      // Semis via le rôle système : BYPASSRLS garantit que la préparation du
      // test ne dépend pas elle-même de ce qu'on est en train de vérifier.
      await sqlWorker`
        insert into tenants (id, name) values
          (${tenantA}::uuid, 'RLS test A'),
          (${tenantB}::uuid, 'RLS test B');
      `;
      await sqlWorker`
        insert into leads (tenant_id, source) values
          (${tenantA}::uuid, 'rls-test-a'),
          (${tenantB}::uuid, 'rls-test-b');
      `;

      // Lecture : sous tenant A, seul le lead de A doit apparaître.
      const visibles = await withTenant(
        tenantA,
        (tx) => tx`select tenant_id, source from leads where source like 'rls-test-%';`,
      );
      assertEquals(visibles.length, 1);
      assertEquals(visibles[0].tenant_id, tenantA);
      assertEquals(visibles[0].source, "rls-test-a");

      // Écriture croisée : sous tenant A, insérer une ligne au nom de B doit
      // être refusé par la policy `WITH CHECK`, pas seulement filtré en
      // lecture. C'est précisément la garantie qui manquait avant 0007 — un
      // filtre `tenant_id` oublié à l'écriture ne se rattrapait qu'à la
      // relecture de code.
      await assertRejects(
        () =>
          withTenant(
            tenantA,
            (tx) => tx`insert into leads (tenant_id, source) values (${tenantB}::uuid, 'rls-test-cross');`,
          ),
        Error,
      );

      // La tentative rejetée ne doit avoir rien écrit : ni chez B (bloqué),
      // ni chez A (la transaction entière a été annulée par le rejet).
      const apresEchec = await sqlWorker`
        select count(*)::int as count from leads where source = 'rls-test-cross';
      `;
      assertEquals(apresEchec[0].count, 0);

      // Lecture croisée : sous tenant A, le lead de B doit être invisible —
      // pas une erreur, un ensemble vide, exactement ce qu'un `WHERE` implicite
      // produirait.
      const croise = await withTenant(
        tenantA,
        (tx) => tx`select id from leads where tenant_id = ${tenantB}::uuid;`,
      );
      assertEquals(croise.length, 0);

      // Symétrique : sous tenant B, seul le lead de B est visible.
      const visiblesB = await withTenant(
        tenantB,
        (tx) => tx`select source from leads where source like 'rls-test-%';`,
      );
      assertEquals(visiblesB.length, 1);
      assertEquals(visiblesB[0].source, "rls-test-b");
    } finally {
      // `on delete cascade` sur `leads.tenant_id` : supprimer les deux
      // instituts de test suffit à tout nettoyer derrière eux.
      await sqlWorker`delete from tenants where id in (${tenantA}::uuid, ${tenantB}::uuid);`;
      await closeDb();
    }
  },
});

Deno.test({
  name: "RLS : hors withTenant, le rôle applicatif échoue bruyamment plutôt que de tout voir",
  ignore: !CONFIGURED,
  async fn() {
    const { sql, closeDb } = await import("../db.ts");

    // Aucun `app.tenant_id` n'a été posé sur cette connexion : la forme
    // stricte de `current_setting` (sans troisième argument) dans les
    // policies doit lever, pas renvoyer un ensemble vide qu'on pourrait
    // confondre avec « cet institut n'a aucune donnée ».
    try {
      await assertRejects(() => sql`select count(*) from leads;`, Error);
    } finally {
      await closeDb();
    }
  },
});

Deno.test({
  name: "RLS : `setwise_worker` continue de tout voir (BYPASSRLS)",
  ignore: !CONFIGURED,
  async fn() {
    const { sqlWorker, closeDb } = await import("../db.ts");

    try {
      // N'importe quelle requête sans filtre doit réussir : c'est la garantie
      // dont dépendent le dispatcher de queue, la purge RGPD et les crons —
      // aucun d'eux ne raisonne "un tenant à la fois".
      const rows = await sqlWorker`select count(*)::int as count from tenants;`;
      assert(rows[0].count >= 0);
    } finally {
      await closeDb();
    }
  },
});
