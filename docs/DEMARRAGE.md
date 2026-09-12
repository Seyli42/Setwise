# Démarrage — comptes, démarches et arbitrages

`DEPLOYMENT.md` suppose que tout ce qui suit existe déjà. Cette page couvre ce
qui se passe **avant** la première commande : les comptes à ouvrir, les
informations à obtenir, les décisions à prendre.

Rien ici ne se code. Tout ici bloque la mise en ligne.

---

## 1. Entreprise

L'éditeur déclaré sur le site est **Ilyes Bouir — EI** (entreprise
individuelle), nom commercial Setwise. Trois informations manquent dans
`frontend/site/mentions-legales.html`, et une dans `confidentialite.html` et
`cgv.html` :

| Information | Où l'obtenir | Pourquoi elle est obligatoire |
|---|---|---|
| Adresse complète | Adresse de l'entreprise déclarée à l'INPI | LCEN art. 6 III |
| SIRET (14 chiffres) | Avis de situation INSEE, sirene.fr | LCEN art. 6 III |
| Téléphone joignable | — | Code de la consommation art. L111-1, vente à distance |

```bash
grep -n "\[" frontend/site/*.html      # doit ne rien renvoyer avant publication
```

**Arbitrage TVA.** Les pages portent `TVA non applicable, article 293 B du CGI`.
Cette mention est obligatoire sous le régime de la franchise en base, et
interdite si l'entreprise est assujettie. Dans ce second cas : supprimer la
mention dans `mentions-legales.html` et `cgv.html`, et renseigner le numéro de
TVA intracommunautaire.

**La mention « EI »** accolée au nom est obligatoire depuis la loi du 14 février
2022. Elle figure déjà sur les trois pages ; ne pas la retirer.

**Relecture juridique.** Les CGV (`cgv.html`) couvrent les clauses usuelles d'un
SaaS B2B français, mais n'ont pas été relues par un professionnel du droit. Le
budget d'une relecture est faible comparé à une clause de limitation de
responsabilité inopposable.

---

## 2. Domaines et hébergement

| Élément | Valeur attendue | Où |
|---|---|---|
| Domaine principal | `setwise.fr` (ou celui retenu) | Registrar |
| Site vitrine | racine du domaine | Hostinger cPanel, statique |
| Dashboard | `dashboard.<domaine>` | Hostinger cPanel, statique |
| Boîtes e-mail | `contact@` et `privacy@` | Hostinger |

Les deux adresses e-mail sont citées dans les mentions légales, les CGV et la
politique de confidentialité. Elles doivent être **relevées** : une demande
d'effacement RGPD non traitée sous un mois est un manquement.

Si le domaine retenu n'est pas `setwise.fr`, remplacer les URL canoniques et les
liens `https://dashboard.setwise.fr` dans les quatre pages de
`frontend/site/`.

---

## 3. Comptes de service

| Service | Ce qu'il faut | Délai réaliste |
|---|---|---|
| Neon | Projet en région **EU** | immédiat |
| DeepSeek (fallback Anthropic) | Clé API, facturation active | immédiat |
| Meta for Developers | Compte développeur, application, **vérification métier** | quelques jours à plusieurs semaines |
| WhatsApp Business | Numéro dédié, modèles soumis à validation | 1 à 3 jours par modèle |
| Google Cloud | Projet, Calendar API, écran de consentement **publié** | quelques jours si vérification demandée |
| Stripe | Compte activé, coordonnées bancaires, trois tarifs mensuels | 1 à 2 jours |
| Resend (ou équivalent) | Clé API, domaine d'envoi vérifié (SPF, DKIM) | quelques heures |

**Le chemin critique est Meta.** La vérification métier et l'approbation des
permissions `instagram_manage_messages` et `whatsapp_business_messaging` sont
les seules étapes qui peuvent prendre des semaines. Les lancer en premier, avant
tout le reste.

**Un domaine d'envoi non vérifié = alertes en spam.** Les alertes d'escalade
partent depuis votre domaine ; sans enregistrements SPF et DKIM, elles
atterrissent en indésirables et le gérant ne les voit jamais.

**Google en mode test expire.** Tant que l'écran de consentement n'est pas
publié, les jetons de rafraîchissement sont invalidés au bout de sept jours et
chaque institut perd son agenda sans prévenir.

---

## 4. Décisions produit à prendre avant le premier client

- **Tarifs.** 25 / 97 / 297 € par mois figurent sur la page d'accueil et
  doivent correspondre exactement aux tarifs créés dans Stripe, puis reportés
  dans la table `plans`.
- **Essai gratuit.** 7 jours sans carte (Light : 0 jour), écrit dans `plans.trial_days`, sur la
  page d'accueil et dans les CGV. Changer la durée impose de changer les trois.
- **Durée de conservation par défaut.** 1095 jours (3 ans depuis le dernier
  contact), conforme à la recommandation CNIL en matière de prospection.
  Modifiable par institut depuis le dashboard.
- **Version des CGV.** La date affichée en haut de `cgv.html` doit être
  identique à `CONFIG.TERMS_VERSION` dans `frontend/dashboard/config.js` :
  c'est elle qui est enregistrée avec chaque acceptation.

---

## 5. Documents à produire hors dépôt

- **DPA signés** avec DeepSeek, Anthropic, Meta, Google, Stripe, Neon et Hostinger.
  Setwise agit comme sous-traitant des instituts ; ces accords sont le maillon
  suivant de la chaîne.
- **Registre des traitements**, obligatoire même pour une entreprise
  individuelle dès lors que le traitement n'est pas occasionnel.
- **Contrat de sous-traitance RGPD** avec chaque institut : la politique de
  confidentialité en tient lieu (article 9 des CGV), mais un institut prudent
  demandera un document dédié.

---

Une fois cette page entièrement cochée, dérouler
[`DEPLOYMENT.md`](DEPLOYMENT.md).
