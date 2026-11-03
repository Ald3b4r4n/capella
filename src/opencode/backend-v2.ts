import type { AccountConnection, AccountInfo, Backend, FormField, McpConfig, McpServerInfo, McpStatus, ModelRef, PendingApproval, OauthAttempt, OauthMethod, OauthStatus, PluginInfo, PromptFile, PromptOptions, SkillInfo, SlashEntry } from "./backend.ts";
import { ApiError, type OpencodeClient } from "./client.ts";
import { mapForm, mapFrame, mapModels, parseFrame, type MapResult, type ModelInfo, type QuestionRequest, type QuestionValue } from "./events.ts";
import { mapSessionRows, replayItems, type ReplayItem, type SessionRow } from "./history.ts";
import { modeById, rulesWith, type Extras, type ModeId, type WebPolicy } from "./modes.ts";
import { mapUsageLimits, type UsageSnapshot } from "./usage.ts";
import { samePath } from "./worktrees.ts";

/** opencode 2.x: the `/api/*` routes, as measured on 2.2.5 (docs/PROTOCOL-NOTES.md). */
export class BackendV2 implements Backend {
  readonly generation = "v2" as const;
  readonly eventPath = "/api/event";
  private readonly client: OpencodeClient;

  constructor(client: OpencodeClient) {
    this.client = client;
  }

  async version(): Promise<string | undefined> {
    const info = await this.client.get<{ version?: unknown }>("/api/info");
    return typeof info?.version === "string" ? info.version : undefined;
  }

  contract(): Promise<unknown> {
    return this.client.get<unknown>("/openapi.json").catch(() => undefined);
  }

  async models(): Promise<ModelInfo[]> {
    const body = await this.client.get<{ data?: unknown }>("/api/model");
    return mapModels(body?.data);
  }

  async defaultModel(): Promise<ModelRef | undefined> {
    const body = await this.client.get<{ data?: { modelID?: unknown; providerID?: unknown } }>("/api/model/default");
    const modelId = body?.data?.modelID;
    const providerId = body?.data?.providerID;
    return typeof modelId === "string" && typeof providerId === "string" ? { providerId, modelId } : undefined;
  }

  async createSession(mode: ModeId, model: ModelRef, effort?: string, web: WebPolicy = "mode", extras: Extras = {}): Promise<string> {
    const m = modeById(mode);
    const created = await this.client.post<{ data?: { id?: string } }>("/api/session", { title: "Capella", agent: m.agent, permissions: rulesWith(m, web, extras) });
    const id = created?.data?.id;
    if (!id) throw new Error("opencode did not return a session id");
    await this.selectModel(id, model, effort);
    return id;
  }

