// Création d'un compte institut, sans passer par l'e-mail.
//
// Le parcours normal (lien magique par Resend) suppose un domaine d'envoi
// vérifié. Tant qu'il ne l'est pas — ou pour ouvrir un compte de démo devant
// un prospect — ce script fait le même travail côté base et imprime le lien
// de connexion directement.
//
// Usage :
//   deno task account -- --email=x@y.fr --institut="Nom" [--demo] [--origin=https://...]
//
// Rôle worker obligatoire : `create_tenant_with_owner` écrit dans `tenants`,
// `tenant_users`, `agents` et `qualification_scripts`, toutes soumises à la
// RLS forcée. Le rôle applicatif y échouerait, par construction.

import postgres from "npm:postgres@^3.4.5";
import { hashToken } from "../src/auth.ts";

function arg(nom: string): string | undefined {
  const prefixe = `--${nom}=`;
  return Deno.args.find((a) => a.startsWith(prefixe))?.slice(prefixe.length);
}

const email = (arg("email") ?? "").toLowerCase().trim();
const institut = arg("institut") ?? "Mon institut";
const avecDemo = Deno.args.includes("--demo");
const origine = (arg("origin") ?? Deno.env.get("APP_ORIGINS")?.split(",")[0] ?? "http://localhost:8000").replace(/\/+$/, "");

if (!email.includes("@")) {
  console.error("❌ --email=... est obligatoire.");
  Deno.exit(1);
}

const url = Deno.env.get("DATABASE_URL_WORKER");
if (!url) {
  console.error("❌ DATABASE_URL_WORKER manquante (rôle setwise_worker).");
  Deno.exit(1);
}

const sql = postgres(url, { ssl: url.includes("localhost") ? false : "require", max: 1 });

try {
  // 1. Utilisateur
  const users = await sql`
    insert into users (email) values (${email})
    on conflict (email) do update set updated_at = now()
    returning id;
  `;
  const userId = users[0].id as string;

  // 2. Institut — réutilisé s'il existe déjà (le script est rejouable)
  const deja = await sql`select tenant_id from tenant_users where user_id = ${userId}::uuid limit 1;`;
  let tenantId: string;
  if (deja.length > 0) {
    tenantId = deja[0].tenant_id;
    console.log(`ℹ️  Institut déjà rattaché : ${tenantId}`);
  } else {
    const res = await sql`
      select create_tenant_with_owner(${userId}::uuid, ${institut}, 'Europe/Paris', '2026-08-17') as tenant_id;
    `;
    tenantId = res[0].tenant_id;
    console.log(`✅ Institut créé (agent + script de qualification inclus) : ${tenantId}`);
  }

  await sql`update tenants set notification_email = ${email} where id = ${tenantId}::uuid;`;

  // 3. Jeu de démonstration : deux leads, une conversation, deux rendez-vous.
  if (avecDemo) {
    const agent = await sql`
      select id from agents where tenant_id = ${tenantId}::uuid and type = 'qualification_rdv' limit 1;
    `;
    const l1 = await sql`
      insert into leads (tenant_id, full_name, phone, instagram_handle, source, status, qualification_data)
      values (${tenantId}::uuid, 'Camille Laurent', '+33698765432', 'camille_lrt', 'instagram', 'booked',
              '{"prestation":"Soin visage hydratant","disponibilite":"Jeudi après-midi"}'::jsonb)
      returning id;
    `;
    const l2 = await sql`
      insert into leads (tenant_id, full_name, phone, instagram_handle, source, status, qualification_data)
      values (${tenantId}::uuid, 'Sarah Benali', '+33611223344', 'sarah_b', 'whatsapp', 'qualified',
              '{"prestation":"Épilation laser demi-jambes","disponibilite":"Samedi matin"}'::jsonb)
      returning id;
    `;
    const fil = `ig_demo_${tenantId.slice(0, 8)}`;
    const conv = await sql`
      insert into conversations (tenant_id, agent_id, lead_id, channel, external_thread_id, status)
      values (${tenantId}::uuid, ${agent[0].id}::uuid, ${l1[0].id}::uuid, 'instagram', ${fil}, 'active')
      on conflict (channel, external_thread_id) do update set last_message_at = now()
      returning id;
    `;
    await sql`
      insert into messages (conversation_id, direction, sender_type, content, external_message_id)
      values
        (${conv[0].id}::uuid, 'inbound', 'lead', 'Bonjour ! Proposez-vous des soins du visage cette semaine ?', ${fil + "_1"}),
        (${conv[0].id}::uuid, 'outbound', 'agent', 'Bonjour Camille ! Oui. Jeudi 14h30 ou vendredi 10h00, lequel préférez-vous ?', ${fil + "_2"}),
        (${conv[0].id}::uuid, 'inbound', 'lead', 'Jeudi 14h30, parfait.', ${fil + "_3"}),
        (${conv[0].id}::uuid, 'outbound', 'agent', 'C''est réservé ! Vous recevrez un rappel la veille.', ${fil + "_4"})
      on conflict (external_message_id) do nothing;
    `;
    await sql`
      insert into appointments (tenant_id, lead_id, conversation_id, starts_at, ends_at, service_type, status)
      values
        (${tenantId}::uuid, ${l1[0].id}::uuid, ${conv[0].id}::uuid, now() + interval '2 days', now() + interval '2 days 1 hour', 'Soin visage hydratant', 'confirmed'),
        (${tenantId}::uuid, ${l2[0].id}::uuid, null, now() - interval '1 day', now() - interval '1 day' + interval '45 minutes', 'Épilation laser', 'completed')
      on conflict do nothing;
    `;
    console.log("✅ Jeu de démonstration inséré (2 leads, 1 conversation, 2 rendez-vous).");
  }

  // 4. Lien de connexion — même mécanique que le lien magique, sans l'e-mail.
  const octets = crypto.getRandomValues(new Uint8Array(32));
  const jeton = Array.from(octets).map((b) => b.toString(16).padStart(2, "0")).join("");
  await sql`
    insert into auth_tokens (email, token_hash, expires_at)
    values (${email}, ${await hashToken(jeton)}, now() + interval '7 days');
  `;

  const etat = await sql`select tenant_billing_state(${tenantId}::uuid) as e;`;
  console.log("\n===========================================================");
  console.log(`📧 Compte      : ${email}`);
  console.log(`🏢 Institut    : ${institut} (${tenantId})`);
  console.log(`💳 Facturation : ${etat[0].e.status} — ${etat[0].e.reason}`);
  console.log(`\n🔗 Lien de connexion (valable 7 jours, à usage unique) :`);
  console.log(`${origine}/dashboard/#token=${jeton}&email=${encodeURIComponent(email)}`);
  console.log("===========================================================\n");
} catch (error) {
  console.error("❌ Échec :", error instanceof Error ? error.message : error);
  Deno.exit(1);
} finally {
  await sql.end();
}
