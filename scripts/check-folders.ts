// Check of "Add folder" against a REAL opencode (2.x or 1.x): with no folder opened, a read outside the project is asked
// about (and rejected here); with the folder opened, it is read without a question; after the folder is removed, it is
// asked about again. Every approval is REJECTED: nothing outside the throwaway folders is ever read.
//
// Usage: node scripts/check-folders.ts <opencode executable> [providerID/modelID]
//   CAPELLA_ISOLATED=1  run in a throwaway home with the API keys stripped (always the case for 1.x, whose database a
//                       different version could migrate); CAPELLA_GO_AUTH=1 copies only the `opencode-go` credential in.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-folders.ts <opencode executable> [model]");
const model = process.argv[3] ?? "opencode-go/deepseek-v4.1-flash";
// The real path, as the extension uses it (opencode 1.x reports the resource in its long, resolved form).
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-folders-")));
const project = join(base, "project");
const outside = join(base, "outside");
mkdirSync(project);
mkdirSync(join(outside, "sub"), { recursive: true });
writeFileSync(join(project, "a.txt"), "inside\n");
writeFileSync(join(outside, "sub", "deep.txt"), "The outside word is KUMQUAT.\n");

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

/** One read of the file outside, in a session that already has (or lacks) the folder. */
async function readOutside(session: OpencodeSession, events: SessionEvent[]): Promise<{ asked: string[]; text: string; ended: string }> {
  const from = events.length;
  const asked: string[] = [];
  const until = Date.now() + 120000;
  await session.send(`Read the file ${join(outside, "sub", "deep.txt")} and tell me the word in it.`);
  let seen = from;
  let ended = "";
  let text = "";
  while (!ended && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    for (; seen < events.length; seen++) {
      const e = events[seen]!;
      if (e.type === "approval-requested") {
        asked.push(`${e.action}: ${e.resources.join(",")}`);
        await session.answerApproval(e.requestId, "reject").catch(() => undefined);
      }
      if (e.type === "text") text += e.delta;
      if (e.type === "turn-ended") ended = e.outcome;
    }
  }
  return { asked, text, ended };
}

const session = new OpencodeSession({ binary, workspaceRoot: project, env, mode: "review", model });
const events: SessionEvent[] = [];
session.on("event", (e: SessionEvent) => events.push(e));
try {
  await session.start();
  console.log(`opencode ${session.version} (${session.generation}), model ${model}`);

  const a = await readOutside(session, events);
  check("with no folder opened, reading outside the project is asked about", a.asked.some((x) => x.startsWith("external_directory")) && !/KUMQUAT/.test(a.text), a);

  await session.setFolders([outside]);
  const b = await readOutside(session, events);
  check("with the folder opened, the file (in a subfolder) is read without a question", b.asked.length === 0 && /KUMQUAT/i.test(b.text) && b.ended === "succeeded", b);

  await session.setFolders([]);
  const c = await readOutside(session, events);
  check("after the folder is removed, it is asked about again", c.asked.some((x) => x.startsWith("external_directory")), c);
} finally {
  await session.dispose();
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
