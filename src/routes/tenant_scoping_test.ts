// Garde-fou d'isolation multi-institut.
//
// POURQUOI CE TEST EXISTE.
// Une revue a trouvé une route qui lisait et écrivait le script de
// qualification d'un agent désigné par l'URL, sans jamais vérifier que cet
// agent appartenait à l'appelant. Six routes sur sept filtraient correctement ;
// la septième non. Rien ne le signalait.
//
// DEUX ÂGES DE CE GARDE-FOU.
// À l'origine (avant la RLS), l'isolation reposait entièrement sur le code :
// ce test exigeait qu'une requête `sql\`...\`` touchant une table métier porte
// un filtre `tenant_id`, ou une dérogation motivée. Depuis
// `migrations/0007_rls_policies.sql`, une requête passée par `withTenant`
// (donc taguée `tx\`...\``) est isolée PAR LA BASE, quel que soit son texte —
// la vérifier statiquement serait redondant avec une garantie déjà tenue à
// l'exécution.
//
// Ce qui reste à surveiller n'a pas changé de nature, seulement de nom :
//   - `sql\`...\`` (rôle applicatif) HORS d'un bloc `withTenant` échouera
//     bruyamment à l'exécution (RLS stricte, `current_setting` sans repli) —
//     mieux vaut le repérer avant le déploiement qu'au premier appel ;
//   - `sqlWorker\`...\`` (rôle système, BYPASSRLS) est la dérogation
//     explicite d'aujourd'hui : elle mérite la même justification que l'ancien
//     filtre manquant, parce qu'aucune policy ne la rattrape.
// `tx\`...\`` n'est jamais signalé : la seule source de `tx` dans ces fichiers
// est le callback de `withTenant` (voir la vérification `.begin(` ci-dessous),
// où la RLS impose déjà l'isolation quel que soit le texte de la requête.
// Attention : `sql`/`sqlWorker` restent tous deux typés `postgres.Sql`, qui
// expose publiquement `.begin(...)` — TypeScript n'interdit PAS d'appeler
// `sqlWorker.begin(async (tx) => ...)` directement dans ces fichiers, ce qui
// produirait un vrai `tx` (BYPASSRLS, `app.tenant_id` jamais posé) invisible
// à la règle ci-dessus. C'est pour ça que le test signale aussi tout appel
// `.begin(` dans ces fichiers hors de `db.ts` : seul `withTenant` a le droit
// d'en ouvrir un.
//
// Lancer : deno test --allow-read src/routes/tenant_scoping_test.ts

import { assertEquals } from "jsr:@std/assert@1";

/** Tables portant des données propres à un institut. */
const TABLES_METIER = new Set([
  "leads",
  "conversations",
  "messages",
  "appointments",
  "escalations",
  "agents",
  "qualification_scripts",
  "channel_connections",
  "calendar_integrations",
  "outbound_touches",
  "notifications",
  "tenant_users",
  "tenants",
  "subscriptions",
  "audit_logs",
  "locations",
  "tenant_invitations",
  "webhook_events",
]);

const FICHIERS = ["src/routes/dashboard.ts", "src/routes/auth.ts"];

interface Manquement {
  fichier: string;
  ligne: number;
  requete: string;
}

function analyser(fichier: string, source: string): Manquement[] {
  const manquements: Manquement[] = [];
  const lignes = source.split("\n");

  // `sql\`` (rôle applicatif, doit passer par withTenant) ou `sqlWorker\``
  // (dérogation explicite) — jamais `tx\``, protégé par construction.
  for (const correspondance of source.matchAll(/\bsql(?:Worker)?`([\s\S]*?)`/g)) {
    const requete = correspondance[1];
    if (!/\b(select|insert|update|delete)\b/i.test(requete)) continue;

    const tables = [...requete.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)/gi)]
      .map((m) => m[1].toLowerCase())
      .filter((t) => TABLES_METIER.has(t));
    if (tables.length === 0) continue;

    // Filtre explicite dans la requête elle-même.
    if (/tenantId/.test(requete)) continue;

    const ligne = source.slice(0, correspondance.index).split("\n").length;

    // Dérogation motivée : dans les cinq lignes qui précèdent la requête.
    const avant = lignes.slice(Math.max(0, ligne - 6), ligne).join("\n");
    if (/\/\/\s*tenant-ok:/.test(avant)) continue;

    manquements.push({
      fichier,
      ligne,
      requete: requete.replace(/\s+/g, " ").trim().slice(0, 100),
    });
  }

  // Seul `withTenant` (dans `db.ts`) a le droit d'ouvrir une transaction : un
  // `sql.begin(...)` ou `sqlWorker.begin(...)` écrit directement dans ces
  // fichiers produirait un `tx` non couvert par la règle ci-dessus (elle
  // exempte `tx` sans condition), avec le rôle et la portée de celui qui
  // appelle `.begin(` — potentiellement `sqlWorker`, donc BYPASSRLS et sans
  // `app.tenant_id` posé.
  for (const correspondance of source.matchAll(/\b(?:sql|sqlWorker)\s*\.\s*begin\s*\(/g)) {
    const ligne = source.slice(0, correspondance.index).split("\n").length;
    manquements.push({
      fichier,
      ligne,
      requete: `${correspondance[0]}… — seul withTenant (db.ts) doit ouvrir une transaction ici`,
    });
  }

  return manquements;
}

