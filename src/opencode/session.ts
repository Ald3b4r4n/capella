import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { AccountInfo, Backend, McpConfig, McpServerInfo, ModelRef, OauthAttempt, OauthStatus, PluginInfo, PromptFile, PromptOptions, SkillInfo, SlashEntry } from "./backend.ts";
import { BackendV1 } from "./backend-v1.ts";
import { BackendV2 } from "./backend-v2.ts";
import { EventStream, OpencodeClient } from "./client.ts";
import { assess, type Compatibility, type Tested } from "./compat.ts";
import type { ChatEvent, ModelInfo, QuestionValue } from "./events.ts";
import type { ReplayItem, SessionRow } from "./history.ts";
import { DEFAULT_MODE, modeById, type ModeId, type WebPolicy } from "./modes.ts";
import { OpencodeServer, type OpencodeServerOptions } from "./server.ts";
import testedV1 from "./tested.v1.json" with { type: "json" };
import testedV2 from "./tested.json" with { type: "json" };
import type { UsageSnapshot } from "./usage.ts";
import { mapWorktrees, projectIdFromRoots, validWorktreeName, type WorktreeRow } from "./worktrees.ts";

export type ApprovalDecision = "once" | "always" | "reject";

export interface OpencodeSessionOptions extends OpencodeServerOptions {
  workspaceRoot: string;
  /** The user's own folder, when `workspaceRoot` is one of its worktrees (worktrees are listed and made from the project). */
  projectRoot?: string;
  mode?: ModeId;
  /** `providerID/modelID`. When absent, the user's own default model is resolved and selected explicitly. */
  model?: string;
}

/** Everything the UI is told besides turn content. */
export type SessionEvent =
  | ChatEvent
  | { type: "resync"; sessionId: string }
  | { type: "server-exit"; code: number | null }
  /** The model list was read again: what appeared, what went, and whether the last read failed (the old list is kept). */
  | { type: "catalog"; added: string[]; removed: string[]; stale?: string };

/** Frames that say the model list may have changed (provider, account or catalog updates), on 2.x and on 1.x. */
const CATALOG_FRAME = /"type"\s*:\s*"(?:model|provider|integration|catalog)\.updated"/;

/** The generation of opencode that answered: 2.x answers `/api/info`, 1.x answers `/global/health`. */
async function detectBackend(client: OpencodeClient): Promise<Backend> {
  const v2 = await client.get<{ version?: unknown }>("/api/info").catch(() => undefined);
  if (v2 && typeof v2.version === "string") return new BackendV2(client);
  const v1 = await client.get<{ version?: unknown }>("/global/health").catch(() => undefined);
  if (v1 && typeof v1.version === "string") return new BackendV1(client);
  throw new Error("This opencode answered neither as 2.x (/api/info) nor as 1.x (/global/health), so Capella cannot talk to it.");
}

export const testedFor = (generation: "v1" | "v2"): Tested => (generation === "v1" ? testedV1 : testedV2);

/**
 * One chat over one `opencode serve` child. Emits "event" (SessionEvent) and "exit". It works with either generation of
 * opencode's API through a `Backend` (backend.ts) and does not know which.
 *
 * Rules this class keeps:
 * - A model is always selected explicitly, and a failed selection stops the send: a session with no model runs on the
 *   user's default provider, which may be metered, without the UI having said so.
 * - Approvals are only relayed. `answerApproval` sends exactly what the user picked and nothing else.
 * - The event stream is volatile, so after a reconnect `resync` tells the UI to re-read the messages, and pending
 *   permission requests are fetched again (a request raised while disconnected would otherwise be lost, and the
 *   turn would wait on it forever).
 */
export class OpencodeSession extends EventEmitter {
  private readonly options: OpencodeSessionOptions;
  private readonly server: OpencodeServer;
  private client?: OpencodeClient;
  private backend?: Backend;
  private stream?: EventStream;
  private sessionId?: string;
  private starting?: Promise<void>;
  private catalog: ModelInfo[] = [];
  private model?: ModelRef;
  /** One of the current model's own variants; undefined means its default. Cleared when the model changes. */
  private effortValue?: string;
  private mode: ModeId;
  private webPolicy: WebPolicy = "mode";
  private extraFolders: string[] = [];
  /** Names of the MCP servers the permission rules cover. */
  private mcpNames: string[] = [];
  private readonly announced = new Set<string>();
  private catalogTimer?: NodeJS.Timeout;

