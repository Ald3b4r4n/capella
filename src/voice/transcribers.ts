import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { modelCacheDir, venvPython } from "./paths.ts";

export type EngineId = "faster-whisper" | "windows";

export interface TranscribeOptions {
  /** "auto", a language code ("pt", "en") or a locale ("pt-BR"). */
  language?: string;
  /** Whisper model name: tiny, base or small. */
  model?: string;
  /** The editor's UI language (for engines that cannot detect the spoken language). */
  uiLanguage?: string;
}

export interface TranscribeResult {
  text: string;
  engine: EngineId;
  /** Detected or used language. */
  language?: string;
  /** Something worth telling the user (for example, the recognizer language that was used instead). */
  note?: string;
  audioSeconds?: number;
  elapsedMs?: number;
}

export interface EngineStatus {
  available: boolean;
  /** Why it is not available, or what it is. */
  detail: string;
}

export interface Transcriber {
  readonly id: EngineId;
  readonly label: string;
  status(): Promise<EngineStatus>;
  transcribe(wavPath: string, options: TranscribeOptions): Promise<TranscribeResult>;
  dispose(): void;
}

/** "auto" means "let the engine decide" (undefined); "pt-BR" becomes "pt". */
export function whisperLanguage(setting: string | undefined): string | undefined {
  if (!setting || setting === "auto") return undefined;
  return setting.split(/[-_]/)[0]?.toLowerCase() || undefined;
}

/** A BCP-47 locale for Windows recognizers: the setting, else the editor's language. "pt-br" becomes "pt-BR". */
export function windowsCulture(setting: string | undefined, uiLanguage: string | undefined): string {
  const raw = !setting || setting === "auto" ? (uiLanguage ?? "en-US") : setting;
  const [lang = "en", region] = raw.split(/[-_]/);
  return region ? `${lang.toLowerCase()}-${region.toUpperCase()}` : lang.toLowerCase();
}

interface Pending {
  resolve: (reply: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface FasterWhisperOptions {
  home: string;
  /** Path to media/voice-worker.py. */
  workerScript: string;
  /** An idle worker is stopped after this long, to give its memory back. */
  idleMs?: number;
  /** Test seam: replaces the venv Python and the worker script. */
  launch?: () => { command: string; args: string[] };
}

/**
 * Local Whisper through faster-whisper, running in a private virtual environment (see setup.ts). The
 * model is loaded by a worker process that stays up between dictations and is stopped when idle. After
 * setup it runs offline: it never reaches for the network while transcribing.
 */
export class FasterWhisperTranscriber implements Transcriber {
  readonly id = "faster-whisper" as const;
  readonly label = "faster-whisper (local Whisper)";
  private readonly options: FasterWhisperOptions;
  private worker?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stderrTail = "";
  private idleTimer?: NodeJS.Timeout;

  constructor(options: FasterWhisperOptions) {
    this.options = options;
  }

  private python(): string {
    return venvPython(this.options.home);
  }

  async status(): Promise<EngineStatus> {
    if (this.options.launch) return { available: true, detail: "test launcher" };
    const py = this.python();
    if (!existsSync(py)) return { available: false, detail: `not set up (no Python at ${py})` };
    const site = join(this.options.home, "venv", process.platform === "win32" ? join("Lib", "site-packages") : join("lib"));
    if (process.platform === "win32" && !existsSync(join(site, "faster_whisper"))) return { available: false, detail: "faster-whisper is not installed in its environment" };
    return { available: true, detail: `environment at ${this.options.home}` };
  }

  async transcribe(wavPath: string, options: TranscribeOptions): Promise<TranscribeResult> {
    const model = options.model ?? "base";
    const reply = await this.request("transcribe", { path: wavPath, model, language: whisperLanguage(options.language) ?? null, cache: modelCacheDir(this.options.home), offline: true }, 10 * 60_000);
    if (reply.ok !== true) throw new Error(this.explain(String(reply.error ?? "unknown error"), model));
    const language = typeof reply.language === "string" ? reply.language : undefined;
    return {
      text: String(reply.text ?? "").trim(),
      engine: this.id,
      language,
      audioSeconds: typeof reply.audioSeconds === "number" ? reply.audioSeconds : undefined,
      elapsedMs: typeof reply.transcribeMs === "number" ? reply.transcribeMs + (typeof reply.loadMs === "number" ? reply.loadMs : 0) : undefined,
    };
  }

  /** Loads the model into the worker (downloading it when `offline` is false). Used by setup. */
  async load(model: string, offline: boolean): Promise<void> {
    const reply = await this.request("load", { model, cache: modelCacheDir(this.options.home), offline }, 30 * 60_000);
    if (reply.ok !== true) throw new Error(String(reply.error ?? "the model could not be loaded"));
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker;
    this.worker = undefined;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("The voice engine was stopped."));
      this.pending.delete(id);
    }
    if (worker) {
      worker.stdin.end();
      setTimeout(() => worker.kill(), 1500).unref();
    }
  }

