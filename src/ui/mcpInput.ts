/**
 * What the user types when adding an MCP server, and how it is checked and shown. Pure, so it is unit-tested. Nothing here
 * runs a program: the command line becomes a list of arguments (no shell is ever involved), and the name becomes part of a URL
 * path and of a permission pattern, so only a narrow set of characters is accepted.
 */
import type { McpConfig } from "../opencode/backend.ts";

export const validMcpName = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(name);

/**
 * `https://…`, or `http://` for this computer only. An address with a user name or password in it is refused: secrets do not
 * belong in an address that is stored and shown.
 */
export function validMcpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** A command line as arguments: spaces separate, single or double quotes group, a backslash is just a character (Windows paths). */
export function parseCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | undefined;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current !== "") out.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started || current !== "") out.push(current);
  return out;
}

const shown = (arg: string): string => (/[\s"']/.test(arg) || arg === "" ? JSON.stringify(arg) : arg);

/** One line for the list, or the full text for the confirmation. */
export function describeMcp(config: McpConfig, long = false): string {
  if (config.type === "remote") return long ? `Address: ${config.url}` : config.url;
  const [program = "", ...args] = config.command;
  return long ? `Program: ${program}\n${args.length > 0 ? `Arguments: ${args.map(shown).join(" ")}` : "Arguments: (none)"}` : config.command.map(shown).join(" ");
}

/** An environment variable name: letters, digits and underscore, not starting with a digit. */
export const validEnvName = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name);

/** An HTTP header name (a token): letters, digits and a few signs; no spaces, no colon. */
export const validHeaderName = (name: unknown): name is string => typeof name === "string" && /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(name);

/** A secret value as typed: not empty, and a single line (a line break in a header would be an injection). */
export const validSecretValue = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !/[\r\n\0]/.test(value);
