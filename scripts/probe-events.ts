// Probe: what the opencode event stream and session endpoints look like, with NO model call and a throwaway home.
// Usage: node scripts/probe-events.ts [opencode-binary]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient, EventStream } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const home = mkdtempSync(join(tmpdir(), "capella-probe-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-probe-project-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"),
};
const server = new OpencodeServer({ binary, cwd: project, env });
const seen: string[] = [];
try {
  const endpoint = await server.start();
  const client = new OpencodeClient(endpoint, project);
  console.log("info:", await client.get("/api/info"));
  const stream = new EventStream(client, "/api/event", {
    onMessage: (m) => {
      seen.push(m.event);
      console.log("event:", m.event, m.data.slice(0, 300));
    },
    onError: (e) => console.log("stream error:", String(e)),
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 800));
  const created = await client.post<{ data?: { id?: string } }>("/api/session", { title: "probe" });
  console.log("created:", JSON.stringify(created).slice(0, 400));
  const id = created.data?.id;
  console.log("list:", JSON.stringify(await client.get("/api/session")).slice(0, 300));
  console.log("agents:", JSON.stringify(await client.get("/api/agent")).slice(0, 600));
  console.log("models:", JSON.stringify(await client.get<{ data?: unknown[] }>("/api/model").then((r) => ({ count: r.data?.length }))));
  console.log("usage limits:", JSON.stringify(await client.get("/api/experimental/usage/limits")).slice(0, 300));
  if (id) await client.request("DELETE", `/api/session/${id}`);
  await new Promise((r) => setTimeout(r, 800));
  stream.stop();
  console.log("event names seen:", [...new Set(seen)]);
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
