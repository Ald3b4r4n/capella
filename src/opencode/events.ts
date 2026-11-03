/**
 * Maps raw opencode event frames and catalog rows to the small set of values the chat UI understands.
 * Pure and dependency-free so it can be tested without a server. Shapes were observed with `scripts/probe-*.ts`
 * (see docs/PROTOCOL-NOTES.md). The opencode API changes often, so every read here is defensive: an unknown or
 * malformed frame becomes `{ kind: "unknown" }` (counted by the caller), never an exception.
 */

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Why a turn failed, as the provider reported it (observed: `{type: "provider.auth", message, status: 401, response: {body}}`). */
export interface TurnError {
  type: string;
  message: string;
  status?: number;
  /** The provider rejected the call because a usage cap was reached (HTTP 429 or a "usage limit" error name). */
  rateLimited: boolean;
  /** When the provider said usage returns, if it said so in the error text. */
  retryAfterMs?: number;
}

/** One answer: text, a number, a yes or no, or the options chosen. */
export type QuestionValue = string | number | boolean | string[];

/**
 * One thing the agent asks. 2.x calls the whole request a "form" and 1.x a "question"; both are turned into this: a choice
 * (one option, or free text when `custom`), several options, text, a number, a yes or no, or a link to open.
 */
export interface QuestionField {
  key: string;
  title: string;
  description?: string;
  kind: "text" | "number" | "integer" | "boolean" | "choice" | "multi" | "link";
  options?: Array<{ value: string; label: string; description?: string }>;
  /** A choice or several: the user may also type something that is not among the options. */
  custom?: boolean;
  required?: boolean;
  /** Not shown to the user (2.x forms can hold fixed fields). */
  hidden?: boolean;
  /** Shown only while another field has (`eq`) or does not have (`neq`) a value. */
  when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }>;
  default?: QuestionValue;
  min?: number;
  max?: number;
  /** `link`: the address (https only). */
  url?: string;
}

export interface QuestionRequest {
  requestId: string;
  sessionId: string;
  title: string;
  fields: QuestionField[];
}

export type ChatEvent =
  | { type: "turn-started"; sessionId: string }
  | { type: "step-started"; sessionId: string; messageId: string; agent?: string; model?: { id: string; providerId: string } }
  | { type: "reasoning"; sessionId: string; messageId: string; ordinal: number; delta: string }
  | { type: "reasoning-end"; sessionId: string; messageId: string; ordinal: number; text: string }
  | { type: "text"; sessionId: string; messageId: string; ordinal: number; delta: string }
  | { type: "text-end"; sessionId: string; messageId: string; ordinal: number; text: string }
  | { type: "tool-started"; sessionId: string; messageId: string; callId: string; name: string }
  /** The arguments are complete (the JSON the model streamed), before the tool runs. The moment to look at a file's "before". */
  | { type: "tool-input"; sessionId: string; messageId: string; callId: string; input: unknown }
  | { type: "tool-called"; sessionId: string; messageId: string; callId: string; input: unknown }
  /** `files`: the patches opencode's edit tool reports (observed: `metadata.files[]` with a unified `patch`). */
  | { type: "tool-result"; sessionId: string; messageId: string; callId: string; text: string; files?: Array<{ file: string; patch: string }> }
  | { type: "tool-failed"; sessionId: string; messageId: string; callId: string; errorType: string; message: string }
  | { type: "approval-requested"; sessionId: string; requestId: string; action: string; resources: string[]; /** Patterns an "always" answer would remember. */ saves: string[]; source?: { messageId: string; callId: string } }
  | { type: "approval-resolved"; sessionId: string; requestId: string; reply: string }
  | { type: "step-ended"; sessionId: string; messageId: string; finish: string; tokens?: TokenUsage }
  /** The agent is asking the user something and waits for the answer (the turn does not go on without it). */
  | { type: "question-asked"; sessionId: string; request: QuestionRequest }
  | { type: "question-resolved"; sessionId: string; requestId: string; outcome: "answered" | "rejected"; answers?: Record<string, QuestionValue> }
  /** A message that was waiting in the queue has just been taken into the turn. */
  | { type: "inbox-delivered"; sessionId: string; inboxId: string }
  | { type: "turn-ended"; sessionId: string; outcome: "succeeded" | "failed" | "interrupted" | "other"; error?: TurnError };

