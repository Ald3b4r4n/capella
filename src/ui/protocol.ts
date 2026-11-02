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

/** Messages the extension sends to the page. Plain data only: nothing here carries a secret. */
export type ToWebview =
  | { type: "init"; version?: string; workspace: string; modes: ModeRow[]; mode: string; models: ModelRow[]; model?: string; features?: { history: boolean } }
  | { type: "event"; event: SessionEvent }
  | { type: "user"; text: string; files?: Array<{ name: string; mime: string; thumb?: string }> }
  | { type: "attachments"; items: AttachmentView[] }
  /** The messages waiting for their turn; `canQueue` is false on opencode 1.x, which has no queue. */
  | { type: "queue"; items: QueueItemView[]; canQueue: boolean }
  /** A queued message has just been taken into the turn: it joins the conversation here. */
  | { type: "delivered"; text: string; files?: Array<{ name: string; mime: string; thumb?: string }> }
  | { type: "slash"; entries: SlashEntryView[] }
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
