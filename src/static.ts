// Serveur de fichiers statiques intégré pour le dashboard et le site vitrine.

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

export async function serveStaticFile(req: Request, pathname: string): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;

  let filePath = pathname;

  // Routage par défaut
  if (filePath === "/" || filePath === "/dashboard" || filePath === "/dashboard/") {
    filePath = "/frontend/dashboard/index.html";
  } else if (filePath.startsWith("/dashboard/")) {
    filePath = `/frontend/dashboard/${filePath.replace("/dashboard/", "")}`;
  } else if (filePath === "/site" || filePath === "/site/") {
    filePath = "/frontend/site/index.html";
  } else if (filePath.startsWith("/site/")) {
    filePath = `/frontend/site/${filePath.replace("/site/", "")}`;
  } else if (filePath.startsWith("/oauth/")) {
    filePath = `/frontend/dashboard${filePath}`;
  } else if (filePath.startsWith("/js/") || filePath.startsWith("/styles.css") || filePath.startsWith("/config.js")) {
    filePath = `/frontend/dashboard${filePath}`;
  } else {
    return null;
  }

  // Protection contre le Directory Traversal
  if (filePath.includes("..")) return null;

  try {
    const rootDir = decodeURIComponent(new URL("../", import.meta.url).pathname);
    let fullPath = `${rootDir.replace(/\/+$/, "")}${filePath}`;

    // Si c'est un dossier, tenter d'ouvrir index.html
    try {
      const stat = await Deno.stat(fullPath);
      if (stat.isDirectory) {
        fullPath = `${fullPath.replace(/\/+$/, "")}/index.html`;
      }
    } catch (_err) {
      // Fichier direct
    }

    const ext = fullPath.substring(fullPath.lastIndexOf(".")).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    const content = await Deno.readFile(fullPath);
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-cache",
      },
    });
  } catch (_err) {
    return null;
  }
}
