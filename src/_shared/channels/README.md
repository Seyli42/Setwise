# Canaux — Instagram DM & WhatsApp Business

Adaptateurs entre les APIs Meta et le moteur d'agent. Chaque canal fournit deux
choses et rien de plus :

1. un **parseur** de webhook → `ParsedInbound[]` ;
2. un **`ChannelSender`** → envoi d'un message texte.

Le moteur (`../agent/engine.ts`) ne connaît ni Instagram ni WhatsApp.

## Chemin d'un message

```
Meta ──POST──▶ webhook-instagram / webhook-whatsapp
                  │ 1. vérifie X-Hub-Signature-256   (HMAC-SHA256, corps brut)
                  │ 2. parse → 1 event par message
                  │ 3. INSERT webhook_events         (unique sur l'id du message)
                  └─▶ 200 EVENT_RECEIVED             (< 100 ms)
                        │
                        └─ tâche de fond ─▶ processQueue()
                                              │ claim atomique (SKIP LOCKED)
                                              │ resolveConnection → tenant
                                              │ runAgentTurn
                                              └─ relais WhatsApp si RDV pris

pg_cron (1 min) ──POST──▶ queue-dispatcher ──▶ processQueue()   (filet de sécurité)
```

## Décisions à connaître

**Le webhook ne traite rien.** Meta considère un webhook en échec au-delà de
~20 s et le rejoue ; un tour d'agent (LLM + calendrier + envoi) peut dépasser ce
budget. On accuse réception immédiatement et on traite derrière. La réactivité
vient de la tâche de fond, pas du cron — le cron n'est qu'un rattrapage.

**Le `tenant_id` ne vient jamais du payload.** Il est lu en base depuis
`channel_connections.external_account_id` (IG account id / WhatsApp
`phone_number_id`), lui-même authentifié par la signature du webhook. Un payload
forgé ne peut pas se faire passer pour un autre institut.

**La signature porte sur le corps brut.** `verifyMetaSignature` reçoit le texte
exact reçu, jamais un JSON re-sérialisé — un test dédié verrouille ce point
(`../meta_test.ts`).

**L'unité de queue est le message, pas la livraison HTTP.**
`webhook_events.external_event_id` porte l'id du message Meta (`mid.*`,
`wamid.*`) : un rejeu du même lot n'insère rien.

**Le fragment de payload conservé est minimal.** Un même appel Meta peut porter
les messages de plusieurs leads ; stocker le corps complet sous chaque message
mélangerait leurs données personnelles dans la même ligne et rendrait le droit à
l'oubli impossible à honorer.

**Ce qui est volontairement ignoré** (aucune erreur, aucune entrée en queue) :

| Cas | Canal | Raison |
|---|---|---|
| `is_echo: true` | Instagram | nos propres messages nous reviennent — sinon l'agent se répond à lui-même |
| `statuses[]` (sent/delivered/read) | WhatsApp | accusés de livraison, pas des messages |
| `type` ≠ `text` | WhatsApp | image/audio/document — traités à l'étape 7 |
| message sans texte | les deux | stickers, pièces jointes seules |
| `field` ≠ `messages` | WhatsApp | mises à jour de compte |

## Fenêtre de 24 h et modèles

Meta n'autorise un message libre que dans les 24 h suivant le dernier message du
client. Deux chemins **séparés**, jamais de bascule implicite :

- `createWhatsAppSender().send()` — message libre, utilisé par le moteur en
  réponse à un message entrant (la fenêtre est donc ouverte par construction) ;
- `sendWhatsAppTemplate()` — modèle approuvé, seul chemin légal pour **ouvrir**
  une conversation (relais depuis Instagram) ou recontacter hors fenêtre
  (rappels, étape 4).

`conversations.messaging_window_expires_at` est mis à jour à chaque message
entrant et sert de source de vérité pour ce choix.

## Relais Instagram → WhatsApp

Déclenché par `EngineResult.bookedAppointmentId` dans `../dispatcher.ts`, pas par
le moteur — c'est ce qui garde le moteur agnostique du canal.

