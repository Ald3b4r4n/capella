// Voice dictation: pure helpers, the recorder protocol, the engines and the state machine. The recorder and
// the Whisper worker are stand-ins that speak the real protocols (test/fixtures); the real engines are
// exercised on this machine by scripts/voice-selftest.ts.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chooseEngine, VoiceController, type VoiceSettings } from "../../src/voice/controller.ts";
import { modelCacheDir, venvPython, voiceHome } from "../../src/voice/paths.ts";
import { FakeRecorder, WindowsRecorder, type AudioRecorder, type RecordingResult } from "../../src/voice/recorder.ts";
import { FasterWhisperTranscriber, whisperLanguage, windowsCulture, WindowsSpeechTranscriber, type EngineStatus, type Transcriber, type TranscribeResult } from "../../src/voice/transcribers.ts";
import { parseWavHeader, readWavInfo, silentWav } from "../../src/voice/wav.ts";

const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error(`${what} did not finish within ${ms} ms`)), ms))]);
async function until(check: () => boolean, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ---------------------------------------------------------------- pure helpers

test("wav: a PCM WAV reports its format and duration; damaged and non-PCM files are refused", () => {
  const info = parseWavHeader(silentWav(1500));
  assert.deepEqual(info, { sampleRate: 16000, channels: 1, bitsPerSample: 16, dataBytes: 48000, durationMs: 1500 });
  const cut = silentWav(2000).subarray(0, 44 + 16000); // a recorder cut off mid-write: header claims more than exists
  assert.equal(parseWavHeader(cut)?.durationMs, 500);
  assert.equal(parseWavHeader(Buffer.from("not a wav file at all, just text")), undefined);
  const floatTag = silentWav(100);
  floatTag.writeUInt16LE(3, 20); // IEEE float, not PCM
  assert.equal(parseWavHeader(floatTag), undefined);
  assert.equal(parseWavHeader(silentWav(100).subarray(0, 30)), undefined);
});

test("wav: readWavInfo reads files from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "capella-wav-"));
  try {
    const p = join(dir, "a.wav");
    writeFileSync(p, silentWav(750, 8000));
    assert.equal(readWavInfo(p)?.durationMs, 750);
    assert.equal(readWavInfo(p)?.sampleRate, 8000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("paths: one folder per user per OS, overridable, with the venv Python inside", () => {
  assert.equal(voiceHome("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }), join("C:\\Users\\u\\AppData\\Local", "Capella", "voice"));
  assert.equal(voiceHome("linux", { XDG_DATA_HOME: "/data" }), join("/data", "capella", "voice"));
  assert.equal(voiceHome("win32", { CAPELLA_VOICE_HOME: "D:\\programas\\Capella\\voice" }), "D:\\programas\\Capella\\voice");
  assert.equal(venvPython("/h", "win32"), join("/h", "venv", "Scripts", "python.exe"));
  assert.equal(venvPython("/h", "linux"), join("/h", "venv", "bin", "python"));
  assert.equal(modelCacheDir("/h"), join("/h", "models"));
});

test("languages: Whisper wants a two-letter code or nothing; Windows wants a locale", () => {
  assert.equal(whisperLanguage("auto"), undefined);
  assert.equal(whisperLanguage(undefined), undefined);
  assert.equal(whisperLanguage("pt-BR"), "pt");
  assert.equal(whisperLanguage("EN"), "en");
  assert.equal(windowsCulture("auto", "pt-br"), "pt-BR");
  assert.equal(windowsCulture(undefined, "en"), "en");
  assert.equal(windowsCulture("pt", "en-us"), "pt");
  assert.equal(windowsCulture("pt_br", undefined), "pt-BR");
  assert.equal(windowsCulture("auto", undefined), "en-US");
});

// ---------------------------------------------------------------- engine choice

const engine = (id: "faster-whisper" | "windows", status: EngineStatus): Transcriber => ({ id, label: id, status: async () => status, transcribe: async () => ({ text: id, engine: id }), dispose() {} });
const ready: EngineStatus = { available: true, detail: "ok" };
const missing: EngineStatus = { available: false, detail: "not set up" };

test("auto prefers faster-whisper, then Windows speech; a named engine is never swapped for the other", async () => {
  assert.equal((await chooseEngine({ "faster-whisper": engine("faster-whisper", ready), windows: engine("windows", ready) }, "auto")).transcriber?.id, "faster-whisper");
  assert.equal((await chooseEngine({ "faster-whisper": engine("faster-whisper", missing), windows: engine("windows", ready) }, "auto")).transcriber?.id, "windows");
  const named = await chooseEngine({ "faster-whisper": engine("faster-whisper", missing), windows: engine("windows", ready) }, "faster-whisper");
  assert.equal(named.transcriber, undefined, "faster-whisper was asked for; Windows must not stand in");
  assert.equal(named.canSetup, true);
  assert.match(named.problem ?? "", /faster-whisper is not set up yet/);
});

test("when nothing can transcribe the problem says why, and offers setup only when it would help", async () => {
  const none = await chooseEngine({ "faster-whisper": engine("faster-whisper", missing), windows: engine("windows", { available: false, detail: "no speech recognizer is installed in Windows" }) }, "auto");
  assert.equal(none.transcriber, undefined);
  assert.equal(none.canSetup, true);
  assert.match(none.problem ?? "", /faster-whisper is not set up yet; Windows speech recognition is unavailable \(no speech recognizer is installed in Windows\)/);
  assert.match(none.problem ?? "", /Set up local voice to use faster-whisper/);
  const winOnly = await chooseEngine({ windows: engine("windows", { available: false, detail: "only on Windows" }) }, "windows");
  assert.equal(winOnly.canSetup, false);
});

// ---------------------------------------------------------------- recorder protocol (stand-in process)

const recorderWith = (mode = "ok", maxSeconds = 30) =>
  new WindowsRecorder({ scriptPath: "unused", maxSeconds, launch: (out, max) => ({ command: process.execPath, args: [fixture("fake-recorder.mjs"), out, String(max), mode] }) });

test("recorder: start, stop returns a valid WAV with its duration", async () => {
  const rec = recorderWith();
  await rec.start();
  assert.equal(rec.recording, true);
  const result = await within(rec.stop(), 8000, "stop");
  try {
    assert.equal(result.durationMs, 1200);
    assert.ok(existsSync(result.path));
    assert.equal(rec.recording, false);
  } finally {
    rmSync(result.path, { force: true });
  }
});

test("recorder: cancel leaves no file behind", async () => {
  const rec = recorderWith();
  await rec.start();
  await within(rec.cancel(), 8000, "cancel");
  assert.equal(rec.recording, false);
});

test("recorder: a recorder that cannot start reports why", async () => {
  const rec = recorderWith("fail");
  await assert.rejects(rec.start(), /No audio input device is available/);
  assert.equal(rec.recording, false);
});

test("recorder: success without a file, or a file that is not a WAV, is an error, not a silent empty result", async () => {
  for (const [mode, re] of [["nofile", /wrote no file/], ["badwav", /not a valid WAV/]] as const) {
    const rec = recorderWith(mode);
    await rec.start();
    await assert.rejects(within(rec.stop(), 8000, "stop"), re);
  }
});

test("recorder: a recording that reaches its length limit ends by itself and is reported", async () => {
  const rec = recorderWith("ok", 1);
  const finished: RecordingResult[] = [];
  rec.on("finished", (r: RecordingResult) => finished.push(r));
  await rec.start();
  await until(() => finished.length === 1, "the automatic finish", 6000);
  assert.equal(finished[0]?.durationMs, 1200);
  const again = await within(rec.stop(), 4000, "stop after auto-finish");
  assert.equal(again.path, finished[0]?.path);
  rmSync(again.path, { force: true });
});

// ---------------------------------------------------------------- faster-whisper worker (stand-in)

const whisperWith = (env: Record<string, string> = {}, idleMs?: number) => {
  Object.assign(process.env, { FAKE_WORKER_MODE: "ok" }, env);
  return new FasterWhisperTranscriber({ home: tmpdir(), workerScript: "unused", idleMs, launch: () => ({ command: process.execPath, args: [fixture("fake-whisper-worker.mjs")] }) });
};

test("whisper: requests go to one long-lived worker, offline, with the language mapped", async () => {
  const w = whisperWith();
  try {
    const a = await w.transcribe("x.wav", { language: "pt-BR", model: "base" });
    const b = await w.transcribe("x.wav", { language: "auto", model: "tiny" });
    assert.equal(a.text, "fake text #1 (pt, base, offline=true)");
    assert.equal(b.text, "fake text #2 (auto, tiny, offline=true)", "the same worker served both (its counter went on)");
    assert.equal(a.engine, "faster-whisper");
    assert.equal(a.audioSeconds, 1.2);
  } finally {
    w.dispose();
  }
});

test("whisper: output from libraries that is not JSON is ignored", async () => {
  const w = whisperWith({ FAKE_WORKER_MODE: "noise" });
  try {
    assert.match((await w.transcribe("x.wav", {})).text, /^fake text #1/);
  } finally {
    w.dispose();
    process.env.FAKE_WORKER_MODE = "ok";
  }
});

test("whisper: a model that is not downloaded gives an instruction, not a Python traceback", async () => {
  const w = whisperWith({ FAKE_WORKER_MODE: "missing-model" });
  try {
    await assert.rejects(w.transcribe("x.wav", { model: "small" }), /"small" is not downloaded yet\. Run "Capella: Set up local voice"/);
  } finally {
    w.dispose();
    process.env.FAKE_WORKER_MODE = "ok";
  }
});

test("whisper: a worker that dies mid-request fails that request with the reason, and the next one starts a new worker", async () => {
  const w = whisperWith({ FAKE_WORKER_MODE: "crash" });
  try {
    await assert.rejects(within(w.transcribe("x.wav", {}), 8000, "crash"), /stopped \(exit 3\).*Segmentation fault/);
    process.env.FAKE_WORKER_MODE = "ok";
    assert.match((await w.transcribe("x.wav", {})).text, /^fake text #1/, "a fresh worker answered");
  } finally {
    w.dispose();
  }
});

test("whisper: an idle worker is stopped to give its memory back", async () => {
  const w = whisperWith({}, 150);
  try {
    await w.transcribe("x.wav", {});
    await new Promise((r) => setTimeout(r, 500));
    // The worker was stopped, so the counter restarts with a new process.
    assert.match((await w.transcribe("x.wav", {})).text, /^fake text #1/);
  } finally {
    w.dispose();
  }
});

// ---------------------------------------------------------------- Windows speech (stand-in)

const winWith = (json: string) => new WindowsSpeechTranscriber({ scriptPath: "unused", launch: () => ({ command: process.execPath, args: ["-e", `console.log(${JSON.stringify(json)})`] }) });

test("windows speech: text comes through; a recognizer for another language is reported, not hidden", async () => {
  const ok = await winWith(JSON.stringify({ text: "olá mundo", culture: "pt-BR", installed: ["pt-BR"], matched: true })).transcribe("x.wav", { language: "pt", uiLanguage: "en" });
  assert.deepEqual([ok.text, ok.engine, ok.note], ["olá mundo", "windows", undefined]);
  const other = await winWith(JSON.stringify({ text: "hello", culture: "en-US", installed: ["en-US"], matched: false })).transcribe("x.wav", { language: "pt-BR" });
  assert.match(other.note ?? "", /no speech recognizer for pt-BR; it used en-US/);
});

test("windows speech: no recognizer installed gives an actionable message", async () => {
  await assert.rejects(winWith(JSON.stringify({ error: "no-recognizer" })).transcribe("x.wav", {}), /no speech recognizer installed.*use faster-whisper/i);
  await assert.rejects(winWith(JSON.stringify({ error: "boom" })).transcribe("x.wav", {}), /failed: boom/);
});

// ---------------------------------------------------------------- the state machine

function controllerWith(options: { engineStatus?: EngineStatus; transcribe?: () => Promise<TranscribeResult>; recorder?: AudioRecorder } = {}) {
  const wavs: string[] = [];
  const recorder = options.recorder ?? new FakeRecorder();
  const t: Transcriber = {
    id: "faster-whisper",
    label: "t",
    status: async () => options.engineStatus ?? ready,
    transcribe: options.transcribe ?? (async (p: string) => { wavs.push(p); return { text: "hello there", engine: "faster-whisper" }; }),
    dispose() {},
  };
  const settings = (): VoiceSettings => ({ engine: "auto", language: "auto", model: "base", uiLanguage: "en" });
  const c = new VoiceController({ recorder, engines: { "faster-whisper": t }, settings });
  const states: string[] = [];
  const results: TranscribeResult[] = [];
  const errors: { message: string; canSetup: boolean }[] = [];
  c.on("state", (s: { state: string }) => states.push(s.state));
  c.on("result", (r: TranscribeResult) => results.push(r));
  c.on("error", (e: { message: string; canSetup: boolean }) => errors.push(e));
  return { c, states, results, errors, wavs };
}

test("dictation: idle, recording, transcribing, idle; the text is delivered and the audio file is deleted", async () => {
  const { c, states, results, errors, wavs } = controllerWith();
  await c.toggle();
  assert.equal(c.state.state, "recording");
  await new Promise((r) => setTimeout(r, 400)); // long enough to be worth transcribing
  await c.toggle();
  assert.deepEqual(states, ["recording", "transcribing", "idle"]);
  assert.equal(results[0]?.text, "hello there");
  assert.deepEqual(errors, []);
  assert.equal(wavs.length, 1);
  assert.equal(existsSync(wavs[0] as string), false, "the recording must not be kept");
});

test("dictation: nothing is recorded when no engine can transcribe", async () => {
  const rec = new FakeRecorder();
  let started = false;
  rec.on("x", () => undefined);
  const orig = rec.start.bind(rec);
  rec.start = async () => { started = true; return orig(); };
  const { c, errors } = controllerWith({ engineStatus: missing, recorder: rec });
  await c.toggle();
  assert.equal(started, false, "the microphone must not open when the audio could not be used");
  assert.equal(c.state.state, "idle");
  assert.equal(errors[0]?.canSetup, true);
  assert.match(errors[0]?.message ?? "", /Set up local voice/);
});

test("dictation: cancel returns to idle without transcribing", async () => {
  const { c, results, states } = controllerWith();
  await c.toggle();
  await c.cancel();
  assert.equal(c.state.state, "idle");
  assert.deepEqual(results, []);
  assert.deepEqual(states, ["recording", "idle"]);
});

test("dictation: audio that is too short is refused with advice, and the file is still deleted", async () => {
  const rec = new EventEmitter() as AudioRecorder;
  const dir = mkdtempSync(join(tmpdir(), "capella-short-"));
  const wav = join(dir, "short.wav");
  writeFileSync(wav, silentWav(100));
  Object.assign(rec, { recording: false, start: async () => undefined, stop: async () => ({ path: wav, durationMs: 100 }), cancel: async () => undefined });
  const { c, errors, results } = controllerWith({ recorder: rec });
  try {
    await c.toggle();
    await c.toggle();
    assert.match(errors[0]?.message ?? "", /too short/);
    assert.deepEqual(results, []);
    assert.equal(existsSync(wav), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dictation: an engine failure is reported (with a setup offer when the model is missing) and the controller recovers", async () => {
  const { c, errors } = controllerWith({ transcribe: async () => { throw new Error('The Whisper model "base" is not downloaded yet. Run "Capella: Set up local voice" to download it.'); } });
  await c.toggle();
  await new Promise((r) => setTimeout(r, 400));
  await c.toggle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.canSetup, true);
  assert.equal(c.state.state, "idle", "ready for another try");
});

test("dictation: silence (empty text) is reported as 'no speech', not inserted", async () => {
  const { c, errors, results } = controllerWith({ transcribe: async () => ({ text: "", engine: "faster-whisper" }) });
  await c.toggle();
  await new Promise((r) => setTimeout(r, 400));
  await c.toggle();
  assert.deepEqual(results, []);
  assert.match(errors[0]?.message ?? "", /No speech was recognized/);
});

test("dictation: a recording that ends by itself (the length limit) is transcribed like a normal stop", async () => {
  const rec = recorderWith("ok", 1);
  const { c, results, states } = controllerWith({ recorder: rec });
  await c.toggle();
  await until(() => results.length === 1, "the automatic transcription", 8000);
  assert.deepEqual(states, ["recording", "transcribing", "idle"]);
});

test("the Antares voice folder is found where Antares keeps it, so it can be reused instead of downloaded again", async () => {
  const { antaresVoiceHome } = await import("../../src/voice/paths.ts");
  assert.equal(antaresVoiceHome("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }), join("C:\\Users\\u\\AppData\\Local", "Antares", "voice"));
  assert.equal(antaresVoiceHome("linux", { XDG_DATA_HOME: "/data" }), join("/data", "antares", "voice"));
});
