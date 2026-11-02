import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FasterWhisperTranscriber } from "./transcribers.ts";
import { venvDir, venvPython } from "./paths.ts";
import { silentWav } from "./wav.ts";

export const FASTER_WHISPER_VERSION = "1.2.1";

/**
 * Dependency pins that keep faster-whisper working. faster-whisper 1.2.1 calls
 * `av.open(..., metadata_errors="ignore")`, an argument PyAV removed in 19.0 (found by the real
 * transcription test: av 19.0.2 failed with "unexpected keyword argument 'metadata_errors'"; 18.1.0 works).
 */
export const COMPAT_PINS = ["av>=11,<19"];

/** Approximate download sizes, shown in the consent dialog. */
export const MODELS: Record<string, { approxMB: number; note: string }> = {
  tiny: { approxMB: 75, note: "fastest, makes more mistakes" },
  base: { approxMB: 145, note: "good balance on a CPU" },
  small: { approxMB: 465, note: "more accurate, slower, needs more memory" },
};

/** What the consent dialog must say before anything is downloaded or installed. */
export function consentText(home: string, model: string): string {
  const m = MODELS[model] ?? MODELS.base;
  return [
    "Local voice uses faster-whisper (Whisper on your CPU). Capella will:",
    `• create a private Python environment in ${home} (your global Python is not touched);`,
    `• install faster-whisper ${FASTER_WHISPER_VERSION} and its dependencies from PyPI (about 100 MB to download, about 300 MB on disk);`,
    `• download the Whisper "${model}" model from Hugging Face (about ${m?.approxMB} MB).`,
    "This runs third-party code on your computer. After setup, transcription runs offline.",
  ].join("\n");
}

export interface PythonInfo {
  command: string;
  args: string[];
  version: string;
}

/** Finds a usable Python 3.9+ (and ignores the Microsoft Store stub that prints an install hint). */
export async function findPython(hint?: string): Promise<PythonInfo | undefined> {
  const candidates: { command: string; args: string[] }[] = [];
  if (hint) candidates.push({ command: hint, args: [] });
  if (process.platform === "win32") candidates.push({ command: "py", args: ["-3"] });
  candidates.push({ command: "python", args: [] }, { command: "python3", args: [] });
  for (const c of candidates) {
    try {
      const out = await run(c.command, [...c.args, "--version"], 15_000);
      const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${out.stdout}${out.stderr}`);
      if (out.code === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 9))) return { ...c, version: `${m[1]}.${m[2]}.${m[3]}` };
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

export type SetupStep = "environment" | "packages" | "model" | "verify" | "done";

export interface SetupOptions {
  home: string;
  workerScript: string;
  model: string;
  python?: PythonInfo;
  onStep?: (step: SetupStep, detail: string) => void;
}

/** Installs faster-whisper into a private venv and downloads the model. Idempotent: finished steps are skipped. */
export async function installFasterWhisper(options: SetupOptions): Promise<void> {
  const { home, model } = options;
  const say = options.onStep ?? (() => undefined);
  mkdirSync(home, { recursive: true });
  const py = venvPython(home);

  if (!existsSync(py)) {
    const python = options.python ?? (await findPython());
    if (!python) throw new Error("Python 3.9 or newer was not found. Install Python, or set capella.voice.pythonPath.");
    say("environment", `Creating a private environment with Python ${python.version}`);
    mkdirSync(dirname(venvDir(home)), { recursive: true });
    const r = await run(python.command, [...python.args, "-m", "venv", venvDir(home)], 5 * 60_000);
    if (r.code !== 0) throw new Error(`Could not create the environment: ${tail(r.stderr || r.stdout)}`);
  }

  say("packages", `Installing faster-whisper ${FASTER_WHISPER_VERSION}`);
  const pip = await run(py, ["-m", "pip", "install", "--disable-pip-version-check", "--no-cache-dir", `faster-whisper==${FASTER_WHISPER_VERSION}`, ...COMPAT_PINS], 20 * 60_000, (line) => {
    if (/^(Collecting|Downloading|Installing)/.test(line)) say("packages", line.slice(0, 90));
  });
  if (pip.code !== 0) throw new Error(`Installing faster-whisper failed: ${tail(pip.stderr || pip.stdout)}`);

  say("model", `Downloading the "${model}" Whisper model (about ${MODELS[model]?.approxMB ?? "?"} MB)`);
  const engine = new FasterWhisperTranscriber({ home, workerScript: options.workerScript, idleMs: 1000 });
  try {
    await engine.load(model, false);
    // Verify the whole path (audio decoding included) offline, so "installed" means "works".
    say("verify", "Checking that transcription works");
    const probe = join(tmpdir(), `capella-voice-verify-${Date.now()}.wav`);
    writeFileSync(probe, silentWav(800));
    try {
      await engine.transcribe(probe, { model, language: "en" });
    } catch (error) {
      throw new Error(`Local voice was installed but does not work: ${(error as Error).message}`);
    } finally {
      rmSync(probe, { force: true });
    }
  } finally {
    engine.dispose();
  }
  say("done", "Local voice is ready");
}

const tail = (text: string): string => text.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);

function run(command: string, args: string[], timeoutMs: number, onLine?: (line: string) => void): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let carry = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
      if (onLine) {
        carry += c;
        let nl: number;
        while ((nl = carry.indexOf("\n")) >= 0) {
          onLine(carry.slice(0, nl).trim());
          carry = carry.slice(nl + 1);
        }
      }
    });
    child.stderr.on("data", (c: string) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} did not finish within ${Math.round(timeoutMs / 60000)} min.`));
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