  version?: string;
  /** `v2` for opencode 2.x, `v1` for 1.x; undefined until the server answered. */
  generation?: "v1" | "v2";
  /** What this opencode offers against what Capella needs; undefined until the server answered. */
  compat?: Compatibility;
  /** How many frames the mapper did not recognise, by type: the compatibility diagnostics read this. */
  readonly unknownEvents = new Map<string, number>();

  constructor(options: OpencodeSessionOptions) {
    super();
    this.options = options;
    this.server = new OpencodeServer({ ...options, cwd: options.workspaceRoot });
    this.mode = options.mode ?? DEFAULT_MODE;
    if (options.model) this.model = parseModelRef(options.model);
    this.server.on("stderr", (line: string) => this.emit("stderr", line));
    this.server.on("exit", (code: number | null) => this.emit("event", { type: "server-exit", code } satisfies SessionEvent));
  }

  get currentMode(): ModeId {
    return this.mode;
  }

  get models(): readonly ModelInfo[] {
    return this.catalog;
  }

  get currentModel(): ModelRef | undefined {
    return this.model;
  }

  get web(): WebPolicy {
    return this.webPolicy;
  }

  /** Folders outside the project that the user opened to this chat. */
  get folders(): readonly string[] {
    return this.extraFolders;
  }

  get effort(): string | undefined {
    return this.effortValue;
  }

  get id(): string | undefined {
    return this.sessionId;
  }

  /**
   * The user's own folder: the one worktrees belong to. In its real form (links and Windows short names resolved), which is
   * how opencode names it, so that the project is not taken for one of its own worktrees.
   */
  get projectRoot(): string {
    const given = this.options.projectRoot ?? this.options.workspaceRoot;
    try {
      return realpathSync.native(given);
    } catch {
      return given;
    }
  }

  get canWorktree(): boolean {
    return this.backend?.canWorktree ?? false;
  }

  /** Starts the server, reads the version and the model catalog and opens the event stream. No model call. */
  start(): Promise<void> {
    this.starting ??= this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const endpoint = await this.server.start();
    const client = new OpencodeClient(endpoint, this.options.workspaceRoot);
    this.client = client;
    const backend = await detectBackend(client);
    this.backend = backend;
    this.generation = backend.generation;
    this.version = await backend.version();
    // The server's own API description decides compatibility, not the version string. Failing to read it is not fatal.
    this.compat = assess(await backend.contract(), this.version, testedFor(backend.generation));
    this.catalog = await backend.models();
    this.stream = new EventStream(client, backend.eventPath, {
      onMessage: (message) => this.onMessage(message.data),
      onReconnect: () => void this.resync(),
      onError: () => undefined,
    });
    this.stream.start();
  }

  private requireBackend(): Backend {
    if (!this.backend) throw new Error("the opencode server is not running");
    return this.backend;
  }

  /**
   * Reads the model list again. A failed read keeps the last good list and says so (the list may be out of date); an
   * empty list after a good one counts as a failure, not as "no models". Changes are reported as ids.
   */
  async refreshModels(): Promise<void> {
    const backend = this.requireBackend();
    let fresh: ModelInfo[];
    try {
      fresh = await backend.models();
      if (fresh.length === 0 && this.catalog.length > 0) throw new Error("opencode returned an empty model list");
    } catch (error) {
      this.emit("event", { type: "catalog", added: [], removed: [], stale: error instanceof Error ? error.message : String(error) } satisfies SessionEvent);
      return;
    }
    const key = (m: ModelInfo) => `${m.providerId}/${m.modelId}`;
    const before = new Set(this.catalog.map(key));
    const after = new Set(fresh.map(key));
    const added = [...after].filter((k) => !before.has(k));
    const removed = [...before].filter((k) => !after.has(k));
    this.catalog = fresh;
    this.emit("event", { type: "catalog", added, removed } satisfies SessionEvent);
  }

  private scheduleCatalogRefresh(): void {
    clearTimeout(this.catalogTimer);
    // Several updates arrive together when an account or catalog changes: one read after they settle.
    this.catalogTimer = setTimeout(() => void this.refreshModels(), 1500);
  }

