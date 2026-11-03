import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mapModelsV1, mimeFor } from "../../src/opencode/backend-v1.ts";
import type { ChatEvent } from "../../src/opencode/events.ts";
import { V1EventMapper } from "../../src/opencode/events-v1.ts";
import { mapSessionRowsV1, replayItemsV1 } from "../../src/opencode/history.ts";
import { modeById, v1Rules } from "../../src/opencode/modes.ts";
import { OpencodeSession, type SessionEvent } from "../../src/opencode/session.ts";
import type { OpencodeClient } from "../../src/opencode/client.ts";

const S = "ses_1";
const frame = (type: string, properties: Record<string, unknown>) => JSON.stringify({ id: "evt", type, properties });
const run = (mapper: V1EventMapper, frames: string[]): ChatEvent[] => frames.flatMap((f) => mapper.map(f, S)).flatMap((r) => (r.kind === "event" ? [r.event] : []));

test("a read turn as 1.19.5 sends it becomes the same events as 2.x (frames from scripts/probe-v1-turn.ts)", () => {
  const m = new V1EventMapper();
  const events = run(m, [
    frame("session.status", { sessionID: S, status: { type: "busy" } }),
    frame("message.updated", { sessionID: S, info: { id: "msg_user", role: "user", sessionID: S } }),
    frame("message.part.updated", { sessionID: S, part: { type: "text", text: "Read hello.txt", messageID: "msg_user", sessionID: S, id: "prt_user" } }),
    frame("message.updated", { sessionID: S, info: { id: "msg_a1", role: "assistant", sessionID: S } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_s", messageID: "msg_a1", sessionID: S, type: "step-start" } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_r", messageID: "msg_a1", sessionID: S, type: "reasoning", text: "", time: { start: 1 } } }),
    frame("message.part.delta", { sessionID: S, messageID: "msg_a1", partID: "prt_r", field: "text", delta: "Let me read" }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_r", messageID: "msg_a1", sessionID: S, type: "reasoning", text: "Let me read", time: { start: 1, end: 2 } } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_t", messageID: "msg_a1", sessionID: S, type: "tool", tool: "read", callID: "call_1", state: { status: "pending", input: {}, raw: "" } } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_t", messageID: "msg_a1", sessionID: S, type: "tool", tool: "read", callID: "call_1", state: { status: "running", input: { filePath: "hello.txt" } } } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_t", messageID: "msg_a1", sessionID: S, type: "tool", tool: "read", callID: "call_1", state: { status: "completed", input: { filePath: "hello.txt" }, output: "1: hi" } } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_f", messageID: "msg_a1", sessionID: S, type: "step-finish", reason: "tool-calls", tokens: { total: 9, input: 5, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } } }),
    frame("message.updated", { sessionID: S, info: { id: "msg_a2", role: "assistant", sessionID: S } }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_x", messageID: "msg_a2", sessionID: S, type: "text", text: "", time: { start: 3 } } }),
    frame("message.part.delta", { sessionID: S, messageID: "msg_a2", partID: "prt_x", field: "text", delta: "It says hi." }),
    frame("message.part.updated", { sessionID: S, part: { id: "prt_x", messageID: "msg_a2", sessionID: S, type: "text", text: "It says hi.", time: { start: 3, end: 4 } } }),
    frame("session.idle", { sessionID: S }),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["turn-started", "step-started", "reasoning", "reasoning-end", "tool-started", "tool-input", "tool-called", "tool-input", "tool-result", "step-ended", "text", "text-end", "turn-ended"]);
  const text = events.find((e) => e.type === "text");
  assert.deepEqual(text?.type === "text" && [text.delta, text.ordinal, text.messageId], ["It says hi.", 0, "msg_a2"]);
  const result = events.find((e) => e.type === "tool-result");
  assert.equal(result?.type === "tool-result" && result.text, "1: hi");
  const ended = events.find((e) => e.type === "step-ended");
  assert.deepEqual(ended?.type === "step-ended" && ended.tokens, { input: 5, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 0 });
});

test("the user's own message is never shown as the assistant's, even when its part arrives before its header", () => {
  const m = new V1EventMapper();
  assert.deepEqual(run(m, [frame("message.part.updated", { sessionID: S, part: { id: "p", messageID: "msg_u", sessionID: S, type: "text", text: "my question" } })]), []);
  run(m, [frame("message.updated", { sessionID: S, info: { id: "msg_u", role: "user", sessionID: S } })]);
  assert.deepEqual(run(m, [frame("message.part.updated", { sessionID: S, part: { id: "p", messageID: "msg_u", sessionID: S, type: "text", text: "my question", time: { start: 1 } } })]), []);
});

