import type { ReplayItem } from "../opencode/history.ts";
import type { SessionEvent } from "../opencode/session.ts";
import type { VoiceMessage } from "./voiceBridge.ts";

export interface ModeRow {
  id: string;
  label: string;
  description: string;
  dangerous: boolean;
  /** Colour hint for the mode chip. */
  tone: "plan" | "edit" | "danger" | "ask";
}

/** One attachment waiting to be sent, as the page may show it. The content itself stays in the extension. */
export interface AttachmentView {
  id: string;
  name: string;
  kind: "image" | "file" | "selection";
  mime: string;
  size: string;
  thumb?: string;
}

/** What one finished edit changed, for the diff shown under its tool card. */
export interface FileChangeView {
  callId: string;
  id: string;
  rel: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  lines: string[];
  more: boolean;
}

export interface ChangeRowView {
  id: string;
  rel: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  edits: number;
  changedSince: boolean;
}

export interface ModelRow {
  /** `providerID/modelID`, the form the host's model call and the settings use. */
  ref: string;
  label: string;
  family: "zen" | "go" | "other";
  free: boolean;
  /** The catalog lists image input; undefined when it does not say. */
  images?: boolean;
  /** The model's own reasoning-effort options, in the catalog's order; empty when it has none. */
  variants: string[];
}

/** One stored chat in the history list. */
export interface SessionRowView {
  id: string;
  title: string;
  age: string;
  forked: boolean;
  costUsd?: number;
}

/** The usage meter in the chat header: numbers only. */
export interface UsageView {
  windows: Array<{ label: string; percent: number; limited: boolean; reset: string }>;
  /** The numbers are older than a few minutes: the host has not been asked recently. */
  stale: boolean;
}

/** One message waiting for its turn, as the tray above the message box shows it. */
export interface QueueItemView {
  id: string;
  text: string;
  files: string[];
  delivery: "queue" | "steer";
}

/** One row of the `/` palette. */
export interface SlashEntryView {
  kind: "command" | "skill" | "builtin";
  name: string;
  description?: string;
}

/** One MCP server in the Tools panel. */
export interface McpRowView {
  name: string;
  status: "connected" | "pending" | "disabled" | "failed" | "needs-auth" | "unknown";
  detail?: string;
  /** Added through Capella: it can be removed here (and is started again in every chat of this project). */
  managed: boolean;
  /** What a managed server runs or reaches, and the names (never the values) of what it is given. */
  summary?: string;
  /** The server needs a browser sign-in and opencode offers one. */
  integrationId?: string;
}

/** One provider in the Accounts section: how it can be connected and how it is. No secret is ever part of it. */
export interface AccountView {
  id: string;
  name: string;
  /** Zen (the console) and Go: shown first. */
  featured: boolean;
  canKey: boolean;
  oauth: Array<{ id: string; label: string }>;
  connections: Array<{ id?: string; label: string; kind: "credential" | "env"; method?: string; active?: boolean; envName?: string }>;
}

export interface ToolsView {
  accounts: AccountView[];
  /** 1.x: no browser sign-in from here. */
  canOauth: boolean;
  mcp: McpRowView[];
  /** `managed`: installed from Capella, so it can be removed here. */
  skills: Array<{ name: string; description?: string; openable: boolean; managed: boolean }>;
  plugins: Array<{ name: string; kind: string; version?: string; outdated?: boolean; updating?: boolean; state: string; error?: string; removable: boolean }>;
  /** 2.x: plugins can be checked, updated, added and removed from here. */
  canManagePlugins: boolean;
  /** 1.x cannot forget a server: removing only disconnects it. */
  removeForgets: boolean;
  worktrees: WorktreesView;
}

/** The Worktrees section: the project and the separate copies of it (detached, no branch) a chat can work in. */
export interface WorktreesView {
  /** 2.x only. */
  supported: boolean;
  rows: Array<{ directory: string; name: string; kind: "project" | "worktree"; current: boolean; removable: boolean }>;
  /** Why the list could not be read (not a git repository, say). */
  problem?: string;
}

