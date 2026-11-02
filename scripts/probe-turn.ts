// Probe: one tiny real turn, to record the event sequence the mapper must understand.
// Uses the REAL opencode home (it needs your credentials) in a throwaway project folder, with a free model only.
// Usage: node scripts/probe-turn.ts <providerID/modelID> [opencode-binary]
// Output is sanitized: model `settings` (which carry provider API keys) are never printed.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const wanted = process.argv[2];
const binary = process.argv[3] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const project = mkdtempSync(join(tmpdir(), "capella-probe-turn-"));
writeFileSync(join(project, "hello.txt"), "hello from the probe\n");

const server = new OpencodeServer({ binary, cwd: project });
try {
  const endpoint = await server.start();
  const client = new OpencodeClient(endpoint, project);
  const models = await client.get<{ data: Array<{ id: string; modelID: string; providerID: string; name: string; cost?: unknown }> }>("/api/model");
  if (!wanted) {
    // Only identifiers: never `settings`.
    for (const m of models.data) console.log(`${m.providerID}/${m.modelID}  ${m.name}`);
    console.log(models.data.length, "models");
  } else {
    const [providerID, ...rest] = wanted.split("/");
    const modelID = rest.join("/");
    if (!models.data.some((m) => m.providerID === providerID && m.modelID === modelID)) throw new Error(`model ${wanted} not in the catalog`);
    const created = await client.post<{ data: { id: string } }>("/api/session", { title: "capella probe" });
    const sessionID = created.data.id;
    console.log("session", sessionID);
    let idle = false;
    const stream = new EventStream(client, "/api/event", {
      onMessage: (m) => {
        let type = "?";
        try {
          type = (JSON.parse(m.data) as { type?: string }).type ?? "?";
        } catch {
          // keep "?"
        }
        if (!/\.updated$|server\.connected|project\./.test(type)) console.log("EVENT", m.data.slice(0, 700));
        if (/session\.(idle|status)/.test(type) && /idle/.test(m.data)) idle = true;
      },
      onError: (e) => console.log("stream error:", String(e)),
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 800));
    // Never prompt on a model other than the one asked for: an unselected session falls back to the user's default
    // provider, which may be a metered one. So a failed selection stops the probe before any model call.
    await client.post(`/api/session/${sessionID}/model`, { model: { id: modelID, providerID } });
    console.log("model selected:", wanted);
    console.log("prompt:", JSON.stringify(await client.post(`/api/session/${sessionID}/prompt`, { text: "Read hello.txt and reply with its content in one short sentence." })).slice(0, 300));
    const until = Date.now() + 90000;
    while (!idle && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 1000));
    const messages = await client.get(`/api/session/${sessionID}/message`);
    console.log("MESSAGES", JSON.stringify(messages).slice(0, 3000));
    stream.stop();
    await client.request("DELETE", `/api/session/${sessionID}`).catch(() => undefined);
  }
} finally {
  await server.stop();
  rmSync(project, { recursive: true, force: true });
}
