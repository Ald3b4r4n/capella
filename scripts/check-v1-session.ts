// Real check of Capella's session against an installed opencode 1.x: detection, compatibility, a streamed turn, an approval
// that is REJECTED, a mode switch, stored chats (list, resume, fork). Throwaway home with your credentials stripped:
// opencode's free models answer with a public key, so none of your accounts is used or billed.
// Usage: node scripts/check-v1-session.ts <opencode-1.x executable> [providerID/modelID]
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession, type SessionEvent } from "../src/opencode/session.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-v1-session.ts <opencode-1.x executable> [model]");
const model = process.argv[3] ?? "opencode/mimo-v2.6-flash-free";
const home = mkdtempSync(join(tmpdir(), "capella-v1-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-v1-project-"));
writeFileSync(join(project, "hello.txt"), "The secret word is PERSIMMON.\n");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

const session = new OpencodeSession({ binary, workspaceRoot: project, env, mode: "review", model });
const events: SessionEvent[] = [];
session.on("event", (e: SessionEvent) => events.push(e));
const until = async (type: SessionEvent["type"], count: number, ms = 120000) => {
  const end = Date.now() + ms;
  while (events.filter((e) => e.type === type).length < count && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
  return events.filter((e) => e.type === type).length >= count;
};
try {
  await session.start();
  check("detected as opencode 1.x", session.generation === "v1", `${session.generation} ${session.version}`);
  check("compatibility is OK for the tested 1.x", session.compat?.status === "ok" || session.compat?.status === "newer", session.compat?.status);
  check("the catalog has the free Zen model and no secret", session.models.some((m) => `${m.providerId}/${m.modelId}` === model && m.free) && !JSON.stringify(session.models).includes("public"), session.models.length);
  check("usage is absent on 1.x", (await session.usage()) === undefined);

  await session.send("Read hello.txt and tell me the secret word, in one short sentence.");
  check("the first turn ended", await until("turn-ended", 1));
  const text = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  const tools = events.flatMap((e) => (e.type === "tool-started" ? [e.name] : []));
  console.log("   answer:", JSON.stringify(text.slice(0, 120)), "| tools:", tools.join(","));
  check("the answer streamed and names the word read from the file", /PERSIMMON/i.test(text) && tools.includes("read"));
  check("the user's own message was not shown as an answer", !events.some((e) => e.type === "text" && /Read hello\.txt and tell me/.test(e.delta)));
  const end1 = events.find((e) => e.type === "turn-ended");
  check("the turn ended as succeeded", end1?.type === "turn-ended" && end1.outcome === "succeeded");

  await session.send("Run the shell command: echo hello-v1");
  check("a shell approval was raised in Review mode", await until("approval-requested", 1, 90000));
  const asked = events.find((e) => e.type === "approval-requested");
  console.log("   approval:", JSON.stringify(asked));
  if (asked?.type === "approval-requested") await session.answerApproval(asked.requestId, "reject");
  check("the second turn ended after the rejection", await until("turn-ended", 2));
  check("the rejected tool is reported as rejected", events.some((e) => e.type === "tool-failed" && e.errorType === "permission.rejected"));

  await session.setMode("plan");
  check("the mode switched to Plan on the live session", session.currentMode === "plan");

  // Loosening: Plan denied the shell; Review asks. 1.x appends rules, so this only works if the new set overrides the old.
  const askedBefore = events.filter((e) => e.type === "approval-requested").length;
  await session.setMode("review");
  await session.send("Run the shell command: echo again-v1");
  check("after Plan, switching to Review makes the shell ask again (rules override, not accumulate)", await until("approval-requested", askedBefore + 1, 90000));
  const again = events.filter((e) => e.type === "approval-requested").at(-1);
  if (again?.type === "approval-requested") await session.answerApproval(again.requestId, "reject");
  await until("turn-ended", 3);
  await session.setMode("plan");

  const rows = await session.listSessions();
  check("the chat is in the stored list", rows.some((r) => r.id === session.id), rows.map((r) => r.title));
  const id = session.id!;
  const items = await session.resume(id);
  console.log("   replay:", JSON.stringify(items.map((i) => (i.kind === "user" ? `user:${i.text.slice(0, 24)}` : `assistant:${i.parts.map((p) => p.kind).join("+")}`))));
  check("the stored conversation replays the questions and the tool calls", items.filter((i) => i.kind === "user").length === 3 && items.some((i) => i.kind === "assistant" && i.parts.some((p) => p.kind === "tool")));
  const forked = await session.fork(id);
  const forkItems = await session.resume(forked);
  check("a fork opens with the same conversation", forkItems.length === items.length && forked !== id, { forked, items: forkItems.length });
  console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
} catch (error) {
  failed++;
  console.error("ERROR:", error instanceof Error ? error.message : String(error));
} finally {
  await session.dispose();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
