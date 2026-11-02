// Probe: does `PATCH /api/session/{id}` replace the permission ruleset, and does `POST .../agent` stick?
// Throwaway home, no model call.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { MODES } from "../src/opencode/modes.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const home = mkdtempSync(join(tmpdir(), "capella-probe-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-probe-project-"));
const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
const server = new OpencodeServer({ binary, cwd: project, env });
const mode = (id: string) => MODES.find((m) => m.id === id)!;
type SessionRow = { data?: { agent?: string; permissions?: unknown[] } };
try {
  const client = new OpencodeClient(await server.start(), project);
  const created = await client.post<{ data: { id: string } }>("/api/session", { title: "switch", agent: mode("plan").agent, permissions: mode("plan").rules });
  const id = created.data.id;
  const show = async (label: string) => {
    const row = await client.get<SessionRow>(`/api/session/${id}`);
    console.log(label, "agent=", row.data?.agent, "rules=", JSON.stringify(row.data?.permissions));
  };
  await show("created as plan:      ");
  await client.request("PATCH", `/api/session/${id}`, { body: { permissions: mode("accept-edits").rules } });
  await client.post(`/api/session/${id}/agent`, { agent: "build" });
  await show("after accept-edits:   ");
  await client.request("PATCH", `/api/session/${id}`, { body: { permissions: mode("bypass").rules } });
  await show("after bypass (empty): ");
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
