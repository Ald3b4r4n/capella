/**
 * Watching for new opencode releases. Only the version number of a public npm package is requested; nothing about the
 * user or the project is sent, and Capella never installs or updates anything itself: it tells the user, who runs the
 * command. opencode ships as `@opencode/cli` from 2.x and as `opencode-ai` for 1.x, so the package follows the major.
 */
import { compareVersions } from "./compat.ts";

export function packageFor(installedVersion: string): string {
  const major = Number(/^(\d+)\./.exec(installedVersion)?.[1] ?? "2");
  return major >= 2 ? "@opencode/cli" : "opencode-ai";
}

export const registryUrl = (pkg: string): string => `https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`;

/** The `version` of an npm "latest" document, or undefined for anything else. */
export function parseLatest(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const version = (body as { version?: unknown }).version;
  return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
}

export async function fetchLatest(pkg: string, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<string | undefined> {
  try {
    const response = await fetchImpl(registryUrl(pkg), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? parseLatest(await response.json()) : undefined;
  } catch {
    return undefined;
  }
}

export interface UpdateNotice {
  kind: "update-available" | "newer-than-tested";
  text: string;
  /** What to run; shown to the user, never run by Capella. */
  command?: string;
}

/**
 * Decides what, if anything, to tell the user. `alreadyTold` holds the notices already shown for a version so each is
 * said once: `update:<latest>` and `tested:<installed>`.
 */
export function decideNotices(installed: string, latest: string | undefined, testedVersion: string, alreadyTold: ReadonlySet<string>): UpdateNotice[] {
  const notices: UpdateNotice[] = [];
  const vsTested = compareVersions(installed, testedVersion);
  if (vsTested !== undefined && vsTested > 0 && !alreadyTold.has(`tested:${installed}`)) {
    notices.push({ kind: "newer-than-tested", text: `opencode ${installed} is newer than ${testedVersion}, the version Capella was last tested with. It should keep working; if something looks wrong, run "Capella: Compatibility diagnostics".` });
  }
  const vsLatest = latest ? compareVersions(installed, latest) : undefined;
  if (latest && vsLatest !== undefined && vsLatest < 0 && !alreadyTold.has(`update:${latest}`)) {
    notices.push({ kind: "update-available", text: `opencode ${latest} is available (you have ${installed}). Capella does not update opencode for you.`, command: `npm install -g ${packageFor(installed)}` });
  }
  return notices;
}
