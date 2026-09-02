// Routes d'authentification autonome Magic Link pour Neon.

import {
  authenticateUserOnly,
  sendMagicLink,
  verifyMagicLink,
} from "../auth.ts";
import { sqlWorker } from "../db.ts";
// Rôle système : `handleGetMe` RÉSOUT le tenant à partir du user_id du
// jeton — aucun `app.tenant_id` n'existe encore à ce stade, la requête ne
// peut donc pas passer par `withTenant`.
import { ValidationError } from "../_shared/errors.ts";
import { clientIp, enforceRateLimit, RateLimitError } from "../_shared/rateLimit.ts";

// Réponse renvoyée telle quelle, qu'un lien parte réellement ou non. La
// route ne doit JAMAIS laisser deviner, par son statut ou son message, si une
// adresse a déjà reçu plusieurs demandes récemment.
const MAGIC_LINK_SUCCESS = {
  ok: true,
  message: "Lien envoyé. Ouvrez votre boîte mail depuis cet appareil.",
};

export async function handleSendMagicLink(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const body = await req.json().catch(() => ({}));
  const email = String(body.email ?? "").trim();
  if (!email) throw new ValidationError("Adresse e-mail requise.");

  const normalizedEmail = email.toLowerCase();

  // Plafond par IP : protège contre un flot depuis une seule source, quelle
  // que soit l'adresse ciblée. Échec FERMÉ — cette route envoie un vrai
  // e-mail à chaque appel réussi, elle ne doit jamais s'ouvrir sur une panne
  // du compteur.
  await enforceRateLimit({
    bucket: `magic_link:ip:${clientIp(req)}`,
    limit: 10,
    windowSeconds: 3600,
    failClosed: true,
  });

  // Plafond par adresse : un dépassement répond EXACTEMENT comme un succès —
  // même statut, même message, aucun envoi. Renvoyer un 429 ici distinguerait
  // "cette adresse a déjà été sollicitée plusieurs fois" de "première
  // demande", une fuite sur l'activité liée à un compte précis.
  try {
    await enforceRateLimit({
      bucket: `magic_link:email:${normalizedEmail}`,
      limit: 3,
      windowSeconds: 15 * 60,
      failClosed: true,
    });
  } catch (error) {
    if (error instanceof RateLimitError) return Response.json(MAGIC_LINK_SUCCESS);
    throw error;
  }

  // L'origine de la requête n'est PAS transmise telle quelle : `sendMagicLink`
  // ne la retient que si elle figure dans l'allowlist de configuration,
  // sinon elle retombe sur l'origine canonique. Voir `resolveOrigin` dans
  // `src/auth.ts` pour le détail de la faille que ce choix corrige.
  const requestedOrigin = req.headers.get("origin");
  const result = await sendMagicLink(email, requestedOrigin);
  return Response.json(result);
}

export async function handleVerifyMagicLink(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  // Plafond par IP : ralentit un essai exhaustif de jetons. Échec OUVERT —
  // contrairement à l'envoi d'e-mail, laisser passer sur panne du compteur ne
  // crée aucun coût ; le jeton lui-même reste la protection de fond.
  await enforceRateLimit({
    bucket: `magic_link_verify:ip:${clientIp(req)}`,
    limit: 20,
    windowSeconds: 3600,
  });

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

  // tenant-ok: cette requête RÉSOUT le tenant à partir du user_id du jeton —
  // aucun tenant n'existe encore à ce stade. Rôle système (voir l'en-tête).
  const memberships = await sqlWorker`
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
