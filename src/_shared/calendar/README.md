# Calendrier — disponibilités et prise de rendez-vous

Découpage volontaire en deux couches :

| Fichier | Réseau ? | Rôle |
|---|---|---|
| `timezone.ts` | non | conversions heure locale ⇄ UTC via `Intl` (tzdata) |
| `slots.ts` | non | horaires d'ouverture, durées, prévenance, soustraction des plages occupées |
| `google.ts` | **oui** | OAuth, `freeBusy`, `events.insert`, `events.delete` |

Toute la logique métier est dans les deux premiers, donc testée exhaustivement
(`calendar_test.ts`, 25 tests). Le provider n'apporte que les plages occupées et
l'écriture de l'événement.

## Configuration par institut

Stockée dans `agents.config.scheduling`, modifiable depuis le dashboard sans
redéploiement. Tous les champs sont facultatifs — une valeur absente ou invalide
retombe sur un défaut plutôt que de casser la prise de RDV de l'institut.

```json
{
  "scheduling": {
    "business_hours": {
      "mon": [["09:00", "12:00"], ["14:00", "19:00"]],
      "tue": [["09:00", "19:00"]],
      "wed": [["09:00", "19:00"]],
      "thu": [["09:00", "19:00"]],
      "fri": [["09:00", "19:00"]],
      "sat": [["09:00", "18:00"]],
      "sun": []
    },
    "services": [
      { "name": "Épilation laser jambes entières", "duration_min": 45 },
      { "name": "Épilation laser aisselles", "duration_min": 20 },
      { "name": "Soin du visage", "duration_min": 75 }
    ],
    "default_duration_min": 60,
    "slot_granularity_min": 30,
    "min_notice_hours": 4,
    "max_days_ahead": 14
  },
  "whatsapp_confirmation_template": "setwise_confirmation_rdv",
  "whatsapp_reminder_template": "setwise_rappel_rdv",
  "handoff_message": "Je transmets à l'équipe, on revient vers vous très vite."
}
```

Les horaires sont en **heure locale de l'établissement** (`locations.timezone`,
sinon `tenants.timezone`).

### Correspondance prestation → durée

Le lead écrit rarement le libellé exact du catalogue. Trois passes, de la plus
sûre à la plus permissive :

