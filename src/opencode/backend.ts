/**
 * What a chat needs from opencode, independent of which generation of its API is running. `OpencodeSession` talks only to
 * this interface; `backend-v2.ts` implements it with the 2.x `/api/*` routes and `backend-v1.ts` with the stable legacy
 * routes of 1.x. The two differ in routes, in event shapes and in where the model and agent live (a 2.x session holds
 * them; a 1.x prompt carries them), and nothing above this file should have to know.
 */
import type { Generation } from "./compat.ts";
import type { MapResult, ModelInfo, QuestionRequest, QuestionValue } from "./events.ts";
import type { ReplayItem, SessionRow } from "./history.ts";
import type { Extras, ModeId, WebPolicy } from "./modes.ts";
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

/** How a message sent while the agent is working reaches it: after the current work (`queue`) or into it at its next step (`steer`). */
export type Delivery = "queue" | "steer";

export interface PromptOptions {
  delivery?: Delivery;
  /** Skills the user picked from the palette (2.x ids), invoked with this message. */
  skillIds?: string[];
}

/** One row of the `/` palette. */
export interface SlashEntry {
  kind: "command" | "skill";
  name: string;
  description?: string;
  /** 2.x: the id a prompt names to invoke the skill. */
  id?: string;
}

/** How an MCP server is doing, in opencode's words reduced to a few. */
export type McpStatus = "connected" | "pending" | "disabled" | "failed" | "needs-auth" | "unknown";

export interface McpServerInfo {
  name: string;
  status: McpStatus;
  /** The error when it failed, trimmed. */
  detail?: string;
  /** 2.x: the id its sign-in goes by (a server that needs a login is also an integration). */
  integrationId?: string;
}

/** What Capella can add: a program to start, or a server to reach. The environment and the headers carry secrets: they are only ever held in memory on the way to opencode. */
export type McpConfig = { type: "local"; command: string[]; cwd?: string; environment?: Record<string, string> } | { type: "remote"; url: string; headers?: Record<string, string> };

export interface SkillInfo {
  name: string;
  description?: string;
  /** Where its SKILL.md is, when opencode says (a built-in one has no file). */
  path?: string;
}

export interface PluginInfo {
  id?: string;
  source: string;
  state: string;
}

/** One question of a sign-in form (GitHub Copilot asks which GitHub it is, for instance). */
export interface FormField {
  key: string;
  title: string;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  /** Not asked: the default is used. */
  hidden?: boolean;
  default?: string;
}

export interface OauthMethod {
  id: string;
  label: string;
  form: FormField[];
}

/** One way a provider is connected: a credential opencode stores, or an environment variable it reads. Never the secret itself. */
export interface AccountConnection {
  id?: string;
  label: string;
  kind: "credential" | "env";
  method?: string;
  active?: boolean;
  envName?: string;
}

/** A provider (opencode calls it an integration) and how it is connected. Whitelisted: no key, token or refresh token passes through here. */
export interface AccountInfo {
  id: string;
  name: string;
  /** Can be connected by pasting an API key. */
  key: boolean;
  oauth: OauthMethod[];
  connections: AccountConnection[];
}

export interface OauthAttempt {
  attemptId: string;
  url: string;
  instructions: string;
  /** `auto`: opencode finishes by itself once the user has signed in; `code`: the user pastes a code back. */
  mode: "auto" | "code";
  expiresAt?: number;
}

export interface OauthStatus {
  status: "pending" | "complete" | "failed" | "expired" | "unknown";
  message?: string;
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
  createSession(mode: ModeId, model: ModelRef, effort?: string, web?: WebPolicy, extras?: Extras): Promise<string>;
  /** `effort` is one of the model's own variants (`low`, `high`...); undefined is the model's default. */
  selectModel(sessionId: string, model: ModelRef, effort?: string): Promise<void>;
  /** Replaces the permission rules (and agent) of a session with the mode's. */
  applyMode(sessionId: string, mode: ModeId, web?: WebPolicy, extras?: Extras): Promise<void>;
  /** Whether a message can be sent while a turn runs (2.x queues and steers; 1.x has no such delivery). */
  readonly canQueue: boolean;
  /** Returns the id the server gave the message (the queue entry), when it gives one. */
  prompt(sessionId: string, text: string, files: readonly PromptFile[], options?: PromptOptions): Promise<string | undefined>;
  /** Inbox ids of the user messages still waiting for their turn. */
  queued(sessionId: string): Promise<string[]>;
  dequeue(sessionId: string, inboxId: string): Promise<void>;
  steer(sessionId: string, inboxId: string): Promise<void>;
  /** The commands and skills for the `/` palette. */
  slash(): Promise<SlashEntry[]>;
  /** Runs a server command in the session. Resolves when the server has accepted it (1.x answers only when it is done, so that is not awaited). */
  runCommand(sessionId: string, name: string, args: string, files: readonly PromptFile[]): Promise<void>;
  /** Asks the server to summarise the conversation to free context. */
  compact(sessionId: string): Promise<void>;
  /** The questions the agent has asked this session and nobody has answered yet. */
  questions(sessionId: string): Promise<QuestionRequest[]>;
  /** Answers a question, keyed by the field keys of the request. Capella never answers by itself. */
  answerQuestion(sessionId: string, requestId: string, answers: Record<string, QuestionValue>): Promise<void>;
  /** Declines to answer. The agent is told the user did not answer. */
  rejectQuestion(sessionId: string, requestId: string, message?: string): Promise<void>;
  /** The providers and how each is connected, without any secret. */
  accounts(): Promise<AccountInfo[]>;
  /** Stores an API key in opencode for this provider. The key is never logged, echoed or kept by Capella. */
  connectKey(integrationId: string, key: string, label?: string): Promise<void>;
  oauthStart(integrationId: string, methodId: string, answers: Record<string, string>): Promise<OauthAttempt>;
  oauthStatus(integrationId: string, attemptId: string): Promise<OauthStatus>;
  oauthComplete(integrationId: string, attemptId: string, code?: string): Promise<void>;
  oauthCancel(integrationId: string, attemptId: string): Promise<void>;
  /** Removes one connection (2.x: a stored credential by id; 1.x: the provider's stored login). */
  disconnect(integrationId: string, connectionId?: string): Promise<void>;
  /** 2.x: makes this stored credential the one used. */
  activate(credentialId: string): Promise<void>;
  mcpList(): Promise<McpServerInfo[]>;
  /** Registers a server for this running opencode only (it is gone when the server restarts) and connects it. */
  mcpAdd(name: string, config: McpConfig): Promise<void>;
  mcpSetEnabled(name: string, on: boolean): Promise<void>;
  /** 2.x forgets the server; 1.x can only disconnect it. */
  mcpRemove(name: string): Promise<void>;
  skills(): Promise<SkillInfo[]>;
  plugins(): Promise<PluginInfo[]>;
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
