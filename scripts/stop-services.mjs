// Stops the background services (`opencode serve --service`) that were started at or after a given time (milliseconds since the
// epoch). The opencode CLI starts one for the home it is given; a test that ran the CLI in a throwaway home calls this when it
// is done, so that nothing keeps that home's database open and the service of your own opencode (started earlier) is not touched.
// Windows only; elsewhere it does nothing.
// Usage: node scripts/stop-services.mjs <since-ms>
import { execFileSync } from "node:child_process";

const since = Number(process.argv[2]);
if (!Number.isFinite(since) || process.platform !== "win32") process.exit(0);
const command = `Get-CimInstance Win32_Process -Filter "Name='opencode.exe'" | Where-Object { $_.CommandLine -match 'serve --service' } | ForEach-Object { "$($_.ProcessId) $([int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds())" }`;
try {
  const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { encoding: "utf8" });
  for (const line of out.split(/\r?\n/).filter(Boolean)) {
    const [pid, created] = line.trim().split(" ");
    if (Number(created) >= since) execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
  }
} catch {
  /* nothing to stop */
}
