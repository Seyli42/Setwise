// Script de peuplement (Seeding) de données de test pour Neon.
//
// Usage :
//   deno run --allow-net --allow-env --allow-read scripts/seed.ts

import postgres from "npm:postgres@^3.4.5";
import * as jose from "npm:jose@^5.9.6";

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
  // Ignorer
}

const databaseUrl = Deno.env.get("DATABASE_URL");
if (!databaseUrl) {
  console.error("❌ Variable DATABASE_URL manquante.");
  Deno.exit(1);
}

const sql = postgres(databaseUrl, {
  ssl: databaseUrl.includes("localhost") ? false : "require",
  max: 1,
});

async function seed() {
  console.log("🌱 Peuplement des données de démonstration dans Neon...");

  try {
    const email = "demo@setwise.fr";

    // 1. Utilisateur démo
    const userRows = await sql`
      insert into users (email)
      values (${email})
      on conflict (email) do update set updated_at = now()
      returning id;
    `;
    const userId = userRows[0].id;

    // 2. Vérifie si l'institut existe déjà
    const existingTenant = await sql`
      select tu.tenant_id
        from tenant_users tu
       where tu.user_id = ${userId}::uuid
       limit 1;
    `;

    let tenantId: string;

    if (existingTenant.length > 0) {
      tenantId = existingTenant[0].tenant_id;
      console.log(`ℹ️ Institut existant trouvé : ${tenantId}`);
    } else {
      const res = await sql`
        select create_tenant_with_owner(
          ${userId}::uuid,
          'Institut L''Échappée Belle',
          'Europe/Paris',
          '2026-08-17'
        ) as tenant_id;
      `;
      tenantId = res[0].tenant_id;
      console.log(`✅ Nouvel institut créé : ${tenantId}`);
    }

    // 3. Mise à jour des informations de contact pour les alertes
    await sql`
      update tenants
         set notification_email = 'alertes@setwise.fr',
             notification_phone = '+33612345678',
             siret = '12345678900012'
       where id = ${tenantId}::uuid;
    `;

    // 4. Récupère l'agent de qualification
    const agentRows = await sql`
      select id from agents where tenant_id = ${tenantId}::uuid and type = 'qualification_rdv' limit 1;
    `;
    const agentId = agentRows[0]?.id;

    // 5. Leads de test
    const lead1 = await sql`
      insert into leads (tenant_id, full_name, phone, instagram_handle, source, status, qualification_data)
      values (
        ${tenantId}::uuid,
        'Camille Laurent',
        '+33698765432',
        'camille_lrt',
        'instagram',
        'booked',
        '{"prestation": "Soin visage hydratant", "disponibilite": "Jeudi après-midi"}'::jsonb
      )
      returning id;
    `;

    const lead2 = await sql`
      insert into leads (tenant_id, full_name, phone, instagram_handle, source, status, qualification_data)
      values (
        ${tenantId}::uuid,
        'Sarah Benali',
        '+33611223344',
        'sarah_b',
        'whatsapp',
        'qualified',
        '{"prestation": "Épilation laser demi-jambes", "disponibilite": "Samedi matin"}'::jsonb
      )
      returning id;
    `;

    // 6. Conversations & Messages
    const conv1 = await sql`
      insert into conversations (tenant_id, agent_id, lead_id, channel, external_thread_id, status)
      values (${tenantId}::uuid, ${agentId}::uuid, ${lead1[0].id}::uuid, 'instagram', 'ig_thread_123', 'active')
      on conflict (channel, external_thread_id) do update set last_message_at = now()
      returning id;
    `;

    await sql`
      insert into messages (conversation_id, direction, sender_type, content, external_message_id)
      values
        (${conv1[0].id}::uuid, 'inbound', 'lead', 'Bonjour ! Proposez-vous des soins du visage hydratants cette semaine ?', 'msg_1'),
        (${conv1[0].id}::uuid, 'outbound', 'agent', 'Bonjour Camille ! Oui tout à fait. Nous avons des créneaux jeudi à 14h30 ou vendredi à 10h00. Lequel préférez-vous ?', 'msg_2'),
        (${conv1[0].id}::uuid, 'inbound', 'lead', 'Parfait pour jeudi 14h30 au nom de Camille Laurent.', 'msg_3'),
        (${conv1[0].id}::uuid, 'outbound', 'agent', 'C''est réservé pour jeudi à 14h30 ! Vous recevrez un rappel par SMS la veille.', 'msg_4')
      on conflict (external_message_id) do nothing;
    `;

    // 7. Rendez-vous de test
    await sql`
      insert into appointments (tenant_id, lead_id, conversation_id, starts_at, ends_at, service_type, status)
      values
        (${tenantId}::uuid, ${lead1[0].id}::uuid, ${conv1[0].id}::uuid, now() + interval '2 days', now() + interval '2 days 1 hour', 'Soin visage hydratant', 'confirmed'),
        (${tenantId}::uuid, ${lead2[0].id}::uuid, null, now() - interval '1 day', now() - interval '1 day' + interval '45 minutes', 'Épilation laser', 'completed')
      on conflict do nothing;
    `;

    // 8. Génération d'un token JWT de test (valable 30 jours)
    const secret = Deno.env.get("JWT_SECRET") || Deno.env.get("ENCRYPTION_KEY") || "setwise_default_secret_key_32bytes_!";
    const jwt = await new jose.SignJWT({
      userId,
      email,
      tenantId,
      role: "owner",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(secret));

    console.log("\n=======================================================");
    console.log("🎉 Données de test insérées avec succès !");
    console.log(`📧 Utilisateur démo : ${email}`);
    console.log(`🏢 Institut ID : ${tenantId}`);
    console.log(`🔑 Jeton JWT de test :\n${jwt}`);
    console.log("=======================================================\n");
  } catch (error) {
    console.error("❌ Erreur pendant le seeding :", error);
    Deno.exit(1);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  await seed();
}
