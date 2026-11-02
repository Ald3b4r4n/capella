// Probe: the agents opencode offers and their permission rules, on a throwaway home (no model call).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const home = mkdtempSync(join(tmpdir(), "capella-probe-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-probe-project-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
const server = new OpencodeServer({ binary, cwd: project, env });
try {
  const client = new OpencodeClient(await server.start(), project);
  const agents = await client.get<{ data: Array<{ id: string; mode?: string; hidden?: boolean; description?: string; permissions?: Array<{ action: string; resource: string; effect: string }> }> }>("/api/agent");
  for (const a of agents.data) {
    console.log(`${a.id} mode=${a.mode} hidden=${a.hidden} :: ${a.description}`);
    for (const p of a.permissions ?? []) console.log(`    ${p.effect.padEnd(5)} ${p.action} ${p.resource}`);
  }
  const permissions = await client.get<unknown>("/api/permission/saved").catch((e) => String(e));
  console.log("saved:", JSON.stringify(permissions).slice(0, 300));
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
