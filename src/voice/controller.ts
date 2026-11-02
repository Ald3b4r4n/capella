import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import type { AudioRecorder } from "./recorder.ts";
import type { EngineId, EngineStatus, TranscribeOptions, TranscribeResult, Transcriber } from "./transcribers.ts";

export type EngineSetting = "auto" | EngineId;

export interface VoiceSettings {
  engine: EngineSetting;
  language: string;
  model: string;
  uiLanguage: string;
}

export type VoiceState =
  | { state: "idle" }
  | { state: "recording"; engine: EngineId; startedAt: number }
  | { state: "transcribing"; engine: EngineId };

export interface EngineChoice {
  transcriber?: Transcriber;
  /** Set when nothing can transcribe: what to tell the user, and whether setting up faster-whisper would help. */
  problem?: string;
  canSetup?: boolean;
  statuses: Record<EngineId, EngineStatus | undefined>;
}

export interface VoiceDeps {
  recorder: AudioRecorder;
  engines: Partial<Record<EngineId, Transcriber>>;
  settings: () => VoiceSettings;
}

/**
 * Picks the engine for a dictation. `auto` prefers faster-whisper (more accurate) when it is set up and
 * falls back to Windows speech recognition when that has a recognizer installed. A named engine is used
 * or reported as unavailable; it is never silently swapped for the other one.
 */
export async function chooseEngine(engines: Partial<Record<EngineId, Transcriber>>, setting: EngineSetting): Promise<EngineChoice> {
  const statuses: Record<EngineId, EngineStatus | undefined> = { "faster-whisper": undefined, windows: undefined };
  const check = async (id: EngineId): Promise<EngineStatus | undefined> => {
    const t = engines[id];
    if (!t) return undefined;
    statuses[id] = await t.status();
    return statuses[id];
  };
  const order: EngineId[] = setting === "auto" ? ["faster-whisper", "windows"] : [setting];
  for (const id of order) {
    const s = await check(id);
    if (s?.available) return { transcriber: engines[id], statuses };
  }
  const plain = (id: EngineId): string => {
    const name = id === "windows" ? "Windows speech recognition" : "faster-whisper";
    const detail = statuses[id]?.detail ?? "not supported here";
    return /^not set up|not installed in its environment/.test(detail) ? `${name} is not set up yet` : `${name} is unavailable (${detail})`;
  };
  const canSetup = Boolean(engines["faster-whisper"]) && order.includes("faster-whisper");
  return {
    statuses,
    canSetup,
    problem: `Dictation needs a voice engine: ${order.map(plain).join("; ")}.${canSetup ? " Set up local voice to use faster-whisper, which runs Whisper on your computer." : ""}`,
  };
}

/**
 * The dictation state machine: idle, recording, transcribing, idle. It does not record when no engine can
 * transcribe. The recording is a temporary file that is deleted as soon as it has been transcribed (or the
 * attempt fails or is cancelled); the text is only handed to whoever listens for "result". Nothing is sent.
 *
 * Events: "state" (VoiceState), "result" (TranscribeResult), "error" ({message, canSetup}).
 */
export class VoiceController extends EventEmitter {
  private readonly deps: VoiceDeps;
  private current: VoiceState = { state: "idle" };
  private engine?: Transcriber;
  private busy = false;

  constructor(deps: VoiceDeps) {
    super();
    this.deps = deps;
    this.deps.recorder.on("finished", () => void this.onAutoFinished());
  }

  get state(): VoiceState {
    return this.current;
  }

  private set(state: VoiceState): void {
    this.current = state;
    this.emit("state", state);
  }

  private fail(message: string, canSetup = false): void {
    this.set({ state: "idle" });
    this.emit("error", { message, canSetup });
  }

  /** Start when idle, stop-and-transcribe when recording; ignored while transcribing. */
  async toggle(): Promise<void> {
    if (this.busy) return;
    if (this.current.state === "recording") return this.stopAndTranscribe();
    if (this.current.state === "idle") return this.start();
  }

  async start(): Promise<void> {
    if (this.busy || this.current.state !== "idle") return;
    this.busy = true;
    try {
      const choice = await chooseEngine(this.deps.engines, this.deps.settings().engine);
      if (!choice.transcriber) return this.fail(choice.problem ?? "No voice engine is available.", choice.canSetup);
      this.engine = choice.transcriber;
      try {
        await this.deps.recorder.start();
      } catch (error) {
        return this.fail(`Could not start recording: ${(error as Error).message}`);
      }
      this.set({ state: "recording", engine: choice.transcriber.id, startedAt: Date.now() });
    } finally {
      this.busy = false;
    }
  }

  async stopAndTranscribe(): Promise<void> {
    if (this.current.state !== "recording" || this.busy) return;
    this.busy = true;
    const engine = this.engine;
    try {
      if (!engine) return this.fail("No voice engine was chosen.");
      let wav: { path: string; durationMs: number } | undefined;
      try {
        wav = await this.deps.recorder.stop();
      } catch (error) {
        return this.fail(`Recording failed: ${(error as Error).message}`);
      }
      await this.transcribe(wav, engine);
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    if (this.current.state !== "recording") return;
    await this.deps.recorder.cancel().catch(() => undefined);
    this.set({ state: "idle" });
  }

  /** A recording that reached its length limit ends by itself and is transcribed like a normal stop. */
  private async onAutoFinished(): Promise<void> {
    if (this.current.state !== "recording" || this.busy || !this.engine) return;
    this.busy = true;
    try {
      // The recorder already holds the finished file; stop() returns it.
      const wav = await this.deps.recorder.stop().catch(() => undefined);
      if (!wav) return this.fail("Recording failed.");
      await this.transcribe(wav, this.engine);
    } finally {
      this.busy = false;
    }
  }

  private async transcribe(wav: { path: string; durationMs: number }, engine: Transcriber): Promise<void> {
    this.set({ state: "transcribing", engine: engine.id });
    const settings = this.deps.settings();
    const options: TranscribeOptions = { language: settings.language, model: settings.model, uiLanguage: settings.uiLanguage };
    try {
      if (wav.durationMs < 300) return this.fail("That was too short to transcribe. Hold the microphone a little longer.");
      const result: TranscribeResult = await engine.transcribe(wav.path, options);
      this.set({ state: "idle" });
      if (!result.text) {
        this.emit("error", { message: "No speech was recognized.", canSetup: false });
        return;
      }
      this.emit("result", result);
    } catch (error) {
      this.fail(`Transcription failed: ${(error as Error).message}`, /not set up|not downloaded|Set up local voice/i.test((error as Error).message));
    } finally {
      rmSync(wav.path, { force: true });
    }
  }

  dispose(): void {
    void this.cancel();
    for (const t of Object.values(this.deps.engines)) t?.dispose();
  }
}
