// Script de migration automatisé pour Neon (PostgreSQL).
//
// Usage :
//   deno run --allow-net --allow-env --allow-read scripts/migrate.ts

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

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error("❌ Variable DATABASE_URL manquante. Définissez DATABASE_URL=postgresql://...");
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
    for (const filename of entries) {
      if (applied.has(filename)) {
        console.log(`⏩ Migration déjà appliquée : ${filename}`);
        continue;
      }

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

    if (count === 0) {
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
