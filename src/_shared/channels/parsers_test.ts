// Tests des parseurs de webhooks Meta. Aucun réseau, aucune base.
// Lancer : deno test --allow-env supabase/functions/_shared/channels/parsers_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { parseInstagramWebhook } from "./instagram.ts";
import { parseWhatsAppWebhook, toWhatsAppNumber } from "./whatsapp.ts";

// ============================================================
// Instagram
// ============================================================

const igMessage = (overrides: Record<string, unknown> = {}) => ({
  object: "instagram",
  entry: [{
    id: "17841400000000000",
    time: 1755264000000,
    messaging: [{
      sender: { id: "IGSID_LEAD_1" },
      recipient: { id: "17841400000000000" },
      timestamp: 1755264000000,
      message: { mid: "mid.abc123", text: "Bonjour, je voudrais un devis laser", ...overrides },
    }],
  }],
});

Deno.test("Instagram : extrait un message texte", () => {
  const parsed = parseInstagramWebhook(igMessage());
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].event.channel, "instagram");
  assertEquals(parsed[0].event.externalAccountId, "17841400000000000");
  assertEquals(parsed[0].event.externalContactId, "IGSID_LEAD_1");
  assertEquals(parsed[0].event.externalMessageId, "mid.abc123");
  assertEquals(parsed[0].event.text, "Bonjour, je voudrais un devis laser");
});

Deno.test("Instagram : ignore nos propres messages (is_echo)", () => {
  // Sans ce filtre l'agent se répondrait à lui-même en boucle.
  assertEquals(parseInstagramWebhook(igMessage({ is_echo: true })).length, 0);
});

Deno.test("Instagram : une pièce jointe remonte comme non exploitable", () => {
  // Cas très courant en esthétique : le lead envoie la photo de la zone à
  // traiter. L'ignorer laissait le lead sans réponse, sans que l'institut
  // le sache.
  const payload = igMessage();
  // deno-lint-ignore no-explicit-any
  delete (payload.entry[0].messaging[0].message as any).text;
  // deno-lint-ignore no-explicit-any
  (payload.entry[0].messaging[0].message as any).attachments = [{ type: "image" }];

  const parsed = parseInstagramWebhook(payload);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].event.kind, "unsupported");
  assertEquals(parsed[0].event.unsupportedType, "image");
});

Deno.test("Instagram : ni texte ni pièce jointe = rien à traiter", () => {
  // Accusé de lecture, réaction : aucun contenu, aucune escalade à ouvrir.
  const payload = igMessage();
  // deno-lint-ignore no-explicit-any
  delete (payload.entry[0].messaging[0].message as any).text;
  assertEquals(parseInstagramWebhook(payload).length, 0);
});

Deno.test("Instagram : un message texte est marqué comme exploitable", () => {
  assertEquals(parseInstagramWebhook(igMessage())[0].event.kind, "text");
});

Deno.test("Instagram : ignore un payload d'un autre objet", () => {
  assertEquals(parseInstagramWebhook({ object: "page", entry: [] }).length, 0);
});

Deno.test("Instagram : le fragment conservé ne contient que le message concerné", () => {
  const payload = igMessage();
  payload.entry[0].messaging.push({
    sender: { id: "IGSID_LEAD_2" },
    recipient: { id: "17841400000000000" },
    timestamp: 1755264000001,
    message: { mid: "mid.def456", text: "Autre lead" },
  });

  const parsed = parseInstagramWebhook(payload);
  assertEquals(parsed.length, 2);
  assertEquals(JSON.stringify(parsed[0].raw).includes("Autre lead"), false);
  assertEquals(JSON.stringify(parsed[1].raw).includes("devis laser"), false);
});

// ============================================================
// WhatsApp
// ============================================================

