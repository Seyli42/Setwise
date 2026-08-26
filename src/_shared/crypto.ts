// Chiffrement au repos des données sensibles stockées en base :
// tokens d'accès Meta (`channel_connections.access_token_encrypted`) et
// credentials calendrier (`calendar_integrations.credentials_encrypted`).
//
// AES-256-GCM (chiffrement authentifié : une altération du ciphertext est
// détectée au déchiffrement). Clé : secret `ENCRYPTION_KEY`, 32 octets en base64.
// Générer : `openssl rand -base64 32`
//
// Format stocké : base64( iv[12] || ciphertext+tag )

import { requireEnv } from "./env.ts";
import { ValidationError } from "./errors.ts";

const IV_BYTES = 12; // taille recommandée pour GCM
let keyPromise: Promise<CryptoKey> | null = null;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * WebCrypto exige un `BufferSource` adossé à un `ArrayBuffer` (et non à un
 * `SharedArrayBuffer`). Les vues issues de `subarray()` / `getRandomValues()`
 * ne le garantissent pas au niveau des types : on recopie dans un buffer neuf.
 */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function getKey(): Promise<CryptoKey> {
  if (keyPromise) return keyPromise;

  keyPromise = (async () => {
    const raw = base64ToBytes(requireEnv("ENCRYPTION_KEY"));
    if (raw.byteLength !== 32) {
      throw new ValidationError(
        `ENCRYPTION_KEY doit faire 32 octets une fois décodée (reçu ${raw.byteLength}). Générer avec: openssl rand -base64 32`,
      );
    }
    return await crypto.subtle.importKey("raw", toBuffer(raw), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  })();

  return keyPromise;
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBuffer(iv) },
      key,
      toBuffer(new TextEncoder().encode(plaintext)),
    ),
  );

  const packed = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.byteLength);
  return bytesToBase64(packed);
}

export async function decryptSecret(packedBase64: string): Promise<string> {
  const key = await getKey();
  const packed = base64ToBytes(packedBase64);

  if (packed.byteLength <= IV_BYTES) {
    throw new ValidationError("Valeur chiffrée invalide (trop courte pour contenir IV + ciphertext).");
  }

  const iv = packed.subarray(0, IV_BYTES);
  const ciphertext = packed.subarray(IV_BYTES);

  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBuffer(iv) },
      key,
      toBuffer(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch (cause) {
    // Échec = mauvaise clé ou données altérées. On ne loggue jamais le ciphertext.
    throw new ValidationError("Déchiffrement impossible : clé incorrecte ou donnée altérée.", {
      cause: String(cause),
    });
  }
}