  async selectModel(sessionId: string, model: ModelRef, effort?: string): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/model`, { model: { id: model.modelId, providerID: model.providerId, ...(effort ? { variant: effort } : {}) } });
  }

  async applyMode(sessionId: string, mode: ModeId, web: WebPolicy = "mode", extras: Extras = {}): Promise<void> {
    const m = modeById(mode);
    await this.client.request("PATCH", `/api/session/${sessionId}`, { body: { permissions: rulesWith(m, web, extras) } });
    await this.client.post(`/api/session/${sessionId}/agent`, { agent: m.agent });
  }

  readonly canQueue = true;

  async prompt(sessionId: string, text: string, files: readonly PromptFile[], options: PromptOptions = {}): Promise<string | undefined> {
    const body: Record<string, unknown> = { text };
    if (files.length > 0) body.files = files.map((f) => ({ uri: f.uri, name: f.name }));
    if (options.skillIds && options.skillIds.length > 0) body.skills = options.skillIds.map((id) => ({ id }));
    if (options.delivery) body.delivery = options.delivery;
    const sent = await this.client.post<{ data?: { id?: unknown } }>(`/api/session/${sessionId}/prompt`, body);
    return typeof sent?.data?.id === "string" ? sent.data.id : undefined;
  }

  async queued(sessionId: string): Promise<string[]> {
    const inbox = await this.client.get<{ data?: Array<{ id?: unknown; type?: unknown }> }>(`/api/session/${sessionId}/inbox`);
    return (inbox?.data ?? []).flatMap((item) => (item.type === "user" && typeof item.id === "string" ? [item.id] : []));
  }

  async dequeue(sessionId: string, inboxId: string): Promise<void> {
    await this.client.request("DELETE", `/api/session/${sessionId}/inbox/${inboxId}`);
  }

  async steer(sessionId: string, inboxId: string): Promise<void> {
    await this.client.request("PATCH", `/api/session/${sessionId}/inbox/${inboxId}`, { body: { delivery: "steer" } });
  }

  async slash(): Promise<SlashEntry[]> {
    const [commands, skills] = await Promise.all([
      this.client.get<{ data?: Array<{ name?: unknown; description?: unknown }> }>("/api/command").catch(() => undefined),
      this.client.get<{ data?: Array<{ id?: unknown; name?: unknown; description?: unknown }> }>("/api/skill").catch(() => undefined),
    ]);
    const out: SlashEntry[] = [];
    for (const c of commands?.data ?? []) if (typeof c.name === "string") out.push({ kind: "command", name: c.name, description: typeof c.description === "string" ? c.description : undefined });
    for (const s of skills?.data ?? []) if (typeof s.name === "string" && typeof s.id === "string") out.push({ kind: "skill", name: s.name, id: s.id, description: typeof s.description === "string" ? s.description : undefined });
    return out;
  }

  async runCommand(sessionId: string, name: string, args: string, files: readonly PromptFile[]): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/command`, { name, text: args, ...(files.length > 0 ? { files: files.map((f) => ({ uri: f.uri, name: f.name })) } : {}) });
  }

  async compact(sessionId: string): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/compact`, {});
  }

  async questions(sessionId: string): Promise<QuestionRequest[]> {
    const rows = await this.client.get<{ data?: unknown[] }>(`/api/session/${pathId(sessionId)}/form`);
    return (rows?.data ?? []).flatMap((row) => {
      const request = mapForm(row);
      return request ? [request] : [];
    });
  }

  async answerQuestion(sessionId: string, requestId: string, answers: Record<string, QuestionValue>): Promise<void> {
    await this.client.post(`/api/session/${pathId(sessionId)}/form/${pathId(requestId)}/reply`, { answer: answers });
  }

  async rejectQuestion(sessionId: string, requestId: string, message?: string): Promise<void> {
    await this.client.request("DELETE", `/api/session/${pathId(sessionId)}/form/${pathId(requestId)}`, message ? { query: { message } } : {});
  }

  async accounts(): Promise<AccountInfo[]> {
    type Row = { id?: unknown; name?: unknown; methods?: unknown[]; connections?: unknown[] };
    const [integrations, credentials] = await Promise.all([
      this.client.get<{ data?: Row[] }>("/api/integration"),
      // This route carries the secrets themselves (`value`): only the id and the flags are read, and nothing else is kept.
      this.client.get<{ data?: Array<{ id?: unknown; active?: unknown }> }>("/api/credential").catch(() => undefined),
    ]);
    const active = new Map((credentials?.data ?? []).flatMap((c): Array<[string, boolean]> => (typeof c.id === "string" ? [[c.id, c.active === true]] : [])));
    const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
    return (integrations?.data ?? []).flatMap((row): AccountInfo[] => {
      if (typeof row.id !== "string" || typeof row.name !== "string") return [];
      const methods = (row.methods ?? []).filter(isRecord);
      const oauth = methods.flatMap((m): OauthMethod[] => (m.type === "oauth" && typeof m.id === "string" ? [{ id: m.id, label: typeof m.label === "string" ? m.label : m.id, form: formOf(m.form) }] : []));
      const connections = (row.connections ?? []).filter(isRecord).flatMap((c): AccountConnection[] => {
        if (c.type === "env" && typeof c.name === "string") return [{ kind: "env", label: c.name, envName: c.name }];
        if (c.type === "credential" && typeof c.id === "string") return [{ kind: "credential", id: c.id, label: typeof c.label === "string" ? c.label : "Credential", method: typeof c.method === "string" ? c.method : undefined, active: active.get(c.id) }];
        return [];
      });
      return [{ id: row.id, name: row.name, key: methods.some((m) => m.type === "key"), oauth, connections }];
    });
  }

  async connectKey(integrationId: string, key: string, label?: string): Promise<void> {
    await this.client.post(`/api/integration/${pathId(integrationId)}/connect/key`, label ? { key, label } : { key });
  }

  async oauthStart(integrationId: string, methodId: string, answers: Record<string, string>): Promise<OauthAttempt> {
    const started = await this.client.post<{ data?: { attemptID?: unknown; url?: unknown; instructions?: unknown; mode?: unknown; time?: { expires?: unknown } } }>(`/api/integration/${pathId(integrationId)}/connect/oauth`, { methodID: methodId, ...(Object.keys(answers).length > 0 ? { answer: answers } : {}) });
    const d = started?.data;
    if (typeof d?.attemptID !== "string" || typeof d.url !== "string") throw new Error("opencode did not start the sign-in");
    return { attemptId: d.attemptID, url: d.url, instructions: typeof d.instructions === "string" ? d.instructions : "", mode: d.mode === "code" ? "code" : "auto", expiresAt: typeof d.time?.expires === "number" ? d.time.expires : undefined };
  }

  async oauthStatus(integrationId: string, attemptId: string): Promise<OauthStatus> {
    const s = await this.client.get<{ data?: { status?: unknown; message?: unknown } }>(`/api/integration/${pathId(integrationId)}/connect/oauth/${pathId(attemptId)}`);
    const status = (["pending", "complete", "failed", "expired"] as const).find((v) => v === s?.data?.status) ?? "unknown";
    return { status, message: typeof s?.data?.message === "string" ? s.data.message : undefined };
  }

  async oauthComplete(integrationId: string, attemptId: string, code?: string): Promise<void> {
    await this.client.post(`/api/integration/${pathId(integrationId)}/connect/oauth/${pathId(attemptId)}/complete`, code ? { code } : {});
  }

  async oauthCancel(integrationId: string, attemptId: string): Promise<void> {
    await this.client.request("DELETE", `/api/integration/${pathId(integrationId)}/connect/oauth/${pathId(attemptId)}`);
  }

  async disconnect(_integrationId: string, connectionId?: string): Promise<void> {
    if (!connectionId) throw new Error("no connection to remove");
    await this.client.request("DELETE", `/api/credential/${pathId(connectionId)}`);
  }

  async activate(credentialId: string): Promise<void> {
    await this.client.post(`/api/credential/${pathId(credentialId)}/activate`);
  }

  async mcpList(): Promise<McpServerInfo[]> {
    const rows = await this.client.get<{ data?: Array<{ name?: unknown; integrationID?: unknown; status?: { status?: unknown; error?: unknown } }> }>("/api/mcp");
    return (rows?.data ?? []).flatMap((row): McpServerInfo[] => {
      if (typeof row.name !== "string") return [];
      const raw = typeof row.status?.status === "string" ? row.status.status.toLowerCase().split("_").join("-") : "";
      const status: McpStatus = (["connected", "pending", "disabled", "failed", "needs-auth"] as const).find((s) => s === raw) ?? "unknown";
      const error = typeof row.status?.error === "string" ? row.status.error.replace(/\s+/g, " ").trim().slice(0, 240) : undefined;
      return [{ name: row.name, status, detail: error ?? (status === "unknown" && raw ? raw : undefined), ...(typeof row.integrationID === "string" ? { integrationId: row.integrationID } : {}) }];
    });
  }

  async mcpAdd(name: string, config: McpConfig): Promise<void> {
    await this.client.request("PUT", `/api/experimental/mcp/${encodeURIComponent(name)}`, { body: { config } });
  }

  async mcpSetEnabled(name: string, on: boolean): Promise<void> {
    await this.client.post(`/api/experimental/mcp/${encodeURIComponent(name)}/${on ? "connect" : "disconnect"}`);
  }

  async mcpRemove(name: string): Promise<void> {
    await this.client.request("DELETE", `/api/experimental/mcp/${encodeURIComponent(name)}`);
  }

  async skills(): Promise<SkillInfo[]> {
    const rows = await this.client.get<{ data?: Array<{ name?: unknown; description?: unknown; path?: unknown }> }>("/api/skill");
    return (rows?.data ?? []).flatMap((s): SkillInfo[] => (typeof s.name === "string" ? [{ name: s.name, description: typeof s.description === "string" ? s.description : undefined, path: typeof s.path === "string" ? s.path : undefined }] : []));
  }

  async plugins(): Promise<PluginInfo[]> {
    return mapPlugins(await this.client.get<{ data?: unknown[] }>("/api/plugin"));
  }

  async pluginsCheck(): Promise<PluginInfo[]> {
    return mapPlugins(await this.client.post<{ data?: unknown[] }>("/api/plugin/check", {}, { timeoutMs: 120_000 }));
  }

  async pluginsUpdate(targets: string[]): Promise<void> {
    await this.client.post("/api/plugin/update", { targets }, { timeoutMs: 180_000 });
  }

  readonly canWorktree = true;

  async projectId(directory: string): Promise<string | undefined> {
    const rows = await this.client.get<unknown>("/api/project");
    for (const row of Array.isArray(rows) ? rows : []) {
      const { id, canonical } = (row ?? {}) as { id?: unknown; canonical?: unknown };
      if (typeof id === "string" && typeof canonical === "string" && samePath(canonical, directory)) return id;
    }
    return undefined;
  }

  async listWorktrees(projectId: string): Promise<Array<{ directory: string; strategy?: string }>> {
    const rows = await this.client.get<unknown>("/api/worktree", { query: { projectID: projectId } });
    return (Array.isArray(rows) ? rows : []).flatMap((r): Array<{ directory: string; strategy?: string }> => {
      const { directory, strategy } = (r ?? {}) as { directory?: unknown; strategy?: unknown };
      return typeof directory === "string" ? [{ directory, strategy: typeof strategy === "string" ? strategy : undefined }] : [];
    });
  }

  async createWorktree(projectId: string, name: string): Promise<string> {
    const made = await this.client.post<{ directory?: unknown }>("/api/worktree", { projectID: projectId, name }, { timeoutMs: 120_000 });
    if (typeof made?.directory !== "string") throw new Error("opencode did not say where the worktree is");
    return made.directory;
  }

  async removeWorktree(projectId: string, directory: string, force: boolean): Promise<void> {
    await this.client.request("DELETE", "/api/worktree", { body: { projectID: projectId, directory, force }, timeoutMs: 120_000 });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/interrupt`);
  }

  async reply(sessionId: string, requestId: string, decision: "once" | "always" | "reject", message?: string): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/permission/${requestId}/reply`, message ? { decision, message } : { decision });
  }

  async pending(): Promise<PendingApproval[]> {
    const rows = await this.client.get<{ data?: Array<{ id?: string; sessionID?: string; action?: string; resources?: string[]; save?: string[] }> }>("/api/permission/request").catch(() => undefined);
    return (rows?.data ?? []).flatMap((r) => (r.id && r.action && r.sessionID ? [{ id: r.id, sessionId: r.sessionID, action: r.action, resources: r.resources ?? [], saves: r.save ?? [] }] : []));
  }

  async usage(): Promise<UsageSnapshot | undefined> {
    try {
      return mapUsageLimits(await this.client.get("/api/experimental/usage/limits"));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return undefined;
      throw error;
    }
  }

  async listSessions(directory: string, search?: string): Promise<SessionRow[]> {
    return mapSessionRows(await this.client.get("/api/session", { query: { limit: "50", order: "desc", directory, search: search && search.trim() !== "" ? search.trim() : undefined } }));
  }

  async fork(sessionId: string): Promise<string> {
    const created = await this.client.post<{ data?: { id?: string } }>(`/api/session/${sessionId}/fork`, {});
    const forked = created?.data?.id;
    if (!forked) throw new Error("opencode did not return the id of the fork");
    return forked;
  }

  async storedModel(sessionId: string): Promise<ModelRef | undefined> {
    const info = await this.client.get<{ data?: { model?: { id?: unknown; providerID?: unknown } } }>(`/api/session/${sessionId}`);
    const stored = info?.data?.model;
    return stored && typeof stored.id === "string" && typeof stored.providerID === "string" ? { providerId: stored.providerID, modelId: stored.id } : undefined;
  }

  async messages(sessionId: string): Promise<ReplayItem[]> {
    return replayItems(await this.client.get(`/api/session/${sessionId}/message`, { query: { order: "asc", limit: "200" } }));
  }

  mapEvent(raw: string, sessionId: string): MapResult[] {
    const frame = parseFrame(raw);
    return frame ? [mapFrame(frame, sessionId)] : [];
  }

  resetEvents(): void {}
}

/** An id from the page or the server that becomes part of a URL path: only the shapes opencode uses are let through. */
export function pathId(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(id)) throw new Error("not a valid id");
  return id;
}

/** The questions of a sign-in form, as far as Capella can ask them (text, or a choice of options). */
export function formOf(value: unknown): FormField[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f): FormField[] => {
    if (typeof f !== "object" || f === null) return [];
    const row = f as { key?: unknown; title?: unknown; required?: unknown; options?: unknown; hidden?: unknown; default?: unknown };
    if (typeof row.key !== "string") return [];
    const options = Array.isArray(row.options) ? row.options.flatMap((o): Array<{ value: string; label: string }> => (typeof o === "object" && o !== null && typeof (o as { value?: unknown }).value === "string" ? [{ value: (o as { value: string }).value, label: typeof (o as { label?: unknown }).label === "string" ? (o as { label: string }).label : (o as { value: string }).value }] : [])) : undefined;
    return [{ key: row.key, title: typeof row.title === "string" ? row.title : row.key, required: row.required === true, options: options && options.length > 0 ? options : undefined, hidden: row.hidden === true, default: typeof row.default === "string" ? row.default : undefined }];
  });
}

/**
 * The plugins of `GET /api/plugin` (or of a check), without opencode's own. Observed on 2.2.5: `source` is `{type: "package",
 * target, version?, outdated?, updating?}`, `{type: "local", path}`, `{type: "sdk"}` or `{type: "builtin"}`, and `state` is
 * `{status: "active"}` or `{status: "failed", error}`.
 */
export function mapPlugins(rows: { data?: unknown[] } | undefined): PluginInfo[] {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
  return (rows?.data ?? []).flatMap((row): PluginInfo[] => {
    if (!isRecord(row) || !isRecord(row.source)) return [];
    const source = row.source;
    if (source.type === "builtin") return [];
    const state = isRecord(row.state) ? row.state : {};
    const status = state.status === "active" || state.status === "failed" ? state.status : "unknown";
    const kind: PluginInfo["kind"] = source.type === "package" || source.type === "local" || source.type === "sdk" ? source.type : "unknown";
    const name = kind === "package" && typeof source.target === "string" ? source.target : kind === "local" && typeof source.path === "string" ? source.path : typeof row.id === "string" ? row.id : kind;
    return [
      {
        id: typeof row.id === "string" ? row.id : undefined,
        kind,
        name,
        version: typeof source.version === "string" ? source.version : undefined,
        outdated: source.outdated === true ? true : undefined,
        updating: source.updating === true ? true : undefined,
        state: status,
        error: typeof state.error === "string" ? state.error.replace(/\s+/g, " ").trim().slice(0, 300) : undefined,
      },
    ];
  });
}
