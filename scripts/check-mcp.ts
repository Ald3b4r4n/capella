// Check of the MCP manager against a REAL opencode (2.x or 1.x): a server added through Capella (a tiny stdio server of the
// test fixtures) connects, its tool is ASKED about in Review mode (and rejected here, so it does not run), and runs once the
// approval is given. Only the fixture's `echo` tool is ever approved.
//
// Usage: node scripts/check-mcp.ts <opencode executable> [providerID/modelID]
//   CAPELLA_ISOLATED=1  throwaway home with the API keys stripped (always for 1.x); CAPELLA_GO_AUTH=1 copies only the
//                       `opencode-go` credential in.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-mcp.ts <opencode executable> [model]");
const model = process.argv[3] ?? "opencode-go/deepseek-v4.1-flash";
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-mcpcheck-")));
const project = join(base, "project");
mkdirSync(project);
const fixture = join(import.meta.dirname, "..", "test", "fixtures", "mini-mcp.mjs");

let env: NodeJS.ProcessEnv | undefined;
if (process.env.CAPELLA_ISOLATED === "1") {
  const home = join(base, "home");
  env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
  for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];
  if (process.env.CAPELLA_GO_AUTH === "1") {
    const real = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as Record<string, unknown>;
    if (!real["opencode-go"]) throw new Error("no opencode-go entry in auth.json");
    mkdirSync(join(home, "d", "opencode"), { recursive: true });
    writeFileSync(join(home, "d", "opencode", "auth.json"), JSON.stringify({ "opencode-go": real["opencode-go"] }));
  }
}

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

const session = new OpencodeSession({ binary, workspaceRoot: project, env, mode: "review", model });
const events: SessionEvent[] = [];
session.on("event", (e: SessionEvent) => events.push(e));

/** One turn; every approval is answered with `decision`. */
async function turn(text: string, decision: "once" | "reject"): Promise<{ asked: string[]; answer: string; ended: string }> {
  const from = events.length;
  const asked: string[] = [];
  await session.send(text);
  let seen = from;
  let ended = "";
  let answer = "";
  const until = Date.now() + 120000;
  while (!ended && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    for (; seen < events.length; seen++) {
      const e = events[seen]!;
      if (e.type === "approval-requested") {
        asked.push(e.action);
        await session.answerApproval(e.requestId, decision).catch(() => undefined);
      }
      if (e.type === "text") answer += e.delta;
      if (e.type === "turn-ended") ended = e.outcome;
    }
  }
  return { asked, answer, ended };
}

try {
  await session.start();
  console.log(`opencode ${session.version} (${session.generation}), model ${model}`);
  await session.mcpAdd("capellaprobe", { type: "local", command: [process.execPath, fixture] });
  let status = "";
  for (let i = 0; i < 20 && status !== "connected"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = (await session.mcpList()).find((s) => s.name === "capellaprobe")?.status ?? "";
  }
  check("the server added through Capella connects", status === "connected", status);

  const ask = "Call the echo tool of the capellaprobe MCP server with the text PINEAPPLE, then tell me what it returned.";
  const rejected = await turn(ask, "reject");
  check("its tool is asked about in Review mode, and rejecting stops it", rejected.asked.some((a) => a.startsWith("capellaprobe_")) && !/echo: PINEAPPLE/.test(rejected.answer), rejected);
  const allowed = await turn(ask, "once");
  check("after the approval the tool runs and the answer has what it returned", allowed.asked.some((a) => a.startsWith("capellaprobe_")) && /PINEAPPLE/.test(allowed.answer), allowed);

  // environment variables, a working folder, and a configuration that is replaced by adding the same name again
  const dump = join(base, "dump.json");
  const wait = async (name: string, wanted: string): Promise<string> => {
    let s = "";
    for (let i = 0; i < 24 && s !== wanted; i++) {
      await new Promise((r) => setTimeout(r, 500));
      s = (await session.mcpList()).find((x) => x.name === name)?.status ?? "";
    }
    return s;
  };
  const read = () => (existsSync(dump) ? (JSON.parse(readFileSync(dump, "utf8")) as { value?: string; cwd?: string; authorization?: string | null }) : undefined);
  await session.mcpAdd("capellaenv", { type: "local", command: [process.execPath, fixture], cwd: base, environment: { CAPELLA_TEST_DUMP_FILE: dump, CAPELLA_TEST_VALUE: "first" } });
  await wait("capellaenv", "connected");
  check("an environment variable given with the server reaches the program", read()?.value === "first", read());
  check("its working folder is the one asked for (not the project folder it would default to)", (read()?.cwd ?? "").toLowerCase() === base.toLowerCase(), read()?.cwd);
  await session.mcpAdd("capellaenv", { type: "local", command: [process.execPath, fixture], environment: { CAPELLA_TEST_DUMP_FILE: dump, CAPELLA_TEST_VALUE: "second" } });
  await wait("capellaenv", "connected");
  check("adding the same name again replaces it and restarts it with the new value", read()?.value === "second", read());
  await session.mcpRemove("capellaenv");

  // headers of a server on the web
  const http = spawn(process.execPath, [join(import.meta.dirname, "..", "test", "fixtures", "mini-mcp-http.mjs")], { env: { ...process.env, CAPELLA_TEST_DUMP_FILE: dump }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the http fixture did not start")), 10000);
      http.stdout.on("data", (c: Buffer) => {
        const m = /listening (http:\/\/\S+)/.exec(String(c));
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      });
    });
    rmSync(dump, { force: true });
    await session.mcpAdd("capellaweb", { type: "remote", url, headers: { Authorization: "Bearer DUMMY-HEADER-VALUE" } });
    const web = await wait("capellaweb", "connected");
    check("a server on the web connects", web === "connected", web);
    check("a header given with it is sent", read()?.authorization === "Bearer DUMMY-HEADER-VALUE", read());
    await session.mcpRemove("capellaweb");
  } finally {
    http.kill();
  }

  await session.setMode("plan");
  // a model may answer from the earlier turns instead of calling the tool again: one more, differently worded, request is allowed
  let plan = await turn(ask, "reject");
  if (plan.asked.length === 0) plan = await turn("Make a NEW call now to the echo tool of capellaprobe with the text KUMQUAT. Do not reuse earlier results.", "reject");
  check("in Plan mode too the tool is asked about", plan.asked.some((a) => a.startsWith("capellaprobe_")), plan);

  await session.mcpSetEnabled("capellaprobe", false);
  check("switching it off shows as disabled", (await session.mcpList()).find((s) => s.name === "capellaprobe")?.status === "disabled");
  await session.mcpRemove("capellaprobe");
  console.log(session.generation === "v2" ? "(2.x forgets the server)" : "(1.x only disconnects it)");
} finally {
  await session.dispose();
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
