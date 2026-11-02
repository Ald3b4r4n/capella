/**
 * What a chat needs from opencode, independent of which generation of its API is running. `OpencodeSession` talks only to
 * this interface; `backend-v2.ts` implements it with the 2.x `/api/*` routes and `backend-v1.ts` with the stable legacy
 * routes of 1.x. The two differ in routes, in event shapes and in where the model and agent live (a 2.x session holds
 * them; a 1.x prompt carries them), and nothing above this file should have to know.
 */
import type { Generation } from "./compat.ts";
import type { MapResult, ModelInfo } from "./events.ts";
import type { ReplayItem, SessionRow } from "./history.ts";
import type { ModeId, WebPolicy } from "./modes.ts";
import type { UsageSnapshot } from "./usage.ts";

export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** A file or image that goes with a message. `mime` is only needed by 1.x and is derived when missing. */
export interface PromptFile {
  uri: string;
  name: string;
  mime?: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  action: string;
  resources: string[];
  saves: string[];
}

export interface Backend {
  readonly generation: Exclude<Generation, "unknown">;
  /** Path of the server-sent-events stream. */
  readonly eventPath: string;
  version(): Promise<string | undefined>;
  /** The server's own API description, for the compatibility check. Undefined when it cannot be read. */
  contract(): Promise<unknown>;
  /** The model catalog, whitelisted: provider settings (which hold API keys) never leave the backend. */
  models(): Promise<ModelInfo[]>;
  /** The user's own default model, identifiers only. */
  defaultModel(): Promise<ModelRef | undefined>;
  /** A new session in the given mode, on the given model. Returns its id. */
  createSession(mode: ModeId, model: ModelRef, effort?: string, web?: WebPolicy): Promise<string>;
  /** `effort` is one of the model's own variants (`low`, `high`...); undefined is the model's default. */
  selectModel(sessionId: string, model: ModelRef, effort?: string): Promise<void>;
  /** Replaces the permission rules (and agent) of a session with the mode's. */
  applyMode(sessionId: string, mode: ModeId, web?: WebPolicy): Promise<void>;
  prompt(sessionId: string, text: string, files: readonly PromptFile[]): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  reply(sessionId: string, requestId: string, decision: "once" | "always" | "reject", message?: string): Promise<void>;
  pending(): Promise<PendingApproval[]>;
  /** Go allowance and Console budgets; undefined when this opencode has none. */
  usage(): Promise<UsageSnapshot | undefined>;
  listSessions(directory: string, search?: string): Promise<SessionRow[]>;
  fork(sessionId: string): Promise<string>;
  /** The model a stored session ran on. */
  storedModel(sessionId: string): Promise<ModelRef | undefined>;
  /** The stored conversation, oldest first. */
  messages(sessionId: string): Promise<ReplayItem[]>;
  /** One raw event frame, as events for the chat. Stateful on 1.x. */
  mapEvent(raw: string, sessionId: string): MapResult[];
  /** Forget what the event mapper learned (a different session is now open). */
  resetEvents(): void;
}
