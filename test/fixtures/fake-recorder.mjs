// Stands in for media/voice-recorder.ps1: same protocol (RECORDING, then DONE <ms> | CANCELLED on a
// stdin line), no microphone. Usage: node fake-recorder.mjs <out.wav> <maxSeconds> [mode]
//   mode "fail"      write to stderr and exit 1 before RECORDING
//   mode "nofile"    print DONE but write no file
//   mode "badwav"    print DONE after writing a file that is not a WAV
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { silentWav } from "../../src/voice/wav.ts";

const [out, maxSeconds = "120", mode = "ok"] = process.argv.slice(2);
if (mode === "fail") {
  console.error("No audio input device is available.");
  process.exit(1);
}
console.log("RECORDING");

const finish = (kind) => {
  if (kind === "cancel") {
    console.log("CANCELLED");
    process.exit(0);
  }
  if (mode === "badwav") writeFileSync(out, Buffer.from("not a wav"));
  else if (mode !== "nofile") writeFileSync(out, silentWav(1200));
  console.log("DONE 1200");
  process.exit(0);
};

const rl = createInterface({ input: process.stdin });
let done = false;
rl.on("line", (line) => {
  if (done) return;
  done = true;
  finish(line.trim() === "cancel" ? "cancel" : "stop");
});
rl.on("close", () => {
  if (!done) {
    done = true;
    finish("stop");
  }
});
setTimeout(() => {
  if (!done) {
    done = true;
    finish("stop");
  }
}, Number(maxSeconds) * 1000);