  private explain(error: string, model: string): string {
    if (/LocalEntryNotFoundError|cannot find (the )?(requested )?files|offline|local_files_only/i.test(error)) {
      return `The Whisper model "${model}" is not downloaded yet. Run "Capella: Set up local voice" to download it.`;
    }
    return error;
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.worker) return this.worker;
    const launch = this.options.launch?.() ?? { command: this.python(), args: [this.options.workerScript] };
    const worker = spawn(launch.command, launch.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HOME: join(this.options.home, "hf") },
    });
    this.worker = worker;
    this.buffer = "";
    this.stderrTail = "";
    worker.stdin.on("error", () => undefined);
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => this.onData(chunk));
    worker.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    const gone = (message: string) => {
      if (this.worker === worker) this.worker = undefined;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(message));
        this.pending.delete(id);
      }
    };
    worker.on("error", (e) => gone(`The voice engine could not start: ${e.message}`));
    worker.on("exit", (code) => gone(`The voice engine stopped (exit ${code})${this.stderrTail.trim() ? `: ${this.stderrTail.trim().split(/\r?\n/).slice(-2).join(" ")}` : ""}.`));
    return worker;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let reply: Record<string, unknown>;
      try {
        reply = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // a library printing to stdout: not ours
      }
      const id = typeof reply.id === "number" ? reply.id : undefined;
      const p = id !== undefined ? this.pending.get(id) : undefined;
      if (id !== undefined && p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.resolve(reply);
      }
    }
  }

  private request(op: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const worker = this.ensureWorker();
    this.armIdle();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The voice engine did not answer within ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve: (r) => { this.armIdle(); resolve(r); }, reject, timer });
      worker.stdin.write(`${JSON.stringify({ id, op, ...params })}\n`);
    });
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const idleMs = this.options.idleMs ?? 5 * 60_000;
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.dispose();
      else this.armIdle();
    }, idleMs);
    this.idleTimer.unref();
  }
}

/** Returns fixed text without any engine. For development (`capella.dev.voice`) and tests. */
export class FakeTranscriber implements Transcriber {
  readonly id = "faster-whisper" as const;
  readonly label = "fake transcriber";

  async status(): Promise<EngineStatus> {
    return { available: true, detail: "fake" };
  }

  async transcribe(): Promise<TranscribeResult> {
    return { text: "texto ditado de teste", engine: this.id, language: "pt" };
  }

  dispose(): void {}
}

export interface WindowsSpeechOptions {
  /** Path to media/voice-speech.ps1. */
  scriptPath: string;
  /** Test seam: replaces the PowerShell launch. */
  launch?: (wavPath: string, culture: string) => { command: string; args: string[] };
}

/** The speech recognition built into Windows: offline, nothing to install, lower quality than Whisper. */
export class WindowsSpeechTranscriber implements Transcriber {
  readonly id = "windows" as const;
  readonly label = "Windows speech recognition";
  private readonly options: WindowsSpeechOptions;

  constructor(options: WindowsSpeechOptions) {
    this.options = options;
  }

  private cached?: { at: number; status: EngineStatus };

  /**
   * Windows ships speech SYNTHESIS voices on every install, but the desktop speech RECOGNIZERS this engine
   * needs come with a speech language feature that is not always present (none was installed on the
   * development machine). So availability is checked, not assumed.
   */
  async status(): Promise<EngineStatus> {
    if (this.options.launch) return { available: true, detail: "test launcher" };
    if (process.platform !== "win32") return { available: false, detail: "only on Windows" };
    if (this.cached && Date.now() - this.cached.at < 60_000) return this.cached.status;
    let status: EngineStatus;
    try {
      const out = await runToEnd(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Speech; [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers() | ForEach-Object { $_.Culture.Name }"],
        30_000,
      );
      const cultures = out.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      status = cultures.length > 0 ? { available: true, detail: `recognizers installed: ${cultures.join(", ")}` } : { available: false, detail: "no speech recognizer is installed in Windows (only speech synthesis voices)" };
    } catch (error) {
      status = { available: false, detail: `could not check: ${(error as Error).message}` };
    }
    this.cached = { at: Date.now(), status };
    return status;
  }

  async transcribe(wavPath: string, options: TranscribeOptions): Promise<TranscribeResult> {
    const culture = windowsCulture(options.language, options.uiLanguage);
    const spec = this.options.launch?.(wavPath, culture) ?? {
      command: "powershell.exe",
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.options.scriptPath, "-Path", wavPath, "-Language", culture],
    };
    const started = Date.now();
    const output = await runToEnd(spec.command, spec.args, 120_000);
    const line = output.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
    if (!line) throw new Error(`Windows speech recognition returned nothing${output.stderr.trim() ? `: ${output.stderr.trim().slice(0, 200)}` : "."}`);
    const parsed = JSON.parse(line) as { text?: string; culture?: string; installed?: string[]; matched?: boolean; error?: string };
    if (parsed.error === "no-recognizer") throw new Error("Windows has no speech recognizer installed. Add a speech language in Windows settings, or use faster-whisper.");
    if (parsed.error) throw new Error(`Windows speech recognition failed: ${parsed.error}`);
    const note = parsed.matched === false ? `Windows has no speech recognizer for ${culture}; it used ${parsed.culture}. Installed: ${(parsed.installed ?? []).join(", ")}.` : undefined;
    return { text: (parsed.text ?? "").trim(), engine: this.id, language: parsed.culture, note, elapsedMs: Date.now() - started };
  }

  dispose(): void {}
}

function runToEnd(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 1000)} s.`));
    }, timeoutMs);
    timer.unref();
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
