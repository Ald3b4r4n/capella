/**
 * Stored sessions of a folder: the list, and how one is replayed in the chat. Shapes from the OpenAPI document of
 * opencode 2.2.5 and from real messages (`GET /api/session/{id}/message`, newest first unless `order=asc`):
 * `user {text}`, `assistant {content: [text | reasoning | tool], finish, tokens, cost, model}`, `idle {outcome}` and
 * housekeeping rows (`model-switched`...). Defensive throughout: an unknown row is skipped, never an error.
 */
import { mapTokens, type TokenUsage } from "./events.ts";

export interface SessionRow {
  id: string;
  title: string;
  updatedMs: number;
  costUsd?: number;
  outcome?: string;
  /** This session was started as a fork of another. */
  forked: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function mapSessionRows(body: unknown): SessionRow[] {
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const out: SessionRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = str(row.id);
    if (!id) continue;
    const time = isRecord(row.time) ? row.time : {};
    const title = (str(row.title) ?? "").trim();
    out.push({
      id,
      title: title === "" ? "Untitled chat" : title,
      updatedMs: num(time.updated) ?? num(time.created) ?? 0,
      costUsd: num(row.cost),
      outcome: str(row.outcome),
      forked: isRecord(row.fork),
    });
  }
  return out.sort((a, b) => b.updatedMs - a.updatedMs);
}

export type ReplayPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; callId: string; name: string; input: unknown; status: "done" | "failed" | "running"; text: string; error?: string };

export type ReplayItem =
  | { kind: "user"; text: string; files: Array<{ name: string; mime: string; thumb?: string }> }
  | { kind: "assistant"; parts: ReplayPart[]; tokens?: TokenUsage; failed?: string };

function toolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .filter((t) => t !== "")
    .join("\n");
}

function mapPart(part: unknown): ReplayPart | undefined {
  if (!isRecord(part)) return undefined;
  if (part.type === "text") return typeof part.text === "string" && part.text !== "" ? { kind: "text", text: part.text } : undefined;
  if (part.type === "reasoning") return typeof part.text === "string" && part.text !== "" ? { kind: "reasoning", text: part.text } : undefined;
  if (part.type !== "tool") return undefined;
  const callId = str(part.id);
  if (!callId) return undefined;
  const state = isRecord(part.state) ? part.state : {};
  const status = state.status === "completed" ? "done" : state.status === "error" ? "failed" : "running";
  const error = isRecord(state.error) ? (str(state.error.message) ?? str(state.error.type)) : undefined;
  return { kind: "tool", callId, name: str(part.name) ?? "tool", input: state.input, status, text: toolText(state.content), error };
}

/** Messages in any order become the chat's items, oldest first. */
export function replayItems(body: unknown): ReplayItem[] {
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  const created = (r: Record<string, unknown>) => (isRecord(r.time) ? (num(r.time.created) ?? 0) : 0);
  const items: ReplayItem[] = [];
  for (const row of [...rows].sort((a, b) => created(a) - created(b))) {
    if (row.type === "user") {
      const text = str(row.text);
      const files = (Array.isArray(row.files) ? row.files : []).filter(isRecord).map((f) => {
        const mime = str(f.mime) ?? "application/octet-stream";
        const data = str(f.data);
        // A small stored image can be shown again; anything else is just a name.
        const thumb = data && mime.startsWith("image/") && data.length <= 340_000 ? `data:${mime};base64,${data}` : undefined;
        return { name: str(f.name) ?? "attachment", mime, thumb };
      });
      if ((text !== undefined && text !== "") || files.length > 0) items.push({ kind: "user", text: text ?? "", files });
    } else if (row.type === "assistant") {
      const parts = (Array.isArray(row.content) ? row.content : []).map(mapPart).filter((p): p is ReplayPart => p !== undefined);
      const failed = row.finish === "error" ? (isRecord(row.error) ? (str(row.error.message) ?? "The step failed.") : "The step failed.") : undefined;
      if (parts.length > 0 || failed) items.push({ kind: "assistant", parts, tokens: mapTokens(row.tokens), failed });
    }
  }
  return items;
}

