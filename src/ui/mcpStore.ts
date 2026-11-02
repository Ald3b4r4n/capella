/**
 * What Capella keeps about the MCP servers the user added, and how it becomes what opencode is given. Pure, so it is
 * unit-tested. The structure (command, address, the NAMES of environment variables and headers) is kept in the project's
 * storage; every VALUE (a token in a variable, an Authorization header) is a secret and lives only in the editor's secret
 * storage (the system keychain), is typed in a masked box, and is never shown again.
 */
import type { McpConfig } from "../opencode/backend.ts";
import { validEnvName, validHeaderName, validMcpName, validMcpUrl } from "./mcpInput.ts";

export interface ManagedMcp {
  name: string;
  type: "local" | "remote";
  command?: string[];
  cwd?: string;
  url?: string;
  /** Names only; the values are secrets. */
  envNames: string[];
  headerNames: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** What the project's storage holds, whichever version wrote it (0.1.4 kept `{name, config}` with no variables). Anything invalid is dropped. */
export function readManaged(raw: unknown): ManagedMcp[] {
  if (!Array.isArray(raw)) return [];
  const out: ManagedMcp[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!validMcpName(r.name)) continue;
    const old = typeof r.config === "object" && r.config !== null ? (r.config as Record<string, unknown>) : undefined;
    const type = (r.type ?? old?.type) as unknown;
    if (type === "local") {
      const command = strings(r.command ?? old?.command);
      if (command.length === 0) continue;
      out.push({ name: r.name, type, command, cwd: typeof r.cwd === "string" ? r.cwd : undefined, envNames: strings(r.envNames).filter(validEnvName), headerNames: [] });
    } else if (type === "remote") {
      const url = r.url ?? old?.url;
      if (!validMcpUrl(url)) continue;
      out.push({ name: r.name, type, url: String(url).trim(), envNames: [], headerNames: strings(r.headerNames).filter(validHeaderName) });
    }
  }
  return out;
}

/** The key under which one secret value is kept: per project (a hash is passed as `scope`), per server, per variable or header. */
export const secretKey = (scope: string, name: string, kind: "env" | "hdr", key: string): string => `capella.mcp:${scope}:${name}:${kind}:${key}`;

/**
 * The config opencode is given: the structure plus the secret values, read at the moment of use and kept only in memory.
 * `missing` lists what has a name but no value (the keychain was cleared, say): the server is then not started with a
 * half-filled configuration.
 */
export function toConfig(entry: ManagedMcp, secret: (kind: "env" | "hdr", key: string) => string | undefined): { config: McpConfig; missing: string[] } {
  const missing: string[] = [];
  const pick = (kind: "env" | "hdr", names: string[]): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const key of names) {
      const value = secret(kind, key);
      if (value === undefined) missing.push(key);
      else out[key] = value;
    }
    return names.length > 0 ? out : undefined;
  };
  if (entry.type === "local") {
    const environment = pick("env", entry.envNames);
    return { config: { type: "local", command: entry.command ?? [], ...(entry.cwd ? { cwd: entry.cwd } : {}), ...(environment ? { environment } : {}) }, missing };
  }
  const headers = pick("hdr", entry.headerNames);
  return { config: { type: "remote", url: entry.url ?? "", ...(headers ? { headers } : {}) }, missing };
}

const shown = (arg: string): string => (/[\s"']/.test(arg) || arg === "" ? JSON.stringify(arg) : arg);

/** A server as the list and the confirmation show it: what runs or is reached, and the NAMES of what it is given. Never a value. */
export function summarize(entry: ManagedMcp, long = false): string {
  const lines: string[] = [];
  if (entry.type === "local") {
    const [program = "", ...args] = entry.command ?? [];
    if (long) {
      lines.push(`Program: ${program}`, args.length > 0 ? `Arguments: ${args.map(shown).join(" ")}` : "Arguments: (none)");
      if (entry.cwd) lines.push(`Working folder: ${entry.cwd}`);
    } else lines.push((entry.command ?? []).map(shown).join(" "));
    if (entry.envNames.length > 0) lines.push(long ? `Environment variables: ${entry.envNames.join(", ")} (values are kept in your system's keychain and never shown)` : `env: ${entry.envNames.join(", ")}`);
  } else {
    lines.push(long ? `Address: ${entry.url}` : entry.url ?? "");
    if (entry.headerNames.length > 0) lines.push(long ? `Headers: ${entry.headerNames.join(", ")} (values are kept in your system's keychain and never shown)` : `headers: ${entry.headerNames.join(", ")}`);
  }
  return lines.join(long ? "\n" : " · ");
}

/** Whether a server is well-formed enough to be sent to opencode. */
export function valid(entry: ManagedMcp): boolean {
  if (!validMcpName(entry.name)) return false;
  if (entry.type === "local") return (entry.command?.length ?? 0) > 0 && entry.envNames.every(validEnvName) && new Set(entry.envNames).size === entry.envNames.length;
  return validMcpUrl(entry.url) && entry.headerNames.every(validHeaderName) && new Set(entry.headerNames.map((h) => h.toLowerCase())).size === entry.headerNames.length;
}