/** Messages the extension sends to the page. Plain data only: nothing here carries a secret. */
export type ToWebview =
  | { type: "init"; version?: string; workspace: string; /** The name of the worktree this chat works in, when it does. */ worktree?: string; modes: ModeRow[]; mode: string; models: ModelRow[]; model?: string; features?: { history: boolean } }
  | { type: "event"; event: SessionEvent }
  | { type: "user"; text: string; files?: Array<{ name: string; mime: string; thumb?: string }> }
  | { type: "attachments"; items: AttachmentView[] }
  /** The messages waiting for their turn; `canQueue` is false on opencode 1.x, which has no queue. */
  | { type: "queue"; items: QueueItemView[]; canQueue: boolean }
  /** A queued message has just been taken into the turn: it joins the conversation here. */
  | { type: "delivered"; text: string; files?: Array<{ name: string; mime: string; thumb?: string }> }
  | { type: "slash"; entries: SlashEntryView[] }
  | { type: "tools"; tools: ToolsView }
  /** Screenshots a tool result named (saved by the browser server in Capella's own folder), for the tool's card. */
  | { type: "toolImages"; callId: string; images: string[] }
  /** Folders outside the project that this chat may use. */
  | { type: "folders"; items: Array<{ path: string; name: string }> }
  /** An image an answer pointed to, read by the extension (inside the open folder only). */
  | { type: "image"; src: string; uri?: string; error?: string }
  | { type: "fileChange"; change: FileChangeView }
  | { type: "changes"; rows: ChangeRowView[] }
  | { type: "busy"; value: boolean }
  | { type: "mode"; id: string }
  | { type: "model"; ref: string }
  | { type: "notice"; text: string; error?: boolean }
  | { type: "usage"; usage: UsageView }
  | { type: "models"; models: ModelRow[]; model?: string }
  | { type: "effort"; effort?: string }
  | { type: "web"; policy: "mode" | "allow" | "deny" }
  | { type: "sessions"; rows: SessionRowView[] }
  | { type: "replay"; items: ReplayItem[] }
  | { type: "modelNote"; text: string }
  | VoiceMessage
  | { type: "reset" };

/** Messages the page sends to the extension. */
export type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string; delivery?: "queue" | "steer" }
  | { type: "unqueue"; id: string }
  | { type: "steerNow"; id: string }
  | { type: "listSlash" }
  | { type: "listTools" }
  | { type: "mcpToggle"; name: string; on: boolean }
  | { type: "mcpAdd" }
  | { type: "mcpAddBrowser" }
  | { type: "mcpRemove"; name: string }
  | { type: "mcpEdit"; name: string }
  | { type: "mcpTest"; name: string }
  | { type: "mcpSignIn"; name: string }
  | { type: "openSkill"; name: string }
  | { type: "pluginCheck" }
  | { type: "pluginUpdate"; target: string }
  | { type: "pluginAdd" }
  | { type: "pluginRemove"; target: string }
  | { type: "skillInstall" }
  | { type: "skillRemove"; name: string }
  | { type: "worktreeNew" }
  | { type: "worktreeChat"; directory: string }
  | { type: "worktreeOpen"; directory: string }
  | { type: "worktreeRemove"; directory: string }
  /** The user's answer to a question of the agent, keyed by the fields of the request. */
  | { type: "answerQuestion"; requestId: string; answers: Record<string, string | number | boolean | string[]> }
  | { type: "rejectQuestion"; requestId: string }
  /** `method`: "key", or the id of one of the provider's browser sign-ins. */
  | { type: "accountConnect"; id: string; method: string }
  | { type: "accountDisconnect"; id: string; connectionId?: string }
  | { type: "accountActivate"; connectionId: string }
  | { type: "addFolder" }
  | { type: "removeFolder"; path: string }
  | { type: "loadImage"; src: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "setMode"; id: string }
  | { type: "setModel"; ref: string }
  | { type: "decide"; requestId: string; decision: "once" | "always" | "reject"; message?: string }
  | { type: "copy"; text: string }
  | { type: "openLink"; url: string }
  | { type: "openUsage" }
  | { type: "listSessions"; search?: string }
  | { type: "openSession"; id: string; fork: boolean }
  | { type: "openPreview"; url: string }
  | { type: "previewMenu" }
  | { type: "refreshModels" }
  | { type: "setEffort"; effort?: string }
  | { type: "setWeb"; policy: "mode" | "allow" | "deny" }
  | { type: "pickFiles" }
  | { type: "addCurrentFile" }
  | { type: "addSelection" }
  | { type: "addData"; name: string; base64: string }
  | { type: "dropUris"; uris: string[] }
  | { type: "removeAttachment"; id: string }
  | { type: "voice"; action: "toggle" | "cancel" | "setup" }
  | { type: "listChanges" }
  | { type: "openDiff"; id: string }
  | { type: "openFile"; id: string };
