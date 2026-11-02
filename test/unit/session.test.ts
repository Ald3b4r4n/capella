import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { OpencodeClient } from "../../src/opencode/client.ts";
import { OpencodeSession, type SessionEvent } from "../../src/opencode/session.ts";

const fixture = new URL("../fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sessions: OpencodeSession[] = [];

function make(options: { mode?: "plan" | "review" | "accept-edits" | "bypass"; model?: string } = {}) {
  const session = new OpencodeSession({ binary: process.execPath, binaryArgs: [fixture], workspaceRoot: process.cwd(), ...options });
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

const calls = async (session: OpencodeSession) =>
  (await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls")).map((c) => `${c.method} ${c.path}`);

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
});

test("starts, reads the version and maps the catalog without leaking provider settings", async () => {
  const { session } = make();
  await session.start();
  assert.equal(session.version, "9.9.9-fake");
  assert.deepEqual(session.models.map((m) => [m.modelId, m.family, m.free]), [["m1", "zen", true], ["m2", "go", false]]);
  assert.equal(JSON.stringify(session.models).includes("SECRET"), false);
});

test("a turn streams as events, and the model is selected explicitly before the prompt", async () => {
  const { session, events } = make({ mode: "review" });
  await session.send("hi");
  await until(events, "turn-ended");
  const text = events.find((e) => e.type === "text");
  assert.equal(text?.type === "text" && text.delta, "echo: hi");
  // No model was chosen, so the user's own default was resolved and selected before the first prompt.
  assert.deepEqual(session.currentModel, { providerId: "opencode-go", modelId: "m2" });
  const order = await calls(session);
  assert.ok(order.indexOf("POST /api/session/ses_1/model") > order.indexOf("POST /api/session"));
  assert.ok(order.indexOf("POST /api/session/ses_1/model") < order.indexOf("POST /api/session/ses_1/prompt"));
});

test("the session is created with the agent and rules of the mode", async () => {
  const { session } = make({ mode: "plan" });
  await session.send("hi");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const all = await client.get<Array<{ method: string; path: string; body: { agent?: string; permissions?: Array<{ action: string; effect: string }> } }>>("/api/calls");
  const create = all.find((c) => c.method === "POST" && c.path === "/api/session");
  assert.equal(create?.body.agent, "plan");
  assert.ok(create?.body.permissions?.some((r) => r.action === "shell" && r.effect === "deny"));
});

test("an approval is relayed once, answered as the user picked, and a rejection fails the tool", async () => {
  const { session, events } = make({ mode: "review" });
  await session.send("ask:echo hi");
  await until(events, "approval-requested");
  // The pending list holds the same request the stream announced: it must not be shown twice.
  await session.surfacePendingApprovals();
  assert.equal(events.filter((e) => e.type === "approval-requested").length, 1);
  const asked = events.find((e) => e.type === "approval-requested");
  assert.deepEqual(asked?.type === "approval-requested" && [asked.action, asked.resources, asked.saves], ["shell", ["echo hi"], ["echo *"]]);
  await session.answerApproval("per_1", "reject", "no thanks");
  await until(events, "turn-ended");
  const failed = events.find((e) => e.type === "tool-failed");
  assert.equal(failed?.type === "tool-failed" && failed.errorType, "permission.rejected");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const all = await client.get<Array<{ path: string; body: Record<string, unknown> }>>("/api/calls");
  assert.deepEqual(all.find((c) => c.path.endsWith("/reply"))?.body, { decision: "reject", message: "no thanks" });
});

test("a failed model selection stops the send before any prompt", async () => {
  const { session } = make({ model: "p/bad" });
  await assert.rejects(session.send("hi"), /no such model/);
  assert.equal((await calls(session)).includes("POST /api/session/ses_1/prompt"), false);
});

test("changing the mode of a live session replaces the rules and the agent", async () => {
  const { session, events } = make({ mode: "plan" });
  await session.send("hi");
  await until(events, "turn-ended");
  await session.setMode("accept-edits");
  assert.equal(session.currentMode, "accept-edits");
  const order = await calls(session);
  assert.ok(order.includes("PATCH /api/session/ses_1"));
  assert.ok(order.includes("POST /api/session/ses_1/agent"));
});

test("a wrong password never reaches the host's data", async () => {
  const { session } = make();
  await session.start();
  const client = (session as unknown as { client: OpencodeClient }).client;
  const bad = new (client.constructor as typeof OpencodeClient)({ baseUrl: client.baseUrl, username: "opencode", password: "wrong" });
  await assert.rejects(bad.get("/api/info"), /HTTP 401/);
});

test("usage reads the Go windows from the host, and says nothing when signed out or unsupported", async () => {
  const { session } = make();
  await session.start();
  const snapshot = await session.usage();
  assert.deepEqual(snapshot?.windows.map((w) => [w.key, w.percent]), [["rolling", 42], ["weekly", 10], ["monthly", 3]]);

  process.env.FAKE_USAGE = "signed-out";
  const out = make();
  await out.session.start();
  assert.equal(await out.session.usage(), undefined);
  delete process.env.FAKE_USAGE;

  process.env.FAKE_NO_USAGE = "404";
  const old = make();
  await old.session.start();
  assert.equal(await old.session.usage(), undefined, "an opencode without the endpoint is not an error");
  delete process.env.FAKE_NO_USAGE;
});

test("stored sessions: list, resume under the current mode, and fork", async () => {
  const { session } = make({ mode: "plan" });
  const rows = await session.listSessions();
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.forked]), [["ses_new", "Untitled chat", true], ["ses_old", "Old chat", false]]);
  const messages = await session.resume("ses_old");
  assert.equal(session.id, "ses_old");
  assert.deepEqual(session.currentModel, { providerId: "opencode-go", modelId: "m2" });
  assert.equal(Array.isArray(messages) && messages.length === 2, true, "the stored conversation comes back as replay items");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const calls = await client.get<Array<{ method: string; path: string; body: { permissions?: Array<{ action: string; effect: string }>; agent?: string } }>>("/api/calls");
  const patch = calls.find((c) => c.method === "PATCH" && c.path === "/api/session/ses_old");
  assert.ok(patch?.body.permissions?.some((r) => r.action === "shell" && r.effect === "deny"), "the stored session gets the rules of Plan, not whatever it had");
  assert.equal(calls.find((c) => c.path === "/api/session/ses_old/agent")?.body.agent, "plan");
  const forked = await session.fork("ses_old");
  assert.equal(forked, "ses_fork");
  await session.resume(forked);
  assert.equal(session.id, "ses_fork");
});

