// Probe: how `opencode serve` announces itself, whether --port 0 and OPENCODE_SERVER_PASSWORD work, and what auth looks like.
// Starts and stops its own child; touches no session and makes no model call.
import { spawn } from "node:child_process";

const binary = process.argv[2] ?? "opencode";
const password = "probe-" + Math.random().toString(36).slice(2);
const child = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
  env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
  shell: process.platform === "win32" && binary.endsWith(".cmd"),
});
let out = "";
const lines = [];
const onData = (chunk) => {
  out += chunk;
  for (const line of String(chunk).split(/\r?\n/)) if (line) lines.push(line.replace(password, "<password>"));
};
child.stdout.on("data", onData);
child.stderr.on("data", onData);
const done = (code) => {
  child.kill();
  setTimeout(() => process.exit(code), 300);
};
const deadline = Date.now() + 20000;
while (!/listening on (http\S+)/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
console.log("announce lines:", lines);
const url = /listening on (http\S+)/.exec(out)?.[1];
if (!url) done(1);
else {
  const noAuth = await fetch(url + "/api/info");
  console.log("no auth ->", noAuth.status);
  const basic = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const ok = await fetch(url + "/api/info", { headers: { authorization: basic } });
  console.log("basic auth ->", ok.status, await ok.text());
  done(0);
}
