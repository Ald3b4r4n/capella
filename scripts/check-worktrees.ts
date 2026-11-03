// Check of worktrees against a REAL opencode 2.x, in a throwaway home and a throwaway git repository: a worktree is made,
// a chat that works in it (a session whose folder is the worktree, as the chat panel makes it) creates a file there and NOT
// in the project, and the worktree is removed again (the server that held its folder having stopped first).
//
// Usage: node scripts/check-worktrees.ts <opencode executable> [providerID/modelID]
//   CAPELLA_GO_AUTH=1  copies only the `opencode-go` credential into the throwaway home (needed for the model turn).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../src/opencode/client.ts";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";
import { removalFailure } from "../src/opencode/worktrees.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-worktrees.ts <opencode executable> [model]");
const model = process.argv[3] ?? "opencode-go/deepseek-v4.1-flash";
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-trees-")));
const project = join(base, "project");
const home = join(base, "home");
mkdirSync(project);
writeFileSync(join(project, "a.txt"), "inside\n");
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.test", ...args], { cwd: project, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("add", ".");
git("commit", "-q", "-m", "init");

const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];
// 2.x keeps credentials in its own database, not in auth.json: the Go key is read from the user's auth.json into memory and
// handed to the throwaway opencode through the same call the Accounts box uses. It is never printed.
const goKey = (): string => {
  const real = JSON.parse(readFileSync(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as Record<string, { key?: unknown } | undefined>;
  const key = real["opencode-go"]?.key;
  if (typeof key !== "string" || key === "") throw new Error("no opencode-go key in auth.json");
  return key;
};

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

const main = new OpencodeSession({ binary, workspaceRoot: project, env, mode: "accept-edits", model });
let tree: OpencodeSession | undefined;
try {
  await main.start();
  console.log(`opencode ${main.version} (${main.generation}), model ${model}`);
  if (process.env.CAPELLA_GO_AUTH === "1") {
    await main.connectKey("opencode-go", goKey());
    await main.refreshModels();
  }
  check("this opencode offers worktrees", main.canWorktree);
  const before = await main.worktrees();
  check("a new project lists only itself (found with no session, through its first commit)", before.length === 1 && before[0]!.kind === "project", before);

  const directory = await main.createWorktree("probe-tree");
  check("a worktree is made, as a git worktree with the project's files", existsSync(join(directory, "a.txt")) && existsSync(join(directory, ".git")), directory);
  const after = await main.worktrees();
  check("it is listed as a worktree", after.some((r) => r.kind === "worktree" && r.directory === directory), after.map((r) => r.name));
  check("git knows it", git("worktree", "list").split(String.fromCharCode(10)).length === 2, git("worktree", "list"));
  console.log("INFO  its HEAD:", execFileSync("git", ["status", "-sb"], { cwd: directory }).toString().trim(), "| branches:", git("branch", "--list").split(String.fromCharCode(10)).join(" "));

  // A chat that works in the worktree: its server runs there, and the model is told to write a file in "the folder".
  tree = new OpencodeSession({ binary, workspaceRoot: directory, projectRoot: project, env, mode: "accept-edits", model });
  const events: SessionEvent[] = [];
  tree.on("event", (e: SessionEvent) => events.push(e));
  await tree.start();
  check("the chat in the worktree lists the same worktrees", (await tree.worktrees()).some((r) => r.directory === directory));
  await tree.send("Create a file named made-here.txt in the current folder with the text CAPELLA-TREE in it, then say done.");
  const until = Date.now() + 150000;
  let ended = "";
  let seen = 0;
  while (!ended && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 300));
    for (; seen < events.length; seen++) {
      const e = events[seen]!;
      if (e.type === "approval-requested") await tree.answerApproval(e.requestId, "reject").catch(() => undefined);
      if (e.type === "turn-ended") ended = e.outcome;
    }
  }
  check("the turn ended", ended === "succeeded", ended);
  if (ended !== "succeeded") console.log("INFO  events:", JSON.stringify(events.filter((e) => e.type === "turn-ended").slice(-4)).slice(0, 800));
  check("the file is in the worktree", existsSync(join(directory, "made-here.txt")) && /CAPELLA-TREE/.test(readFileSync(join(directory, "made-here.txt"), "utf8")));
  check("the file is NOT in the project", !existsSync(join(project, "made-here.txt")));
  check("the project's own files are untouched", git("status", "--porcelain") === "" && readFileSync(join(project, "a.txt"), "utf8") === "inside\n", git("status", "--porcelain"));

  // An untracked file in it: does the server ask for force?
  let removal = "";
  await tree.dispose();
  tree = undefined;
  try {
    await main.removeWorktree(directory, false);
    removal = "removed without force";
  } catch (error) {
    const failure = error instanceof ApiError ? removalFailure(error.body) : { message: String(error), forceRequired: false };
    removal = `refused (forceRequired=${failure.forceRequired}): ${failure.message}`;
    if (failure.forceRequired) await main.removeWorktree(directory, true);
  }
  console.log("INFO  removal with an untracked file in it:", removal);
  if (existsSync(directory)) await main.removeWorktree(directory, true).catch((e) => console.log("INFO  second removal:", String(e).slice(0, 200)));
  check("the worktree's folder is gone", !existsSync(directory));
  check("it is no longer listed", !(await main.worktrees()).some((r) => r.directory === directory));
  check("git no longer knows it", git("worktree", "list").split("\n").length === 1, git("worktree", "list"));
} finally {
  await tree?.dispose();
  await main.dispose();
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