Conditions cumulatives, sinon le relais est simplement sauté (log `relay.skipped`,
jamais d'échec du tour) :

1. le RDV est en statut `confirmed` ;
2. le lead a un téléphone normalisable en E.164 ;
3. le tenant a une connexion WhatsApp active ;
4. `agents.config.whatsapp_confirmation_template` est renseigné.

Le modèle attendu porte trois variables : `{{1}}` prénom, `{{2}}` date et heure
(formatées en `fr-FR` dans le fuseau de l'établissement), `{{3}}` prestation.

## Secrets requis

| Secret | Usage |
|---|---|
| `META_APP_SECRET` | vérification de signature des deux webhooks |
| `META_WEBHOOK_VERIFY_TOKEN` | handshake `hub.verify_token` |
| `META_GRAPH_VERSION` | facultatif, défaut `v21.0` |
| `META_GRAPH_BASE` | facultatif, défaut `https://graph.facebook.com` |
| `QUEUE_BATCH_SIZE` | facultatif, défaut `10` |

Les tokens d'accès par institut ne sont pas des secrets d'environnement : ils
vivent chiffrés dans `channel_connections.access_token_encrypted` (AES-256-GCM,
clé `ENCRYPTION_KEY`).

## Déploiement

```bash
supabase db push
supabase functions deploy webhook-instagram --no-verify-jwt
supabase functions deploy webhook-whatsapp  --no-verify-jwt
supabase functions deploy queue-dispatcher
```

`--no-verify-jwt` est **obligatoire** sur les webhooks : Meta n'envoie pas de JWT
Supabase. L'authentification est assurée par la signature HMAC.

Puis, une fois, en SQL (`postgres`) :

```sql
select setwise_schedule_dispatcher(
  'https://<ref>.supabase.co/functions/v1/queue-dispatcher',
  '<service_role_key>'
);
```

## Tester en isolation

```bash
deno task test    # parseurs + signature, aucun réseau ni base
```

Handshake de vérification :

```bash
curl "http://localhost:54321/functions/v1/webhook-instagram?hub.mode=subscribe&hub.verify_token=$META_WEBHOOK_VERIFY_TOKEN&hub.challenge=42"
# attendu : 42
```

Webhook signé (le corps doit être envoyé octet pour octet) :

```bash
BODY='{"object":"instagram","entry":[{"id":"<IG_ACCOUNT_ID>","messaging":[{"sender":{"id":"IGSID_TEST"},"timestamp":1755264000000,"message":{"mid":"mid.test1","text":"Bonjour"}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -r | cut -d' ' -f1)"
curl -X POST http://localhost:54321/functions/v1/webhook-instagram \
  -H "content-type: application/json" -H "x-hub-signature-256: $SIG" -d "$BODY"
# attendu : EVENT_RECEIVED, puis une ligne dans webhook_events
```

Signature invalide → `401`, rien en queue :

```bash
curl -X POST http://localhost:54321/functions/v1/webhook-instagram \
  -H "content-type: application/json" -H "x-hub-signature-256: sha256=deadbeef" -d "$BODY"
```

## Limites connues

- **Pièces jointes non traitées.** Un lead qui envoie une photo de la zone à
  traiter est ignoré. À router vers une escalade explicite (étape 7).
- **Pas de rafraîchissement automatique des tokens Meta.** `token_expires_at` est
  stocké mais aucun job ne renouvelle les tokens longue durée (étape 7).
- **Migrations non exécutées.** Docker n'était pas disponible pour lancer
  `supabase db reset` : `0002` et `0003` sont relues à la main mais pas
  vérifiées contre un vrai Postgres. À faire avant tout déploiement.
- **La clé service_role apparaît dans `cron.job.command`.** C'est le schéma
  documenté par Supabase pour pg_cron + pg_net ; la table n'est lisible que par
  `postgres`/`supabase_admin`. À migrer vers Supabase Vault si le seuil de
  conformité l'exige.
