// Probe: what a failed turn looks like on the event stream. Throwaway home with NO credentials, so the model call is
// refused before anything is billed: an authentication failure stands in for other provider errors (such as a free
// usage limit), whose events are expected to take the same path.
// Usage: node scripts/probe-failure.ts [providerID/modelID]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = locateOpencode();
if (!binary) throw new Error("opencode not found");
const wanted = process.argv[2] ?? "openrouter/anthropic/claude-3.5-haiku";
const home = mkdtempSync(join(tmpdir(), "capella-probe-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-probe-project-"));
// Credentials also come from the environment (OPENROUTER_API_KEY, OPENCODE_API_KEY...): a "no credentials" probe must
// not inherit them, or the model call goes through and is billed to the real account.
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET|^ANTHROPIC_BASE_URL$)/i.test(name)) delete env[name];
env.OPENROUTER_API_KEY = "capella-probe-invalid-key"; // a deliberately invalid key: the provider appears in the catalog and the call is refused, never billed
const server = new OpencodeServer({ binary, cwd: project, env });
try {
  const client = new OpencodeClient(await server.start(), project);
  const models = await client.get<{ data: Array<{ modelID: string; providerID: string }> }>("/api/model");
  const [providerID, ...rest] = wanted.split("/");
  const modelID = rest.join("/");
  const found = models.data.find((m) => m.providerID === providerID && m.modelID === modelID) ?? models.data.find((m) => m.providerID === providerID);
  if (!found) throw new Error(`no model for provider ${providerID}`);
  console.log("using", `${found.providerID}/${found.modelID}`);
  const created = await client.post<{ data: { id: string } }>("/api/session", { title: "failure probe" });
  const id = created.data.id;
  await client.post(`/api/session/${id}/model`, { model: { id: found.modelID, providerID: found.providerID } });
  let done = false;
  const stream = new EventStream(client, "/api/event", {
    onMessage: (m) => {
      let frame: { type?: string; data?: unknown } = {};
      try {
        frame = JSON.parse(m.data);
      } catch {
        return;
      }
      const type = frame.type ?? "?";
      if (/\.updated$|server\.connected|^project\.|^mcp\.|models-dev|reasoning\.|inbox\./.test(type)) return;
      console.log("EVENT", type, JSON.stringify(frame.data).slice(0, 700));
      if (/execution\.(succeeded|failed|interrupted|errored)/.test(type)) done = true;
    },
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 800));
  await client.post(`/api/session/${id}/prompt`, { text: "Say hi." });
  const until = Date.now() + 45000;
  while (!done && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  console.log("finished:", done);
  console.log("MESSAGES", JSON.stringify(await client.get(`/api/session/${id}/message`)).slice(0, 1500));
  stream.stop();
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