Deno.test("aucune requête métier sans filtre d'institut ni dérogation motivée", async () => {
  const manquements: Manquement[] = [];

  for (const fichier of FICHIERS) {
    const source = await Deno.readTextFile(fichier);
    manquements.push(...analyser(fichier, source));
  }

  const rapport = manquements
    .map((m) => `\n  ${m.fichier}:${m.ligne}\n    ${m.requete}`)
    .join("");

  assertEquals(
    manquements.length,
    0,
    `Requête(s) touchant une table métier sans filtre sur le tenant.${rapport}\n\n` +
      "Utilisez `withTenant`/`tx`, ou justifiez par `// tenant-ok: <raison>` juste au-dessus.\n",
  );
});

// ============================================================
// Le garde-fou doit lui-même être vérifié
// ============================================================

Deno.test("le garde-fou repère bien une requête non filtrée", () => {
  const faute = "const rows = await sql`select id from leads where status = 'new';`;";
  assertEquals(analyser("test.ts", faute).length, 1);
});

Deno.test("le garde-fou accepte un filtre sur le tenant", () => {
  const bon = "const rows = await sql`select id from leads where tenant_id = ${caller.tenantId};`;";
  assertEquals(analyser("test.ts", bon).length, 0);
});

Deno.test("le garde-fou accepte une dérogation motivée", () => {
  const derogation = "// tenant-ok: appartenance vérifiée au-dessus.\n" +
    "const rows = await sql`select id from leads where id = ${leadId};`;";
  assertEquals(analyser("test.ts", derogation).length, 0);
});

Deno.test("une dérogation trop lointaine ne compte pas", () => {
  // Sinon un `tenant-ok` posé sur une requête couvrirait par accident toutes
  // celles qui suivent dans le même bloc.
  const lointain = "// tenant-ok: raison.\n" + "\n".repeat(8) +
    "const rows = await sql`select id from leads where id = ${leadId};`;";
  assertEquals(analyser("test.ts", lointain).length, 1);
});

Deno.test("les requêtes hors tables métier sont ignorées", () => {
  const neutre = "const rows = await sql`select now() as maintenant;`;";
  assertEquals(analyser("test.ts", neutre).length, 0);
});

Deno.test("les requêtes `tx` ne sont jamais signalées, protégées par la RLS", () => {
  // Aucun filtre, aucune dérogation — et c'est très bien : `tx` ne peut
  // exister qu'à l'intérieur du callback de `withTenant`, où la RLS impose
  // déjà l'isolation quel que soit le texte de la requête.
  const viaTx = "const rows = await tx`select id from leads where status = 'new';`;";
  assertEquals(analyser("test.ts", viaTx).length, 0);
});

Deno.test("le garde-fou repère un `.begin(` ouvert hors de withTenant", () => {
  const contournement = "await sqlWorker.begin(async (tx) => { await tx`select id from leads`; });";
  assertEquals(analyser("test.ts", contournement).length, 1);

  const viaSqlAussi = "await sql.begin(async (tx) => { await tx`select id from leads`; });";
  assertEquals(analyser("test.ts", viaSqlAussi).length, 1);
});

Deno.test("`sqlWorker` sur une table métier exige la même justification que `sql`", () => {
  const nonJustifie = "const rows = await sqlWorker`select id from leads where status = 'new';`;";
  assertEquals(analyser("test.ts", nonJustifie).length, 1);

  const justifie = "// tenant-ok: pas encore de tenant à ce stade.\n" +
    "const rows = await sqlWorker`select id from leads where status = 'new';`;";
  assertEquals(analyser("test.ts", justifie).length, 0);
});
