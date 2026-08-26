# `_shared` — Moteur d'agent core

Code partagé par toutes les Edge Functions. Aucun module ici n'est un point
d'entrée HTTP : ce sont des briques importées par `webhook-instagram`,
`webhook-whatsapp`, `queue-dispatcher`, etc.

## Rôle

Le moteur exécute un **tour d'agent** : un message entrant, normalisé par un
canal, est qualifié puis répondu — sans que le moteur sache d'où vient le
message ni où part la réponse.

```
message normalisé ──▶ runAgentTurn() ──▶ ChannelSender.send()
                          │
                          ├─ résolution tenant / agent / script / calendrier
                          ├─ dédup + reprise après crash
                          ├─ garde-fous d'escalade
                          └─ boucle LLM ⇄ outils
```

## Fichiers

| Fichier | Rôle |
|---|---|
| `env.ts` | Lecture validée des secrets. Aucun secret en dur, lecture paresseuse. |
| `logger.ts` | Logs JSON structurés avec redaction automatique des clés sensibles. |
| `errors.ts` | Erreurs typées (`retryable` pilote la queue) + `withRetry` backoff+jitter. |
| `crypto.ts` | AES-256-GCM pour les tokens et credentials stockés en base. |
| `supabaseAdmin.ts` | Client `service_role` (bypass RLS) — jamais exposé au front. |
| `llm.ts` | Unique point de contact Anthropic. Modèle, cache, fallbacks, refus. |
| `calendar.ts` | Registre de providers calendrier (Google en MVP, Planity en V2). |
| `types.ts` | Contrats partagés : `NormalizedInboundMessage`, `ChannelSender`, `CalendarProvider`. |
| `notifications.ts` | File d'alertes au gérant : transports e-mail et WhatsApp, claim, backoff. |
| `channels/metaOauth.ts` | Connexion Instagram par OAuth : échange du code, découverte des comptes. |
| `calendar/rrule.ts` | Développement des récurrences RFC 5545, en heure murale locale. |
| `notificationMessage.ts` | Rédaction des alertes. Pur, sans dépendance — donc testable sans secrets. |
| `agent/prompt.ts` | Construit le prompt système depuis la config **en base**. |
| `agent/tools.ts` | Définitions d'outils + dispatcher (qualification, créneaux, RDV, escalade). |
| `agent/memory.ts` | Persistance : conversation, messages, lead, escalade. |
| `agent/engine.ts` | Boucle d'exécution d'un tour. |

## Dépendances externes à configurer

Secrets Edge Function (`supabase secrets set NOM=valeur`) :

| Secret | Obligatoire | Usage |
|---|---|---|
| `SUPABASE_URL` | oui | injecté automatiquement par Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | oui | injecté automatiquement par Supabase |
| `ANTHROPIC_API_KEY` | oui | appels modèle |
| `ENCRYPTION_KEY` | oui | 32 octets base64 — `openssl rand -base64 32` |
| `ANTHROPIC_MODEL` | non | défaut `claude-opus-5` |
| `ANTHROPIC_MAX_TOKENS` | non | défaut `4096` |
| `RESEND_API_KEY` | non\* | alertes d'escalade par e-mail |
| `NOTIFICATION_FROM` | non\* | expéditeur des alertes, domaine vérifié SPF/DKIM |
| `WHATSAPP_ALERT_TEMPLATE` | non\* | modèle approuvé pour l'alerte WhatsApp au gérant |

\* Aucun n'est obligatoire pris isolément, mais **au moins un canal doit
fonctionner**. Sans e-mail ni WhatsApp, les escalades sont marquées `skipped` :
l'agent passe la main et personne n'est prévenu. C'est précisément le défaut que
ce module corrige.

## Décisions à connaître avant de modifier

**Le script de qualification n'est jamais dans le code.** `agent/prompt.ts`
assemble un prompt à partir de `agents.system_prompt_template` et
`qualification_scripts.questions`. Le gérant modifie ces lignes depuis le
dashboard ; le tour suivant utilise la nouvelle version, sans redéploiement.

**Un outil non exposé ne peut pas être halluciné.** Tant qu'aucun provider
calendrier n'est enregistré pour l'établissement, `buildTools()` n'expose ni
`list_available_slots` ni `book_appointment`, et le prompt interdit explicitement
d'annoncer un horaire. L'agent qualifie puis escalade.

**Le rendez-vous est écrit en base avant l'appel calendrier.** `book_appointment`
insère le RDV en `pending`, appelle le provider avec retry, puis passe en
`confirmed`. Si l'appel échoue définitivement, le RDV reste `pending`, une
escalade est ouverte, et le modèle reçoit l'instruction explicite de **ne pas**
confirmer. Aucun rendez-vous ne disparaît en silence.

**Trois chemins d'escalade, dont deux déterministes.**

1. Mot-clé (`qualification_scripts.escalation_keywords`) — testé avant tout appel
   LLM, coût zéro token, ne dépend pas du jugement du modèle.
2. Outil `escalate_to_human` — le modèle décide (question médicale, réclamation…).
3. `stop_reason: "refusal"` ou boucle d'outils non convergente — sécurité.

Dans les trois cas la conversation passe en `escalated` et **plus aucune réponse
automatique n'est produite** aux messages suivants.

**Idempotence.** L'unicité de `messages.external_message_id` est le verrou. Un
webhook rejoué par Meta est ignoré *si* une réponse existe déjà après le message
entrant ; sinon le tour est repris (crash entre l'enregistrement et l'envoi).

## Tester en isolation

Prérequis : `deno` (`brew install deno`). Tâches définies dans `deno.json` à la
racine du projet.

```bash
deno task check   # typage de tous les modules
deno task lint    # règles Deno recommandées
deno task test    # 12 tests : prompt + crypto (aucun secret, aucun réseau)
```

Ce que couvrent les tests actuels :

- `agent/prompt_test.ts` — le prompt reflète bien la config du gérant, marque les
  questions déjà répondues, et n'expose la réservation que si un calendrier est
  connecté ; détection de mots-clés insensible à la casse et aux accents.
- `crypto_test.ts` — aller-retour de chiffrement, IV aléatoire (deux
  chiffrements du même token donnent des ciphertexts différents), rejet d'un
  ciphertext altéré.

Test d'un tour complet contre une base Supabase locale :

```bash
supabase start
supabase db reset               # applique migrations/0001_init.sql
supabase functions serve agent-engine --env-file supabase/.env.local
```

Puis injecter un message normalisé (voir `agent-engine/README.md`, étape 3).

## Limites connues

- **Pas de streaming.** Une réponse DM fait quelques phrases ; le streaming
  n'apporte rien et compliquerait la persistance.
- **Historique tronqué à 40 messages.** Suffisant pour une qualification. Une
  conversation plus longue est un signal d'escalade, pas un cas à optimiser.
- **`loadHistory` ne rejoue pas les appels d'outils des tours passés.** Les
  `tool_use` ne sont pas persistés comme messages : l'état durable vit dans
  `leads.qualification_data` et `appointments`, qui sont réinjectés dans le
  prompt système. Volontaire — l'historique reste lisible dans le dashboard.
- **Fenêtre 24 h Meta** : stockée (`conversations.messaging_window_expires_at`)
  mais exploitée à l'étape 3 (envoi hors fenêtre → template WhatsApp).
