// Client PostgreSQL pour Neon.
//
// Gère le pooling de connexions et SSL pour Neon Serverless Postgres.
// Compatible transactions atomiques (sql.begin) et interpolation sécurisée.

import postgres from "npm:postgres@^3.4.5";
import { requireEnv, optionalIntEnv } from "./_shared/env.ts";

let client: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (!client) {
    const url = requireEnv("DATABASE_URL");
    const max = optionalIntEnv("DATABASE_POOL_SIZE", 10);

    client = postgres(url, {
      ssl: url.includes("localhost") ? false : "require",
      max,
      idle_timeout: 20,
      connect_timeout: 15,
      transform: {
        undefined: null,
      },
    });
  }
  return client;
}

// Raccourci pour tagged template queries : sql`SELECT * FROM ...`
export const sql: postgres.Sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  apply(_target, _thisArg, argArray) {
    const db = getDb();
    // deno-lint-ignore no-explicit-any
    return (db as any)(...argArray);
  },
  get(_target, prop, receiver) {
    const db = getDb();
    const value = Reflect.get(db, prop, receiver);
    if (typeof value === "function") {
      return value.bind(db);
    }
    return value;
  },
});

export async function closeDb(): Promise<void> {
  if (client) {
    await client.end({ timeout: 5 });
    client = null;
  }
}