export type MapResult = { kind: "event"; event: ChatEvent } | { kind: "ignored" } | { kind: "unknown"; eventType: string };

/** The envelope every frame on `/api/event` carries; `data` is its payload, `type` the real event name. */
export interface Frame {
  id?: string;
  type: string;
  data: Record<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Parses the JSON of one SSE message. Returns undefined for anything that is not a frame with a string `type`. */
export function parseFrame(raw: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  return { id: str(value.id), type: value.type, data: isRecord(value.data) ? value.data : {} };
}

export function mapTokens(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value.cache) ? value.cache : {};
  return { input: num(value.input), output: num(value.output), reasoning: num(value.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) };
}

/** Frames that are state chatter and carry nothing a chat shows. They are expected, so they are not "unknown". */
const CHATTER = /^(server\.|project\.|models-dev\.|config\.|integration\.|provider\.|model\.|agent\.|command\.|skill\.|websearch\.|reference\.|plugin\.|mcp\.|session\.(created|deleted|updated)$)/;

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** `permission.asked` / `permission.replied`, observed on 2.2.5. The reply `reject` makes the tool fail with `permission.rejected`. */
function mapPermission(frame: Frame, sessionId: string): MapResult {
  const d = frame.data;
  if ((str(d.sessionID) ?? sessionId) !== sessionId) return { kind: "ignored" };
  if (frame.type === "permission.asked") {
    const requestId = str(d.id);
    const action = str(d.action);
    if (!requestId || !action) return { kind: "unknown", eventType: frame.type };
    const src = isRecord(d.source) ? d.source : undefined;
    const source = src && str(src.messageID) && str(src.id) ? { messageId: str(src.messageID)!, callId: str(src.id)! } : undefined;
    return { kind: "event", event: { type: "approval-requested", sessionId, requestId, action, resources: strings(d.resources), saves: strings(d.save), source } };
  }
  const requestId = str(d.requestID);
  const reply = str(d.reply);
  return requestId && reply ? { kind: "event", event: { type: "approval-resolved", sessionId, requestId, reply } } : { kind: "unknown", eventType: frame.type };
}

/** Seconds or minutes or hours found next to "retry"/"try again"/"resets" in an error text. Undefined when none is stated. */
export function parseRetryAfter(text: string): number | undefined {
  const match = /(?:retry[- ]after|try again in|resets? in|available again in)\D{0,12}(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)?/i.exec(text);
  if (!match?.[1]) return undefined;
  const n = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = unit.startsWith("d") ? 86_400_000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("m") ? 60_000 : 1000;
  return Number.isFinite(n) && n > 0 ? Math.round(n * factor) : undefined;
}

export function mapTurnError(value: unknown): TurnError | undefined {
  if (!isRecord(value)) return undefined;
  const response = isRecord(value.response) ? value.response : {};
  const body = typeof response.body === "string" ? response.body : "";
  const message = str(value.message) ?? "";
  const status = typeof value.status === "number" ? value.status : undefined;
  const text = `${message} ${body}`;
  const rateLimited = status === 429 || /usage.?limit|rate.?limit|too many requests|quota/i.test(text);
  return { type: str(value.type) ?? "unknown", message, status, rateLimited, retryAfterMs: rateLimited ? parseRetryAfter(text) : undefined };
}

const FIELD_KINDS = new Set(["string", "number", "integer", "boolean", "multiselect", "external"]);