export function describeAge(updatedMs: number, now: number = Date.now()): string {
  const minutes = Math.floor((now - updatedMs) / 60000);
  if (!Number.isFinite(minutes) || updatedMs <= 0) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

// ---- opencode 1.x: the same two views from its legacy routes --------------------------------------------------------

/** `GET /session` on 1.x returns a bare array. Sessions started by a subagent (`parentID`) are not chats of the user. */
export function mapSessionRowsV1(body: unknown): SessionRow[] {
  const rows = Array.isArray(body) ? body.filter((r) => isRecord(r) && r.parentID === undefined) : [];
  return mapSessionRows({ data: rows });
}

/**
 * `GET /session/{id}/message` on 1.x: `[{info: {role, ...}, parts: [...]}]`, oldest first, one assistant message per model
 * step. Consecutive assistant messages are one answer to the user, so they are merged into one item.
 */
export function replayItemsV1(body: unknown): ReplayItem[] {
  const messages = Array.isArray(body) ? body.filter(isRecord) : [];
  const items: ReplayItem[] = [];
  for (const message of messages) {
    const info = isRecord(message.info) ? message.info : {};
    const parts = (Array.isArray(message.parts) ? message.parts : []).filter(isRecord);
    if (info.role === "user") {
      const text = parts.filter((p) => p.type === "text" && p.synthetic !== true).map((p) => str(p.text) ?? "").join("\n").trim();
      const files = parts
        .filter((p) => p.type === "file")
        .map((p) => {
          const mime = str(p.mime) ?? "application/octet-stream";
          const url = str(p.url) ?? "";
          const thumb = mime.startsWith("image/") && url.startsWith("data:") && url.length <= 340_000 ? url : undefined;
          return { name: str(p.filename) ?? "attachment", mime, thumb };
        });
      if (text !== "" || files.length > 0) items.push({ kind: "user", text, files });
    } else if (info.role === "assistant") {
      const mapped: ReplayPart[] = [];
      let tokens: TokenUsage | undefined;
      for (const p of parts) {
        if ((p.type === "text" || p.type === "reasoning") && typeof p.text === "string" && p.text !== "") mapped.push({ kind: p.type, text: p.text });
        else if (p.type === "tool" && typeof p.callID === "string") {
          const state = isRecord(p.state) ? p.state : {};
          const status = state.status === "completed" ? "done" : state.status === "error" ? "failed" : "running";
          mapped.push({ kind: "tool", callId: p.callID, name: str(p.tool) ?? "tool", input: state.input, status, text: str(state.output) ?? "", error: str(state.error) });
        } else if (p.type === "step-finish") {
          const t = isRecord(p.tokens) ? p.tokens : {};
          const cache = isRecord(t.cache) ? t.cache : {};
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          tokens = { input: (tokens?.input ?? 0) + n(t.input), output: (tokens?.output ?? 0) + n(t.output), reasoning: (tokens?.reasoning ?? 0) + n(t.reasoning), cacheRead: (tokens?.cacheRead ?? 0) + n(cache.read), cacheWrite: (tokens?.cacheWrite ?? 0) + n(cache.write) };
        }
      }
      const error = isRecord(info.error) && isRecord(info.error.data) ? str(info.error.data.message) : undefined;
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && !last.failed) {
        last.parts.push(...mapped);
        if (tokens) last.tokens = { input: (last.tokens?.input ?? 0) + tokens.input, output: (last.tokens?.output ?? 0) + tokens.output, reasoning: (last.tokens?.reasoning ?? 0) + tokens.reasoning, cacheRead: (last.tokens?.cacheRead ?? 0) + tokens.cacheRead, cacheWrite: (last.tokens?.cacheWrite ?? 0) + tokens.cacheWrite };
        if (error) last.failed = error;
      } else if (mapped.length > 0 || error) items.push({ kind: "assistant", parts: mapped, tokens, failed: error });
    }
  }
  return items;
}
