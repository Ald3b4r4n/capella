import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

/**
 * npm installs `opencode.cmd`, a batch shim that launches the real executable. Spawning the shim needs a shell, and
 * killing it then leaves the real server running, so the shim is resolved to the executable it points at.
 */
export function resolveShim(candidate: string): string {
  if (!candidate.toLowerCase().endsWith(".cmd")) return candidate;
  try {
    const match = /"%dp0%[\\/]+([^"]+?\.exe)"/i.exec(readFileSync(candidate, "utf8"));
    if (match?.[1]) {
      const target = resolve(dirname(candidate), match[1]);
      if (existsSync(target)) return target;
    }
  } catch {
    // An unreadable shim is returned as is; the caller will fail to spawn it with a clear error.
  }
  return candidate;
}

/**
 * Finds the opencode executable. Order: explicit path, PATH, common install locations.
 * Returns undefined when nothing is found; callers decide how to report that.
 */
export function locateOpencode(explicit?: string): string | undefined {
  if (explicit && explicit.trim() !== "") {
    return existsSync(explicit) ? resolveShim(explicit) : undefined;
  }
  const isWindows = process.platform === "win32";
  const names = isWindows ? ["opencode.exe", "opencode.cmd"] : ["opencode"];
  const home = process.env.USERPROFILE ?? process.env.HOME;
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter),
    isWindows ? process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs", "opencode") : home && join(home, ".local", "bin"),
    home && join(home, ".opencode", "bin"),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return resolveShim(candidate);
    }
  }
  return undefined;
}
