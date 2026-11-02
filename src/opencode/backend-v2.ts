import type { Backend, ModelRef, PendingApproval, PromptFile, PromptOptions, SlashEntry } from "./backend.ts";
import { ApiError, type OpencodeClient } from "./client.ts";
import { mapFrame, mapModels, parseFrame, type MapResult, type ModelInfo } from "./events.ts";
import { mapSessionRows, replayItems, type ReplayItem, type SessionRow } from "./history.ts";
import { modeById, rulesWith, type ModeId, type WebPolicy } from "./modes.ts";
import { mapUsageLimits, type UsageSnapshot } from "./usage.ts";

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

  async createSession(mode: ModeId, model: ModelRef, effort?: string, web: WebPolicy = "mode", folders: readonly string[] = []): Promise<string> {
    const m = modeById(mode);
    const created = await this.client.post<{ data?: { id?: string } }>("/api/session", { title: "Capella", agent: m.agent, permissions: rulesWith(m, web, folders) });
    const id = created?.data?.id;
    if (!id) throw new Error("opencode did not return a session id");
    await this.selectModel(id, model, effort);
    return id;
  }

  async selectModel(sessionId: string, model: ModelRef, effort?: string): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/model`, { model: { id: model.modelId, providerID: model.providerId, ...(effort ? { variant: effort } : {}) } });
  }

  async applyMode(sessionId: string, mode: ModeId, web: WebPolicy = "mode", folders: readonly string[] = []): Promise<void> {
    const m = modeById(mode);
    await this.client.request("PATCH", `/api/session/${sessionId}`, { body: { permissions: rulesWith(m, web, folders) } });
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
