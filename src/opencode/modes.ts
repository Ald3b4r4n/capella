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
    rules: [all("edit", "deny"), all("shell", "deny")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "review",
    label: "Review each change",
    description: "Builds, but asks before every edit, shell command, web fetch and web search.",
    agent: "build",
    rules: [all("edit", "ask"), all("shell", "ask"), all("webfetch", "ask"), all("websearch", "ask")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "accept-edits",
    label: "Accept edits",
    description: "Edits files in the folder without asking; still asks before shell commands and web access.",
    agent: "build",
    rules: [all("shell", "ask"), all("webfetch", "ask"), all("websearch", "ask")],
    dangerous: false,
    cycles: true,
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    description: "opencode's own default: nothing is asked except .env reads and folders outside the project. Use with care.",
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

/** The mode's rules with the web policy laid over them. `mode` changes nothing. */
export function rulesWith(mode: Mode, web: WebPolicy): Rule[] {
  if (web === "mode") return mode.rules;
  const rest = mode.rules.filter((rule) => !WEB_ACTIONS.includes(rule.action));
  return [...rest, ...WEB_ACTIONS.map((action): Rule => ({ action, resource: "*", effect: web === "deny" ? "deny" : "allow" }))];
}

/** A permission rule as opencode 1.x writes it. */
export interface V1Rule {
  permission: string;
  pattern: string;
  action: Rule["effect"];
}

const V1_ACTIONS = ["edit", "bash", "webfetch", "websearch"] as const;

/**
 * The mode's rules for opencode 1.x: same meaning, other names (`shell` is `bash` there; `pattern` instead of
 * `resource`). Measured on 1.19.5: `PATCH /session/{id} {permission}` APPENDS to the session's rules instead of
 * replacing them, and the last matching rule wins. So a mode is written as a complete set, one rule for each action it
 * controls, with an explicit `allow` where the mode lets the action through: appended at the end, it overrides whatever
 * an earlier mode left, in both directions (an empty list would change nothing, and Bypass after Plan would stay Plan).
 */
export function v1Rules(mode: Mode, web: WebPolicy = "mode"): V1Rule[] {
  const rules = rulesWith(mode, web);
  return V1_ACTIONS.map((permission) => ({ permission, pattern: "*", action: rules.find((rule) => (rule.action === "shell" ? "bash" : rule.action) === permission)?.effect ?? "allow" }));
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
  const sameRules = (a: readonly Rule[], b: readonly Rule[]) => a.length === b.length && a.every((rule) => b.some((o) => o.action === rule.action && o.resource === rule.resource && o.effect === rule.effect));
  return MODES.find((mode) => mode.agent === agent && sameRules(mode.rules, rules ?? []))?.id;
}
