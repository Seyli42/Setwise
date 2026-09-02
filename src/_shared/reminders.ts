// Rappels de rendez-vous J-1 (Neon).
//
// Le no-show est le poste de perte n°1 d'un institut : un rappel la veille le
// réduit nettement. Passe obligatoirement par un modèle WhatsApp approuvé — la
// fenêtre de 24 h est fermée depuis longtemps au moment du rappel.

import { sqlWorker as sql } from "../db.ts"; // rôle système : BYPASSRLS, hors RLS
import { DatabaseError } from "./errors.ts";
import { log, scopedLogger } from "./logger.ts";
import { resolveAgentContext } from "./agent/memory.ts";
import { findWhatsAppConnection } from "./channels/connection.ts";
import { sendWhatsAppTemplate, toWhatsAppNumber } from "./channels/whatsapp.ts";
import { formatFrench } from "./calendar/timezone.ts";

export interface ReminderRun {
  claimed: number;
  sent: number;
  skipped: number;
  released: number;
}

interface ClaimedAppointment {
  id: string;
  tenant_id: string;
  location_id: string | null;
  lead_id: string | null;
  starts_at: string;
  service_type: string | null;
}

export async function sendDueReminders(limit = 50): Promise<ReminderRun> {
  let appointments: ClaimedAppointment[] = [];
  try {
    const rows = await sql`
      select id, tenant_id, location_id, lead_id, starts_at, service_type
        from claim_appointment_reminders(${limit});
    `;
    appointments = rows as unknown as ClaimedAppointment[];
  } catch (err) {
    throw new DatabaseError("Claim des rappels échoué", { cause: err });
  }

  const run: ReminderRun = { claimed: appointments.length, sent: 0, skipped: 0, released: 0 };

  for (const appointment of appointments) {
    const logger = scopedLogger({
      tenantId: appointment.tenant_id,
      appointmentId: appointment.id,
    });

    try {
      const outcome = await sendReminder(appointment, logger);
      if (outcome === "sent") run.sent++;
      else run.skipped++;
    } catch (error) {
      logger.error("reminder.failed", { error: String(error) });
      try {
        await sql`select release_appointment_reminder(${appointment.id}::uuid);`;
      } catch (_err) {
        // Non bloquant
      }
      run.released++;
    }
  }

  log.info("reminders.run", { ...run });
  return run;
}

async function sendReminder(
  appointment: ClaimedAppointment,
  logger: ReturnType<typeof scopedLogger>,
): Promise<"sent" | "skipped"> {
  if (!appointment.lead_id) {
    logger.info("reminder.skipped", { reason: "rendez-vous sans lead" });
    return "skipped";
  }

  const leadRows = await sql`
    select full_name, phone, deleted_at
      from leads
     where id = ${appointment.lead_id}::uuid
     limit 1;
  `;

  if (leadRows.length === 0) {
    logger.info("reminder.skipped", { reason: "lead introuvable" });
    return "skipped";
  }

  const lead = leadRows[0];

  // Droit à l'oubli exercé entre la prise de RDV et le rappel : on n'écrit plus.
  if (lead.deleted_at) {
    logger.info("reminder.skipped", { reason: "lead supprimé" });
    return "skipped";
  }

  const phone = lead.phone ? toWhatsAppNumber(lead.phone) : null;
  if (!phone) {
    logger.info("reminder.skipped", { reason: "numéro absent ou invalide" });
    return "skipped";
  }

  const connection = await findWhatsAppConnection(appointment.tenant_id, appointment.location_id);
  if (!connection) {
    logger.info("reminder.skipped", { reason: "aucune connexion WhatsApp active" });
    return "skipped";
  }

  const agent = await resolveAgentContext(appointment.tenant_id, appointment.location_id);
  const templateName = typeof agent.agentConfig["whatsapp_reminder_template"] === "string"
    ? agent.agentConfig["whatsapp_reminder_template"] as string
    : "";

  if (!templateName) {
    logger.info("reminder.skipped", { reason: "aucun modèle de rappel configuré" });
    return "skipped";
  }

  const firstName = (lead.full_name ?? "").trim().split(/\s+/)[0] || "Bonjour";
  const whenLabel = formatFrench(new Date(appointment.starts_at), agent.timezone);

  await sendWhatsAppTemplate({
    connection,
    to: phone,
    templateName,
    languageCode: "fr",
    bodyParameters: [firstName, whenLabel, appointment.service_type ?? "votre soin"],
  });

  logger.info("reminder.sent", { template: templateName, startsAt: appointment.starts_at });
  return "sent";
}
