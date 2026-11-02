import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFrame, mapModels, parseFrame, type ChatEvent } from "../../src/opencode/events.ts";

const SESSION = "ses_1";

const frame = (type: string, data: Record<string, unknown>) => {
  const parsed = parseFrame(JSON.stringify({ id: "evt_1", created: 1, type, data }));
  assert.ok(parsed);
  return parsed;
};

const events = (frames: Array<[string, Record<string, unknown>]>): ChatEvent[] =>
  frames.flatMap(([type, data]) => {
    const result = mapFrame(frame(type, data), SESSION);
    return result.kind === "event" ? [result.event] : [];
  });

test("maps the sequence of one real turn (shape observed on opencode 2.2.5)", () => {
  const out = events([
    ["session.execution.started", { sessionID: SESSION }],
    ["session.step.started", { sessionID: SESSION, agent: "build", model: { id: "m", providerID: "p" }, assistantMessageID: "msg_a" }],
    ["session.reasoning.delta", { sessionID: SESSION, assistantMessageID: "msg_a", ordinal: 0, delta: "thinking" }],
    ["session.tool.input.started", { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", name: "read" }],
    ["session.tool.called", { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", input: { path: "hello.txt" }, executed: false }],
    ["session.tool.success", { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", content: [{ type: "text", text: "Read file" }] }],
    ["session.step.ended", { sessionID: SESSION, assistantMessageID: "msg_a", finish: "tool-calls", tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } } }],
    ["session.text.delta", { sessionID: SESSION, assistantMessageID: "msg_b", ordinal: 0, delta: "hi" }],
    ["session.execution.succeeded", { sessionID: SESSION }],
  ]);
  assert.deepEqual(
    out.map((e) => e.type),
    ["turn-started", "step-started", "reasoning", "tool-started", "tool-called", "tool-result", "step-ended", "text", "turn-ended"],
  );
  const result = out.find((e) => e.type === "tool-result");
  assert.equal(result?.type === "tool-result" && result.text, "Read file");
  const ended = out.find((e) => e.type === "step-ended");
  assert.deepEqual(ended?.type === "step-ended" && ended.tokens, { input: 10, output: 2, reasoning: 1, cacheRead: 3, cacheWrite: 0 });
});

test("frames of another session are ignored", () => {
  const result = mapFrame(frame("session.text.delta", { sessionID: "ses_other", delta: "x" }), SESSION);
  assert.equal(result.kind, "ignored");
});

test("state chatter is ignored and unknown session events are reported, never thrown", () => {
  assert.equal(mapFrame(frame("provider.updated", {}), SESSION).kind, "ignored");
  assert.equal(mapFrame(frame("mcp.status.changed", { server: "x" }), SESSION).kind, "ignored");
  assert.deepEqual(mapFrame(frame("session.something.new", { sessionID: SESSION }), SESSION), { kind: "unknown", eventType: "session.something.new" });
  assert.deepEqual(mapFrame(frame("brand.new.family", {}), SESSION), { kind: "unknown", eventType: "brand.new.family" });
});

test("a tool event without a call id degrades to unknown instead of crashing", () => {
  assert.equal(mapFrame(frame("session.tool.called", { sessionID: SESSION }), SESSION).kind, "unknown");
});

test("parseFrame rejects anything that is not a frame", () => {
  assert.equal(parseFrame("not json"), undefined);
  assert.equal(parseFrame("[]"), undefined);
  assert.equal(parseFrame('{"data":{}}'), undefined);
  assert.deepEqual(parseFrame('{"type":"server.connected"}'), { id: undefined, type: "server.connected", data: {} });
});

test("model mapping never exposes provider settings (API key, base URL)", () => {
  const secret = "vck_SECRET_SHOULD_NEVER_APPEAR";
  const rows = [
    { id: "a/b", modelID: "a/b", providerID: "vercel", name: "B", settings: { apiKey: secret, baseURL: "https://gateway.example/v1" }, variants: [{ id: "low", settings: { reasoningEffort: "low" } }], limit: { context: 1000 } },
    { id: "glm-free", modelID: "glm-free", providerID: "opencode", name: "GLM Free", settings: { apiKey: secret } },
    { id: "kimi", modelID: "kimi", providerID: "opencode-go", name: "Kimi" },
    { nope: true },
  ];
  const mapped = mapModels(rows);
  assert.equal(mapped.length, 3);
  assert.equal(JSON.stringify(mapped).includes(secret), false);
  assert.equal(JSON.stringify(mapped).includes("gateway.example"), false);
  assert.deepEqual(mapped.map((m) => m.family), ["other", "zen", "go"]);
  assert.equal(mapped[1]?.free, true);
  assert.deepEqual(mapped[0]?.variants, ["low"]);
  assert.equal(mapped[0]?.contextLimit, 1000);
});

test("model mapping tolerates garbage", () => {
  assert.deepEqual(mapModels(undefined), []);
  assert.deepEqual(mapModels([null, 5, "x"]), []);
});

test("maps a permission request, its reply and the failure it causes (shapes observed on 2.2.5)", () => {
  const asked = mapFrame(
    frame("permission.asked", { id: "per_1", sessionID: SESSION, action: "read", resources: [".env"], save: ["*"], source: { type: "tool", messageID: "msg_a", id: "call_1" } }),
    SESSION,
  );
  assert.deepEqual(asked, {
    kind: "event",
    event: { type: "approval-requested", sessionId: SESSION, requestId: "per_1", action: "read", resources: [".env"], saves: ["*"], source: { messageId: "msg_a", callId: "call_1" } },
  });
  const replied = mapFrame(frame("permission.replied", { sessionID: SESSION, requestID: "per_1", reply: "reject" }), SESSION);
  assert.deepEqual(replied, { kind: "event", event: { type: "approval-resolved", sessionId: SESSION, requestId: "per_1", reply: "reject" } });
  const failed = mapFrame(frame("session.tool.failed", { sessionID: SESSION, assistantMessageID: "msg_a", id: "call_1", error: { type: "permission.rejected", message: "no" }, executed: false }), SESSION);
  assert.deepEqual(failed, { kind: "event", event: { type: "tool-failed", sessionId: SESSION, messageId: "msg_a", callId: "call_1", errorType: "permission.rejected", message: "no" } });
});

test("permission frames of another session are ignored and malformed ones are unknown", () => {
  assert.equal(mapFrame(frame("permission.asked", { id: "p", sessionID: "ses_other", action: "read" }), SESSION).kind, "ignored");
  assert.equal(mapFrame(frame("permission.asked", { sessionID: SESSION }), SESSION).kind, "unknown");
});

test("the catalog tells which models take images, and says nothing when it does not know", () => {
  const mapped = mapModels([
    { modelID: "vl", providerID: "opencode", name: "VL", capabilities: { tools: true, input: ["text", "image"], output: ["text"] } },
    { modelID: "txt", providerID: "opencode", name: "Text", capabilities: { tools: true, input: ["text"], output: ["text"] } },
    { modelID: "unk", providerID: "opencode", name: "Unknown" },
  ]);
  assert.deepEqual(mapped.map((m) => m.images), [true, false, undefined]);
});
