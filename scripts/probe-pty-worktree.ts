// Probe of the terminal (/api/pty) and worktree (/api/worktree) routes of a REAL opencode 2.x, in a throwaway home and
// a throwaway git repository. Prints the contract and what the server really does; nothing outside the temp folder is touched.
//
// Usage: node scripts/probe-pty-worktree.ts <opencode executable>
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "../src/opencode/client.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/probe-pty-worktree.ts <opencode executable>");
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-pty-")));
const project = join(base, "project");
const home = join(base, "home");
mkdirSync(project);
writeFileSync(join(project, "a.txt"), "hello\n");
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, stdio: "pipe" }).toString();
git("init", "-q", "-b", "main");
git("-c", "user.name=t", "-c", "user.email=t@t.test", "add", ".");
git("-c", "user.name=t", "-c", "user.email=t@t.test", "commit", "-q", "-m", "init");

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

const server = new OpencodeServer({ binary, cwd: project, env });
const show = (title: string, value: unknown) => console.log(`\n== ${title}\n${typeof value === "string" ? value : JSON.stringify(value, null, 1).slice(0, 2500)}`);
try {
  const endpoint = await server.start();
  const client = new OpencodeClient(endpoint, project);
  const spec = await client.request<{ paths: Record<string, Record<string, unknown>>; components?: { schemas?: Record<string, unknown> } }>("GET", "/openapi.json");
  const attempt = async <T = unknown>(title: string, method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T | undefined> => {
    try {
      const value = await client.request<T>(method, path, { body, query });
      show(title, value as unknown);
      return value;
    } catch (error) {
      show(`${title} FAILED`, String(error));
      return undefined;
    }
  };
    await attempt("POST session (registers the project)", "POST", "/api/session", {});
  const listed = await attempt<unknown>("GET project", "GET", "/api/project");
  const projects = (Array.isArray(listed) ? listed : (listed as { data?: unknown[] } | undefined)?.data ?? []) as { id: string; canonical: string }[];
  const projectID = projects.find((p) => p.canonical.toLowerCase() === project.toLowerCase())?.id ?? projects[0]?.id;
  if (projectID) {
    await attempt("GET worktree (before)", "GET", "/api/worktree", undefined, { projectID });
    const made = await attempt<{ directory: string }>("POST worktree", "POST", "/api/worktree", { projectID, name: "probe-tree" });
    await attempt("GET worktree (after)", "GET", "/api/worktree", undefined, { projectID });
    if (made) {
      await attempt("DELETE worktree", "DELETE", "/api/worktree", { projectID, directory: made.directory, force: true });
      await attempt("GET worktree (removed)", "GET", "/api/worktree", undefined, { projectID });
    }
  }
  const pty = await attempt<{ data: { id: string } }>("POST pty", "POST", "/api/pty", { title: "probe" });
  if (pty) {
    const auth = "Basic " + Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64");
    const tokenUrl = `${endpoint.baseUrl}/api/pty/${pty.data.id}/connect-token?location[directory]=${encodeURIComponent(project)}`;
    const tryToken = async (label: string, headers: Record<string, string>) => {
      const r = await fetch(tokenUrl, { method: "POST", headers: { authorization: auth, ...headers } });
      const text = await r.text();
      show("token " + label, `${r.status} ${text.slice(0, 200)}`);
      try { return (JSON.parse(text) as { data?: { ticket?: string } }).data?.ticket; } catch { return undefined; }
    };
    await tryToken("plain", {});
    await tryToken("with Origin", { origin: endpoint.baseUrl });
    const ticket = (await tryToken("with x-opencode-ticket: 1", { "x-opencode-ticket": "1" })) ?? (await tryToken("with Origin + Sec-Fetch-Site", { origin: endpoint.baseUrl, "sec-fetch-site": "same-origin" }));
    const wsUrl = new URL(endpoint.baseUrl.replace(/^http/, "ws") + `/api/pty/${pty.data.id}/connect`);
    wsUrl.searchParams.set("location[directory]", project);
    if (ticket) wsUrl.searchParams.set("ticket", ticket);
    // Node's WebSocket (undici) takes a headers option; Basic auth is tried when there is no ticket.
    const ws = new WebSocket(wsUrl, { headers: ticket ? {} : { authorization: auth } } as never);
    ws.binaryType = "arraybuffer";
    let got = "";
    ws.addEventListener("message", (m) => { got += typeof m.data === "string" ? m.data : Buffer.from(m.data as ArrayBuffer).toString("utf8"); });
    await new Promise<void>((resolve) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", (e) => { show("ws error", String((e as ErrorEvent).message ?? e)); resolve(); }); ws.addEventListener("close", () => resolve()); setTimeout(resolve, 8000); });
    show("ws state (1 = open)", ws.readyState);
    if (ws.readyState === 1) {
      ws.send("echo CAPELLA_$((20+22))" + String.fromCharCode(13));
      await new Promise((r) => setTimeout(r, 3000));
      show("ws output", JSON.stringify(got.slice(0, 600)));
      show("ws includes CAPELLA_42", got.includes("CAPELLA_42"));
      ws.close();
    }
    await attempt("DELETE pty", "DELETE", `/api/pty/${pty.data.id}`);
  }
} finally {
  await server.stop?.();
  console.log("\nbase folder:", base);
}
