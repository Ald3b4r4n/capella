/**
 * Permission modes. opencode has no "mode" concept: it has agents (`build`, `plan`) and permission rules, and its
 * default `build` agent allows everything (`allow * *`, only `.env` reads ask). Capella therefore builds each mode
 * from an agent plus session-level rules sent at `POST /api/session` (observed: `ask shell` makes the host raise
 * `permission.asked` for the command; `deny` hides the tool from the model).
 *
 * Capella never answers a permission request by itself. These rules only decide which actions the host asks about.
 */

export type ModeId = "plan" | "review" | "accept-edits" | "bypass";

export interface Rule {
  action: string;
  resource: string;
  effect: "allow" | "deny" | "ask";
}

export interface Mode {
  id: ModeId;
  label: string;
  description: string;
  agent: "plan" | "build";
  rules: Rule[];
  /** True when switching to it needs an explicit confirmation from the user. */
  dangerous: boolean;
  /** Part of the Shift+Tab cycle. `bypass` never is. */
  cycles: boolean;
}

const all = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect });

export const MODES: readonly Mode[] = [
  {
    id: "plan",
    label: "Plan",
    description: "Reads and plans; editing and shell commands are denied (the tools are not even offered to the model).",
    agent: "plan",
    rules: [all("edit", "deny"), all("shell", "deny"), all("external_directory", "ask")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "review",
    label: "Review each change",
    description: "Builds, but asks before every edit, shell command, web fetch and web search.",
    agent: "build",
    rules: [all("edit", "ask"), all("shell", "ask"), all("webfetch", "ask"), all("websearch", "ask"), all("external_directory", "ask")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    description: "Edits files in the folder without asking; still asks before shell commands and web access.",
    agent: "build",
    rules: [all("shell", "ask"), all("webfetch", "ask"), all("websearch", "ask"), all("external_directory", "ask")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    description: "opencode's own default: nothing is asked (measured on 2.2.5: even a file outside the project is read without asking). Use with care.",
    agent: "build",
    rules: [],
    dangerous: true,
    cycles: false,
  },
];

export const DEFAULT_MODE: ModeId = "plan";

/**
 * Web access of a chat, on top of its mode: follow the mode (Plan and Bypass let the web tools through, Review and
 * Accept edits ask), always allow them, or turn them off. It is a rule on the session like the mode's own; opencode's
 * `websearch` and `webfetch` tools are not offered to a model when denied.
 */
export type WebPolicy = "mode" | "allow" | "deny";

const WEB_ACTIONS = ["webfetch", "websearch"];

/**
 * What a folder the user added to a chat is allowed as: the `external_directory` resources opencode asks about are the
 * folder's path with `/*`, in forward slashes (measured: a file in a subfolder is covered too). On Windows the drive letter
 * may come in either case, so both are listed; a pattern that fails to match only means opencode asks, never that it allows.
 */
export function folderPatterns(path: string): string[] {
  const slashed = path.split("\\").join("/").replace(/\/+$/, "");
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(slashed);
  const forms = drive ? [`${drive[1]!.toLowerCase()}:${drive[2] ?? ""}`, `${drive[1]!.toUpperCase()}:${drive[2] ?? ""}`] : [slashed];
  return forms.map((form) => `${form}/*`);
}

/**
 * The mode's rules with the web policy laid over them, and then the folders the user added to this chat: the last matching
 * rule wins, so each folder's `allow` comes after the mode's `ask` for everything outside the project. `mode` with no
 * folders changes nothing.
 */
export function rulesWith(mode: Mode, web: WebPolicy, extras: Extras = {}): Rule[] {
  const folders = extras.folders ?? [];
  const base = web === "mode" ? mode.rules : [...mode.rules.filter((rule) => !WEB_ACTIONS.includes(rule.action)), ...WEB_ACTIONS.map((action): Rule => ({ action, resource: "*", effect: web === "deny" ? "deny" : "allow" }))];
  // Bypass asks about nothing, so there is nothing to add or to lift.
  if (mode.rules.length === 0) return base;
  return [...base, ...mcpRules(extras.mcp ?? []), ...folders.flatMap((folder) => folderPatterns(folder).map((resource): Rule => ({ action: "external_directory", resource, effect: "allow" })))];
}

/** What a chat is given on top of its mode: folders outside the project it may use, and the MCP servers it can reach. */
export interface Extras {
  folders?: readonly string[];
  /** Names of the MCP servers opencode has: each of their tools is asked about. */
  mcp?: readonly string[];
}

/**
 * An MCP server's tools are permissions named `<server>_<tool>`. opencode runs them without a question by default: measured
 * on 2.2.5, a tool of an MCP server ran in Review and even in Plan mode with no approval. A wildcard action covers every tool
 * of a server (`server_*`), so each server the chat can reach is asked about, in every mode but Bypass. The name is listed
 * as it is and with the characters opencode replaces; a pattern that fails to match only means a tool runs unasked as before.
 */
export function mcpRules(servers: readonly string[]): Rule[] {
  const names = new Set(servers.flatMap((name) => [name, name.replace(/[^A-Za-z0-9_-]/g, "_")]));
  return [...names].map((name): Rule => ({ action: `${name}_*`, resource: "*", effect: "ask" }));
}

/** A permission rule as opencode 1.x writes it. */
export interface V1Rule {
  permission: string;
  pattern: string;
  action: Rule["effect"];
}

const V1_ACTIONS = ["edit", "bash", "webfetch", "websearch", "external_directory"] as const;

/**
 * The mode's rules for opencode 1.x: same meaning, other names (`shell` is `bash` there; `pattern` instead of
 * `resource`). Measured on 1.19.5: `PATCH /session/{id} {permission}` APPENDS to the session's rules instead of
 * replacing them, and the last matching rule wins. So a mode is written as a complete set, one rule for each action it
 * controls, with an explicit `allow` where the mode lets the action through: appended at the end, it overrides whatever
 * an earlier mode left, in both directions (an empty list would change nothing, and Bypass after Plan would stay Plan).
 */
/**
 * 1.x writes the resource it asks about with the platform's own separators (measured on Windows: `C:\Users\me\lib\sub\*`), and a forward-slash pattern did not match it, so a Windows folder is
 * listed in both forms. A pattern that fails to match only means opencode asks, never that it allows.
 */
function v1FolderPatterns(path: string): string[] {
  const forward = folderPatterns(path);
  if (!path.includes("\\")) return forward;
  return [...forward, ...forward.map((p) => p.slice(0, -2).split("/").join("\\") + "\\*")];
}

export function v1Rules(mode: Mode, web: WebPolicy = "mode", extras: Extras = {}): V1Rule[] {
  const folders = extras.folders ?? [];
  const rules = rulesWith(mode, web);
  const base = V1_ACTIONS.map((permission): V1Rule => ({ permission, pattern: "*", action: rules.find((rule) => (rule.action === "shell" ? "bash" : rule.action) === permission)?.effect ?? "allow" }));
  // Because 1.x appends, a folder that was removed is covered too: the `ask` for everything comes back after its old `allow`.
  if (mode.rules.length === 0) return base;
  const mcp = mcpRules(extras.mcp ?? []).map((r): V1Rule => ({ permission: r.action, pattern: "*", action: "ask" }));
  return [...base, ...mcp, ...folders.flatMap((folder) => v1FolderPatterns(folder).map((pattern): V1Rule => ({ permission: "external_directory", pattern, action: "allow" })))];
}

export function modeById(id: string | undefined): Mode {
  return MODES.find((mode) => mode.id === id) ?? MODES.find((mode) => mode.id === DEFAULT_MODE)!;
}

/** Next mode for Shift+Tab; `bypass` is skipped, and coming from it the cycle restarts at Plan. */
export function nextMode(current: ModeId): ModeId {
  const cycle = MODES.filter((mode) => mode.cycles);
  const index = cycle.findIndex((mode) => mode.id === current);
  return cycle[(index + 1) % cycle.length]!.id;
}

/** Whether the mode with this id is what an existing session currently has, judging by its agent and rules. */
export function modeOf(agent: string | undefined, rules: readonly Rule[] | undefined): ModeId | undefined {
  // Rules about folders outside the project (the baseline ask, and the folders the user added) do not tell the modes apart.
  const own = (list: readonly Rule[]) => list.filter((rule) => rule.action !== "external_directory");
  const sameRules = (a: readonly Rule[], b: readonly Rule[]) => a.length === b.length && a.every((rule) => b.some((o) => o.action === rule.action && o.resource === rule.resource && o.effect === rule.effect));
  return MODES.find((mode) => mode.agent === agent && sameRules(own(mode.rules), own(rules ?? [])))?.id;
}
