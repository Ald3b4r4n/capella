import { EventEmitter } from "node:events";
import type { Backend, ModelRef, PromptFile } from "./backend.ts";
import { BackendV1 } from "./backend-v1.ts";
import { BackendV2 } from "./backend-v2.ts";
import { EventStream, OpencodeClient } from "./client.ts";
import { assess, type Compatibility, type Tested } from "./compat.ts";
import type { ChatEvent, ModelInfo } from "./events.ts";
import type { ReplayItem, SessionRow } from "./history.ts";
import { DEFAULT_MODE, modeById, type ModeId } from "./modes.ts";
import { OpencodeServer, type OpencodeServerOptions } from "./server.ts";
import testedV1 from "./tested.v1.json" with { type: "json" };
import testedV2 from "./tested.json" with { type: "json" };
import type { UsageSnapshot } from "./usage.ts";

export type ApprovalDecision = "once" | "always" | "reject";

export interface OpencodeSessionOptions extends OpencodeServerOptions {
  workspaceRoot: string;
  mode?: ModeId;
  /** `providerID/modelID`. When absent, the user's own default model is resolved and selected explicitly. */
  model?: string;
}

/** Everything the UI is told besides turn content. */
export type SessionEvent = ChatEvent | { type: "resync"; sessionId: string } | { type: "server-exit"; code: number | null };

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
  private mode: ModeId;
  private readonly announced = new Set<string>();

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

  get id(): string | undefined {
    return this.sessionId;
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

  private onMessage(raw: string): void {
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
      this.emit("event", event satisfies SessionEvent);
    }
  }

  private async resync(): Promise<void> {
    if (!this.sessionId) return;
    this.emit("event", { type: "resync", sessionId: this.sessionId } satisfies SessionEvent);
    await this.surfacePendingApprovals();
  }

  /** Raises approvals that are pending on the host but were never seen on the stream. */
  async surfacePendingApprovals(): Promise<void> {
    if (!this.sessionId || !this.backend) return;
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
    const id = await backend.createSession(this.mode, model);
    this.sessionId = id;
    backend.resetEvents();
    this.model = model;
    return id;
  }

  async setModel(ref: string): Promise<void> {
    const model = parseModelRef(ref);
    if (this.sessionId) await this.requireBackend().selectModel(this.sessionId, model);
    this.model = model;
  }

  /** Sends one user message. Returns when the host has accepted it; the turn then streams as events. */
  async send(text: string, files: readonly PromptFile[] = []): Promise<void> {
    const id = await this.ensureSession();
    await this.requireBackend().prompt(id, text, files);
  }

  async interrupt(): Promise<void> {
    if (!this.sessionId) return;
    await this.requireBackend().interrupt(this.sessionId);
  }

  /** Relays the user's pick for one approval. `always` remembers the host's own suggested patterns. */
  async answerApproval(requestId: string, decision: ApprovalDecision, message?: string): Promise<void> {
    if (!this.sessionId) throw new Error("no session");
    await this.requireBackend().reply(this.sessionId, assertId(requestId, "per"), decision, message);
  }

  /** Changes the mode of a live session: the mode's rules replace the session's, and so does the agent. Not during a turn. */
  async setMode(id: ModeId): Promise<void> {
    const mode = modeById(id);
    if (this.sessionId) await this.requireBackend().applyMode(this.sessionId, mode.id);
    this.mode = mode.id;
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
    if (stored) this.model = stored;
    await backend.applyMode(id, this.mode);
    if (this.model) await backend.selectModel(id, this.model);
    const items = await backend.messages(id);
    await this.surfacePendingApprovals();
    return items;
  }

  async dispose(): Promise<void> {
    this.stream?.stop();
    await this.server.stop();
  }
}

/** Ids from the page become part of a URL path: only the shapes opencode really uses are let through (`ses_...`, `per_...`). */
export function assertId(id: string, prefix: "ses" | "per"): string {
  if (!new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(id)) throw new Error(`not a valid ${prefix === "ses" ? "session" : "permission request"} id`);
  return id;
}

export function parseModelRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) throw new Error(`model must look like providerID/modelID, got "${ref}"`);
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