const waMessage = (value: Record<string, unknown> = {}) => ({
  object: "whatsapp_business_account",
  entry: [{
    id: "WABA_1",
    changes: [{
      field: "messages",
      value: {
        messaging_product: "whatsapp",
        metadata: { display_phone_number: "33600000000", phone_number_id: "PNID_1" },
        contacts: [{ profile: { name: "Camille Durand" }, wa_id: "33612345678" }],
        messages: [{
          from: "33612345678",
          id: "wamid.HBg",
          timestamp: "1755264000",
          type: "text",
          text: { body: "Bonjour, vous avez de la place samedi ?" },
        }],
        ...value,
      },
    }],
  }],
});

Deno.test("WhatsApp : extrait un message texte avec le nom de profil", () => {
  const parsed = parseWhatsAppWebhook(waMessage());
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0].event.externalAccountId, "PNID_1");
  assertEquals(parsed[0].event.externalContactId, "33612345678");
  assertEquals(parsed[0].event.externalMessageId, "wamid.HBg");
  assertEquals(parsed[0].event.contactDisplayName, "Camille Durand");
  assertEquals(parsed[0].event.receivedAt, new Date(1755264000 * 1000).toISOString());
});

Deno.test("WhatsApp : ignore les mises à jour de statut (sent/delivered/read)", () => {
  // Elles arrivent sur le même webhook et ne portent pas de `messages`.
  const payload = waMessage();
  // deno-lint-ignore no-explicit-any
  delete (payload.entry[0].changes[0].value as any).messages;
  // deno-lint-ignore no-explicit-any
  (payload.entry[0].changes[0].value as any).statuses = [{ id: "wamid.X", status: "delivered" }];
  assertEquals(parseWhatsAppWebhook(payload).length, 0);
});

Deno.test("WhatsApp : les types non textuels remontent comme non exploitables", () => {
  for (const type of ["image", "audio", "document", "location", "video"]) {
    const parsed = parseWhatsAppWebhook(waMessage({
      messages: [{ from: "33612345678", id: `wamid.${type}`, timestamp: "1755264000", type }],
    }));

    assertEquals(parsed.length, 1, `type non remonté : ${type}`);
    assertEquals(parsed[0].event.kind, "unsupported");
    assertEquals(parsed[0].event.unsupportedType, type);
    // Le texte reste vide : le moteur s'appuie sur `kind`, pas sur le contenu.
    assertEquals(parsed[0].event.text, "");
  }
});

Deno.test("WhatsApp : un message texte est marqué comme exploitable", () => {
  const parsed = parseWhatsAppWebhook(waMessage());
  assertEquals(parsed[0].event.kind, "text");
  assertEquals(parsed[0].event.unsupportedType, undefined);
});

Deno.test("WhatsApp : un message texte vide est écarté", () => {
  const parsed = parseWhatsAppWebhook(waMessage({
    messages: [{
      from: "33612345678",
      id: "wamid.EMPTY",
      timestamp: "1755264000",
      type: "text",
      text: { body: "   " },
    }],
  }));
  assertEquals(parsed.length, 0);
});

Deno.test("WhatsApp : ignore un champ autre que `messages`", () => {
  const payload = waMessage();
  payload.entry[0].changes[0].field = "account_update";
  assertEquals(parseWhatsAppWebhook(payload).length, 0);
});

// ============================================================
// Normalisation de numéro
// ============================================================

Deno.test("toWhatsAppNumber normalise les formats français courants", () => {
  assertEquals(toWhatsAppNumber("06 12 34 56 78"), "33612345678");
  assertEquals(toWhatsAppNumber("+33 6 12 34 56 78"), "33612345678");
  assertEquals(toWhatsAppNumber("0033612345678"), "33612345678");
  assertEquals(toWhatsAppNumber("33612345678"), "33612345678");
});

Deno.test("toWhatsAppNumber rejette ce qui n'est pas un numéro", () => {
  assertEquals(toWhatsAppNumber("je ne sais pas"), null);
  assertEquals(toWhatsAppNumber("06 12"), null);
  assertEquals(toWhatsAppNumber(""), null);
});
