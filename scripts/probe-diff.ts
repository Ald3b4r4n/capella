// Probe: how opencode reports file edits (tool events, `GET /api/session/{id}/diff`) and what revert does.
// Real opencode home (a free model), a THROWAWAY project folder: the model may edit and create files there only.
// Shell is denied. Usage: node scripts/probe-diff.ts [providerID/modelID]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const wanted = process.argv[2] ?? "opencode/glm-5.3-flash-free";
const binary = locateOpencode();
if (!binary) throw new Error("opencode not found");
const project = mkdtempSync(join(tmpdir(), "capella-probe-diff-"));
writeFileSync(join(project, "plan.txt"), "alpha\nbeta\ngamma\n");
if (process.argv.includes("--git")) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "add", "-A");
  git("-c", "user.name=probe", "-c", "user.email=probe@example.invalid", "commit", "-q", "-m", "init");
  console.log("(throwaway project is a git repository)");
}
const read = (name: string) => (existsSync(join(project, name)) ? JSON.stringify(readFileSync(join(project, name), "utf8")) : "(absent)");

const server = new OpencodeServer({ binary, cwd: project });
try {
  const client = new OpencodeClient(await server.start(), project);
  const [providerID, ...rest] = wanted.split("/");
  const created = await client.post<{ data: { id: string } }>("/api/session", { title: "diff probe", agent: "build", permissions: [{ action: "shell", resource: "*", effect: "deny" }] });
  const id = created.data.id;
  await client.post(`/api/session/${id}/model`, { model: { id: rest.join("/"), providerID } });
  let idle = false;
  const stream = new EventStream(client, "/api/event", {
    onMessage: (m) => {
      let frame: { type?: string; data?: Record<string, unknown> } = {};
      try {
        frame = JSON.parse(m.data);
      } catch {
        return;
      }
      if (frame.data?.sessionID !== id) return;
      const type = frame.type ?? "";
      if (/^session\.tool\.(called|success|failed)$/.test(type) || /^file\./.test(type) || /^session\.diff/.test(type)) console.log("EVENT", type, JSON.stringify(frame.data).slice(0, 900));
      if (/execution\.(succeeded|failed|interrupted)/.test(type)) idle = true;
    },
  });
  stream.start();
  await new Promise((r) => setTimeout(r, 700));
  const turn = async (text: string) => {
    idle = false;
    console.log(`\n---- PROMPT: ${text}`);
    await client.post(`/api/session/${id}/prompt`, { text });
    const until = Date.now() + 120000;
    while (!idle && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    await new Promise((r) => setTimeout(r, 800));
  };
  await turn("Use your edit tool to change the line 'beta' to 'BETA' in plan.txt. Do not run any command.");
  console.log("plan.txt:", read("plan.txt"));
  console.log("DIFF (default turn):", JSON.stringify(await client.get(`/api/session/${id}/diff`)).slice(0, 1500));
  await turn("Create a new file notes.md whose only line is '# Notes'. Do not run any command.");
  console.log("notes.md:", read("notes.md"));
  const msgs = await client.get<{ data: Array<{ id: string; type: string; time?: { created?: number } }> }>(`/api/session/${id}/message`, { query: { order: "asc" } });
  const users = msgs.data.filter((m) => m.type === "user");
  console.log("user messages:", users.map((u) => u.id));
  console.log("DIFF (second turn):", JSON.stringify(await client.get(`/api/session/${id}/diff`)).slice(0, 900));
  console.log("DIFF (both turns):", JSON.stringify(await client.get(`/api/session/${id}/diff`, { query: { from: users[0]!.id, to: users[users.length - 1]!.id } })).slice(0, 1800));
  console.log("DIFF (context=2):", JSON.stringify(await client.get(`/api/session/${id}/diff`, { query: { from: users[0]!.id, to: users[users.length - 1]!.id, context: "2" } })).slice(0, 900));
  // Revert: stage the boundary at the second user message and apply file changes.
  const staged = await client.post(`/api/session/${id}/revert/stage`, { messageID: users[users.length - 1]!.id, files: true }).catch((e) => String(e));
  console.log("\nREVERT stage:", JSON.stringify(staged).slice(0, 700));
  console.log("after stage -> plan.txt:", read("plan.txt"), " notes.md:", read("notes.md"));
  const cleared = await client.request("DELETE", `/api/session/${id}/revert`).catch((e) => String(e));
  console.log("REVERT clear:", JSON.stringify(cleared)?.slice(0, 300));
  console.log("after clear -> plan.txt:", read("plan.txt"), " notes.md:", read("notes.md"));
  stream.stop();
} finally {
  await server.stop();
  rmSync(project, { recursive: true, force: true });
}
