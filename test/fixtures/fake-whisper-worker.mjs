// Stands in for media/voice-worker.py: same JSON-lines protocol, no Whisper.
//   FAKE_WORKER_MODE=missing-model  transcribe fails the way an offline HF cache miss does
//   FAKE_WORKER_MODE=crash          exits right after receiving a transcribe request
//   FAKE_WORKER_MODE=noise          prints non-JSON lines first, as a chatty library would
import { createInterface } from "node:readline";

const mode = process.env.FAKE_WORKER_MODE ?? "ok";
let served = 0;
const reply = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (mode === "noise") process.stdout.write("Downloading something... 42%\n");
  if (req.op === "ping") return reply({ id: req.id, ok: true, version: "fake", python: "3.13" });
  if (req.op === "load") return reply({ id: req.id, ok: true, loadMs: 5 });
  if (req.op === "transcribe") {
    served++;
    if (mode === "crash") {
      console.error("Segmentation fault (simulated)");
      process.exit(3);
    }
    if (mode === "missing-model") return reply({ id: req.id, ok: false, error: "LocalEntryNotFoundError: Cannot find an appropriate cached snapshot folder for the specified revision on the local disk" });
    return reply({ id: req.id, ok: true, text: ` fake text #${served} (${req.language ?? "auto"}, ${req.model}, offline=${req.offline}) `, language: req.language ?? "pt", languageProbability: 0.99, audioSeconds: 1.2, loadMs: served === 1 ? 5 : 0, transcribeMs: 7, pid: process.pid });
  }
  reply({ id: req.id, ok: false, error: `unknown op ${req.op}` });
});
