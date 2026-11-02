import type { Backend, ModelRef, PendingApproval, PromptFile } from "./backend.ts";
import { ApiError, type OpencodeClient } from "./client.ts";
import { mapFrame, mapModels, parseFrame, type MapResult, type ModelInfo } from "./events.ts";
import { mapSessionRows, replayItems, type ReplayItem, type SessionRow } from "./history.ts";
import { modeById, type ModeId } from "./modes.ts";
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

  async createSession(mode: ModeId, model: ModelRef): Promise<string> {
    const m = modeById(mode);
    const created = await this.client.post<{ data?: { id?: string } }>("/api/session", { title: "Capella", agent: m.agent, permissions: m.rules });
    const id = created?.data?.id;
    if (!id) throw new Error("opencode did not return a session id");
    await this.selectModel(id, model);
    return id;
  }

  async selectModel(sessionId: string, model: ModelRef): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/model`, { model: { id: model.modelId, providerID: model.providerId } });
  }

  async applyMode(sessionId: string, mode: ModeId): Promise<void> {
    const m = modeById(mode);
    await this.client.request("PATCH", `/api/session/${sessionId}`, { body: { permissions: m.rules } });
    await this.client.post(`/api/session/${sessionId}/agent`, { agent: m.agent });
  }

  async prompt(sessionId: string, text: string, files: readonly PromptFile[]): Promise<void> {
    await this.client.post(`/api/session/${sessionId}/prompt`, files.length > 0 ? { text, files: files.map((f) => ({ uri: f.uri, name: f.name })) } : { text });
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
