// Client PostgreSQL pour Neon — deux rôles, deux usages.
//
// `sql`       rôle applicatif (`setwise_app`), utilisé par le chemin API
//             (`routes/dashboard.ts`, `routes/auth.ts`) via `withTenant`.
//             Soumis à la RLS une fois `migrations/0007_rls_policies.sql`
//             appliquée : sans transaction posant `app.tenant_id`, toute
//             requête sur une table métier ne voit rien.
//
// `sqlWorker` rôle système (`setwise_worker`), utilisé par tout le reste :
//             webhooks, crons, moteur d'agent, notifications, facturation.
//             Ce sont des traitements par lots qui balaient plusieurs
//             instituts par construction (le dispatcher de queue, la purge
//             RGPD) — leur imposer une transaction par tenant n'a pas de
//             sens. `setwise_worker` porte l'attribut `BYPASSRLS`
//             (`migrations/0006_rls_roles.sql`) : il continue de fonctionner
//             exactement comme avant l'introduction de la RLS.
//
// AUCUN REPLI SILENCIEUX ENTRE LES DEUX. `DATABASE_URL_WORKER` manquant fait
// échouer au démarrage (`requireEnv`), jamais un retour discret vers le rôle
// applicatif — une fois la RLS forcée (0007), un worker qui utiliserait par
// erreur le rôle `setwise_app` ne verrait plus aucune ligne d'aucune table
// métier, une panne totale et silencieuse à l'exécution. Mieux vaut un
// démarrage qui refuse de se lancer qu'un webhook qui traite du vide.

import postgres from "npm:postgres@^3.4.5";
import { requireEnv, optionalIntEnv } from "./_shared/env.ts";

function makeClient(urlEnvVar: string): postgres.Sql {
  const url = requireEnv(urlEnvVar);
  const max = optionalIntEnv("DATABASE_POOL_SIZE", 10);

  return postgres(url, {
    ssl: url.includes("localhost") ? false : "require",
    max,
    idle_timeout: 20,
    connect_timeout: 15,
    transform: {
      undefined: null,
    },
  });
}

let appClient: postgres.Sql | null = null;
let workerClient: postgres.Sql | null = null;

function getAppDb(): postgres.Sql {
  if (!appClient) appClient = makeClient("DATABASE_URL");
  return appClient;
}

function getWorkerDb(): postgres.Sql {
  if (!workerClient) workerClient = makeClient("DATABASE_URL_WORKER");
  return workerClient;
}

/**
 * Proxy paresseux : la connexion n'est ouverte qu'au premier appel réel, pas
 * à l'import du module. Un script qui n'a besoin que du rôle worker (un cron
 * isolé, un test) ne force jamais l'ouverture de la connexion applicative, et
 * réciproquement.
 */
function lazyProxy(getDb: () => postgres.Sql): postgres.Sql {
  return new Proxy((() => {}) as unknown as postgres.Sql, {
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
}

/** Rôle applicatif — requêtes du tableau de bord, toujours via `withTenant`. */
export const sql: postgres.Sql = lazyProxy(getAppDb);

/** Rôle système — tout le reste : webhooks, crons, moteur d'agent, facturation. */
export const sqlWorker: postgres.Sql = lazyProxy(getWorkerDb);

/**
 * Ouvre une transaction sur le rôle applicatif, y pose `app.tenant_id` en
 * portée LOCALE, puis exécute `fn` avec cette transaction.
 *
 * `set_config(..., true)` — le troisième argument `true` restreint le
 * réglage à la transaction en cours : il disparaît automatiquement au
 * COMMIT/ROLLBACK. Un `SET` de session ordinaire survivrait à la requête et
 * fuiterait vers la requête suivante servie par la même connexion physique —
 * catastrophique sur un pooler en mode transaction (PgBouncer/Neon), où une
 * connexion est réattribuée à une autre requête, potentiellement d'un autre
 * institut, dès la fin de la transaction précédente.
 *
 * Tenir cette transaction ouverte pendant un appel réseau externe (Stripe,
 * Meta, Google) est un contresens : ne l'utiliser que pour des opérations
 * base de données. Les appels externes se placent AVANT ou APRÈS l'appel à
 * `withTenant`, jamais à l'intérieur du callback.
 */
export function withTenant<T>(
  tenantId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // `sql.begin` type ses generics pour le cas où le callback renvoie un
  // tableau de promesses (semantique "batch" propre à postgres.js) ; notre
  // callback renvoie une valeur unique, d'où l'assertion.
  return getAppDb().begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true);`;
    return await fn(tx);
  }) as Promise<T>;
}

export async function closeDb(): Promise<void> {
  if (appClient) {
    await appClient.end({ timeout: 5 });
    appClient = null;
  }
  if (workerClient) {
    await workerClient.end({ timeout: 5 });
    workerClient = null;
  }
}
