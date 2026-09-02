// Alertes au gérant : escalade ouverte, escalade oubliée (Neon).
//
// Ce module est la contrepartie d'une phrase que l'agent dit à la cliente :
// « je préviens l'institut ». Tant qu'il n'existait pas, cette phrase était un
// mensonge — l'escalade dormait en base jusqu'à ce que quelqu'un ouvre le
// tableau de bord.
//
// Deux transports, indépendants et tous deux facultatifs :
//
//   e-mail    via une API HTTP (Resend par défaut). Universel, mais lu le
//             lendemain matin.
//   WhatsApp  via le compte Business déjà connecté de l'institut, avec un
//             modèle approuvé. C'est celui qui sonne à 23 h.

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { optionalEnv, optionalIntEnv } from "./env.ts";
import { DatabaseError, ExternalApiError, isRetryable, ValidationError } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { findWhatsAppConnection } from "./channels/connection.ts";
import { sendWhatsAppTemplate, toWhatsAppNumber } from "./channels/whatsapp.ts";
import { compose, templateParameters } from "./notificationMessage.ts";

export interface NotificationRun {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  staleQueued: number;
}

interface ClaimedNotification {
  id: string;
  tenant_id: string;
  kind: string;
  subject_id: string;
  channel: "email" | "whatsapp";
  destination: string;
  payload: Record<string, unknown>;
  attempts: number;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

// ============================================================
// Transport e-mail
// ============================================================

async function sendEmail(notification: ClaimedNotification): Promise<void> {
  const apiKey = optionalEnv("RESEND_API_KEY", "");
  const from = optionalEnv("NOTIFICATION_FROM", "");

  if (!apiKey || !from) {
    throw new ValidationError(
      "Canal e-mail non configuré : RESEND_API_KEY et NOTIFICATION_FROM sont requis.",
      { channel: "email" },
    );
  }

  const { subject, body } = compose(notification);

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [notification.destination],
      subject,
      text: body,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new ExternalApiError("resend", "Envoi e-mail refusé", {
      status: response.status,
      context: { detail: detail.slice(0, 500) },
    });
  }
}

// ============================================================
// Transport WhatsApp
// ============================================================

async function sendWhatsApp(notification: ClaimedNotification): Promise<void> {
  const templateName = optionalEnv("WHATSAPP_ALERT_TEMPLATE", "");
  if (!templateName) {
    throw new ValidationError(
      "Canal WhatsApp non configuré : WHATSAPP_ALERT_TEMPLATE est requis.",
      { channel: "whatsapp" },
    );
  }

  const to = toWhatsAppNumber(notification.destination);
  if (!to) {
    throw new ValidationError("Numéro d'alerte inexploitable.", { channel: "whatsapp" });
  }

  const connection = await findWhatsAppConnection(notification.tenant_id, null);
  if (!connection) {
    throw new ValidationError(
      "Aucune connexion WhatsApp active : impossible d'alerter par ce canal.",
      { channel: "whatsapp" },
    );
  }

  await sendWhatsAppTemplate({
    connection,
    to,
    templateName,
    bodyParameters: templateParameters(notification),
  });
}

// ============================================================
// Mise en file depuis le moteur d'agent
// ============================================================

/**
 * UUID déterministe pour (tenant, mois courant). `notifications` exige un
 * `subject_id` non nul et porte l'unicité `(kind, subject_id, channel)` : sans
 * sujet stable, l'avertissement de quota partirait à chaque appel au lieu
 * d'une fois par mois. Aucune ligne réelle ne correspond à cet identifiant —
 * il sert uniquement de clé de déduplication.
 */
async function monthlySubjectId(tenantId: string): Promise<string> {
  const mois = new Date().toISOString().slice(0, 7); // "2026-08"
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`llm_quota:${tenantId}:${mois}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20, 32)
  }`;
}

