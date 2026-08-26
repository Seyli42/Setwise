// Connexion des canaux Meta par OAuth, au lieu d'un token collé à la main.
//
// Jusqu'ici, connecter Instagram supposait d'aller chercher un token dans le
// Graph API Explorer. Techniquement correct, commercialement mort : aucune
// gérante d'institut ne franchit cette étape. Ce module fait ce que fait
// n'importe quelle application grand public — un bouton, l'écran de
// consentement Meta, et c'est connecté.
//
// LE CHOIX DES COMPTES SE FAIT DANS L'ÉCRAN META, pas chez nous. Meta affiche
// déjà la liste des pages et laisse cocher celles à autoriser. Redemander
// ensuite « lesquelles voulez-vous ? » serait une seconde question posée pour
// la même décision. On connecte donc ce qui a été accordé, ni plus, ni moins.

import { GRAPH_BASE, GRAPH_VERSION, graphGet } from "../meta.ts";
import { requireEnv } from "../env.ts";
import { ExternalApiError } from "../errors.ts";
import { log } from "../logger.ts";

export interface DiscoveredAsset {
  channel: "instagram" | "whatsapp";
  externalAccountId: string;
  label: string;
  /** Jeton à stocker pour ce compte. Chiffré par l'appelant. */
  accessToken: string;
  expiresAt: string | null;
}

export interface Discovery {
  assets: DiscoveredAsset[];
  /** Ce qui n'a pas pu être découvert, en clair, pour l'afficher au gérant. */
  warnings: string[];
}

/**
 * Échange le `code` de l'écran de consentement contre un jeton utilisateur,
 * puis contre sa version longue durée.
 *
 * `redirect_uri` doit être rigoureusement identique à celle de la demande :
 * Meta compare les deux chaînes et refuse au moindre écart.
 */
export async function exchangeOAuthCode(
  code: string,
  redirectUri: string,
): Promise<{ token: string; expiresAt: string | null }> {
  const params = new URLSearchParams({
    client_id: requireEnv("META_APP_ID"),
    client_secret: requireEnv("META_APP_SECRET"),
    redirect_uri: redirectUri,
    code,
  });

  const response = await fetch(`${GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${params}`);
  const text = await response.text();

  if (!response.ok) {
    // Un code OAuth est à usage unique et expire en quelques minutes : un
    // rejeu ou un aller-retour trop lent tombe ici. Inutile de réessayer.
    throw new ExternalApiError("meta-oauth", `échange du code échoué: ${text.slice(0, 300)}`, {
      status: response.status,
      retryable: false,
    });
  }

  const shortLived = JSON.parse(text) as { access_token: string };

  // Second échange : sans lui le jeton meurt en une à deux heures, et avec lui
  // les jetons de page qui en dérivent.
  const longLivedParams = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: requireEnv("META_APP_ID"),
    client_secret: requireEnv("META_APP_SECRET"),
    fb_exchange_token: shortLived.access_token,
  });

  const longLivedRes = await fetch(
    `${GRAPH_BASE}/${GRAPH_VERSION}/oauth/access_token?${longLivedParams}`,
  );
  const longLivedText = await longLivedRes.text();

  if (!longLivedRes.ok) {
    throw new ExternalApiError(
      "meta-oauth",
      `passage en longue durée échoué: ${longLivedText.slice(0, 300)}`,
      { status: longLivedRes.status, retryable: longLivedRes.status >= 500 },
    );
  }

  const longLived = JSON.parse(longLivedText) as { access_token: string; expires_in?: number };

  return {
    token: longLived.access_token,
    expiresAt: typeof longLived.expires_in === "number"
      ? new Date(Date.now() + longLived.expires_in * 1000).toISOString()
      : null,
  };
}

interface PageNode {
  id: string;
  name?: string;
  access_token?: string;
  instagram_business_account?: { id: string; username?: string };
}

