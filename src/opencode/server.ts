import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export interface OpencodeServerOptions {
  binary: string;
  /** Working directory of the server: the folder the chat is about. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Arguments placed before `serve` (lets a script stand in for the opencode binary in tests). */
  binaryArgs?: string[];
  startTimeoutMs?: number;
}

/** What a started server tells a client: where it listens and the Basic credentials that open it. */
export interface ServerEndpoint {
  baseUrl: string;
  username: string;
  password: string;
}

const ANNOUNCE = /listening on (https?:\/\/\S+)/;

/**
 * One `opencode serve` child for one chat window. The extension picks the password, so nothing has to be parsed
 * out of the child's output, and asks for port 0 so two windows never fight over a port. The password lives only
 * in memory and in this child's environment; it is never logged.
 *
 * Events: "stderr" (line), "exit" (code, signal).
 */
export class OpencodeServer extends EventEmitter {
  private child?: ChildProcess;
  private exited = false;
  private starting?: Promise<ServerEndpoint>;
  readonly password = randomBytes(24).toString("base64url");
  private readonly options: OpencodeServerOptions;

  constructor(options: OpencodeServerOptions) {
    super();
    this.options = options;
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  start(): Promise<ServerEndpoint> {
    this.starting ??= this.spawnAndWait();
    return this.starting;
  }

  private spawnAndWait(): Promise<ServerEndpoint> {
    return new Promise<ServerEndpoint>((resolve, reject) => {
      const child = spawn(this.options.binary, [...(this.options.binaryArgs ?? []), "serve", "--port", "0", "--hostname", "127.0.0.1"], {
        cwd: this.options.cwd,
        env: { ...(this.options.env ?? process.env), OPENCODE_SERVER_PASSWORD: this.password, OPENCODE_SERVER_USERNAME: "opencode" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      let output = "";
      let settled = false;
      const settle = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      const timer = setTimeout(() => {
        settle(() => reject(new Error(`opencode did not announce a listening address within ${this.options.startTimeoutMs ?? 30000} ms`)));
        void this.stop();
      }, this.options.startTimeoutMs ?? 30000);
      const onData = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        output += text;
        for (const line of text.split(/\r?\n/)) {
          if (line === "") continue;
          // The announce line is the only output carrying nothing secret; everything else is passed on as is.
          this.emit("stderr", line);
        }
        const match = ANNOUNCE.exec(output);
        if (match?.[1]) settle(() => resolve({ baseUrl: match[1]!.replace(/\/$/, ""), username: "opencode", password: this.password }));
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("error", (error) => {
        this.exited = true;
        settle(() => reject(error));
        this.emit("exit", null, null);
      });
      child.on("exit", (code, signal) => {
        if (this.exited) return;
        this.exited = true;
        settle(() => reject(new Error(`opencode exited before it was ready (code ${code}, signal ${signal})`)));
        this.emit("exit", code, signal);
      });
    });
  }

  /** Asks the server to end and escalates to a kill if it lingers. */
  async stop(graceMs = 3000): Promise<void> {
    const child = this.child;
    if (!child || this.exited) return;
    const done = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), graceMs));
    if ((await Promise.race([done, timeout])) === "timeout") {
      child.kill("SIGKILL");
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    }
  }
}