test("attachments travel as files[] with their URI and name, and a plain message carries none", async () => {
  const { session, events } = make({ mode: "review" });
  await session.send("what is this?", [{ uri: "file:///c:/proj/a.txt", name: "a.txt" }, { uri: "data:text/plain;base64,aGk=", name: "sel.ts:1-2" }]);
  await until(events, "turn-ended");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const calls = await client.get<Array<{ path: string; body: { text?: string; files?: Array<{ uri: string; name: string }> } }>>("/api/calls");
  const prompt = calls.find((c) => c.path.endsWith("/prompt"));
  assert.deepEqual(prompt?.body.files, [{ uri: "file:///c:/proj/a.txt", name: "a.txt" }, { uri: "data:text/plain;base64,aGk=", name: "sel.ts:1-2" }]);
  await session.send("and without");
  await until(events, "turn-ended", 2);
  const later = (await client.get<Array<{ path: string; body: { files?: unknown } }>>("/api/calls")).filter((c) => c.path.endsWith("/prompt"));
  assert.equal("files" in (later[1]?.body ?? {}), false);
});

test("ids from the page are checked before they become part of a URL path", async () => {
  const { assertId } = await import("../../src/opencode/session.ts");
  assert.equal(assertId("ses_e63fb110cffe4XL31GkGa0UfAc", "ses"), "ses_e63fb110cffe4XL31GkGa0UfAc");
  assert.equal(assertId("per_19c1159db001YZZABZ2EO6leGG", "per"), "per_19c1159db001YZZABZ2EO6leGG");
  for (const bad of ["../session", "ses_1/../../x", "ses_1?x=1", "per_1", "", "ses_ 1"]) assert.throws(() => assertId(bad, "ses"), /not a valid/, bad);
  const { session } = make();
  await session.start();
  await assert.rejects(session.fork("../config"), /not a valid session id/);
  await assert.rejects(session.resume("ses_old/../x"), /not a valid session id/);
});

