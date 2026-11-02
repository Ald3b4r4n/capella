// Probe: does `PATCH /session/{id} {permission}` on opencode 1.x REPLACE the session's rules (so a mode switch really
// tightens AND loosens)? Throwaway home, no model call. Usage: node scripts/probe-v1-mode.ts <opencode-1.x executable>
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "../src/opencode/client.ts";
import { modeById, v1Rules } from "../src/opencode/modes.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/probe-v1-mode.ts <executable>");
const home = mkdtempSync(join(tmpdir(), "capella-v1-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-v1-project-"));
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];
const server = new OpencodeServer({ binary, cwd: project, env });
try {
  const client = new OpencodeClient(await server.start(), project);
  const created = await client.post<{ id: string }>("/session", { title: "mode", agent: "plan", permission: v1Rules(modeById("plan")) });
  const show = async (label: string) => console.log(label.padEnd(26), JSON.stringify(((await client.get<{ permission?: unknown }>(`/session/${created.id}`)).permission ?? []) as unknown[]));
  await show("created as plan:");
  await client.request("PATCH", `/session/${created.id}`, { body: { permission: v1Rules(modeById("accept-edits")) } });
  await show("after accept-edits:");
  await client.request("PATCH", `/session/${created.id}`, { body: { permission: v1Rules(modeById("bypass")) } });
  await show("after bypass (empty list):");
  await client.request("PATCH", `/session/${created.id}`, { body: { permission: v1Rules(modeById("plan")) } });
  await show("back to plan:");
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
