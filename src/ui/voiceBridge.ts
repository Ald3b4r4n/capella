import { join } from "node:path";
import * as vscode from "vscode";
import { VoiceController, type EngineSetting, type VoiceSettings, type VoiceState } from "../voice/controller.ts";
import { existsSync } from "node:fs";
import { antaresVoiceHome, venvPython, voiceHome } from "../voice/paths.ts";
import { FakeRecorder, UnsupportedRecorder, WindowsRecorder, type AudioRecorder } from "../voice/recorder.ts";
import { consentText, installFasterWhisper, MODELS } from "../voice/setup.ts";
import { FakeTranscriber, FasterWhisperTranscriber, WindowsSpeechTranscriber, type EngineId, type TranscribeResult, type Transcriber } from "../voice/transcribers.ts";

const config = () => vscode.workspace.getConfiguration("capella");

/** The user's voice folder: the setting when set, else the standard per-user location. */
export function resolveVoiceHome(): string {
  const configured = config().get<string>("voice.home");
  return configured && configured.trim() !== "" ? configured : voiceHome();
}

export function readVoiceSettings(): VoiceSettings {
  const engine = config().get<string>("voice.engine", "auto");
  const model = config().get<string>("voice.model", "base");
  return {
    engine: (["auto", "faster-whisper", "windows"].includes(engine) ? engine : "auto") as EngineSetting,
    language: config().get<string>("voice.language", "auto"),
    model: model in MODELS ? model : "base",
    uiLanguage: vscode.env.language,
  };
}

/** Messages the page understands. */
export type VoiceMessage =
  | { type: "voice"; state: VoiceState["state"]; engine?: EngineId; startedAt?: number }
  | { type: "voiceResult"; text: string; engine: EngineId; language?: string; note?: string }
  | { type: "voiceError"; message: string; canSetup: boolean };

/**
 * Connects the voice controller to one chat panel. The microphone is recorded here, in the extension host,
 * because the webview is not allowed to use it (measured in VS Code and Antigravity IDE).
 */
export class VoiceBridge {
  private readonly context: vscode.ExtensionContext;
  private readonly post: (message: VoiceMessage) => void;
  private controller?: VoiceController;

  constructor(context: vscode.ExtensionContext, post: (message: VoiceMessage) => void) {
    this.context = context;
    this.post = post;
  }

  private media(file: string): string {
    return join(this.context.extensionPath, "media", file);
  }

  private create(): VoiceController {
    const fake = config().get<boolean>("dev.voice", false);
    const maxSeconds = Math.max(5, Math.min(600, config().get<number>("voice.maxSeconds", 120)));
    let recorder: AudioRecorder;
    const engines: Partial<Record<EngineId, Transcriber>> = {};
    if (fake) {
      recorder = new FakeRecorder();
      engines["faster-whisper"] = new FakeTranscriber();
    } else {
      recorder = process.platform === "win32" ? new WindowsRecorder({ scriptPath: this.media("voice-recorder.ps1"), maxSeconds }) : new UnsupportedRecorder("Recording from the microphone is only implemented on Windows in this version.");
      engines["faster-whisper"] = new FasterWhisperTranscriber({ home: resolveVoiceHome(), workerScript: this.media("voice-worker.py"), idleMs: Math.max(1, config().get<number>("voice.idleMinutes", 5)) * 60_000 });
      if (process.platform === "win32") engines.windows = new WindowsSpeechTranscriber({ scriptPath: this.media("voice-speech.ps1") });
    }
    const controller = new VoiceController({ recorder, engines, settings: readVoiceSettings });
    controller.on("state", (s: VoiceState) => this.post({ type: "voice", state: s.state, engine: s.state === "idle" ? undefined : s.engine, startedAt: s.state === "recording" ? s.startedAt : undefined }));
    controller.on("result", (r: TranscribeResult) => this.post({ type: "voiceResult", text: r.text, engine: r.engine, language: r.language, note: r.note }));
    controller.on("error", (e: { message: string; canSetup: boolean }) => this.post({ type: "voiceError", message: e.message, canSetup: e.canSetup }));
    return controller;
  }

