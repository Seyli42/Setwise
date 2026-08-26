// Authentification autonome sans mot de passe (Magic Link) pour Neon.
//
// 1. Demande de lien magique : génération d'un token cryptographique éphémère (15 min),
//    stockage du hash en base, envoi par email via Resend.
// 2. Vérification : validation du token, invalidation à usage unique, émission d'un JWT de session.
// 3. Authentification des requêtes API : vérification du JWT et résolution du tenant_id.

import { sql } from "./db.ts";
import { optionalEnv } from "./_shared/env.ts";
import { AppError, ValidationError } from "./_shared/errors.ts";
import { log } from "./_shared/logger.ts";
import * as jose from "npm:jose@^5.9.6";

export class AuthError extends AppError {
  readonly status: number;

  constructor(message: string, status = 401) {
    super("auth_error", message, { retryable: false });
    this.status = status;
  }
}

export interface DashboardCaller {
  userId: string;
  email: string;
  tenantId: string;
  role: "owner" | "staff";
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

function getJwtSecret(): Uint8Array {
  const secret = optionalEnv("JWT_SECRET", "") || optionalEnv("ENCRYPTION_KEY", "setwise_default_secret_key_32bytes_!");
  return new TextEncoder().encode(secret);
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SendMagicLinkResult {
  ok: boolean;
  message: string;
}

/**
 * Génère et envoie un lien magique de connexion par email.
 */
export async function sendMagicLink(email: string, origin: string): Promise<SendMagicLinkResult> {
  const normalizedEmail = email.toLowerCase().trim();
  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    throw new ValidationError("Adresse e-mail invalide.");
  }

  // Crée l'utilisateur s'il n'existe pas encore
  await sql`
    insert into users (email)
    values (${normalizedEmail})
    on conflict (email) do nothing;
  `;

  // Génération du token aléatoire sécurisé (32 octets hexadécimaux)
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const rawToken = Array.from(randomBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const tokenHash = await hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

  await sql`
    insert into auth_tokens (email, token_hash, expires_at)
    values (${normalizedEmail}, ${tokenHash}, ${expiresAt});
  `;

  const loginUrl = `${origin.replace(/\/+$/, "")}/#token=${rawToken}&email=${encodeURIComponent(normalizedEmail)}`;

  // Envoi de l'e-mail
  const resendApiKey = optionalEnv("RESEND_API_KEY", "");
  const fromAddress = optionalEnv("NOTIFICATION_FROM", "Setwise <connexion@setwise.fr>");

  if (resendApiKey) {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddress,
        to: [normalizedEmail],
        subject: "Votre lien de connexion Setwise",
        text: `Bonjour,\n\nCliquez sur ce lien pour vous connecter à votre tableau de bord Setwise (valable 15 minutes) :\n\n${loginUrl}\n\nSi vous n'avez pas demandé ce lien, vous pouvez ignorer cet e-mail.\n\nL'équipe Setwise`,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      log.error("auth.email_failed", { status: res.status, error: errText });
      throw new AppError("auth_email_error", "Impossible d'envoyer l'e-mail de connexion. Vérifiez la configuration Resend.");
    }
  } else {
    // Mode développement local sans Resend
    log.warn("auth.dev_magic_link", { email: normalizedEmail, loginUrl });
    console.log(`\n🔗 [DEV] Lien magique pour ${normalizedEmail} :\n${loginUrl}\n`);
  }

  return {
    ok: true,
    message: "Lien envoyé. Ouvrez votre boîte mail depuis cet appareil.",
  };
}

export interface VerifyTokenResult {
  token: string;
  user: { id: string; email: string };
  membership: { tenantId: string; role: "owner" | "staff"; tenantName: string; timezone: string } | null;
}

/**
 * Valide le token reçu du lien magique et émet un JWT de session.
 */
export async function verifyMagicLink(rawToken: string, emailCandidate?: string): Promise<VerifyTokenResult> {
  const token = rawToken.trim();
  if (!token) throw new ValidationError("Jeton de connexion manquant.");

  const tokenHash = await hashToken(token);

  // Recherche du token actif
  const rows = await sql`
    select id, email, expires_at, used_at
      from auth_tokens
     where token_hash = ${tokenHash}
       and used_at is null
       and expires_at > now()
     limit 1;
  `;

  if (rows.length === 0) {
    throw new AuthError("Lien de connexion expiré ou déjà utilisé. Demandez-en un nouveau.");
  }

  const tokenRecord = rows[0];

  if (emailCandidate && tokenRecord.email.toLowerCase() !== emailCandidate.toLowerCase().trim()) {
    throw new AuthError("Adresse e-mail non correspondante.");
  }

  // Marque le token comme consommé
  await sql`
    update auth_tokens
       set used_at = now()
     where id = ${tokenRecord.id};
  `;

  // Récupère ou insère l'utilisateur
  const users = await sql`
    select id, email from users where lower(email) = lower(${tokenRecord.email}) limit 1;
  `;
  if (users.length === 0) {
    throw new AuthError("Utilisateur introuvable.");
  }
  const user = users[0];

  // Recherche du rattachement à un institut
  const memberships = await sql`
    select tu.tenant_id, tu.role, t.name as tenant_name, t.timezone
      from tenant_users tu
      join tenants t on t.id = tu.tenant_id
     where tu.user_id = ${user.id}
       and t.deleted_at is null
     limit 1;
  `;

  const membership = memberships.length > 0
    ? {
      tenantId: memberships[0].tenant_id,
      role: memberships[0].role as "owner" | "staff",
      tenantName: memberships[0].tenant_name,
      timezone: memberships[0].timezone,
    }
    : null;

  // Création du JWT de session (durée 30 jours)
  const jwt = await new jose.SignJWT({
    userId: user.id,
    email: user.email,
    tenantId: membership?.tenantId ?? null,
    role: membership?.role ?? null,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getJwtSecret());

  return {
    token: jwt,
    user: { id: user.id, email: user.email },
    membership,
  };
}

/**
 * Authentifie les requêtes protégées à partir du header Authorization.
 */
export async function authenticateCaller(req: Request): Promise<DashboardCaller> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (!token) throw new AuthError("Jeton d'authentification absent.");

  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    const userId = String(payload.userId ?? "");
    const email = String(payload.email ?? "");

    if (!userId) throw new AuthError("Jeton invalide.");

    // Vérifie en base l'appartenance actuelle (revérification temps réel)
    const memberships = await sql`
      select tu.tenant_id, tu.role
        from tenant_users tu
        join tenants t on t.id = tu.tenant_id
       where tu.user_id = ${userId}
         and t.deleted_at is null
       limit 1;
    `;

    if (memberships.length === 0) {
      throw new AuthError("Ce compte n'est rattaché à aucun institut.", 403);
    }

    return {
      userId,
      email,
      tenantId: memberships[0].tenant_id,
      role: memberships[0].role as "owner" | "staff",
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AuthError("Session expirée ou invalide, veuillez vous reconnecter.");
  }
}

/**
 * Authentifie un utilisateur connecté sans exiger qu'il appartienne déjà à un institut (utile pour l'onboarding).
 */
export async function authenticateUserOnly(req: Request): Promise<{ userId: string; email: string }> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";

  if (!token) throw new AuthError("Jeton d'authentification absent.");

  try {
    const { payload } = await jose.jwtVerify(token, getJwtSecret());
    const userId = String(payload.userId ?? "");
    const email = String(payload.email ?? "");

    if (!userId) throw new AuthError("Jeton invalide.");
    return { userId, email };
  } catch (_err) {
    throw new AuthError("Session expirée ou invalide, veuillez vous reconnecter.");
  }
}

export function requireOwner(caller: DashboardCaller): void {
  if (caller.role !== "owner") {
    throw new AuthError("Action réservée au propriétaire du compte.", 403);
  }
}

/** Trace une action sensible dans audit_logs. */
export async function audit(params: {
  caller: DashboardCaller;
  action: string;
  entity: string;
  entityId?: string | null;
}): Promise<void> {
  try {
    await sql`
      insert into audit_logs (tenant_id, actor, action, entity, entity_id)
      values (${params.caller.tenantId}, ${params.caller.userId}, ${params.action}, ${params.entity}, ${params.entityId ?? null});
    `;
  } catch (err) {
    log.warn("audit.insert_failed", { error: String(err) });
  }
}
