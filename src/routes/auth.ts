// Routes d'authentification autonome Magic Link pour Neon.

import {
  authenticateUserOnly,
  sendMagicLink,
  verifyMagicLink,
} from "../auth.ts";
import { sql } from "../db.ts";
import { ValidationError } from "../_shared/errors.ts";

export async function handleSendMagicLink(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim();
  if (!email) throw new ValidationError("Adresse e-mail requise.");

  const origin = req.headers.get("origin") ||
    req.headers.get("referer") ||
    "http://localhost:8000";

  const result = await sendMagicLink(email, origin);
  return Response.json(result);
}

export async function handleVerifyMagicLink(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const body = await req.json().catch(() => ({}));
  const token = String(body.token ?? "").trim();
  const email = body.email ? String(body.email).trim() : undefined;

  if (!token) throw new ValidationError("Jeton de connexion requis.");

  const session = await verifyMagicLink(token, email);
  return Response.json(session);
}

export async function handleGetMe(req: Request): Promise<Response> {
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  const user = await authenticateUserOnly(req);

  // Recherche tenant actuel
  const memberships = await sql`
    select tu.tenant_id, tu.role, t.name as tenant_name, t.timezone, t.plan, t.siret,
           t.notification_email, t.notification_phone
      from tenant_users tu
      join tenants t on t.id = tu.tenant_id
     where tu.user_id = ${user.userId}::uuid
       and t.deleted_at is null
     limit 1;
  `;

  if (memberships.length === 0) {
    return Response.json({
      user: { id: user.userId, email: user.email },
      membership: null,
      tenant: null,
    });
  }

  const m = memberships[0];
  return Response.json({
    user: { id: user.userId, email: user.email },
    membership: {
      tenantId: m.tenant_id,
      role: m.role,
      tenantName: m.tenant_name,
      timezone: m.timezone,
    },
    tenant: {
      id: m.tenant_id,
      name: m.name,
      timezone: m.timezone,
      plan: m.plan,
      siret: m.siret,
      notificationEmail: m.notification_email,
      notificationPhone: m.notification_phone,
    },
  });
}