test("a rejected permission fails the tool and a usage cap is told apart", () => {
  const m = new V1EventMapper();
  const events = run(m, [
    frame("permission.asked", { id: "per_1", sessionID: S, permission: "bash", patterns: ["echo hi"], metadata: {}, always: ["echo *"], tool: { messageID: "m", callID: "c" } }),
    frame("permission.replied", { sessionID: S, requestID: "per_1", reply: "reject" }),
    frame("message.part.updated", { sessionID: S, part: { id: "t", messageID: "m", sessionID: S, type: "tool", tool: "bash", callID: "c", state: { status: "error", input: { command: "echo hi" }, error: "The user rejected permission to use this specific tool call." } } }),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["approval-requested", "approval-resolved", "tool-started", "tool-failed"]);
  const asked = events[0];
  assert.deepEqual(asked?.type === "approval-requested" && [asked.action, asked.resources, asked.saves, asked.source], ["bash", ["echo hi"], ["echo *"], { messageId: "m", callId: "c" }]);
  const failed = events[3];
  assert.equal(failed?.type === "tool-failed" && failed.errorType, "permission.rejected");
  const cap = run(new V1EventMapper(), [frame("session.error", { sessionID: S, error: { name: "APIError", data: { message: "Too many requests", statusCode: 429 } } }), frame("session.idle", { sessionID: S })]);
  assert.equal(cap.length, 1, "the idle that follows an error does not end the turn a second time");
  const end = cap[0];
  assert.deepEqual(end?.type === "turn-ended" && [end.outcome, end.error?.rateLimited], ["failed", true]);
  const stop = run(new V1EventMapper(), [frame("session.error", { sessionID: S, error: { name: "MessageAbortedError", data: { message: "aborted" } } })]);
  assert.equal(stop[0]?.type === "turn-ended" && stop[0].outcome, "interrupted");
});

test("frames of other sessions and state chatter are ignored, unknown ones are counted", () => {
  const m = new V1EventMapper();
  assert.deepEqual(m.map(frame("message.part.delta", { sessionID: "ses_other", partID: "x", delta: "z" }), S), [{ kind: "ignored" }]);
  assert.deepEqual(m.map(frame("plugin.added", { id: "x" }), S), [{ kind: "ignored" }]);
  assert.deepEqual(m.map(frame("session.updated", { sessionID: S, info: {} }), S), [{ kind: "ignored" }]);
  assert.deepEqual(m.map(frame("brand.new", {}), S), [{ kind: "unknown", eventType: "brand.new" }]);
  assert.deepEqual(m.map("not json", S), []);
});

test("the catalog is whitelisted: provider options (which hold the API key) never come through", () => {
  const mapped = mapModelsV1({ providers: [{ id: "opencode", options: { apiKey: "SECRET" }, models: { a: { id: "a", name: "A Free", cost: { input: 0, output: 0 }, capabilities: { input: { image: true } }, limit: { context: 5 } } } }, { id: "x", models: { b: { name: "B", headers: { authorization: "SECRET" }, capabilities: { input: { image: false } } } } }, { nope: 1 }] });
  assert.equal(JSON.stringify(mapped).includes("SECRET"), false);
  assert.deepEqual(mapped.map((m) => [m.providerId, m.modelId, m.free, m.images, m.family]), [["opencode", "a", true, true, "zen"], ["x", "b", false, false, "other"]]);
});

test("1.x rules use its own names", () => {
  assert.deepEqual(v1Rules(modeById("plan")), [{ permission: "edit", pattern: "*", action: "deny" }, { permission: "bash", pattern: "*", action: "deny" }, { permission: "webfetch", pattern: "*", action: "allow" }, { permission: "websearch", pattern: "*", action: "allow" }, { permission: "external_directory", pattern: "*", action: "ask" }]);
  // 1.x appends rules and the last match wins: every mode is a complete set, so it can loosen what an earlier one tightened.
  assert.deepEqual(v1Rules(modeById("bypass")).map((r) => r.action), ["allow", "allow", "allow", "allow", "allow"]);
  assert.deepEqual(v1Rules(modeById("accept-edits")).map((r) => [r.permission, r.action]), [["edit", "allow"], ["bash", "ask"], ["webfetch", "ask"], ["websearch", "ask"], ["external_directory", "ask"]]);
});

test("a stored 1.x chat replays with one answer per question, and subagent sessions are not listed", () => {
  const rows = mapSessionRowsV1([{ id: "ses_a", title: "A", time: { created: 1, updated: 5 } }, { id: "ses_s", title: "sub", parentID: "ses_a", time: { created: 1, updated: 9 } }]);
  assert.deepEqual(rows.map((r) => r.id), ["ses_a"]);
  const items = replayItemsV1([
    { info: { role: "user" }, parts: [{ type: "text", text: "Read it" }, { type: "file", mime: "image/png", filename: "r.png", url: "data:image/png;base64,AAAA" }] },
    { info: { role: "assistant" }, parts: [{ type: "reasoning", text: "hm" }, { type: "tool", callID: "c", tool: "read", state: { status: "completed", input: {}, output: "ok" } }, { type: "step-finish", tokens: { input: 5, output: 1, cache: { read: 2 } } }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "done" }, { type: "step-finish", tokens: { input: 1, output: 4, cache: {} } }] },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant"]);
  const answer = items[1];
  assert.deepEqual(answer?.kind === "assistant" && answer.parts.map((p) => p.kind), ["reasoning", "tool", "text"]);
  assert.deepEqual(answer?.kind === "assistant" && [answer.tokens?.input, answer.tokens?.output, answer.tokens?.cacheRead], [6, 5, 2]);
  const user = items[0];
  assert.equal(user?.kind === "user" && user.files[0]?.thumb, "data:image/png;base64,AAAA");
});

test("the media type of an attachment comes from its data URI, else its name", () => {
  assert.equal(mimeFor({ uri: "data:image/webp;base64,AA", name: "x" }), "image/webp");
  assert.equal(mimeFor({ uri: "file:///a/b.PNG", name: "b.PNG" }), "image/png");
  assert.equal(mimeFor({ uri: "file:///a/b.ts", name: "b.ts" }), "text/plain");
  assert.equal(mimeFor({ uri: "file:///a/b", name: "b", mime: "application/json" }), "application/json");
});

// ---- the whole session against a fake 1.x server ------------------------------------------------------------------------

const fixture = new URL("../fixtures/fake-opencode-v1.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sessions: OpencodeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  delete process.env.FAKE_V1_FAIL;
});
function make(mode?: "plan" | "review" | "accept-edits" | "bypass") {
  const session = new OpencodeSession({ binary: process.execPath, binaryArgs: [fixture], workspaceRoot: process.cwd(), mode });
  sessions.push(session);
  const events: SessionEvent[] = [];
  session.on("event", (e: SessionEvent) => events.push(e));
  return { session, events };
}
async function until(events: SessionEvent[], type: SessionEvent["type"], count = 1): Promise<void> {
  const deadline = Date.now() + 8000;
  while (events.filter((e) => e.type === type).length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}; saw ${events.map((e) => e.type).join(",")}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const calls = async (s: OpencodeSession) => (await (s as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls"));

test("a 1.x server is detected, its catalog read without secrets, and the compatibility is OK", async () => {
  const { session } = make();
  await session.start();
  assert.equal(session.generation, "v1");
  assert.equal(session.version, "1.19.5-fake");
  assert.equal(session.compat?.generation, "v1");
  assert.equal(session.compat?.status, "ok", "every route Capella needs is present");
  assert.equal(JSON.stringify(session.models).includes("SECRET"), false);
  assert.deepEqual(session.models.map((m) => [m.modelId, m.free]), [["m1", true], ["m2", false]]);
  assert.equal(await session.usage(), undefined, "1.x has no usage endpoint");
});

test("a turn on 1.x: the session is created with the mode's rules and the model, the prompt carries model, agent and files", async () => {
  const { session, events } = make("review");
  await session.send("hello", [{ uri: "data:image/png;base64,AAAA", name: "r.png" }]);
  await until(events, "turn-ended");
  assert.deepEqual(session.currentModel, { providerId: "opencode", modelId: "m1" }, "the user's default was resolved and selected explicitly");
  const all = await calls(session);
  const create = all.find((c) => c.method === "POST" && c.path === "/session");
  assert.deepEqual(create?.body.model, { id: "m1", providerID: "opencode" });
  assert.equal(create?.body.agent, "build");
  assert.ok((create?.body.permission as Array<{ permission: string; action: string }>).some((r) => r.permission === "bash" && r.action === "ask"));
  const prompt = all.find((c) => c.path.endsWith("/prompt_async"));
  assert.deepEqual(prompt?.body.model, { providerID: "opencode", modelID: "m1" });
  assert.equal(prompt?.body.agent, "build");
  assert.deepEqual(prompt?.body.parts, [{ type: "text", text: "hello" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "r.png" }]);
  const streamed = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.equal(streamed, "echo: hello", "the deltas add up to the text once: the final part update repeats nothing");
  const end = events.find((e) => e.type === "text-end");
  assert.equal(end?.type === "text-end" && end.text, "echo: hello");
});

test("an approval on 1.x is relayed once and answered as the user picked", async () => {
  const { session, events } = make("review");
  await session.send("ask:echo hi");
  await until(events, "approval-requested");
  await session.surfacePendingApprovals();
  assert.equal(events.filter((e) => e.type === "approval-requested").length, 1);
  await session.answerApproval("per_1", "reject", "a note 1.x cannot take");
  await until(events, "turn-ended");
  const failed = events.find((e) => e.type === "tool-failed");
  assert.equal(failed?.type === "tool-failed" && failed.errorType, "permission.rejected");
  const reply = (await calls(session)).find((c) => c.path.endsWith("/permissions/per_1"));
  assert.deepEqual(reply?.body, { response: "reject" });
});

test("changing the mode on 1.x patches the rules and switches the agent for the next prompt; the model can change too", async () => {
  const { session, events } = make("plan");
  await session.send("one");
  await until(events, "turn-ended");
  await session.setMode("accept-edits");
  await session.setModel("opencode-go/m2");
  await session.send("two");
  await until(events, "turn-ended", 2);
  const all = await calls(session);
  const patch = all.find((c) => c.method === "PATCH");
  assert.deepEqual(patch?.body.permission, v1Rules(modeById("accept-edits"), "mode", { mcp: ["docs"] }));
  const second = all.filter((c) => c.path.endsWith("/prompt_async"))[1];
  assert.equal(second?.body.agent, "build");
  assert.deepEqual(second?.body.model, { providerID: "opencode-go", modelID: "m2" });
});

test("a usage cap on 1.x ends the turn as failed with the limit flagged", async () => {
  process.env.FAKE_V1_FAIL = "1";
  const { session, events } = make();
  await session.send("hi");
  await until(events, "turn-ended");
  const end = events.find((e) => e.type === "turn-ended");
  assert.deepEqual(end?.type === "turn-ended" && [end.outcome, end.error?.rateLimited, end.error?.status], ["failed", true, 429]);
});

test("stored chats on 1.x: list, resume under the current mode, fork", async () => {
  const { session } = make("plan");
  assert.deepEqual((await session.listSessions()).map((r) => r.id), ["ses_old"]);
  const items = await session.resume("ses_old");
  assert.equal(session.id, "ses_old");
  assert.deepEqual(session.currentModel, { providerId: "opencode-go", modelId: "m2" });
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant"]);
  const patch = (await calls(session)).find((c) => c.method === "PATCH" && c.path === "/session/ses_old");
  assert.deepEqual(patch?.body.permission, v1Rules(modeById("plan"), "mode", { mcp: ["docs"] }), "the stored chat gets this chat's rules, whatever it had");
  assert.equal(await session.fork("ses_old"), "ses_fork");
});

test("on 1.x the effort rides on each prompt as `variant`", async () => {
  const { session, events } = make("review");
  await session.setModel("opencode/m1");
  await session.setEffort("low");
  await session.send("hello");
  await until(events, "turn-ended");
  const prompt = (await calls(session)).find((c) => c.path.endsWith("/prompt_async"));
  assert.equal(prompt?.body.variant, "low");
});

test("a spent free allowance (status retry, as 1.19.5 sends it) ends the turn once as a flagged failure, and the abort that follows adds nothing", () => {
  const mapper = new V1EventMapper();
  const retry = frame("session.status", { sessionID: S, status: { type: "retry", attempt: 1, message: "Free usage exceeded, subscribe to Go", action: { reason: "free_tier_limit", provider: "opencode" } } });
  const events = run(mapper, [
    frame("session.status", { sessionID: S, status: { type: "busy" } }),
    retry,
    retry,
    frame("session.error", { sessionID: S, error: { name: "MessageAbortedError", data: { message: "aborted" } } }),
    frame("session.idle", { sessionID: S }),
  ]);
  assert.deepEqual(events.map((e) => e.type), ["turn-started", "turn-ended"]);
  const ended = events[1] as Extract<ChatEvent, { type: "turn-ended" }>;
  assert.equal(ended.outcome, "failed");
  assert.equal(ended.error?.rateLimited, true);
  // a transient retry is not an ending
  const other = run(new V1EventMapper(), [frame("session.status", { sessionID: S, status: { type: "busy" } }), frame("session.status", { sessionID: S, status: { type: "retry", attempt: 1, message: "overloaded" } })]);
  assert.deepEqual(other.map((e) => e.type), ["turn-started"]);
});

test("on 1.x there is no queue; the palette is the server's command list, skills among them", async () => {
  const { session } = make();
  await session.start();
  assert.equal(session.canQueue, false);
  assert.deepEqual(await session.queued(), []);
  const rows = await session.slash();
  assert.deepEqual(rows.map((r) => `${r.kind}:${r.name}`), ["command:review", "skill:pdf"]);
});

test("on 1.x a folder is appended after the base set, and removing it appends the ask again", async () => {
  const { session } = make("review");
  await session.setFolders(["/work/lib"]);
  await session.send("hi");
  await new Promise((r) => setTimeout(r, 300));
  await session.setFolders([]);
  const calls = await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: { permission?: Array<{ permission: string; pattern: string; action: string }> } }>>("/api/calls");
  const external = (c: (typeof calls)[number]) => (c.body.permission ?? []).filter((r) => r.permission === "external_directory").map((r) => `${r.action}:${r.pattern}`);
  const created = calls.find((c) => c.method === "POST" && c.path === "/session")!;
  assert.deepEqual(external(created), ["ask:*", "allow:/work/lib/*"]);
  const patch = calls.filter((c) => c.method === "PATCH").at(-1)!;
  assert.deepEqual(external(patch), ["ask:*"]);
});

test("on 1.x: MCP servers are listed by name, added, switched off and 'removed' by disconnecting; skills come from /skill and plugins from the config", async () => {
  const { session } = make("review");
  await session.start();
  assert.deepEqual(await session.mcpList(), [{ name: "docs", status: "connected", detail: undefined }]);
  await session.mcpAdd("probe", { type: "remote", url: "https://example.com/mcp" });
  assert.deepEqual((await session.mcpList()).map((s) => s.name), ["docs", "probe"]);
  await session.mcpSetEnabled("probe", false);
  assert.equal((await session.mcpList()).find((s) => s.name === "probe")!.status, "disabled");
  await session.mcpRemove("probe");
  assert.equal((await session.mcpList()).find((s) => s.name === "probe")!.status, "disabled");
  assert.deepEqual((await session.skills()).map((s) => [s.name, s.path]), [["pdf", "/skills/pdf/SKILL.md"]]);
  assert.deepEqual((await session.plugins()).map((p) => [p.kind, p.name, p.state]), [["config", "some-plugin@1.2.3", "configured"], ["config", "other-plugin", "configured"]]);
  await assert.rejects(session.pluginsCheck(), /needs opencode 2.x/);
});

test("on 1.x: providers come from /provider with the connected ones marked, a key is stored with PUT /auth and removed with DELETE, and a browser sign-in says to use the terminal", async () => {
  const { session } = make("review");
  await session.start();
  const first = await session.accounts();
  assert.deepEqual(first.map((a) => [a.id, a.connections.length, a.key, a.oauth.length]), [["opencode", 1, true, 0], ["opencode-go", 0, true, 0]]);
  await session.connectKey("opencode-go", "A-1X-KEY-789");
  const sent = (await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls")).find((c) => c.method === "PUT" && c.path === "/auth/opencode-go")!;
  assert.deepEqual(sent.body, { type: "api", key: "A-1X-KEY-789" });
  assert.equal((await session.accounts()).find((a) => a.id === "opencode-go")!.connections.length, 1);
  await session.disconnect("opencode-go");
  assert.equal((await session.accounts()).find((a) => a.id === "opencode-go")!.connections.length, 0);
  await assert.rejects(session.oauthStart("opencode", "x", {}), /opencode auth login/);
});
