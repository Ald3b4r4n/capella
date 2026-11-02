// Voice check with no microphone: Windows text-to-speech makes a WAV, then the real faster-whisper (offline, on this
// CPU) transcribes it from a voice folder that is already set up. Nothing is recorded and nothing leaves the computer.
// Usage: node scripts/voice-check.ts <voice-home> [language] ["text to speak"]
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FasterWhisperTranscriber } from "../src/voice/transcribers.ts";

const home = process.argv[2];
if (!home) throw new Error("usage: node scripts/voice-check.ts <voice-home> [language] [text]");
const language = process.argv[3] ?? "en";
const text = process.argv[4] ?? "Capella voice dictation works on this computer.";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const dir = mkdtempSync(join(tmpdir(), "capella-voice-check-"));
const wav = join(dir, "speech.wav");
try {
  const script = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${wav}', $f); $s.Speak('${text}'); $s.Dispose()`;
  execFileSync("powershell", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  const engine = new FasterWhisperTranscriber({ home, workerScript: join(root, "media", "voice-worker.py"), idleMs: 60_000 });
  console.log("engine status:", JSON.stringify(await engine.status()));
  const result = await engine.transcribe(wav, { model: "base", language });
  console.log("spoken:     ", text);
  console.log("transcribed:", JSON.stringify(result.text), "| language:", result.language, "| audio s:", result.audioSeconds, "| ms:", result.elapsedMs);
  engine.dispose();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
