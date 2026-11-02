/**
 * opencode 1.x events turned into the same ChatEvents the 2.x mapper produces, so nothing above this file knows which
 * generation is running. Shapes observed on 1.19.5 (`scripts/probe-v1-turn.ts`): frames are `{id, type, properties}`;
 * a reply arrives as `message.part.updated` (text, reasoning, tool, step-start, step-finish) plus `message.part.delta`
 * for streaming text; `session.status` busy and `session.idle` bracket a turn; `permission.asked` / `permission.replied`.
 *
 * Unlike 2.x, 1.x does not say a part is "ended" or give an ordinal, and the user's own message arrives as a part too, so
 * this mapper keeps a little state: which messages are the user's, which part is text or reasoning, and what text a part
 * has shown so far.
 */
import { mapTurnError, type ChatEvent, type MapResult, type TurnError } from "./events.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Frames that are state chatter a chat never shows. */
const CHATTER = /^(server\.|plugin\.|catalog\.|integration\.|reference\.|project\.|vcs\.|lsp\.|file\.|installation\.|mcp\.|models-dev\.|global\.|pty\.|command\.|todo\.|tui\.|workspace\.|worktree\.|sync\.|question\.|session\.(created|updated|deleted|diff|compacted|status)|message\.(removed|part\.removed))/;

export function mapV1Error(value: unknown): TurnError | undefined {
  if (!isRecord(value)) return undefined;
  const data = isRecord(value.data) ? value.data : {};
  // The v2 classifier reads {type, message, status, response.body}: give it that shape.
  return mapTurnError({ type: str(value.name) ?? "unknown", message: str(data.message) ?? str(value.message) ?? "", status: typeof data.statusCode === "number" ? data.statusCode : undefined, response: { body: str(data.responseBody) ?? "" } });
}

export class V1EventMapper {
  private readonly roles = new Map<string, string>();
  private readonly kinds = new Map<string, { kind: "text" | "reasoning"; messageId: string; ordinal: number }>();
  private readonly shown = new Map<string, string>();
  private readonly ordinals = new Map<string, number>();
  private readonly tools = new Set<string>();
  private readonly toolDone = new Set<string>();
  private busy = false;
  private failed = false;

  reset(): void {
    this.roles.clear();
    this.kinds.clear();
    this.shown.clear();
    this.ordinals.clear();
    this.tools.clear();
    this.toolDone.clear();
    this.busy = false;
    this.failed = false;
  }

  /** One frame may yield several events (a tool's pending → running step, for instance). */
  map(raw: string, sessionId: string): MapResult[] {
    let frame: unknown;
    try {
      frame = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!isRecord(frame) || typeof frame.type !== "string") return [];
    const type = frame.type;
    const props = isRecord(frame.properties) ? frame.properties : {};
    if (CHATTER.test(type) && type !== "session.status") return [{ kind: "ignored" }];
    const owner = str(props.sessionID) ?? (isRecord(props.info) ? str(props.info.sessionID) : undefined) ?? (isRecord(props.part) ? str(props.part.sessionID) : undefined);
    if (owner !== undefined && owner !== sessionId) return [{ kind: "ignored" }];
    const ev = (e: ChatEvent): MapResult => ({ kind: "event", event: e });
    const out: MapResult[] = [];

    switch (type) {
      case "session.status": {
        const status = isRecord(props.status) ? str(props.status.type) : undefined;
        if (status === "busy" && !this.busy) {
          this.busy = true;
          this.failed = false;
          out.push(ev({ type: "turn-started", sessionId }));
        }
        // A model's free allowance is spent: 1.x keeps retrying quietly and never ends the turn, so end it here (the
        // backend then aborts the retry loop). Other retries are transient and stay silent.
        if (status === "retry" && isRecord(props.status) && this.busy && !this.failed) {
          const action = isRecord(props.status.action) ? props.status.action : {};
          if (str(action.reason) === "free_tier_limit") {
            this.busy = false;
            this.failed = true;
            const text = str(props.status.message) ?? str(action.message) ?? "Free usage exceeded";
            out.push(ev({ type: "turn-ended", sessionId, outcome: "failed", error: { type: "FreeTierLimit", message: text, status: 429, rateLimited: true } }));
          }
        }
        return out.length > 0 ? out : [{ kind: "ignored" }];
      }
      case "session.idle":
        this.busy = false;
        // After an error 1.x still sends idle: the turn already ended as failed.
        if (this.failed) {
          this.failed = false;
          return [{ kind: "ignored" }];
        }
        return [ev({ type: "turn-ended", sessionId, outcome: "succeeded" })];
      case "session.error": {
        // The turn already ended as failed (a spent free allowance); the abort that stops its retries lands here.
        if (this.failed) return [{ kind: "ignored" }];
        this.busy = false;
        this.failed = true;
        const error = mapV1Error(props.error);
        // A user stop is reported as an error named MessageAbortedError.
        const aborted = isRecord(props.error) && props.error.name === "MessageAbortedError";
        return [ev({ type: "turn-ended", sessionId, outcome: aborted ? "interrupted" : "failed", error: aborted ? undefined : error })];
      }
      case "message.updated": {
        const info = isRecord(props.info) ? props.info : {};
        const id = str(info.id);
        const role = str(info.role);
        if (id && role) this.roles.set(id, role);
        return [{ kind: "ignored" }];
      }
      case "message.part.delta": {
        const known = this.kinds.get(str(props.partID) ?? "");
        const delta = str(props.delta);
        if (!known || delta === undefined || props.field !== "text") return [{ kind: "ignored" }];
        this.shown.set(str(props.partID)!, (this.shown.get(str(props.partID)!) ?? "") + delta);
        return [ev({ type: known.kind, sessionId, messageId: known.messageId, ordinal: known.ordinal, delta })];
      }
      case "message.part.updated": {
        const part = isRecord(props.part) ? props.part : undefined;
        return part ? this.part(part, sessionId) : [{ kind: "ignored" }];
      }
      case "permission.asked": {
        const requestId = str(props.id);
        const action = str(props.permission);
        if (!requestId || !action) return [{ kind: "unknown", eventType: type }];
        const tool = isRecord(props.tool) ? props.tool : undefined;
        const source = tool && str(tool.messageID) && str(tool.callID) ? { messageId: str(tool.messageID)!, callId: str(tool.callID)! } : undefined;
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        return [ev({ type: "approval-requested", sessionId, requestId, action, resources: list(props.patterns), saves: list(props.always), source })];
      }
      case "permission.replied": {
        const requestId = str(props.requestID);
        const reply = str(props.reply);
        return requestId && reply ? [ev({ type: "approval-resolved", sessionId, requestId, reply })] : [{ kind: "unknown", eventType: type }];
      }
      default:
        return [{ kind: "unknown", eventType: type }];
    }
  }

