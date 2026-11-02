// Probe: the event sequence of a real turn on opencode 1.x, through the stable legacy routes. Throwaway home with the
// user's credentials stripped: opencode's own `opencode` provider offers free models with a public key, so no account
// of yours is used or billed. Every permission asked is REJECTED.
// Usage: node scripts/probe-v1-turn.ts <opencode-1.x executable> [providerID/modelID]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/probe-v1-turn.ts <executable> [model]");
const wanted = process.argv[3] ?? "opencode/mimo-v2.6-flash-free";
const home = mkdtempSync(join(tmpdir(), "capella-v1-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-v1-project-"));
writeFileSync(join(project, "hello.txt"), "The secret word is PERSIMMON.\n");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

const server = new OpencodeServer({ binary, cwd: project, env });
try {
  const client = new OpencodeClient(await server.start(), project);
  const [providerID, ...rest] = wanted.split("/");
  const modelID = rest.join("/");
  const providers = await client.get<{ providers: Array<{ id: string; models: Record<string, unknown> }>; default?: Record<string, string> }>("/config/providers");
  console.log("providers:", providers.providers.map((p) => `${p.id}(${Object.keys(p.models).length})`).join(" "), "| default:", JSON.stringify(providers.default).slice(0, 200));
  if (!providers.providers.some((p) => p.id === providerID && modelID in p.models)) throw new Error(`model ${wanted} is not offered`);
  const config = await client.get<Record<string, unknown>>("/config");
  console.log("config.model:", JSON.stringify(config.model), "| keys:", Object.keys(config).slice(0, 12).join(","));

  const run = async (label: string, text: string, permission: unknown) => {
    console.log(`\n==== ${label}`);
    const created = await client.post<{ id: string }>("/session", { title: label, agent: "build", model: { id: modelID, providerID }, permission });
    const id = created.id;
    let done = false;
    const stream = new EventStream(client, "/event", {
      onMessage: (m) => {
        let frame: { type?: string; properties?: Record<string, unknown> } = {};
        try {
          frame = JSON.parse(m.data);
        } catch {
          return;
        }
        const props = frame.properties ?? {};
        const sid = (props.sessionID ?? (props.info as { sessionID?: string } | undefined)?.sessionID ?? (props.part as { sessionID?: string } | undefined)?.sessionID) as string | undefined;
        if (sid && sid !== id) return;
        const type = frame.type ?? "?";
        if (/^(server\.|project\.|config\.|lsp\.|vcs\.|file\.watcher|installation|mcp\.|models-dev|global\.)/.test(type)) return;
        console.log("EVENT", type, JSON.stringify(props).slice(0, 520));
        if (type === "session.idle") done = true;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 700));
    const sent = await client.post(`/session/${id}/prompt_async`, { model: { providerID, modelID }, agent: "build", parts: [{ type: "text", text }] });
    console.log("prompt_async ->", JSON.stringify(sent ?? null));
    const until = Date.now() + 120000;
    while (!done && Date.now() < until) {
      const pending = await client.get<Array<{ id: string; sessionID: string }>>("/permission").catch(() => []);
      if (pending.length) console.log("PENDING /permission", JSON.stringify(pending).slice(0, 500));
      for (const request of pending) if (request.sessionID === id) console.log("REPLY", JSON.stringify((await client.post(`/session/${id}/permissions/${request.id}`, { response: "reject" }).catch((e) => String(e))) ?? null));
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 800));
    const messages = await client.get<Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>>(`/session/${id}/message`);
    console.log("MESSAGES:", messages.length, JSON.stringify(messages.map((m) => ({ role: m.info.role, parts: m.parts.map((p) => p.type) }))));
    const tool = messages.flatMap((m) => m.parts).find((p) => p.type === "tool");
    if (tool) console.log("TOOL PART:", JSON.stringify(tool).slice(0, 700));
    stream.stop();
  };
  await run("read a file", "Read hello.txt and tell me the secret word, in one short sentence.", []);
  await run("shell asks", "Run the shell command: echo hello-v1", [{ permission: "bash", pattern: "*", action: "ask" }]);
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
