import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

/**
 * Previewing a page while the agent builds it. Capella has no browser of its own; it opens the editor's built-in one on a URL. Two
 * helpers: the local addresses a dev server prints, and a small read-only static server for a folder (so a static landing page can be
 * seen without any server of the project's own). The static server binds to 127.0.0.1 only, answers GET and HEAD only, only for its
 * own host name (DNS rebinding), never leaves the folder (not by `..`, encoding, backslashes or links) and never serves dotfiles.
 */

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d{2,5}(?:\/[^\s"'<>)\]]*)?/g;

/** Local http(s) addresses in some output (a dev server's banner), once each, in order of appearance. Trailing punctuation is not part of a URL. */
export function extractLocalUrls(text: string): string[] {
  const seen: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:]+$/, "");
    if (!seen.includes(url)) seen.push(url);
  }
  return seen;
}

/** Whether an address may be opened in the preview: http or https. Nothing else (no file:, javascript:, data:, custom schemes). */
export function isPreviewableUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

export interface PreviewServer {
  /** `http://127.0.0.1:<port>/`. */
  baseUrl: string;
  close: () => Promise<void>;
}

function reply(res: import("node:http").ServerResponse, status: number, body = ""): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}

/** Serves `folder` read-only on a free port of 127.0.0.1. */
export async function startPreviewServer(folder: string): Promise<PreviewServer> {
  const root = await realpath(resolve(folder));
  let port = 0;
  const server: Server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Method not allowed");
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return reply(res, 403, "Forbidden host");
      // The raw request path, not a parsed URL: "//host/x" would parse as a different host and a path of "/".
      const rawPath = (req.url ?? "/").split(/[?#]/)[0] ?? "/";
      if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return reply(res, 400, "Bad request");
      let pathname: string;
      try {
        pathname = decodeURIComponent(rawPath);
      } catch {
        return reply(res, 400, "Bad request");
      }
      if (pathname.includes("\0") || pathname.includes("\\")) return reply(res, 400, "Bad request");
      const parts = pathname.split("/").filter((p) => p !== "");
      if (parts.some((p) => p === ".." || p.startsWith("."))) return reply(res, parts.some((p) => p === "..") ? 403 : 404, "Not found");
      let target = join(root, ...parts);
      if (pathname.endsWith("/") || parts.length === 0) target = join(target, "index.html");
      const real = await realpath(target).catch(() => undefined);
      if (!real) return reply(res, 404, "Not found");
      if (real !== root && !real.startsWith(root + sep)) return reply(res, 403, "Forbidden");
      const info = await stat(real);
      if (!info.isFile()) return reply(res, 404, "Not found");
      res.writeHead(200, { "Content-Type": TYPES[extname(real).toLowerCase()] ?? "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      if (req.method === "HEAD") return void res.end();
      createReadStream(real).on("error", () => res.destroy()).pipe(res);
    } catch {
      reply(res, 500, "Error");
    }
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
