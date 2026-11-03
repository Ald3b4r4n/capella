// Check of the agent's questions against a REAL opencode (2.x or 1.x) with a real model: the agent uses its question tool, the
// request reaches Capella with its options, an answer goes back and the agent continues with it, and declining ends the wait.
// Nothing is approved and no file or command is involved: the only thing answered is a question about a colour.
//
// Usage: node scripts/check-questions.ts <opencode executable> [providerID/modelID]
//   CAPELLA_ISOLATED=1 (a throwaway home with the API keys stripped; always for 1.x) and CAPELLA_GO_AUTH=1 (copy only the
//   `opencode-go` credential into it), as in check-mcp.ts.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-questions.ts <opencode executable> [model]");
const model = process.argv[3] ?? "opencode-go/deepseek-v4.1-flash";
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-qcheck-")));
const project = join(base, "project");
mkdirSync(project);

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

const ask = "Use your tool for asking the user a question (not plain text) to ask me which colour I prefer, with the choices Red and Blue, then wait for my answer and tell me what I picked.";

/** One turn; each question the agent asks is handled by `decide` (an answer, or undefined to decline). */
async function turn(text: string, decide: (n: number) => string | undefined): Promise<{ questions: number; answer: string; ended: string; resolved: string[] }> {
  const from = events.length;
  let seen = from;
  let questions = 0;
  let ended = "";
  let answer = "";
  const resolved: string[] = [];
  await session.send(text);
  const until = Date.now() + 120000;
  while (!ended && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 250));
    for (; seen < events.length; seen++) {
      const e = events[seen]!;
      if (e.type === "question-asked") {
        questions++;
        const choice = decide(questions);
        if (choice) await session.answerQuestion(e.request.requestId, Object.fromEntries(e.request.fields.map((f) => [f.key, f.kind === "multi" ? [choice] : choice])));
        else await session.rejectQuestion(e.request.requestId, "The user chose not to answer.");
      }
      if (e.type === "question-resolved") resolved.push(e.outcome);
      if (e.type === "text") answer += e.delta;
      if (e.type === "text-end") answer = e.text;
      if (e.type === "turn-ended") ended = e.outcome;
    }
  }
  return { questions, answer, ended, resolved };
}

try {
  await session.start();
  console.log(`opencode ${session.version} (${session.generation}), model ${model}`);
  const answered = await turn(ask, () => "Blue");
  check("the agent's question reached Capella", answered.questions >= 1, answered.questions);
  check("the user's answer was taken and the turn went on to its end", answered.resolved.includes("answered") && answered.ended === "succeeded", answered);
  check("the agent continued with the answer", /blue/i.test(answered.answer), answered.answer.slice(0, 160));

  const declined = await turn(ask, (n) => (n === 1 ? undefined : "Blue"));
  check("declining was reported as declined", declined.resolved[0] === "rejected", declined.resolved);
  check("and the turn ended instead of waiting", declined.ended !== "", declined);
} finally {
  await session.dispose();
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