  async handle(action: "toggle" | "cancel" | "setup"): Promise<void> {
    if (action === "setup") {
      await setupVoice(this.context);
      // The engine is looked up again on the next dictation; drop the old worker settings.
      this.controller?.dispose();
      this.controller = undefined;
      return;
    }
    this.controller ??= this.create();
    if (action === "toggle") await this.controller.toggle();
    else await this.controller.cancel();
  }

  /** Test hook: what the controller is doing. */
  get state(): VoiceState {
    return this.controller?.state ?? { state: "idle" };
  }

  dispose(): void {
    this.controller?.dispose();
    this.controller = undefined;
  }
}

let setupRunning = false;

/** "Capella: Set up local voice": asks first, shows what will be downloaded and where, then installs. */
export async function setupVoice(context: vscode.ExtensionContext): Promise<boolean> {
  if (setupRunning) {
    void vscode.window.showInformationMessage("Capella: local voice setup is already running.");
    return false;
  }
  const settings = readVoiceSettings();
  const model = settings.model;
  let home = resolveVoiceHome();
  // Antares keeps the same environment and model: offer to reuse it instead of downloading about 450 MB again.
  // Where Antares keeps it: the folder its own setting names (read, never written), else its standard location.
  const antaresSetting = vscode.workspace.getConfiguration("antares").get<string>("voice.home");
  const antares = [antaresSetting, antaresVoiceHome()].find((p): p is string => !!p && p.trim() !== "" && existsSync(venvPython(p))) ?? antaresVoiceHome();
  if (home !== antares && !existsSync(venvPython(home)) && existsSync(venvPython(antares))) {
    const REUSE = "Reuse it";
    const choice = await vscode.window.showInformationMessage("Local voice from Antares was found", { modal: true, detail: `Antares already installed faster-whisper at:\n${antares}\n\nCapella can use that same folder: nothing is downloaded or installed, and Capella only reads it. If dictation does not work, run this command again and choose to install a separate copy.` }, REUSE, "Install a separate copy");
    if (choice === REUSE) {
      await config().update("voice.home", antares, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Capella: using the local voice installed by Antares (${antares}).`);
      return true;
    }
    if (choice === undefined) return false;
  }
  const OK = "Set up";
  const CHOOSE = "Choose another folder…";
  for (;;) {
    const choice = await vscode.window.showInformationMessage("Set up local voice (faster-whisper)?", { modal: true, detail: consentText(home, model) }, OK, CHOOSE);
    if (choice === CHOOSE) {
      const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: "Install here", title: "Folder for Capella local voice (about 450 MB)" });
      if (picked?.[0]) home = join(picked[0].fsPath, "Capella", "voice");
      continue;
    }
    if (choice !== OK) return false;
    break;
  }
  setupRunning = true;
  const output = vscode.window.createOutputChannel("Capella voice setup");
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Capella: setting up local voice", cancellable: false }, async (progress) => {
      await installFasterWhisper({
        home,
        model,
        workerScript: join(context.extensionPath, "media", "voice-worker.py"),
        python: undefined,
        onStep: (step, detail) => {
          output.appendLine(`${step}: ${detail}`);
          progress.report({ message: detail });
        },
      });
    });
    await config().update("voice.home", home, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(`Capella: local voice is ready (faster-whisper, model "${model}") in ${home}.`);
    return true;
  } catch (error) {
    output.appendLine(`FAILED: ${(error as Error).message}`);
    void vscode.window.showErrorMessage(`Capella: local voice setup failed. ${(error as Error).message}`, "Show log").then((c) => c && output.show());
    return false;
  } finally {
    setupRunning = false;
  }
}