/** A 2.x form as the questions of the chat. Fields it does not understand are dropped, never guessed. */
export function mapForm(raw: unknown): QuestionRequest | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.sessionID !== "string" || !Array.isArray(raw.fields)) return undefined;
  const fields: QuestionField[] = [];
  for (const f of raw.fields) {
    if (!isRecord(f) || typeof f.key !== "string" || typeof f.type !== "string" || !FIELD_KINDS.has(f.type)) continue;
    const options = Array.isArray(f.options)
      ? f.options.flatMap((o): Array<{ value: string; label: string; description?: string }> => (isRecord(o) && typeof o.value === "string" ? [{ value: o.value, label: typeof o.label === "string" ? o.label : o.value, description: typeof o.description === "string" ? o.description : undefined }] : []))
      : undefined;
    const when = Array.isArray(f.when)
      ? f.when.flatMap((w): Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }> => (isRecord(w) && typeof w.key === "string" && (w.op === "eq" || w.op === "neq") && (typeof w.value === "string" || typeof w.value === "number" || typeof w.value === "boolean") ? [{ key: w.key, op: w.op, value: w.value }] : []))
      : undefined;
    let kind: QuestionField["kind"];
    if (f.type === "multiselect") kind = "multi";
    else if (f.type === "external") kind = "link";
    else if (f.type === "string") kind = options && options.length > 0 ? "choice" : "text";
    else kind = f.type as "number" | "integer" | "boolean";
    const def = f.default;
    fields.push({
      key: f.key,
      title: typeof f.title === "string" ? f.title : f.key,
      description: typeof f.description === "string" ? f.description : undefined,
      kind,
      options: options && options.length > 0 ? options : undefined,
      custom: f.custom === true ? true : undefined,
      required: f.required === true ? true : undefined,
      hidden: f.hidden === true ? true : undefined,
      when: when && when.length > 0 ? when : undefined,
      default: typeof def === "string" || typeof def === "number" || typeof def === "boolean" ? def : Array.isArray(def) ? def.filter((x): x is string => typeof x === "string") : undefined,
      min: typeof f.minimum === "number" ? f.minimum : typeof f.minItems === "number" ? f.minItems : undefined,
      max: typeof f.maximum === "number" ? f.maximum : typeof f.maxItems === "number" ? f.maxItems : undefined,
      url: f.type === "external" && typeof f.url === "string" ? f.url : undefined,
    });
  }
  if (fields.length === 0) return undefined;
  return { requestId: raw.id, sessionId: raw.sessionID, title: typeof raw.title === "string" && raw.title !== "" ? raw.title : "The agent has a question", fields };
}

/** Maps one frame. `sessionId` filters to one chat; frames of other sessions are `ignored`. */
export function mapFrame(frame: Frame, sessionId: string): MapResult {
  const d = frame.data;
  if (frame.type === "form.created") {
    const request = mapForm(d.form);
    return request && request.sessionId === sessionId ? { kind: "event", event: { type: "question-asked", sessionId, request } } : { kind: "ignored" };
  }
  if ((frame.type === "form.replied" || frame.type === "form.cancelled") && str(d.sessionID) === sessionId && typeof d.id === "string") {
    const answers = isRecord(d.answer) ? (d.answer as Record<string, QuestionValue>) : undefined;
    return { kind: "event", event: { type: "question-resolved", sessionId, requestId: d.id, outcome: frame.type === "form.replied" ? "answered" : "rejected", answers } };
  }
  if (frame.type.startsWith("form.")) return { kind: "ignored" };
  const eventSession = str(d.sessionID);
  if (CHATTER.test(frame.type)) return { kind: "ignored" };
  if (frame.type === "permission.asked" || frame.type === "permission.replied") return mapPermission(frame, sessionId);
  if (!frame.type.startsWith("session.")) return { kind: "unknown", eventType: frame.type };
  if (eventSession !== undefined && eventSession !== sessionId) return { kind: "ignored" };
  const messageId = str(d.assistantMessageID) ?? "";
  const ordinal = num(d.ordinal);
  const event = (e: ChatEvent): MapResult => ({ kind: "event", event: e });
  switch (frame.type) {
    case "session.execution.started":
      return event({ type: "turn-started", sessionId });
    case "session.execution.succeeded":
      return event({ type: "turn-ended", sessionId, outcome: "succeeded" });
    case "session.execution.failed":
      return event({ type: "turn-ended", sessionId, outcome: "failed", error: mapTurnError(d.error) });
    case "session.execution.interrupted":
      return event({ type: "turn-ended", sessionId, outcome: "interrupted" });
    case "session.step.started": {
      const model = isRecord(d.model) && typeof d.model.id === "string" && typeof d.model.providerID === "string" ? { id: d.model.id, providerId: d.model.providerID } : undefined;
      return event({ type: "step-started", sessionId, messageId, agent: str(d.agent), model });
    }
    case "session.reasoning.delta":
      return event({ type: "reasoning", sessionId, messageId, ordinal, delta: str(d.delta) ?? "" });
    case "session.reasoning.ended":
      return event({ type: "reasoning-end", sessionId, messageId, ordinal, text: str(d.text) ?? "" });
    case "session.text.delta":
      return event({ type: "text", sessionId, messageId, ordinal, delta: str(d.delta) ?? "" });
    case "session.text.ended":
      return event({ type: "text-end", sessionId, messageId, ordinal, text: str(d.text) ?? "" });
    case "session.tool.input.started": {
      const callId = str(d.id);
      return callId ? event({ type: "tool-started", sessionId, messageId, callId, name: str(d.name) ?? "tool" }) : { kind: "unknown", eventType: frame.type };
    }
    case "session.tool.input.ended": {
      const callId = str(d.id);
      if (!callId) return { kind: "unknown", eventType: frame.type };
      let input: unknown;
      try {
        input = typeof d.text === "string" ? JSON.parse(d.text) : undefined;
      } catch {
        input = undefined;
      }
      return event({ type: "tool-input", sessionId, messageId, callId, input });
    }
    case "session.tool.called": {
      const callId = str(d.id);
      return callId ? event({ type: "tool-called", sessionId, messageId, callId, input: d.input }) : { kind: "unknown", eventType: frame.type };
    }
    case "session.tool.success": {
      const callId = str(d.id);
      if (!callId) return { kind: "unknown", eventType: frame.type };
      const meta = isRecord(d.metadata) && Array.isArray(d.metadata.files) ? d.metadata.files : [];
      const files = meta.filter(isRecord).flatMap((f) => (typeof f.file === "string" && typeof f.patch === "string" ? [{ file: f.file, patch: f.patch }] : []));
      return event({ type: "tool-result", sessionId, messageId, callId, text: textOfContent(d.content), files: files.length > 0 ? files : undefined });
    }
    case "session.tool.failed": {
      const callId = str(d.id);
      const error = isRecord(d.error) ? d.error : {};
      return callId ? event({ type: "tool-failed", sessionId, messageId, callId, errorType: str(error.type) ?? "unknown", message: str(error.message) ?? "" }) : { kind: "unknown", eventType: frame.type };
    }
    case "session.step.ended":
      return event({ type: "step-ended", sessionId, messageId, finish: str(d.finish) ?? "unknown", tokens: mapTokens(d.tokens) });
    // Streaming bookkeeping with no visible content.
    case "session.reasoning.started":
    case "session.text.started":
    case "session.step.failed":
    case "session.step.streamed":
    case "session.inbox.delivered": {
      const inboxId = str(d.inboxID);
      return inboxId ? event({ type: "inbox-delivered", sessionId, inboxId }) : { kind: "ignored" };
    }
    case "session.inbox.enqueued":
      return { kind: "ignored" };
    default:
      return { kind: "unknown", eventType: frame.type };
  }
}

