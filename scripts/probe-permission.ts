// Probe: what a permission request, a rejected permission and a failing tool look like on the event stream.
// Uses the REAL opencode home (credentials) in a throwaway project, with one named model that must be selected
// successfully before any prompt. Every permission is REJECTED; nothing is ever approved.
// Usage: node scripts/probe-permission.ts <providerID/modelID> [opencode-binary]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const wanted = process.argv[2];
if (!wanted || !wanted.includes("/")) throw new Error("usage: probe-permission.ts providerID/modelID");
const binary = process.argv[3] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const project = mkdtempSync(join(tmpdir(), "capella-probe-perm-"));
writeFileSync(join(project, ".env"), "PROBE_VALUE=not-a-secret\n");

const server = new OpencodeServer({ binary, cwd: project });
try {
  const endpoint = await server.start();
  const client = new OpencodeClient(endpoint, project);
  const [providerID, ...rest] = wanted.split("/");
  const modelID = rest.join("/");
  const created = await client.post<{ data: { id: string } }>("/api/session", { title: "capella permission probe" });
  const sessionID = created.data.id;
  await client.post(`/api/session/${sessionID}/model`, { model: { id: modelID, providerID } });
  console.log("model selected:", wanted);
  let idle = false;
  const seen = new Set<string>();
  const stream = new EventStream(client, "/api/event", {
    onMessage: (m) => {
      let frame: { type?: string; data?: Record<string, unknown> } = {};
      try {
        frame = JSON.parse(m.data);
      } catch {
        return;
      }
      const type = frame.type ?? "?";
      if (/\.updated$|server\.connected|^project\.|^mcp\.|reasoning\.|text\.|step\.|inbox\./.test(type)) return;
      console.log("EVENT", m.data.slice(0, 900));
      if (/execution\.(succeeded|failed|interrupted)/.test(type)) idle = true;
      if (/permission/.test(type)) seen.add(type);
    },
    onError: (e) => console.log("stream error:", String(e)),
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 800));
  const waitIdle = async (ms: number) => {
    const until = Date.now() + ms;
    while (!idle && Date.now() < until) {
      // A pending permission blocks the turn, so answer (reject) whatever is pending, as a real client would on the event.
      const pending = await client.get<{ data?: Array<{ id?: string; sessionID?: string }> }>("/api/permission/request").catch(() => undefined);
      console.log("PENDING", JSON.stringify(pending).slice(0, 1200));
      for (const request of pending?.data ?? []) {
        if (request.id && (request.sessionID ?? sessionID) === sessionID) {
          const reply = await client.post(`/api/session/${sessionID}/permission/${request.id}/reply`, { decision: "reject", message: "probe: rejected" }).catch((e) => String(e));
          console.log("REPLY", JSON.stringify(reply ?? null));
        }
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 1000));
  };
  await client.post(`/api/session/${sessionID}/prompt`, { text: "Read the file .env and tell me its content." });
  await waitIdle(60000);
  idle = false;
  console.log("---- second prompt: a tool that fails");
  await client.post(`/api/session/${sessionID}/prompt`, { text: "Read the file does-not-exist.txt and say what happened." });
  await waitIdle(60000);
  console.log("permission event types seen:", [...seen]);
  stream.stop();
  await client.request("DELETE", `/api/session/${sessionID}`).catch(() => undefined);
} finally {
  await server.stop();
  rmSync(project, { recursive: true, force: true });
}
