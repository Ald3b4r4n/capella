/**
 * The "browser" preset: Microsoft's Playwright MCP server (`@playwright/mcp`), added as an ordinary MCP server so that an
 * agent can open a page, look at it, click and take a screenshot. Pure helpers, unit-tested; the installation and the
 * questions are in `mcpManager.ts`.
 *
 * What was measured (Playwright MCP 0.0.83 with opencode 2.2.5 and Edge, headless, `--isolated`): the agent opened a local
 * page, clicked a button and read the new heading; with `--allowed-origins` limited to localhost an outside site failed with
 * `net::ERR_BLOCKED_BY_CLIENT`. The package says that filter "does not serve as a security boundary and does not affect
 * redirects", and Capella says the same in its question.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/** Pinned: the version that was tested, and old enough (more than two weeks) to have been seen by others. Updating it is a decision, not a side effect. */
export const PLAYWRIGHT_MCP_VERSION = "0.0.83";

export type BrowserScope = "local" | "web";
export type BrowserChannel = "msedge" | "chrome";

/** Only this computer: the browser may load pages served from here. */
export const LOCAL_ORIGINS = "http://127.0.0.1:*;http://localhost:*;http://[::1]:*";

/** The installed browser Playwright can drive without downloading one: Edge, else Chrome on Windows; Chrome elsewhere. Undefined when neither is installed. */
export function browserChannel(platform: string, exists: (path: string) => boolean, env: Record<string, string | undefined> = process.env): BrowserChannel | undefined {
  if (platform === "win32") {
    const roots = [env["ProgramFiles"], env["ProgramFiles(x86)"], env["LOCALAPPDATA"]].filter((r): r is string => !!r);
    const has = (rel: string) => roots.some((root) => exists(`${root}\\${rel}`));
    if (has("Microsoft\\Edge\\Application\\msedge.exe")) return "msedge";
    if (has("Google\\Chrome\\Application\\chrome.exe")) return "chrome";
    return undefined;
  }
  if (platform === "darwin") return exists("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") ? "chrome" : undefined;
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/opt/google/chrome/chrome"].some(exists) ? "chrome" : undefined;
}

/**
 * The command that starts the server: node, the installed package's CLI and the options. An isolated profile (in memory: no
 * cookies, no logins, nothing kept), headless, service workers blocked, `file:` pages not reachable (the package's default),
 * screenshots written to a folder Capella owns.
 */
export function browserCommand(cli: string, channel: BrowserChannel, scope: BrowserScope, outDir: string): string[] {
  return ["node", cli, "--browser", channel, "--isolated", "--headless", "--block-service-workers", ...(scope === "local" ? ["--allowed-origins", LOCAL_ORIGINS] : []), "--output-dir", outDir];
}

/** Whether `path` is `dir` or inside it. */
const within = (path: string, dir: string): boolean => {
  const base = (dir.endsWith(sep) ? dir : dir + sep).toLowerCase();
  return (path + sep).toLowerCase().startsWith(base);
};

/**
 * The picture files a tool result says the server saved. The server names one by an absolute path, or relative to the project
 * folder it works from (measured: `./shot.png` for a name the model chose, which lands in the project, and `..\\out\\page-1.png` for
 * the one it names itself, which lands in `outDir`). Every candidate is resolved and kept only when the file exists and is
 * inside `outDir` or the project folder, so a name written by a page or a model cannot point anywhere else, and nothing is
 * read here: the picture itself is checked and read by the host, which accepts only real PNG, JPEG, GIF and WebP bytes.
 * The result may be JSON, whose backslashes are doubled.
 */
export function imagePathsIn(text: string, outDir: string, projectRoot: string, exists: (path: string) => boolean = existsSync, limit = 4): string[] {
  const found = absolutePathsIn(text, outDir, limit).filter(exists);
  const flat = text.split("\\\\").join("\\");
  // what was found as an absolute path is not read again as pieces of relative ones (a folder name with a space in it)
  let rest = flat;
  for (const p of found) rest = rest.split(p).join(" ");
  for (const token of rest.match(/[^\s"'()<>|*?[\]]+\.(?:png|jpe?g|webp)(?![\w.-])/gi) ?? []) {
    if (found.length >= limit) break;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || isAbsolute(token)) continue;
    for (const base of [projectRoot, outDir]) {
      const full = resolve(base, token);
      if ((within(full, outDir) || within(full, projectRoot)) && exists(full)) {
        if (!found.some((p) => p.toLowerCase() === full.toLowerCase())) found.push(full);
        break;
      }
    }
  }
  return found;
}

function absolutePathsIn(text: string, outDir: string, limit: number): string[] {
  const flat = text.split("\\\\").join("\\");
  const norm = (p: string) => p.split("/").join("\\").toLowerCase();
  const haystack = norm(flat);
  const needle = norm(outDir);
  const found: string[] = [];
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    const match = /^[^\n\r"'<>|*?]*?\.(?:png|jpe?g|webp)(?![\w.-])/i.exec(flat.slice(at));
    if (!match) continue;
    const path = match[0];
    // the folder itself must be followed by a separator: `outdir-evil\x.png` is not inside `outdir`
    const next = path.charAt(outDir.length);
    if ((next !== "\\" && next !== "/") || path.includes("..")) continue;
    if (!found.includes(path)) found.push(path);
    from = at + path.length;
  }
  return found;
}