export interface ModelInfo {
  modelId: string;
  providerId: string;
  label: string;
  /** Zen (`opencode`), Go (`opencode-go`) or any other provider. */
  family: "zen" | "go" | "other";
  free: boolean;
  variants: string[];
  contextLimit?: number;
  /** The catalog lists image input for this model; undefined when the catalog does not say. */
  images?: boolean;
}

export function familyOf(providerId: string): ModelInfo["family"] {
  if (providerId === "opencode") return "zen";
  if (providerId === "opencode-go") return "go";
  return "other";
}

/**
 * Maps catalog rows with a whitelist. `Model.Info.settings` carries the provider's API key and base URL in clear
 * text, so it is never read here: nothing outside this function can see it, log it or send it to the webview.
 */
export function mapModels(rows: unknown): ModelInfo[] {
  if (!Array.isArray(rows)) return [];
  const out: ModelInfo[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const modelId = str(row.modelID) ?? str(row.id);
    const providerId = str(row.providerID);
    if (!modelId || !providerId) continue;
    const label = str(row.name) ?? modelId;
    const variants = Array.isArray(row.variants) ? row.variants.map((v) => (isRecord(v) ? str(v.id) : undefined)).filter((v): v is string => v !== undefined) : [];
    const input = isRecord(row.capabilities) && Array.isArray(row.capabilities.input) ? row.capabilities.input : undefined;
    const images = input ? input.includes("image") : undefined;
    const limit = isRecord(row.limit) && typeof row.limit.context === "number" ? row.limit.context : undefined;
    out.push({ modelId, providerId, label, family: familyOf(providerId), free: /-free$/.test(modelId) || /\bfree\b/i.test(label), variants, contextLimit: limit, images });
  }
  return out;
}
