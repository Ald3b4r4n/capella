import type { AccountInfo, Backend, McpConfig, McpServerInfo, McpStatus, ModelRef, PendingApproval, OauthAttempt, OauthStatus, PluginInfo, PromptFile, PromptOptions, SkillInfo, SlashEntry } from "./backend.ts";
import type { OpencodeClient } from "./client.ts";
import { familyOf, type MapResult, type ModelInfo, type QuestionRequest, type QuestionValue } from "./events.ts";
import { mapQuestionRequest, V1EventMapper } from "./events-v1.ts";
import { pathId } from "./backend-v2.ts";
import { mapSessionRowsV1, replayItemsV1, type ReplayItem, type SessionRow } from "./history.ts";
import { modeById, v1Rules, type Extras, type ModeId, type WebPolicy } from "./modes.ts";
import type { UsageSnapshot } from "./usage.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const IMAGE_BY_EXTENSION: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The media type 1.x wants on a file part: from a `data:` URI, else from the file name; text when it is unknown. */
export function mimeFor(file: PromptFile): string {
  if (file.mime) return file.mime;
  const fromData = /^data:([^;,]+)/.exec(file.uri)?.[1];
  if (fromData) return fromData;
  return IMAGE_BY_EXTENSION[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "text/plain";
}

/**
 * The catalog of 1.x (`GET /config/providers`), whitelisted. Each provider also carries `options` (which holds its API
 * key: a public one for opencode's free models, the user's for others) and model `headers`: neither is read here.
 */
export function mapModelsV1(body: unknown): ModelInfo[] {
  const providers = isRecord(body) && Array.isArray(body.providers) ? body.providers : [];
  const out: ModelInfo[] = [];
  for (const provider of providers) {
    if (!isRecord(provider)) continue;
    const providerId = str(provider.id);
    const models = isRecord(provider.models) ? provider.models : {};
    if (!providerId) continue;
    for (const [key, model] of Object.entries(models)) {
      if (!isRecord(model)) continue;
      const modelId = str(model.id) ?? key;
      const cost = isRecord(model.cost) ? model.cost : undefined;
      const zeroCost = cost !== undefined && cost.input === 0 && cost.output === 0;
      const label = str(model.name) ?? modelId;
      const input = isRecord(model.capabilities) ? model.capabilities.input : undefined;
      const images = isRecord(input) ? input.image === true : Array.isArray(input) ? input.includes("image") : undefined;
      const limit = isRecord(model.limit) && typeof model.limit.context === "number" ? model.limit.context : undefined;
      const variants = isRecord(model.variants) ? Object.keys(model.variants) : [];
      out.push({ modelId, providerId, label, family: familyOf(providerId), free: zeroCost || /-free$/.test(modelId) || /\bfree\b/i.test(label), variants, contextLimit: limit, images });
    }
  }
  return out;
}

/**
 * opencode 1.x through its stable legacy routes (observed on 1.19.5). Differences from 2.x that this class absorbs:
 * the model and agent travel with every prompt, so they are kept here; there is no usage endpoint; rules are
 * `{permission, pattern, action}` and the shell is called `bash`; and the stream's events need a stateful mapper.
 */
export class BackendV1 implements Backend {
  readonly generation = "v1" as const;
  readonly eventPath = "/event";
  private readonly client: OpencodeClient;
  private readonly events = new V1EventMapper();
  private agent = "plan";
  private model?: ModelRef;
  private effort?: string;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async version(): Promise<string | undefined> {
    const health = await this.client.get<{ version?: unknown }>("/global/health");
    return typeof health?.version === "string" ? health.version : undefined;
  }

  contract(): Promise<unknown> {
    return this.client.get<unknown>("/doc").catch(() => undefined);
  }

  async models(): Promise<ModelInfo[]> {
    return mapModelsV1(await this.client.get("/config/providers"));
  }

  async defaultModel(): Promise<ModelRef | undefined> {
    const config = await this.client.get<{ model?: unknown }>("/config").catch(() => undefined);
    const configured = typeof config?.model === "string" ? /^([^/]+)\/(.+)$/.exec(config.model) : null;
    if (configured) return { providerId: configured[1]!, modelId: configured[2]! };
    // No model configured: the first provider's own default, as `/config/providers` reports it.
    const body = await this.client.get<{ default?: unknown }>("/config/providers");
    const defaults = isRecord(body?.default) ? Object.entries(body.default) : [];
    const first = defaults.find(([, model]) => typeof model === "string");
    return first ? { providerId: first[0], modelId: first[1] as string } : undefined;
  }

  async createSession(mode: ModeId, model: ModelRef, effort?: string, web: WebPolicy = "mode", extras: Extras = {}): Promise<string> {
    const m = modeById(mode);
    this.agent = m.agent;
    this.model = model;
    this.effort = effort;
    const created = await this.client.post<{ id?: string }>("/session", { title: "Capella", agent: m.agent, model: { id: model.modelId, providerID: model.providerId }, permission: v1Rules(m, web, extras) });
    if (!created?.id) throw new Error("opencode did not return a session id");
    return created.id;
  }

  async selectModel(_sessionId: string, model: ModelRef, effort?: string): Promise<void> {
    // 1.x has no "set the session's model" call: the model (and its variant) ride on each prompt.
    this.model = model;
    this.effort = effort;
  }

  async applyMode(sessionId: string, mode: ModeId, web: WebPolicy = "mode", extras: Extras = {}): Promise<void> {
    const m = modeById(mode);
    this.agent = m.agent;
    await this.client.request("PATCH", `/session/${sessionId}`, { body: { permission: v1Rules(m, web, extras) } });
  }

  readonly canQueue = false;

  async prompt(sessionId: string, text: string, files: readonly PromptFile[], _options?: PromptOptions): Promise<string | undefined> {
    if (!this.model) throw new Error("no model is selected");
    const parts: unknown[] = [{ type: "text", text }, ...files.map((f) => ({ type: "file", mime: mimeFor(f), url: f.uri, filename: f.name }))];
    await this.client.post(`/session/${sessionId}/prompt_async`, { model: { providerID: this.model.providerId, modelID: this.model.modelId }, agent: this.agent, ...(this.effort ? { variant: this.effort } : {}), parts });
    return undefined;
  }

  async queued(): Promise<string[]> {
    return [];
  }

  async dequeue(): Promise<void> {
    throw new Error("opencode 1.x has no message queue");
  }

  async steer(): Promise<void> {
    throw new Error("opencode 1.x cannot steer a running turn");
  }

  async slash(): Promise<SlashEntry[]> {
    // 1.x lists its skills among the commands (`source: "skill"`): one list serves the palette.
    const rows = await this.client.get<Array<{ name?: unknown; description?: unknown; source?: unknown }>>("/command").catch(() => undefined);
    return (Array.isArray(rows) ? rows : []).flatMap((c): SlashEntry[] => (typeof c.name === "string" ? [{ kind: c.source === "skill" ? "skill" : "command", name: c.name, description: typeof c.description === "string" ? c.description : undefined }] : []));
  }

  async runCommand(sessionId: string, name: string, args: string, files: readonly PromptFile[]): Promise<void> {
    if (!this.model) throw new Error("no model is selected");
    const parts = files.map((f) => ({ type: "file", mime: mimeFor(f), url: f.uri, filename: f.name }));
    // The legacy route answers when the command has finished; the turn itself streams as events, so it is not awaited.
    void this.client.request("POST", `/session/${sessionId}/command`, { body: { command: name, arguments: args, model: `${this.model.providerId}/${this.model.modelId}`, agent: this.agent, ...(this.effort ? { variant: this.effort } : {}), ...(parts.length > 0 ? { parts } : {}) }, timeoutMs: 10 * 60 * 1000 }).catch(() => undefined);
  }

  async questions(sessionId: string): Promise<QuestionRequest[]> {
    const rows = await this.client.get<unknown[]>("/question");
    return (Array.isArray(rows) ? rows : []).flatMap((row) => {
      const request = mapQuestionRequest(row);
      return request && request.sessionId === sessionId ? [request] : [];
    });
  }

  async answerQuestion(_sessionId: string, requestId: string, answers: Record<string, QuestionValue>): Promise<void> {
    // 1.x takes one list of chosen labels for each question, in order: `q0`, `q1`…
    const count = Math.max(-1, ...Object.keys(answers).flatMap((k) => (/^q\d+$/.test(k) ? [Number(k.slice(1))] : []))) + 1;
    const list = (v: QuestionValue | undefined): string[] => (Array.isArray(v) ? v : v === undefined || v === "" ? [] : [String(v)]);
    await this.client.post(`/question/${pathId(requestId)}/reply`, { answers: Array.from({ length: count }, (_, i) => list(answers[`q${i}`])) });
  }

  async rejectQuestion(_sessionId: string, requestId: string): Promise<void> {
    await this.client.post(`/question/${pathId(requestId)}/reject`, {});
  }

  async accounts(): Promise<AccountInfo[]> {
    const rows = await this.client.get<{ all?: Array<{ id?: unknown; name?: unknown; env?: unknown }>; connected?: unknown }>("/provider");
    const connected = new Set(Array.isArray(rows?.connected) ? rows.connected.filter((c): c is string => typeof c === "string") : []);
    return (rows?.all ?? []).flatMap((p): AccountInfo[] => {
      if (typeof p.id !== "string") return [];
      const envNames = Array.isArray(p.env) ? p.env.filter((e): e is string => typeof e === "string") : [];
      // 1.x does not say whether a provider is connected by a stored login or by a variable: it only says it is connected.
      return [{ id: p.id, name: typeof p.name === "string" ? p.name : p.id, key: true, oauth: [], connections: connected.has(p.id) ? [{ kind: "credential", id: p.id, label: "Connected", method: envNames.length > 0 ? "key or environment" : "key" }] : [] }];
    });
  }

  async connectKey(integrationId: string, key: string): Promise<void> {
    await this.client.request("PUT", `/auth/${encodeURIComponent(integrationId)}`, { body: { type: "api", key } });
  }

  async oauthStart(): Promise<OauthAttempt> {
    throw new Error("Signing in with a browser is not available through opencode 1.x here: run `opencode auth login` in a terminal.");
  }

  async oauthStatus(): Promise<OauthStatus> {
    return { status: "unknown" };
  }

  async oauthComplete(): Promise<void> {
    throw new Error("not available on opencode 1.x");
  }

  async oauthCancel(): Promise<void> {
    /* nothing was started */
  }

  async disconnect(integrationId: string): Promise<void> {
    await this.client.request("DELETE", `/auth/${encodeURIComponent(integrationId)}`);
  }

  async activate(): Promise<void> {
    throw new Error("not available on opencode 1.x");
  }

  async mcpList(): Promise<McpServerInfo[]> {
    const rows = await this.client.get<Record<string, { status?: unknown; error?: unknown }>>("/mcp");
    return Object.entries(rows ?? {}).map(([name, row]): McpServerInfo => {
      const raw = typeof row?.status === "string" ? row.status.toLowerCase().split("_").join("-") : "";
      const status: McpStatus = (["connected", "pending", "disabled", "failed", "needs-auth"] as const).find((s) => s === raw) ?? "unknown";
      const error = typeof row?.error === "string" ? row.error.replace(/\s+/g, " ").trim().slice(0, 240) : undefined;
      return { name, status, detail: error ?? (status === "unknown" && raw ? raw : undefined) };
    });
  }

  async mcpAdd(name: string, config: McpConfig): Promise<void> {
    await this.client.post("/mcp", { name, config });
  }

  async mcpSetEnabled(name: string, on: boolean): Promise<void> {
    await this.client.post(`/mcp/${encodeURIComponent(name)}/${on ? "connect" : "disconnect"}`);
  }

  async mcpRemove(name: string): Promise<void> {
    // 1.x has no way to forget a server: it is disconnected, and gone when opencode restarts.
    await this.client.post(`/mcp/${encodeURIComponent(name)}/disconnect`);
  }

  async skills(): Promise<SkillInfo[]> {
    const rows = await this.client.get<Array<{ name?: unknown; description?: unknown; location?: unknown }>>("/skill");
    return (Array.isArray(rows) ? rows : []).flatMap((s): SkillInfo[] => (typeof s.name === "string" ? [{ name: s.name, description: typeof s.description === "string" ? s.description : undefined, path: typeof s.location === "string" ? s.location : undefined }] : []));
  }

  async plugins(): Promise<PluginInfo[]> {
    const config = await this.client.get<{ plugin?: unknown }>("/config");
    return (Array.isArray(config?.plugin) ? config.plugin : []).flatMap((p): PluginInfo[] => {
      const spec = typeof p === "string" ? p : Array.isArray(p) && typeof p[0] === "string" ? p[0] : undefined;
      return spec ? [{ source: `config: ${spec}`, state: "configured" }] : [];
    });
  }

  async compact(sessionId: string): Promise<void> {
    if (!this.model) throw new Error("no model is selected");
    void this.client.request("POST", `/session/${sessionId}/summarize`, { body: { providerID: this.model.providerId, modelID: this.model.modelId }, timeoutMs: 10 * 60 * 1000 }).catch(() => undefined);
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.post(`/session/${sessionId}/abort`);
  }

  async reply(sessionId: string, requestId: string, decision: "once" | "always" | "reject"): Promise<void> {
    // 1.x takes no note with a rejection.
    await this.client.post(`/session/${sessionId}/permissions/${requestId}`, { response: decision });
  }

  async pending(): Promise<PendingApproval[]> {
    const rows = await this.client.get<unknown>("/permission").catch(() => undefined);
    const list = Array.isArray(rows) ? rows : [];
    return list.flatMap((r) => {
      if (!isRecord(r) || !str(r.id) || !str(r.permission) || !str(r.sessionID)) return [];
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      return [{ id: str(r.id)!, sessionId: str(r.sessionID)!, action: str(r.permission)!, resources: strings(r.patterns), saves: strings(r.always) }];
    });
  }

  async usage(): Promise<UsageSnapshot | undefined> {
    return undefined;
  }

  async listSessions(directory: string, search?: string): Promise<SessionRow[]> {
    return mapSessionRowsV1(await this.client.get("/session", { query: { limit: "50", directory, search: search && search.trim() !== "" ? search.trim() : undefined } }));
  }

  async fork(sessionId: string): Promise<string> {
    const created = await this.client.post<{ id?: string }>(`/session/${sessionId}/fork`, {});
    if (!created?.id) throw new Error("opencode did not return the id of the fork");
    return created.id;
  }

  async storedModel(sessionId: string): Promise<ModelRef | undefined> {
    const info = await this.client.get<{ model?: { id?: unknown; providerID?: unknown } }>(`/session/${sessionId}`);
    const stored = info?.model;
    return stored && typeof stored.id === "string" && typeof stored.providerID === "string" ? { providerId: stored.providerID, modelId: stored.id } : undefined;
  }

  async messages(sessionId: string): Promise<ReplayItem[]> {
    return replayItemsV1(await this.client.get(`/session/${sessionId}/message`, { query: { limit: "200" } }));
  }

  mapEvent(raw: string, sessionId: string): MapResult[] {
    const results = this.events.map(raw, sessionId);
    // A spent free allowance ends the turn on our side while 1.x keeps retrying it: stop that.
    if (results.some((r) => r.kind === "event" && r.event.type === "turn-ended" && r.event.error?.type === "FreeTierLimit")) void this.interrupt(sessionId).catch(() => undefined);
    return results;
  }

  resetEvents(): void {
    this.events.reset();
  }
}