test("the model list is read again on request and when the server says it changed; a failed read keeps the old list and says so", async () => {
  const { session, events } = make();
  await session.start();
  const call = (body: unknown) => (session as unknown as { client: OpencodeClient }).client.post("/api/test", body);
  const catalogEvents = () => events.filter((e): e is Extract<SessionEvent, { type: "catalog" }> => e.type === "catalog");

  await call({ models: [{ id: "m1", modelID: "m1", providerID: "opencode", name: "Zen One Free" }, { id: "m3", modelID: "m3", providerID: "opencode", name: "Zen Three" }] });
  await session.refreshModels();
  assert.deepEqual([catalogEvents().at(-1)?.added, catalogEvents().at(-1)?.removed], [["opencode/m3"], ["opencode-go/m2"]]);
  assert.deepEqual(session.models.map((m) => m.modelId), ["m1", "m3"]);

  await call({ fail: true });
  await session.refreshModels();
  assert.match(catalogEvents().at(-1)?.stale ?? "", /catalog unavailable|500/);
  assert.deepEqual(session.models.map((m) => m.modelId), ["m1", "m3"], "the last good list is kept");

  await call({ fail: false, models: [] });
  await session.refreshModels();
  assert.match(catalogEvents().at(-1)?.stale ?? "", /empty/);
  assert.equal(session.models.length, 2, "an empty list after a good one is a failure, not 'no models'");

  // The server announcing an update makes Capella read again, once, after the burst settles.
  await call({ models: [{ id: "m1", modelID: "m1", providerID: "opencode", name: "Zen One Free" }] });
  const before = catalogEvents().length;
  await session.setModel("opencode/m1"); // makes sure an event stream is open and a session exists
  await call({ emit: "provider.updated" });
  await call({ emit: "model.updated" });
  const deadline = Date.now() + 6000;
  while (catalogEvents().length === before && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.equal(catalogEvents().length, before + 1, "two announcements, one read");
  assert.deepEqual(catalogEvents().at(-1)?.removed, ["opencode/m3"]);
});

test("the reasoning effort is one of the model's own variants, travels with the model, and resets when the model changes", async () => {
  const { session, events } = make({ model: "opencode/m1" });
  await session.start();
  await assert.rejects(session.setEffort("extreme"), /not one of this model's options/);
  await session.send("one");
  await until(events, "turn-ended");
  await session.setEffort("high");
  assert.equal(session.effort, "high");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const models = (await client.get<Array<{ path: string; body: { model?: { id?: string; variant?: string } } }>>("/api/calls")).filter((c) => c.path.endsWith("/model"));
  assert.equal(models.at(-1)?.body.model?.variant, "high");
  await session.setModel("opencode-go/m2");
  assert.equal(session.effort, undefined, "a variant belongs to one model");
  await session.setEffort(undefined).catch(() => undefined);
});

test("web access is sent as rules: at creation, and replacing the mode's on a live session", async () => {
  const { session, events } = make({ mode: "review" });
  await session.setWeb("deny");
  await session.send("hi");
  await until(events, "turn-ended");
  const client = (session as unknown as { client: OpencodeClient }).client;
  const get = () => client.get<Array<{ method: string; path: string; body: { permissions?: Array<{ action: string; effect: string }> } }>>("/api/calls");
  const created = (await get()).find((c) => c.method === "POST" && c.path === "/api/session");
  assert.deepEqual(created?.body.permissions?.filter((r) => /^web/.test(r.action)).map((r) => r.effect), ["deny", "deny"]);
  await session.setWeb("mode");
  const patch = (await get()).filter((c) => c.method === "PATCH").at(-1);
  assert.deepEqual(patch?.body.permissions?.filter((r) => /^web/.test(r.action)).map((r) => r.effect), ["ask", "ask"], "back to the mode's own rule");
});
