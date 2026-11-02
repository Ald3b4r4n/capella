/**
 * Compatibility with the opencode that is actually running. opencode changes fast (2.2.5 serves `/api/*` and answers
 * the 1.x paths with its web app), so Capella never trusts a version number alone: it reads the server's own OpenAPI
 * document, checks which routes it needs are really there, and compares with the routes it was last tested against.
 * Pure: everything here takes plain data, so it is tested without a server.
 */
import { createHash } from "node:crypto";

export interface Route {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
}

export interface Capability {
  id: string;
  label: string;
  /** Without it the chat cannot work at all. */
  essential: boolean;
  routes: Route[];
}

const r = (method: Route["method"], path: string): Route => ({ method, path });

/** What Capella calls on the server. Keep in step with src/opencode/session.ts and usage.ts. */
export const CAPABILITIES: readonly Capability[] = [
  { id: "info", label: "Server version", essential: true, routes: [r("GET", "/api/info")] },
  { id: "sessions", label: "Create a session and send a message", essential: true, routes: [r("POST", "/api/session"), r("POST", "/api/session/{sessionID}/prompt"), r("GET", "/api/session/{sessionID}/message")] },
  { id: "events", label: "Live events (streaming)", essential: true, routes: [r("GET", "/api/event")] },
  { id: "interrupt", label: "Stop a turn", essential: true, routes: [r("POST", "/api/session/{sessionID}/interrupt")] },
  { id: "permissions", label: "Approvals", essential: true, routes: [r("GET", "/api/permission/request"), r("POST", "/api/session/{sessionID}/permission/{requestID}/reply")] },
  { id: "models", label: "Model list and choice", essential: true, routes: [r("GET", "/api/model"), r("POST", "/api/session/{sessionID}/model")] },
  { id: "modes", label: "Permission modes (rules and agent)", essential: true, routes: [r("PATCH", "/api/session/{sessionID}"), r("POST", "/api/session/{sessionID}/agent")] },
  { id: "defaultModel", label: "Your default model", essential: false, routes: [r("GET", "/api/model/default")] },
  { id: "history", label: "Stored chats (list, continue, fork)", essential: false, routes: [r("GET", "/api/session"), r("GET", "/api/session/{sessionID}"), r("POST", "/api/session/{sessionID}/fork")] },
  { id: "usageLimits", label: "OpenCode Go usage and Console budgets", essential: false, routes: [r("GET", "/api/experimental/usage/limits")] },
  { id: "queue", label: "Messages queued while the agent works", essential: false, routes: [r("GET", "/api/session/{sessionID}/inbox"), r("PATCH", "/api/session/{sessionID}/inbox/{inboxID}"), r("DELETE", "/api/session/{sessionID}/inbox/{inboxID}")] },
  { id: "commands", label: "/ palette: commands, skills and compaction", essential: false, routes: [r("GET", "/api/command"), r("GET", "/api/skill"), r("POST", "/api/session/{sessionID}/command"), r("POST", "/api/session/{sessionID}/compact")] },
  { id: "mcp", label: "MCP servers: list, add, switch on and off, remove", essential: false, routes: [r("GET", "/api/mcp"), r("PUT", "/api/experimental/mcp/{server}"), r("DELETE", "/api/experimental/mcp/{server}"), r("POST", "/api/experimental/mcp/{server}/connect"), r("POST", "/api/experimental/mcp/{server}/disconnect")] },
  { id: "plugins", label: "Plugins list", essential: false, routes: [r("GET", "/api/plugin")] },
];

export type Generation = "v2" | "v1" | "unknown";

/**
 * The same needs against the stable legacy routes of opencode 1.x (observed on 1.19.5, whose OpenAPI is at `/doc`).
 * 1.19.5 also serves a partial `/api/*` preview; Capella ignores it and uses these.
 */
export const CAPABILITIES_V1: readonly Capability[] = [
  { id: "info", label: "Server version", essential: true, routes: [r("GET", "/global/health")] },
  { id: "sessions", label: "Create a session and send a message", essential: true, routes: [r("POST", "/session"), r("POST", "/session/{sessionID}/prompt_async"), r("GET", "/session/{sessionID}/message")] },
  { id: "events", label: "Live events (streaming)", essential: true, routes: [r("GET", "/event")] },
  { id: "interrupt", label: "Stop a turn", essential: true, routes: [r("POST", "/session/{sessionID}/abort")] },
  { id: "permissions", label: "Approvals", essential: true, routes: [r("GET", "/permission"), r("POST", "/session/{sessionID}/permissions/{permissionID}")] },
  { id: "models", label: "Model list and choice", essential: true, routes: [r("GET", "/config/providers")] },
  { id: "modes", label: "Permission modes (rules)", essential: true, routes: [r("PATCH", "/session/{sessionID}")] },
  { id: "defaultModel", label: "Your default model", essential: false, routes: [r("GET", "/config")] },
  { id: "history", label: "Stored chats (list, continue, fork)", essential: false, routes: [r("GET", "/session"), r("GET", "/session/{sessionID}"), r("POST", "/session/{sessionID}/fork")] },
  { id: "commands", label: "/ palette: commands, skills and compaction", essential: false, routes: [r("GET", "/command"), r("POST", "/session/{sessionID}/command"), r("POST", "/session/{sessionID}/summarize")] },
  { id: "mcp", label: "MCP servers: list, add, switch on and off", essential: false, routes: [r("GET", "/mcp"), r("POST", "/mcp"), r("POST", "/mcp/{name}/connect"), r("POST", "/mcp/{name}/disconnect")] },
  { id: "skills", label: "Skills list", essential: false, routes: [r("GET", "/skill")] },
];

const METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** Every `METHOD path` in an OpenAPI `paths` object, sorted. Unknown shapes give an empty list, never an error. */
export function routesOf(openapi: unknown): string[] {
  const paths = typeof openapi === "object" && openapi !== null ? (openapi as { paths?: unknown }).paths : undefined;
  if (typeof paths !== "object" || paths === null) return [];
  const out: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (typeof item !== "object" || item === null) continue;
    for (const method of Object.keys(item)) if (METHODS.has(method)) out.push(`${method.toUpperCase()} ${path}`);
  }
  return out.sort();
}

/** 2.x has `GET /api/info`; 1.x has `/global/health` with `/session` and `/event` (and only a partial `/api/*` preview). */
export function generationOf(routes: readonly string[]): Generation {
  if (routes.includes("GET /api/info")) return "v2";
  if (routes.includes("GET /session") && routes.includes("GET /event")) return "v1";
  return "unknown";
}

export const capabilitiesOf = (generation: Generation): readonly Capability[] => (generation === "v1" ? CAPABILITIES_V1 : CAPABILITIES);

const key = (route: Route): string => `${route.method} ${route.path}`;

/** The routes Capella uses, sorted: what the "tested" snapshot records. */
export function usedRoutes(generation: Generation = "v2"): string[] {
  return [...new Set(capabilitiesOf(generation).flatMap((c) => c.routes.map(key)))].sort();
}

/** A short hash of a route list: the "fingerprint" of a contract. */
export function fingerprintOf(routes: readonly string[]): string {
  return createHash("sha256").update([...routes].sort().join("\n")).digest("hex").slice(0, 12);
}

export interface Tested {
  version: string;
  /** Routes Capella used when this version was last verified. */
  usedRoutes: string[];
  fingerprint: string;
}

export interface CapabilityResult {
  id: string;
  label: string;
  essential: boolean;
  present: boolean;
  missing: string[];
}

export type Status = "ok" | "newer" | "degraded" | "broken" | "unsupported" | "unknown";

export interface Compatibility {
  status: Status;
  generation: Generation;
  version?: string;
  testedVersion: string;
  /** Hash of the routes Capella needs, as the running server has them. */
  usedFingerprint: string;
  testedFingerprint: string;
  capabilities: CapabilityResult[];
  /** Routes Capella needs that the tested snapshot had and this server lacks. */
  removedSinceTested: string[];
  summary: string;
}

/** Compares dotted numeric versions; ignores any pre-release tail. Undefined when either is not a version. */
export function compareVersions(a: string, b: string): number | undefined {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1, 4).map(Number);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return undefined;
  for (let i = 0; i < 3; i++) if (pa[i]! !== pb[i]!) return pa[i]! < pb[i]! ? -1 : 1;
  return 0;
}

export function assess(openapi: unknown, version: string | undefined, tested: Tested): Compatibility {
  const routes = routesOf(openapi);
  const have = new Set(routes);
  const generation = generationOf(routes);
  const capabilities = capabilitiesOf(generation).map<CapabilityResult>((c) => {
    const missing = c.routes.map(key).filter((route) => !have.has(route));
    return { id: c.id, label: c.label, essential: c.essential, present: missing.length === 0, missing };
  });
  const usedHere = usedRoutes(generation).filter((route) => have.has(route));
  const base = {
    generation,
    version,
    testedVersion: tested.version,
    usedFingerprint: fingerprintOf(usedHere),
    testedFingerprint: tested.fingerprint,
    capabilities,
    removedSinceTested: tested.usedRoutes.filter((route) => !have.has(route)),
  };
  if (routes.length === 0) return { ...base, status: "unknown", summary: "Capella could not read this opencode's API description, so it cannot check compatibility. It will try to work anyway." };
  if (generation === "unknown") return { ...base, status: "unsupported", summary: "This opencode serves an API Capella does not recognise (neither the 2.x /api routes nor the 1.x /session routes). opencode 1.x and 2.x are supported." };
  const essentialMissing = capabilities.filter((c) => c.essential && !c.present);
  if (essentialMissing.length > 0) return { ...base, status: "broken", summary: `This opencode no longer offers what Capella needs for: ${essentialMissing.map((c) => c.label).join(", ")}. Capella cannot work reliably with it. Update Capella, or use opencode ${tested.version}.` };
  const optionalMissing = capabilities.filter((c) => !c.essential && !c.present);
  const order = version ? compareVersions(version, tested.version) : undefined;
  if (optionalMissing.length > 0) return { ...base, status: "degraded", summary: `Working, but this opencode lacks: ${optionalMissing.map((c) => c.label).join(", ")}. Those parts of Capella are switched off.` };
  if (order !== undefined && order > 0) return { ...base, status: "newer", summary: `opencode ${version} is newer than ${tested.version}, the version Capella was last tested with. Everything Capella needs is still there, but other things may have changed.` };
  return { ...base, status: "ok", summary: `opencode ${version ?? "?"} offers everything Capella needs.` };
}

/** Which switches the UI should flip off for this server. */
export function featureFlags(compat: Compatibility | undefined): { usage: boolean; history: boolean; defaultModel: boolean } {
  const present = (id: string) => compat === undefined || compat.status === "unknown" || (compat.capabilities.find((c) => c.id === id)?.present ?? true);
  return { usage: present("usageLimits"), history: present("history"), defaultModel: present("defaultModel") };
}