/**
 * Alerte à 80 % du quota IA mensuel. Réutilise `enqueue_escalation_notification`
 * — générique malgré son nom, elle ne fait qu'insérer dans `notifications`
 * pour les canaux configurés du tenant.
 */
export async function queueQuotaWarning(params: {
  tenantId: string;
  used: number;
  limit: number;
}): Promise<void> {
  const logger = scopedLogger({ tenantId: params.tenantId });
  const subjectId = await monthlySubjectId(params.tenantId);

  try {
    await sql`
      select queued, channels_configured
        from enqueue_escalation_notification(
          ${params.tenantId}::uuid,
          ${subjectId}::uuid,
          'llm_quota_warning',
          ${sql.json({ used: params.used, limit: params.limit })}
        );
    `;
  } catch (error) {
    // Un avertissement manqué n'est pas critique — contrairement à une
    // escalade, aucune cliente n'attend de réponse derrière celui-ci.
    logger.warn("notifications.quota_warning_failed", { error: String(error) });
  }
}

export async function queueEscalationAlert(params: {
  tenantId: string;
  escalationId: string;
  reason: string;
}): Promise<boolean> {
  const logger = scopedLogger({ tenantId: params.tenantId });

  try {
    const res = await sql`
      select queued, channels_configured
        from enqueue_escalation_notification(
          ${params.tenantId}::uuid,
          ${params.escalationId}::uuid,
          'escalation_opened',
          ${sql.json({ reason: params.reason })}
        );
    `;

    const row = res[0] as { queued: number; channels_configured: number } | undefined;

    if (!row || row.channels_configured === 0) {
      logger.warn("notifications.no_channel", { escalationId: params.escalationId });
      return false;
    }

    return row.queued > 0;
  } catch (error) {
    logger.error("notifications.enqueue_failed", {
      escalationId: params.escalationId,
      error: String(error),
    });
    return false;
  }
}

// ============================================================
// Consommation de la file
// ============================================================

export async function deliverPendingNotifications(limit?: number): Promise<NotificationRun> {
  const batch = limit ?? optionalIntEnv("NOTIFICATIONS_BATCH_SIZE", 20);

  let notifications: ClaimedNotification[] = [];
  try {
    const claim = await sql`
      select id, tenant_id, kind, subject_id, channel, destination, payload, attempts
        from claim_notifications(${batch});
    `;
    notifications = claim as unknown as ClaimedNotification[];
  } catch (err) {
    throw new DatabaseError("Claim des alertes échoué", { cause: err });
  }

  const run: NotificationRun = {
    claimed: notifications.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    staleQueued: 0,
  };

  for (const notification of notifications) {
    const logger = scopedLogger({ tenantId: notification.tenant_id });

    try {
      if (notification.channel === "email") {
        await sendEmail(notification);
      } else {
        await sendWhatsApp(notification);
      }

      await sql`select complete_notification(${notification.id}::uuid);`;
      run.sent += 1;
      logger.info("notifications.sent", {
        kind: notification.kind,
        channel: notification.channel,
        attempts: notification.attempts,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        await sql`select skip_notification(${notification.id}::uuid, ${error.message});`;
        run.skipped += 1;
        logger.warn("notifications.skipped", {
          kind: notification.kind,
          channel: notification.channel,
          reason: error.message,
        });
        continue;
      }

      await sql`
        select fail_notification(
          ${notification.id}::uuid,
          ${String(error)},
          ${isRetryable(error)}
        );
      `;
      run.failed += 1;
      logger.error("notifications.failed", {
        kind: notification.kind,
        channel: notification.channel,
        attempts: notification.attempts,
        error: String(error),
      });
    }
  }

  try {
    const stale = await sql`
      select enqueue_stale_escalation_notifications(50) as count;
    `;
    run.staleQueued = Number(stale[0]?.count ?? 0);
  } catch (err) {
    log.error("notifications.stale_scan_failed", { error: String(err) });
  }

  return run;
}
