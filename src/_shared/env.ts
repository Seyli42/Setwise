// Accès centralisé aux secrets. Aucune valeur en dur : tout vient des secrets
// Edge Function (`supabase secrets set`). Lecture paresseuse pour qu'une fonction
// qui n'a pas besoin d'un secret ne plante pas au démarrage s'il est absent.

const cache = new Map<string, string>();

export function requireEnv(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const value = Deno.env.get(name);
  if (!value || value.trim() === "") {
    throw new Error(
      `Variable d'environnement manquante : ${name}. Définissez-la dans votre fichier .env ou vos variables d'environnement.`,
    );
  }
  cache.set(name, value);
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = Deno.env.get(name);
  return value && value.trim() !== "" ? value : fallback;
}

export function optionalIntEnv(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