  private onMessage(raw: string): void {
    if (CATALOG_FRAME.test(raw)) this.scheduleCatalogRefresh();
    if (!this.sessionId || !this.backend) return;
    for (const result of this.backend.mapEvent(raw, this.sessionId)) {
      if (result.kind === "unknown") {
        this.unknownEvents.set(result.eventType, (this.unknownEvents.get(result.eventType) ?? 0) + 1);
        continue;
      }
      if (result.kind === "ignored") continue;
      const event = result.event;
      // The host announces a request on the event stream and in the pending list: show each request once.
      if (event.type === "approval-requested") {
        if (this.announced.has(event.requestId)) continue;
        this.announced.add(event.requestId);
      }
      if (event.type === "question-asked") {
        if (this.announced.has(event.request.requestId)) continue;
        this.announced.add(event.request.requestId);
      }
      this.emit("event", event satisfies SessionEvent);
    }
  }

  private async resync(): Promise<void> {
    if (!this.sessionId) return;
    this.emit("event", { type: "resync", sessionId: this.sessionId } satisfies SessionEvent);
    await this.surfacePendingApprovals();
  }

  /** Raises approvals and questions that are pending on the host but were never seen on the stream. */
  async surfacePendingApprovals(): Promise<void> {
    if (!this.sessionId || !this.backend) return;
    for (const request of await this.backend.questions(this.sessionId).catch(() => [])) {
      if (this.announced.has(request.requestId)) continue;
      this.announced.add(request.requestId);
      this.emit("event", { type: "question-asked", sessionId: this.sessionId, request } satisfies SessionEvent);
    }
    for (const row of await this.backend.pending()) {
      if (row.sessionId !== this.sessionId || this.announced.has(row.id)) continue;
      this.announced.add(row.id);
      this.emit("event", { type: "approval-requested", sessionId: this.sessionId, requestId: row.id, action: row.action, resources: row.resources, saves: row.saves } satisfies SessionEvent);
    }
  }

  /** Resolves the model to use: the chosen one, else the user's own default (identifiers only, never its settings). */
  async resolveModel(): Promise<ModelRef> {
    if (this.model) return this.model;
    const found = await this.requireBackend().defaultModel();
    if (!found) throw new Error("opencode has no default model; choose one in the model picker");
    this.model = found;
    return found;
  }

  private async ensureSession(): Promise<string> {
    await this.start();
    if (this.sessionId) return this.sessionId;
    const backend = this.requireBackend();
    const model = await this.resolveModel();
    const id = await backend.createSession(this.mode, model, this.effortValue, this.webPolicy, await this.extras(backend));
    this.sessionId = id;
    backend.resetEvents();
    this.model = model;
    return id;
  }

  async setModel(ref: string): Promise<void> {
    const model = parseModelRef(ref);
    // A variant belongs to one model: a new model starts at its default.
    if (this.sessionId) await this.requireBackend().selectModel(this.sessionId, model);
    this.model = model;
    this.effortValue = undefined;
  }

  /** Picks one of the current model's variants (its reasoning effort); undefined returns to the model's default. */
  async setEffort(effort: string | undefined): Promise<void> {
    await this.start();
    const model = await this.resolveModel();
    const allowed = this.catalog.find((m) => m.providerId === model.providerId && m.modelId === model.modelId)?.variants ?? [];
    if (effort !== undefined && !allowed.includes(effort)) throw new Error(`${effort} is not one of this model's options`);
    if (this.sessionId) await this.requireBackend().selectModel(this.sessionId, model, effort);
    this.effortValue = effort;
  }

  /** What the permission rules add to the mode: the folders opened to this chat and the MCP servers there are. */
  private async extras(backend: Backend = this.requireBackend()): Promise<{ folders: string[]; mcp: string[] }> {
    // Read fresh each time: a server may have been added or removed since the rules were last written.
    this.mcpNames = (await backend.mcpList().catch(() => undefined))?.map((s) => s.name) ?? this.mcpNames;
    return { folders: this.extraFolders, mcp: this.mcpNames };
  }

  private worktreeProject?: string;