  private part(part: Record<string, unknown>, sessionId: string): MapResult[] {
    const ev = (e: ChatEvent): MapResult => ({ kind: "event", event: e });
    const partId = str(part.id) ?? "";
    const messageId = str(part.messageID) ?? "";
    const type = str(part.type);
    // The user's own message is also a part: it is already on the page.
    const role = this.roles.get(messageId);
    if (role === "user") return [{ kind: "ignored" }];
    const out: MapResult[] = [];
    if (type === "text" || type === "reasoning") {
      // An unknown role with a text part that has no times is the user's message that arrived before its header.
      if (role === undefined && type === "text" && !isRecord(part.time)) return [{ kind: "ignored" }];
      let known = this.kinds.get(partId);
      if (!known) {
        const key = `${messageId}:${type}`;
        const ordinal = this.ordinals.get(key) ?? 0;
        this.ordinals.set(key, ordinal + 1);
        known = { kind: type, messageId, ordinal };
        this.kinds.set(partId, known);
      }
      const text = str(part.text) ?? "";
      const before = this.shown.get(partId) ?? "";
      // Text that arrived without deltas (a short part, or a missed delta) is shown as the difference.
      if (text.length > before.length && text.startsWith(before)) {
        out.push(ev({ type: known.kind, sessionId, messageId, ordinal: known.ordinal, delta: text.slice(before.length) }));
        this.shown.set(partId, text);
      }
      const end = isRecord(part.time) && typeof part.time.end === "number";
      if (end) out.push(ev({ type: known.kind === "text" ? "text-end" : "reasoning-end", sessionId, messageId, ordinal: known.ordinal, text }));
      return out.length > 0 ? out : [{ kind: "ignored" }];
    }
    if (type === "tool") {
      const callId = str(part.callID);
      const state = isRecord(part.state) ? part.state : {};
      const status = str(state.status);
      if (!callId) return [{ kind: "unknown", eventType: "message.part.updated:tool" }];
      if (!this.tools.has(callId)) {
        this.tools.add(callId);
        out.push(ev({ type: "tool-started", sessionId, messageId, callId, name: str(part.tool) ?? "tool" }));
      }
      if (status === "running") {
        out.push(ev({ type: "tool-input", sessionId, messageId, callId, input: state.input }), ev({ type: "tool-called", sessionId, messageId, callId, input: state.input }));
      } else if (status === "completed" && !this.toolDone.has(callId)) {
        this.toolDone.add(callId);
        out.push(ev({ type: "tool-input", sessionId, messageId, callId, input: state.input }), ev({ type: "tool-result", sessionId, messageId, callId, text: str(state.output) ?? "" }));
      } else if (status === "error" && !this.toolDone.has(callId)) {
        this.toolDone.add(callId);
        const message = str(state.error) ?? "The tool failed.";
        out.push(ev({ type: "tool-failed", sessionId, messageId, callId, errorType: /reject|denied|declined/i.test(message) ? "permission.rejected" : "tool.execution", message }));
      }
      return out.length > 0 ? out : [{ kind: "ignored" }];
    }
    if (type === "step-start") return [ev({ type: "step-started", sessionId, messageId })];
    if (type === "step-finish") {
      const t = isRecord(part.tokens) ? part.tokens : {};
      const cache = isRecord(t.cache) ? t.cache : {};
      return [ev({ type: "step-ended", sessionId, messageId, finish: str(part.reason) ?? "unknown", tokens: { input: num(t.input), output: num(t.output), reasoning: num(t.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) } })];
    }
    return [{ kind: "ignored" }];
  }
}
