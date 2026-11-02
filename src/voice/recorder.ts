import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWavInfo, silentWav } from "./wav.ts";

export interface RecordingResult {
  /** A temporary WAV file. The caller deletes it once it has been transcribed. */
  path: string;
  durationMs: number;
}

/**
 * Microphone capture happens OUTSIDE the webview: in both VS Code and Antigravity IDE the webview's
 * iframe has no `microphone` permission (measured: getUserMedia is denied), so the extension host
 * records and the page only shows the state.
 *
 * Events: "finished" (RecordingResult) when a recording ended by itself (the maximum length), "error".
 */
export interface AudioRecorder extends EventEmitter {
  readonly recording: boolean;
  start(): Promise<void>;
  stop(): Promise<RecordingResult>;
  cancel(): Promise<void>;
}

export interface LaunchSpec {
  command: string;
  args: string[];
}

export interface WindowsRecorderOptions {
  /** Path to media/voice-recorder.ps1. */
  scriptPath: string;
  maxSeconds?: number;
  /** Test seam: replaces the PowerShell launch with another program that speaks the same protocol. */
  launch?: (outPath: string, maxSeconds: number) => LaunchSpec;
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 20_000;

/** Records from the default Windows input device through MCI (winmm), with nothing to install. */
export class WindowsRecorder extends EventEmitter implements AudioRecorder {
  private readonly options: WindowsRecorderOptions;
  private child?: ChildProcessWithoutNullStreams;
  private outPath = "";
  private stderrTail = "";
  private stdoutBuffer = "";
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  private exited?: { code: number | null };
  private auto?: Promise<RecordingResult>;

  constructor(options: WindowsRecorderOptions) {
    super();
    this.options = options;
  }

  get recording(): boolean {
    return this.child !== undefined && this.exited === undefined;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("A recording is already in progress.");
    const maxSeconds = this.options.maxSeconds ?? 120;
    this.outPath = join(tmpdir(), `capella-voice-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.wav`);
    const spec = this.options.launch
      ? this.options.launch(this.outPath, maxSeconds)
      : { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.options.scriptPath, "-Out", this.outPath, "-MaxSeconds", String(maxSeconds)] };
    this.stderrTail = "";
    this.stdoutBuffer = "";
    this.lines = [];
    this.exited = undefined;
    const child = spawn(spec.command, spec.args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdin.on("error", () => undefined);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-1500);
    });
    child.on("error", (error) => this.onExit(null, error.message));
    child.on("exit", (code) => this.onExit(code));

    const first = await this.nextLine(START_TIMEOUT_MS);
    if (first !== "RECORDING") {
      await this.kill();
      throw new Error(this.failure("The recorder did not start"));
    }
    // A recording that ends on its own (the length limit) is reported without anyone calling stop().
    this.auto = this.nextLine(maxSecondsToMs(maxSeconds) + STOP_TIMEOUT_MS).then((line) => this.finish(line)).catch((error: Error) => {
      this.emit("error", error);
      throw error;
    });
    this.auto.catch(() => undefined);
  }

  async stop(): Promise<RecordingResult> {
    return this.end("stop");
  }

  async cancel(): Promise<void> {
    if (!this.child) return;
    try {
      await this.end("cancel");
    } catch {
      /* cancelled: nothing to report */
    }
    rmSync(this.outPath, { force: true });
  }

  private async end(command: "stop" | "cancel"): Promise<RecordingResult> {
    const child = this.child;
    if (!child || !this.auto) throw new Error("Nothing is being recorded.");
    if (this.exited === undefined) {
      try {
        child.stdin.write(`${command}\n`);
        child.stdin.end();
      } catch {
        /* the process may already be finishing */
      }
    }
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(this.failure("The recorder did not stop in time"))), STOP_TIMEOUT_MS).unref());
    try {
      return await Promise.race([this.auto, timeout]);
    } catch (error) {
      await this.kill();
      throw error;
    } finally {
      this.child = undefined;
      this.auto = undefined;
    }
  }

  private finish(line: string): RecordingResult {
    if (line === "CANCELLED") throw new Error("cancelled");
    if (!/^DONE\b/.test(line)) throw new Error(this.failure("The recorder failed"));
    if (!existsSync(this.outPath)) throw new Error("The recorder reported success but wrote no file.");
    const info = readWavInfo(this.outPath);
    if (!info) throw new Error("The recording is not a valid WAV file.");
    const result = { path: this.outPath, durationMs: info.durationMs };
    this.emit("finished", result);
    return result;
  }

  private failure(prefix: string): string {
    const detail = this.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
    return detail ? `${prefix}: ${detail}` : `${prefix}.`;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line === "") continue;
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    }
  }

  private onExit(code: number | null, spawnError?: string): void {
    this.exited = { code };
    if (spawnError) this.stderrTail += spawnError;
    // Wake anyone still waiting for a line with an "exit" marker so they can report the failure.
    for (const w of this.waiters.splice(0)) w(`EXIT ${code ?? "null"}`);
  }

  private nextLine(timeoutMs: number): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.exited !== undefined) return Promise.resolve(`EXIT ${this.exited.code ?? "null"}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(this.failure("The recorder stopped answering")));
      }, timeoutMs);
      timer.unref();
      const waiter = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiters.push(waiter);
    });
  }

  private async kill(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.auto = undefined;
    if (child && this.exited === undefined) {
      child.kill();
      await new Promise((r) => setTimeout(r, 100));
    }
    rmSync(this.outPath, { force: true });
  }
}

const maxSecondsToMs = (s: number): number => s * 1000;

/** Records nothing: a silent WAV of the elapsed time. For development and tests. */
export class FakeRecorder extends EventEmitter implements AudioRecorder {
  private startedAt = 0;
  private active = false;

  get recording(): boolean {
    return this.active;
  }

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.active = true;
  }

  async stop(): Promise<RecordingResult> {
    this.active = false;
    const durationMs = Math.max(300, Date.now() - this.startedAt);
    const path = join(tmpdir(), `capella-voice-fake-${Date.now()}.wav`);
    writeFileSync(path, silentWav(durationMs));
    return { path, durationMs };
  }

  async cancel(): Promise<void> {
    this.active = false;
  }
}

/** For platforms where capture is not implemented yet. */
export class UnsupportedRecorder extends EventEmitter implements AudioRecorder {
  readonly recording = false;
  private readonly reason: string;

  constructor(reason: string) {
    super();
    this.reason = reason;
  }

  async start(): Promise<never> {
    throw new Error(this.reason);
  }

  async stop(): Promise<never> {
    throw new Error(this.reason);
  }

  async cancel(): Promise<void> {}
}
