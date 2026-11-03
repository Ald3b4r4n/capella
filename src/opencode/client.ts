import type { ServerEndpoint } from "./server.ts";

/** An HTTP error from the opencode API. The body is kept short and is never the model-settings payload. */
export class ApiError extends Error {
  readonly status: number;
  readonly path: string;
  /** The answer's text, up to 2000 characters (the message carries only the first 300). */
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path}: HTTP ${status}${body ? ` ${body.slice(0, 300)}` : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.path = path;
    this.body = body.slice(0, 2000);
  }
}

export interface SseMessage {
  id?: string;
  event: string;
  /** The raw `data:` payload; parsing is the mapper's job, so a malformed frame cannot kill the stream. */
  data: string;
}

/**
 * Parses a Server-Sent-Events byte stream. Pure and incremental: feed it text chunks, collect messages.
 * Lines end with LF, CR or CRLF; a blank line ends a message; lines starting with ":" are comments.
 */
export class SseParser {
  private buffer = "";
  private event = "message";
  private id: string | undefined;
  private data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.buffer += chunk;
    const out: SseMessage[] = [];
    let index: number;
    while ((index = this.buffer.search(/\r\n|\n|\r/)) >= 0) {
      const sep = this.buffer.startsWith("\r\n", index) ? 2 : 1;
      const line = this.buffer.slice(0, index);
      // A lone CR at the very end could be the first half of a CRLF: wait for more input.
      if (this.buffer[index] === "\r" && index + 1 === this.buffer.length) break;
      this.buffer = this.buffer.slice(index + sep);
      if (line === "") {
        if (this.data.length > 0) out.push({ id: this.id, event: this.event, data: this.data.join("\n") });
        this.event = "message";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
    }
    return out;
  }
}

/** How long a request waits for a server that is still starting its plugins. */
export const STARTING_PATIENCE_MS = 60_000;

export interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Basic-auth HTTP client for one opencode server. Knows nothing about the shape of any endpoint. */
export class OpencodeClient {
  private readonly auth: string;
  readonly baseUrl: string;
  /** The folder requests are resolved against, sent as the `location[directory]` query parameter (a deepObject in the OpenAPI). */
  directory?: string;

  constructor(endpoint: ServerEndpoint, directory?: string) {
    this.baseUrl = endpoint.baseUrl;
    this.auth = "Basic " + Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64");
    this.directory = directory;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { authorization: this.auth, accept: "application/json", ...extra };
    return headers;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(this.baseUrl + path);
    if (this.directory) url.searchParams.set("location[directory]", this.directory);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value);
    return url.toString();
  }

  /**
   * A server that has just started can answer 503 `ServiceUnavailableError` ("Location plugins did not finish activating")
   * while its plugins and servers come up, which can take many seconds on a machine with many of them. Nothing was done by
   * that answer, so the same request is made again after a short wait, for up to a minute, before it is an error.
   */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const until = Date.now() + STARTING_PATIENCE_MS;
    for (let wait = 400; ; wait = Math.min(Math.round(wait * 1.5), 3000)) {
      try {
        return await this.requestOnce<T>(method, path, options);
      } catch (error) {
        const starting = error instanceof ApiError && error.status === 503 && /ServiceUnavailable|did not finish activating/i.test(error.message);
        if (!starting || Date.now() + wait > until || options.signal?.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async requestOnce<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 20000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const response = await fetch(this.url(path, options.query), {
      method,
      headers: this.headers(options.body === undefined ? undefined : { "content-type": "application/json" }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new ApiError(method, path, response.status, text);
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError(method, path, response.status, "response is not JSON");
    }
  }

  get<T = unknown>(path: string, options?: RequestOptions): Promise<T> {
    return this.request<T>("GET", path, options);
  }

  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>("POST", path, { ...options, body: body ?? {} });
  }

  /**
   * Reads an SSE endpoint until it ends or `signal` aborts, handing each message to `onMessage`.
   * Resolves when the stream ends; rejects on a connection error. Reconnection is the caller's job (see EventStream).
   */
  async stream(path: string, onMessage: (message: SseMessage) => void, signal: AbortSignal): Promise<void> {
    const response = await fetch(this.url(path), { headers: this.headers({ accept: "text/event-stream" }), signal });
    if (!response.ok || !response.body) throw new ApiError("GET", path, response.status, await response.text().catch(() => ""));
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of parser.push(decoder.decode(value, { stream: true }))) onMessage(message);
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export interface EventStreamHandlers {
  onMessage: (message: SseMessage) => void;
  onReconnect?: () => void;
  onError?: (error: unknown) => void;
}

/**
 * Keeps an SSE endpoint connected. The opencode event stream is volatile by contract: a slow consumer fails the stream
 * and events sent while disconnected are never replayed. So after every reconnect `onReconnect` runs, and the owner
 * re-reads whatever state it cares about (for a chat: the session's messages) instead of trusting the gap was empty.
 */
export class EventStream {
  private controller?: AbortController;
  private stopped = false;

  private readonly client: OpencodeClient;
  private readonly path: string;
  private readonly handlers: EventStreamHandlers;

  constructor(client: OpencodeClient, path: string, handlers: EventStreamHandlers) {
    this.client = client;
    this.path = path;
    this.handlers = handlers;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.controller?.abort();
  }

  private async loop(): Promise<void> {
    let delay = 500;
    let first = true;
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        if (!first) this.handlers.onReconnect?.();
        first = false;
        await this.client.stream(this.path, this.handlers.onMessage, this.controller.signal);
        delay = 500;
      } catch (error) {
        if (this.stopped) return;
        this.handlers.onError?.(error);
      }
      if (this.stopped) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 10000);
    }
  }
}