  /** The id opencode knows the project by: from its list of projects, else (a git folder it has not met yet) its first commit. */
  private async projectId(backend: Backend): Promise<string> {
    if (this.worktreeProject) return this.worktreeProject;
    const known = await backend.projectId(this.projectRoot);
    const id = known ?? (await new Promise<string | undefined>((resolve) => execFile("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: this.projectRoot, timeout: 15000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : projectIdFromRoots(stdout)))));
    if (!id) throw new Error("opencode does not know this folder yet (it must be a git repository with a commit). Send a first message in it, then try again.");
    this.worktreeProject = id;
    return id;
  }

  /** The project and the worktrees opencode made from it. */
  async worktrees(): Promise<WorktreeRow[]> {
    await this.start();
    const backend = this.requireBackend();
    if (!backend.canWorktree) throw new Error("Worktrees need opencode 2.x.");
    return mapWorktrees(await backend.listWorktrees(await this.projectId(backend)), this.projectRoot);
  }

  /** Makes a worktree and returns its folder. The name becomes a folder and a branch name, so only plain names are taken. */
  async createWorktree(name: string): Promise<string> {
    await this.start();
    if (!validWorktreeName(name)) throw new Error("That is not a name a worktree can have.");
    const backend = this.requireBackend();
    if (!backend.canWorktree) throw new Error("Worktrees need opencode 2.x.");
    return backend.createWorktree(await this.projectId(backend), name);
  }

  /**
   * Removes a worktree. Only a folder that opencode lists as one of this project's worktrees can be removed: never the project
   * itself, and never a path the page or a model made up.
   */
  async removeWorktree(directory: string, force: boolean): Promise<void> {
    const rows = await this.worktrees();
    const row = rows.find((r) => r.directory === directory);
    if (!row || row.kind !== "worktree" || !row.removable) throw new Error("That folder is not one of this project's worktrees.");
    const backend = this.requireBackend();
    await backend.removeWorktree(await this.projectId(backend), row.directory, force);
  }

  async mcpList(): Promise<McpServerInfo[]> {
    return this.requireBackend().mcpList();
  }

  async accounts(): Promise<AccountInfo[]> {
    return this.requireBackend().accounts();
  }

  async connectKey(integrationId: string, key: string, label?: string): Promise<void> {
    await this.requireBackend().connectKey(integrationId, key, label);
  }

  async oauthStart(integrationId: string, methodId: string, answers: Record<string, string>): Promise<OauthAttempt> {
    return this.requireBackend().oauthStart(integrationId, methodId, answers);
  }

  async oauthStatus(integrationId: string, attemptId: string): Promise<OauthStatus> {
    return this.requireBackend().oauthStatus(integrationId, attemptId);
  }

  async oauthComplete(integrationId: string, attemptId: string, code?: string): Promise<void> {
    await this.requireBackend().oauthComplete(integrationId, attemptId, code);
  }

  async oauthCancel(integrationId: string, attemptId: string): Promise<void> {
    await this.requireBackend().oauthCancel(integrationId, attemptId).catch(() => undefined);
  }

  async disconnect(integrationId: string, connectionId?: string): Promise<void> {
    await this.requireBackend().disconnect(integrationId, connectionId);
  }

  async activate(credentialId: string): Promise<void> {
    await this.requireBackend().activate(credentialId);
  }

  /** Adds a server and rewrites the rules so that its tools are asked about like the rest. */
  async mcpAdd(name: string, config: McpConfig): Promise<void> {
    const backend = this.requireBackend();
    await backend.mcpAdd(name, config);
    if (this.sessionId) await backend.applyMode(this.sessionId, this.mode, this.webPolicy, await this.extras());
  }

  async mcpSetEnabled(name: string, on: boolean): Promise<void> {
    await this.requireBackend().mcpSetEnabled(name, on);
  }

  async mcpRemove(name: string): Promise<void> {
    await this.requireBackend().mcpRemove(name);
  }

  async skills(): Promise<SkillInfo[]> {
    return this.requireBackend().skills().catch(() => []);
  }

  async pluginsCheck(): Promise<PluginInfo[]> {
    return this.requireBackend().pluginsCheck();
  }

  async pluginsUpdate(targets: string[]): Promise<void> {
    await this.requireBackend().pluginsUpdate(targets);
  }

  async plugins(): Promise<PluginInfo[]> {
    return this.requireBackend().plugins().catch(() => []);
  }

  /** Whether a message can be sent while a turn runs. Known once the server answered. */
  get canQueue(): boolean {
    return this.backend?.canQueue ?? false;
  }

  /**
   * Sends one user message. Returns when the host has accepted it (with the id the server gave it, which a queued message is
   * known by); the turn then streams as events.
   */
  async send(text: string, files: readonly PromptFile[] = [], options?: PromptOptions): Promise<string | undefined> {
    const id = await this.ensureSession();
    return this.requireBackend().prompt(id, text, files, options);
  }

  async queued(): Promise<string[]> {
    return this.sessionId ? this.requireBackend().queued(this.sessionId) : [];
  }

  async dequeue(inboxId: string): Promise<void> {
    if (this.sessionId) await this.requireBackend().dequeue(this.sessionId, assertId(inboxId, "msg"));
  }

  async steer(inboxId: string): Promise<void> {
    if (this.sessionId) await this.requireBackend().steer(this.sessionId, assertId(inboxId, "msg"));
  }

  /** The commands and skills the `/` palette offers. An empty list when the server does not say. */
  async slash(): Promise<SlashEntry[]> {
    return this.requireBackend().slash().catch(() => []);
  }

  async runCommand(name: string, args: string, files: readonly PromptFile[] = []): Promise<void> {
    const id = await this.ensureSession();
    await this.requireBackend().runCommand(id, name, args, files);
  }

  async compact(): Promise<void> {
    const id = await this.ensureSession();
    await this.requireBackend().compact(id);
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    await this.requireBackend().interrupt(this.sessionId);
  }

  /** Relays the user's answer to a question of the agent. Only ever called for what the user typed or chose. */
  async answerQuestion(requestId: string, answers: Record<string, QuestionValue>): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    await this.requireBackend().answerQuestion(this.sessionId, requestId, answers);
  }

  async rejectQuestion(requestId: string, message?: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    await this.requireBackend().rejectQuestion(this.sessionId, requestId, message);
  }

  /** Relays the user's pick for one approval. `always` remembers the host's own suggested patterns. */
  async answerApproval(requestId: string, decision: ApprovalDecision, message?: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    await this.requireBackend().reply(this.sessionId, assertId(requestId, "per"), decision, message);
  }

  /** Changes the mode of a live session: the mode's rules replace the session's, and so does the agent. Not during a turn. */
  async setMode(id: ModeId): Promise<void> {
    const mode = modeById(id);
    if (this.sessionId) await this.requireBackend().applyMode(this.sessionId, mode.id, this.webPolicy, await this.extras());
    this.mode = mode.id;
  }

  /** Web access of this chat, laid over the mode's rules. Not during a turn; the caller checks. */
  async setWeb(policy: WebPolicy): Promise<void> {
    if (this.sessionId) await this.requireBackend().applyMode(this.sessionId, this.mode, policy, await this.extras());
    this.webPolicy = policy;
  }

  /** Replaces the folders opened to this chat. The new set takes effect at once on a live session. Not during a turn; the caller checks. */
  async setFolders(folders: readonly string[]): Promise<void> {
    this.extraFolders = [...folders];
    if (this.sessionId) await this.requireBackend().applyMode(this.sessionId, this.mode, this.webPolicy, await this.extras());
  }

  /** OpenCode Go allowance and Console budgets. Undefined when not signed in or when this opencode has none (1.x has none). */
  async usage(): Promise<UsageSnapshot | undefined> {
    return this.requireBackend().usage();
  }

  /** Stored sessions of this folder, newest first. */
  async listSessions(search?: string): Promise<SessionRow[]> {
    await this.start();
    return this.requireBackend().listSessions(this.options.workspaceRoot, search);
  }

  /** A new stored session that continues from another one. Returns its id; call `resume` to open it. */
  async fork(id: string): Promise<string> {
    await this.start();
    return this.requireBackend().fork(assertId(id, "ses"));
  }

  /**
   * Opens a stored session in this chat and returns its conversation, oldest first. The session's own model is kept (and
   * selected explicitly), but its permissions are NOT: they are replaced by the rules of the mode this chat is in, so
   * a chat stored under "Bypass" never comes back more permissive than the chat the user is looking at.
   */
  async resume(id: string): Promise<ReplayItem[]> {
    await this.start();
    assertId(id, "ses");
    const backend = this.requireBackend();
    const stored = await backend.storedModel(id);
    this.sessionId = id;
    this.announced.clear();
    backend.resetEvents();
    if (stored) {
      this.model = stored;
      this.effortValue = undefined;
    }
    await backend.applyMode(id, this.mode, this.webPolicy, await this.extras(backend));
    if (this.model) await backend.selectModel(id, this.model, this.effortValue);
    const items = await backend.messages(id);
    await this.surfacePendingApprovals();
    return items;
  }

  async dispose(): Promise<void> {
    clearTimeout(this.catalogTimer);
    this.stream?.stop();
    await this.server.stop();
  }
}

/** Ids from the page become part of a URL path: only the shapes opencode really uses are let through (`ses_...`, `per_...`). */
export function assertId(id: string, prefix: "ses" | "per" | "msg"): string {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id)) throw new Error(`not a valid ${prefix === "ses" ? "session" : prefix === "msg" ? "queued message" : "permission request"} id`);
  return id;
}

export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`model must look like providerID/modelID, got "${ref}"`);
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
