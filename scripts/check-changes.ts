// Real check of the change tracker: opencode edits and creates files in a THROWAWAY folder (a free model, Accept edits,
// shell denied by the mode), every event goes through ChangeTracker as the panel does, and each call's outcome is printed.
// Repeats the same turn a few times because a lost race between opencode's write and Capella's read is intermittent.
// Usage: node scripts/check-changes.ts [runs] [providerID/modelID]
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";
import { ChangeTracker } from "../src/ui/changes.ts";

const runs = Number(process.argv[2] ?? 3);
const model = process.argv[3] ?? "opencode/glm-5.3-flash-free";
let missed = 0;
for (let run = 1; run <= runs; run++) {
  const project = mkdtempSync(join(tmpdir(), "capella-chg-real-"));
  writeFileSync(join(project, "plan.txt"), "alpha\nbeta\ngamma\n");
  await new Promise((r) => setTimeout(r, 50));
  const session = new OpencodeSession({ binary: process.env.OPENCODE_BIN ?? "opencode", workspaceRoot: project, mode: "accept-edits", model });
  const tracker = new ChangeTracker([project]);
  const names = new Map<string, string>();
  const outcomes: string[] = [];
  let queue: Promise<void> = Promise.resolve();
  let ended = false;
  session.on("event", (event: SessionEvent) => {
    if (event.type === "resync" || event.type === "server-exit" || event.type === "catalog") return;
    if (event.type === "turn-ended") {
      ended = true;
      outcomes.push(`turn-ended ${event.outcome} ${JSON.stringify(event.error ?? null)}`);
    }
    const at = Date.now();
    if (event.type === "tool-started") names.set(event.callId, event.name);
    queue = queue.then(async () => {
      const change = await tracker.handle(event, at);
      if (event.type === "tool-input") outcomes.push(`input ${names.get(event.callId)} ${JSON.stringify(event.input)}`);
      if (event.type === "tool-result") outcomes.push(`result ${names.get(event.callId)} -> ${change ? `${change.status} +${change.additions} -${change.deletions}` : "NOT TRACKED"}`);
    });
  });
  try {
    await session.send("Use your edit tool to change the line 'beta' to 'BETA' in plan.txt, then create a file notes.md whose only line is '# Notes'. Do not run any command.");
    const until = Date.now() + 120000;
    while (!ended && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    await queue;
    const rows = await tracker.rows();
    const notes = existsSync(join(project, "notes.md"));
    console.log(`run ${run}: files on disk: notes.md=${notes}; tracked rows: ${rows.map((r) => `${r.rel}(${r.status})`).join(", ") || "none"}`);
    for (const line of outcomes) console.log("   ", line);
    if (notes && !rows.some((r) => r.rel === "notes.md")) missed++;
  } finally {
    await session.dispose();
    rmSync(project, { recursive: true, force: true });
  }
}
console.log(missed === 0 ? `ALL ${runs} RUNS TRACKED` : `${missed} of ${runs} runs MISSED the created file`);
process.exit(missed === 0 ? 0 : 1);