1. **libellé identique** ;
2. **un libellé est contenu dans ce qu'a écrit le lead** → le plus long gagne
   (il exploite le plus d'information fournie) ;
3. **ce qu'a écrit le lead est contenu dans un libellé** → le plus **court**
   gagne (allonger reviendrait à supposer une prestation non demandée).

L'inversion entre 2 et 3 est le point sensible : sans elle, « épilation laser »
hériterait des 45 min de « épilation laser jambes entières » et l'institut
bloquerait 45 min d'agenda pour une prestation de 30. Un test de régression
verrouille ce cas.

## Fuseaux horaires

Deno n'embarque pas de bibliothèque de dates : les conversions passent par
`Intl.DateTimeFormat`, qui connaît tzdata.

`zonedTimeToUtc` fait **deux passes** — le décalage dépend de l'instant, qu'on ne
connaît pas encore. Cas couverts par les tests :

| Cas | Résultat |
|---|---|
| 9 h à Paris en hiver | `08:00Z` (CET, UTC+1) |
| 9 h à Paris en été | `07:00Z` (CEST, UTC+2) |
| 29 mars 2026, 01:30 / 03:00 | `00:30Z` / `01:00Z` (de part et d'autre de la bascule) |
| 29 mars 2026, 02:30 (heure inexistante) | décalé à 03:30 locale, jamais d'exception |
| jour de bascule dans une plage de dates | aucune journée sautée |

## Idempotence de la réservation

`book_appointment` écrit le RDV en base **avant** l'appel Google, et passe son
UUID comme `idempotencyKey`. Google accepte un identifiant d'événement fourni par
le client (alphabet base32hex : `0-9a-v`) — un UUID hexadécimal sans tirets y
entre directement.

Conséquence : un retry après timeout renvoie **409** au lieu de créer un second
événement dans l'agenda de l'institut. Le 409 est traité comme un succès.

Si l'appel échoue définitivement (3 tentatives), le RDV reste en `pending`, une
escalade est ouverte, et le modèle reçoit l'instruction explicite de **ne pas**
confirmer au lead.

## Connexion Google d'un institut

Une seule application Google Cloud pour Setwise, un refresh token par institut.

1. Console Google Cloud → activer **Google Calendar API**.
2. Écran de consentement OAuth, scope `https://www.googleapis.com/auth/calendar.events`
   (+ `calendar.readonly` pour `freeBusy`).
3. Identifiants OAuth « Application Web » → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Le gérant autorise depuis le dashboard (étape 5) avec `access_type=offline`
   et `prompt=consent` — sans ces deux paramètres Google ne renvoie **pas** de
   refresh token.
5. Le refresh token est chiffré (AES-256-GCM) et stocké dans
   `calendar_integrations.credentials_encrypted` sous la forme :

```json
{ "refresh_token": "1//0g..." }
```

`calendar_external_id` est l'identifiant de l'agenda (`primary`, ou l'adresse
`...@group.calendar.google.com` d'un agenda dédié).

**Révocation.** Si l'institut révoque l'accès, Google renvoie `invalid_grant` :
l'erreur est marquée non réessayable, l'outil échoue proprement et l'agent
escalade au lieu de boucler.

## Rappels J-1

`../reminders.ts` + `../../reminders-cron/`, planifiés toutes les heures.

- Fenêtre : rendez-vous démarrant dans **22 h à 26 h** — assez large pour
  encaisser une exécution manquée.
- `claim_appointment_reminders` pose `reminder_sent_at` **dans la requête de
  sélection** : deux exécutions concurrentes ne peuvent pas doubler l'envoi.
- Si l'envoi échoue, `release_appointment_reminder` remet le champ à `null` et
  l'heure suivante retente. Réserver d'abord protège du doublon, relâcher
  ensuite protège de l'oubli.
- Un lead supprimé entre la prise de RDV et le rappel est ignoré (droit à l'oubli).

## Secrets

| Secret | Obligatoire | Usage |
|---|---|---|
| `GOOGLE_CLIENT_ID` | oui | rafraîchissement des jetons |
| `GOOGLE_CLIENT_SECRET` | oui | idem |
| `REMINDERS_BATCH_SIZE` | non | défaut `50` |

## Déploiement

```bash
supabase db push
supabase functions deploy reminders-cron
```

Puis, une fois, en SQL (`postgres`) :

```sql
select setwise_schedule_reminders(
  'https://<ref>.supabase.co/functions/v1/reminders-cron',
  '<service_role_key>'
);
```

## Tester en isolation

```bash
deno test --allow-env supabase/functions/_shared/calendar/calendar_test.ts
```

## Limites connues

- **`freeBusy` sur un seul agenda.** Un institut avec une praticienne par agenda
  verra les créneaux d'un seul. L'API accepte plusieurs `items` : à étendre quand
  le besoin se présentera.
- **Pas de gestion de la capacité.** Deux leads peuvent se voir proposer le même
  créneau simultanément ; le second `book_appointment` créera un événement
  superposé. Google ne verrouille pas. À traiter par un re-`freeBusy` juste avant
  l'insertion si le volume le justifie.
- **Récurrences ICS : parties rares non gérées.** `BYSETPOS`, `BYWEEKNO`,
  `BYYEARDAY` sont ignorés lors du développement. Conséquence assumée : la
  règle produit plus d'occurrences que la réalité, donc des créneaux libres
  bloqués à tort. Le sens de l'erreur est délibéré — perdre un rendez-vous
  possible coûte moins cher que d'en placer deux au même moment. Voir
  `rrule.ts`.
- **`cancelEvent` implémenté mais pas encore appelé** — annulations et no-shows
  sont l'étape 7.
- **Migrations 0002–0004 non exécutées** contre un Postgres réel (Docker
  indisponible). Relues à la main. `supabase db reset` requis avant déploiement.
