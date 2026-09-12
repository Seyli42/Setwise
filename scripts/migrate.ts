// Script de migration automatisé pour Neon (PostgreSQL).
//
// Usage :
//   deno run --allow-net --allow-env --allow-read scripts/migrate.ts
//
// Toutes les migrations en attente sont appliquées en une seule fois, dans
// l'ordre du nom de fichier. Pour s'arrêter à une migration précise — utile
// pour la bascule des rôles RLS (voir docs/DEPLOYMENT.md §3.2), où des
// étapes manuelles doivent avoir lieu entre deux migrations — fixer
// `MIGRATE_UNTIL` au nom exact du dernier fichier à appliquer :
//
//   MIGRATE_UNTIL=0006_rls_roles.sql deno run --env --allow-net --allow-env --allow-read scripts/migrate.ts
//   # ... étapes manuelles (mots de passe, variables d'environnement, déploiement) ...
//   deno run --env --allow-net --allow-env --allow-read scripts/migrate.ts   # reprend à partir de 0007

import postgres from "npm:postgres@^3.4.5";

// Chargement de secours du fichier .env si présent
try {
  const envPath = decodeURIComponent(new URL("../.env", import.meta.url).pathname);
  const envText = await Deno.readTextFile(envPath).catch(() => "");
  for (const line of envText.split("\n")) {
    const match = line.trim().match(/^([^=]+)=(.*)$/);
    if (match && !Deno.env.get(match[1].trim())) {
      const val = match[2].trim().replace(/^["'](.*)["']$/, "$1");
      Deno.env.set(match[1].trim(), val);
    }
  }
} catch (_err) {
  // Ignorer si inaccessible
}

const migrateUntil = Deno.env.get("MIGRATE_UNTIL")?.trim() || null;

// Les migrations font du DDL (create table, alter role, create policy) : elles
// exigent le propriétaire du schéma, pas le rôle applicatif. Depuis 0006/0007,
// `DATABASE_URL` porte `setwise_app`, volontairement dépourvu de ces droits —
// l'y envoyer donnerait « permission denied for schema public ». D'où une
// variable dédiée, utilisée par ce seul script et jamais par le serveur.
const databaseUrl = Deno.env.get("DATABASE_URL_ADMIN") ?? Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error("❌ Variable DATABASE_URL_ADMIN manquante (connexion propriétaire du schéma, ex. neondb_owner).");
  Deno.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 1,
});

async function runMigrations() {
  console.log("🚀 Connexion à Neon PostgreSQL...");

  try {
    // Table de traçabilité des migrations
    await sql`
      create table if not exists _migrations (
        id serial primary key,
        name text not null unique,
        applied_at timestamptz not null default now()
      );
    `;

    const appliedRows = await sql`select name from _migrations order by id asc;`;
    const applied = new Set(appliedRows.map((r) => r.name));

    const migrationsDir = decodeURIComponent(new URL("../migrations", import.meta.url).pathname);
    const entries: string[] = [];

    for await (const entry of Deno.readDir(migrationsDir)) {
      if (entry.isFile && entry.name.endsWith(".sql") && !entry.name.startsWith(".")) {
        entries.push(entry.name);
      }
    }

    entries.sort();

    let count = 0;
    let arretDemande = false;
    for (const filename of entries) {
      if (applied.has(filename)) {
        console.log(`⏩ Migration déjà appliquée : ${filename}`);
      } else {
        console.log(`⏳ Application de la migration : ${filename}...`);
        const filePath = `${migrationsDir}/${filename}`;
        const content = await Deno.readTextFile(filePath);

        await sql.begin(async (tx) => {
          await tx.unsafe(content);
          await tx`insert into _migrations (name) values (${filename});`;
        });

        console.log(`✅ Migration appliquée avec succès : ${filename}`);
        count++;
      }

      // Vérifié après les deux branches (appliquée à l'instant ou déjà en
      // base) : une migration déjà appliquée qui se trouve être la borne
      // demandée doit arrêter l'exécution tout autant qu'une migration qu'on
      // vient d'appliquer — sinon un second run avec le même MIGRATE_UNTIL
      // continue tout droit au-delà, silencieusement.
      if (filename === migrateUntil) {
        console.log(`⏸️  Arrêt demandé après ${filename} (MIGRATE_UNTIL).`);
        arretDemande = true;
        break;
      }
    }

    const dernierFichier = entries[entries.length - 1];
    if (arretDemande && migrateUntil !== dernierFichier) {
      // Ne jamais dire « à jour » quand l'arrêt est volontaire et que des
      // migrations existent après la borne demandée — c'est justement le cas
      // qui a fait tourner ce script en rond lors de la bascule RLS.
      console.log(`⏸️  Exécution arrêtée après ${migrateUntil} — des migrations restent en attente au-delà.`);
    } else if (count === 0) {
      console.log("✨ La base de données est déjà à jour.");
    } else {
      console.log(`🎉 ${count} migration(s) appliquée(s) avec succès sur Neon.`);
    }
  } catch (error) {
    console.error("❌ Erreur pendant la migration :", error);
    Deno.exit(1);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await runMigrations();
}