/**
 * Liste les comptes exploitables accordés par l'écran de consentement.
 *
 * Instagram : le jeton stocké est celui de la PAGE, pas celui de
 * l'utilisateur — c'est lui qui autorise `POST /{ig_id}/messages`. Dérivé d'un
 * jeton utilisateur longue durée, il n'expire pas tant que l'autorisation
 * tient ; d'où `expiresAt: null`, que `tokens-cron` laisse tranquille.
 *
 * L'identifiant stocké est celui du compte Instagram professionnel, parce que
 * c'est lui que Meta place dans `entry.id` des webhooks entrants. Stocker
 * l'identifiant de page à la place ferait échouer la résolution du tenant,
 * silencieusement, sur chaque message reçu.
 */
export async function discoverAssets(userToken: string): Promise<Discovery> {
  const warnings: string[] = [];
  const assets: DiscoveredAsset[] = [];

  const pages = await graphGet<{ data?: PageNode[] }>({
    service: "meta-oauth",
    path: "me/accounts",
    accessToken: userToken,
    query: { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "100" },
  });

  for (const page of pages.data ?? []) {
    const instagram = page.instagram_business_account;

    if (!instagram?.id) {
      warnings.push(
        `La page « ${page.name ?? page.id} » n'a aucun compte Instagram professionnel rattaché.`,
      );
      continue;
    }
    if (!page.access_token) {
      warnings.push(`Jeton indisponible pour la page « ${page.name ?? page.id} ».`);
      continue;
    }

    assets.push({
      channel: "instagram",
      externalAccountId: instagram.id,
      label: instagram.username ? `@${instagram.username}` : (page.name ?? instagram.id),
      accessToken: page.access_token,
      expiresAt: null,
    });
  }

  if ((pages.data ?? []).length === 0) {
    warnings.push(
      "Aucune page Facebook accordée. L'agent ne recevra pas les messages Instagram " +
        "tant qu'une page liée au compte professionnel n'est pas autorisée.",
    );
  }

  await discoverWhatsApp(userToken, assets, warnings);

  log.info("meta_oauth.discovered", {
    instagram: assets.filter((a) => a.channel === "instagram").length,
    whatsapp: assets.filter((a) => a.channel === "whatsapp").length,
    warnings: warnings.length,
  });

  return { assets, warnings };
}

/**
 * WhatsApp est facultatif et souvent inaccessible : il exige la permission
 * `whatsapp_business_management` et un compte WhatsApp Business déjà créé.
 * Un échec ici n'invalide pas la connexion Instagram — il devient un
 * avertissement affiché au gérant, qui garde la saisie manuelle.
 */
async function discoverWhatsApp(
  userToken: string,
  assets: DiscoveredAsset[],
  warnings: string[],
): Promise<void> {
  try {
    const businesses = await graphGet<{ data?: Array<{ id: string; name?: string }> }>({
      service: "meta-oauth",
      path: "me/businesses",
      accessToken: userToken,
      query: { fields: "id,name", limit: "50" },
    });

    for (const business of businesses.data ?? []) {
      const wabas = await graphGet<{ data?: Array<{ id: string; name?: string }> }>({
        service: "meta-oauth",
        path: `${business.id}/owned_whatsapp_business_accounts`,
        accessToken: userToken,
        query: { fields: "id,name", limit: "50" },
      });

      for (const waba of wabas.data ?? []) {
        const numbers = await graphGet<
          { data?: Array<{ id: string; display_phone_number?: string; verified_name?: string }> }
        >({
          service: "meta-oauth",
          path: `${waba.id}/phone_numbers`,
          accessToken: userToken,
          query: { fields: "id,display_phone_number,verified_name", limit: "50" },
        });

        for (const number of numbers.data ?? []) {
          assets.push({
            channel: "whatsapp",
            externalAccountId: number.id,
            label: number.display_phone_number ?? number.verified_name ?? number.id,
            accessToken: userToken,
            expiresAt: null,
          });
        }
      }
    }
  } catch (error) {
    warnings.push(
      "Compte WhatsApp Business non détecté automatiquement — connectez-le à la main " +
        "avec son Phone Number ID.",
    );
    log.warn("meta_oauth.whatsapp_discovery_failed", { error: String(error) });
  }
}
