// Probe: do session-level permission rules (sent at `POST /api/session`) change what the agent may do?
// Real credentials, throwaway project, one named model that must be selected before any prompt.
// Every permission asked is REJECTED. Nothing is ever approved, so no file is written and no command runs.
// Usage: node scripts/probe-modes.ts <providerID/modelID> [opencode-binary]
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const wanted = process.argv[2];
if (!wanted || !wanted.includes("/")) throw new Error("usage: probe-modes.ts providerID/modelID");
const binary = process.argv[3] ?? locateOpencode();
if (!binary) throw new Error("opencode not found");
const project = mkdtempSync(join(tmpdir(), "capella-probe-modes-"));
const [providerID, ...rest] = wanted.split("/");
const modelID = rest.join("/");

type Rule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };
const scenarios: Array<{ name: string; agent: string; permissions: Rule[]; prompt: string }> = [
  { name: "build + ask shell", agent: "build", permissions: [{ action: "shell", resource: "*", effect: "ask" }], prompt: "Run the shell command: echo hello-from-probe" },
  {
    name: "plan + deny shell and edit",
    agent: "plan",
    permissions: [
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ],
    prompt: "Create a file named probe-out.txt containing the word hi, using whatever tool you have.",
  },
];

const server = new OpencodeServer({ binary, cwd: project });
try {
  const client = new OpencodeClient(await server.start(), project);
  for (const scenario of scenarios) {
    console.log(`\n==== ${scenario.name}`);
    const created = await client.post<{ data: { id: string } }>("/api/session", { title: `capella ${scenario.name}`, agent: scenario.agent, permissions: scenario.permissions });
    const sessionID = created.data.id;
    await client.post(`/api/session/${sessionID}/model`, { model: { id: modelID, providerID } });
    let done = false;
    const stream = new EventStream(client, "/api/event", {
      onMessage: (m) => {
        let frame: { type?: string; data?: Record<string, unknown> } = {};
        try {
          frame = JSON.parse(m.data);
        } catch {
          return;
        }
        const type = frame.type ?? "?";
        if (/^(permission\.|session\.tool\.(called|failed|success))/.test(type)) console.log("EVENT", type, JSON.stringify(frame.data).slice(0, 500));
        if (/execution\.(succeeded|failed|interrupted)/.test(type)) done = true;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 800));
    await client.post(`/api/session/${sessionID}/prompt`, { text: scenario.prompt });
    const until = Date.now() + 90000;
    while (!done && Date.now() < until) {
      const pending = await client.get<{ data?: Array<{ id?: string; sessionID?: string }> }>("/api/permission/request").catch(() => undefined);
      for (const request of pending?.data ?? []) {
        if (request.id && request.sessionID === sessionID) await client.post(`/api/session/${sessionID}/permission/${request.id}/reply`, { decision: "reject", message: "probe: rejected" }).catch(() => undefined);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    stream.stop();
    console.log("probe-out.txt exists:", existsSync(join(project, "probe-out.txt")));
    await client.request("DELETE", `/api/session/${sessionID}`).catch(() => undefined);
  }
} finally {
  await server.stop();
  rmSync(project, { recursive: true, force: true });
}
