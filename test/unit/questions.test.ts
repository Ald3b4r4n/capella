import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { OpencodeClient } from "../../src/opencode/client.ts";
import { mapForm, mapFrame, parseFrame } from "../../src/opencode/events.ts";
import { mapQuestionRequest, V1EventMapper } from "../../src/opencode/events-v1.ts";
import { OpencodeSession, type SessionEvent } from "../../src/opencode/session.ts";
import { sanitizeAnswers, visible } from "../../src/ui/questions.ts";

const fixture = new URL("../fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const fixtureV1 = new URL("../fixtures/fake-opencode-v1.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sessions: OpencodeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
});

function make(v1 = false) {
  const session = new OpencodeSession({ binary: process.execPath, binaryArgs: [v1 ? fixtureV1 : fixture], workspaceRoot: process.cwd(), mode: "review", ...(v1 ? { model: "opencode/m1" } : {}) });
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

const asked = (events: SessionEvent[]) => events.find((e) => e.type === "question-asked") as Extract<SessionEvent, { type: "question-asked" }> | undefined;

test("a 2.x form becomes the questions of the chat, field by field, and what it cannot read is dropped", () => {
  const request = mapForm({
    id: "frm_1",
    sessionID: "ses_1",
    title: "Questions",
    fields: [
      { key: "q0", title: "Colour", description: "Which?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true, required: true },
      { key: "q1", title: "Extras", type: "multiselect", options: [{ value: "a", label: "Alpha" }], minItems: 1, maxItems: 2, default: ["a"] },
      { key: "q2", title: "Ship it?", type: "boolean", default: true },
      { key: "q3", title: "Why?", type: "string", when: [{ key: "q0", op: "eq", value: "Blue" }, { key: "x", op: "bad", value: 1 }] },
      { key: "q4", title: "How many?", type: "integer", minimum: 1, maximum: 9 },
      { key: "q5", title: "Read", type: "external", url: "https://example.com/doc" },
      { key: "q6", title: "Mystery", type: "hologram" },
      { title: "no key", type: "string" },
    ],
  });
  assert.ok(request);
  assert.deepEqual(request.fields.map((f) => [f.key, f.kind]), [["q0", "choice"], ["q1", "multi"], ["q2", "boolean"], ["q3", "text"], ["q4", "integer"], ["q5", "link"]]);
  assert.equal(request.fields[0]!.custom, true);
  assert.deepEqual(request.fields[1]!.default, ["a"]);
  assert.deepEqual(request.fields[3]!.when, [{ key: "q0", op: "eq", value: "Blue" }], "an unknown operator is dropped");
  assert.deepEqual([request.fields[4]!.min, request.fields[4]!.max, request.fields[5]!.url], [1, 9, "https://example.com/doc"]);
  assert.equal(mapForm({ id: "frm_2", sessionID: "ses_1", title: "x", fields: [{ key: "k", type: "hologram" }] }), undefined);
  assert.equal(mapForm({ id: 5 }), undefined);
});

test("the frames of a form open, answer and close a question, only for this session", () => {
  const form = { id: "frm_1", sessionID: "ses_1", title: "Questions", fields: [{ key: "q0", title: "Colour", type: "string", options: [{ value: "Red", label: "Red" }] }] };
  const created = mapFrame(parseFrame(JSON.stringify({ id: "e1", type: "form.created", data: { form } }))!, "ses_1");
  assert.equal(created.kind === "event" && created.event.type, "question-asked");
  assert.equal(mapFrame(parseFrame(JSON.stringify({ id: "e1", type: "form.created", data: { form } }))!, "ses_other").kind, "ignored");
  const replied = mapFrame(parseFrame(JSON.stringify({ id: "e2", type: "form.replied", data: { id: "frm_1", sessionID: "ses_1", answer: { q0: "Red" } } }))!, "ses_1");
  assert.deepEqual(replied.kind === "event" ? replied.event : undefined, { type: "question-resolved", sessionId: "ses_1", requestId: "frm_1", outcome: "answered", answers: { q0: "Red" } });
  const cancelled = mapFrame(parseFrame(JSON.stringify({ id: "e3", type: "form.cancelled", data: { id: "frm_1", sessionID: "ses_1" } }))!, "ses_1");
  assert.equal(cancelled.kind === "event" && cancelled.event.type === "question-resolved" && cancelled.event.outcome, "rejected");
});

test("1.x question frames, as measured on 1.19.5, become the same events", () => {
  const frame = (type: string, properties: unknown) => JSON.stringify({ id: "e", type, properties });
  const mapper = new V1EventMapper();
  const request = { id: "que_1", sessionID: "ses_1", questions: [{ question: "Which colour do you prefer?", header: "Colour preference", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }, { question: "Extras?", multiple: true, options: [{ label: "A", description: "" }] }], tool: { messageID: "m", callID: "c" } };
  const asked1 = mapper.map(frame("question.asked", request), "ses_1");
  const event = asked1[0]!.kind === "event" ? asked1[0]!.event : undefined;
  assert.equal(event?.type, "question-asked");
  const fields = event?.type === "question-asked" ? event.request.fields : [];
  assert.deepEqual(fields.map((f) => [f.key, f.kind, f.title, f.description, f.custom]), [["q0", "choice", "Colour preference", "Which colour do you prefer?", true], ["q1", "multi", "Extras?", undefined, true]]);
  assert.deepEqual(fields[0]!.options!.map((o) => o.value), ["Red", "Blue"]);
  const answered = mapper.map(frame("question.replied", { sessionID: "ses_1", requestID: "que_1", answers: [["Blue"], ["A", "B"]] }), "ses_1");
  assert.deepEqual(answered[0]!.kind === "event" ? answered[0]!.event : undefined, { type: "question-resolved", sessionId: "ses_1", requestId: "que_1", outcome: "answered", answers: { q0: ["Blue"], q1: ["A", "B"] } });
  const rejected = mapper.map(frame("question.rejected", { sessionID: "ses_1", requestID: "que_1" }), "ses_1");
  assert.equal(rejected[0]!.kind === "event" && rejected[0]!.event.type === "question-resolved" && rejected[0]!.event.outcome, "rejected");
  assert.equal(mapper.map(frame("question.asked", request), "ses_other")[0]!.kind, "ignored");
  assert.equal(mapQuestionRequest({ id: "que_2", sessionID: "s", questions: [] }), undefined);
});

test("what the page sends back as an answer is checked before it is forwarded", () => {
  assert.deepEqual(sanitizeAnswers({ q0: "Blue", q1: ["a", "b"], q2: true, q3: 4 }), { q0: "Blue", q1: ["a", "b"], q2: true, q3: 4 });
  for (const bad of [null, "x", [], { "bad key!": "x" }, { q0: { nested: 1 } }, { q0: [1] }, { q0: Number.NaN }, { q0: "x".repeat(20_001) }, Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, "x"]))]) assert.equal(sanitizeAnswers(bad), undefined, JSON.stringify(bad)?.slice(0, 40));
});

test("a field that depends on another is shown only while the condition holds", () => {
  const why = { key: "q3", when: [{ key: "q0", op: "eq" as const, value: "Blue" }] };
  assert.equal(visible(why, { q0: "Blue" }), true);
  assert.equal(visible(why, { q0: "Red" }), false);
  assert.equal(visible({ when: [{ key: "q0", op: "neq" as const, value: "Red" }] }, {}), true);
  assert.equal(visible({ hidden: true }, {}), false);
});

test("2.x: the agent asks, the user answers, and the turn goes on with the answer", async () => {
  const { session, events } = make();
  await session.send("richform:go");
  await until(events, "question-asked");
  const request = asked(events)!.request;
  assert.equal(request.requestId, "frm_1");
  assert.deepEqual(request.fields.map((f) => f.kind), ["choice", "multi", "boolean", "text", "integer", "link"]);
  // the request is also in the host's pending list, which resync reads: it is not shown a second time
  assert.equal((await session.surfacePendingApprovals(), events.filter((e) => e.type === "question-asked").length), 1);
  await session.answerQuestion("frm_1", { q0: "Blue", q1: ["a"], q2: true, q3: "because", q4: 3 });
  await until(events, "question-resolved");
  await until(events, "turn-ended");
  const resolved = events.find((e) => e.type === "question-resolved") as Extract<SessionEvent, { type: "question-resolved" }>;
  assert.deepEqual([resolved.outcome, resolved.answers?.q0], ["answered", "Blue"]);
  const sent = (await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls")).find((c) => c.path.endsWith("/reply"))!;
  assert.deepEqual(sent.body, { answer: { q0: "Blue", q1: ["a"], q2: true, q3: "because", q4: 3 } });
  const text = events.filter((e) => e.type === "text-end").map((e) => (e.type === "text-end" ? e.text : ""));
  assert.match(text.join(" "), /You picked/);
});

test("2.x: declining tells the agent the user did not answer, and ids from the page are checked", async () => {
  const { session, events } = make();
  await session.send("form:go");
  await until(events, "question-asked");
  await session.rejectQuestion("frm_1", "The user chose not to answer.");
  await until(events, "question-resolved");
  await until(events, "turn-ended");
  assert.equal((events.find((e) => e.type === "question-resolved") as Extract<SessionEvent, { type: "question-resolved" }>).outcome, "rejected");
  const failed = events.find((e) => e.type === "tool-failed");
  assert.match(failed?.type === "tool-failed" ? failed.message : "", /did not answer|chose not to answer/);
  await assert.rejects(session.answerQuestion("../../x", { q0: "a" }), /not a valid id/);
});

test("1.x: the question is asked, answered with one list of labels for each question, and declined", async () => {
  const { session, events } = make(true);
  await session.send("question:go");
  await until(events, "question-asked");
  const request = asked(events)!.request;
  assert.deepEqual(request.fields.map((f) => [f.key, f.kind]), [["q0", "choice"], ["q1", "multi"]]);
  await session.answerQuestion(request.requestId, { q0: "Blue", q1: ["Alpha", "Beta"] });
  assert.equal(request.requestId, "que_1");
  await until(events, "question-resolved");
  await until(events, "turn-ended");
  const reply = (await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls")).find((c) => c.path === "/question/que_1/reply")!;
  assert.deepEqual(reply.body, { answers: [["Blue"], ["Alpha", "Beta"]] });
  // a free-text answer travels as its own label, and an unanswered question as an empty list
  await session.send("question:again");
  await until(events, "question-asked", 2);
  const again = events.filter((e) => e.type === "question-asked").at(-1) as Extract<SessionEvent, { type: "question-asked" }>;
  await session.answerQuestion(again.request.requestId, { q0: "Green, my own" });
  await until(events, "turn-ended", 2);
  const second = (await (session as unknown as { client: OpencodeClient }).client.get<Array<{ method: string; path: string; body: Record<string, unknown> }>>("/api/calls")).filter((c) => c.path === "/question/que_2/reply").at(-1)!;
  assert.deepEqual(second.body, { answers: [["Green, my own"]] });
  await session.send("question:third");
  await until(events, "question-asked", 3);
  await session.rejectQuestion((events.filter((e) => e.type === "question-asked").at(-1) as Extract<SessionEvent, { type: "question-asked" }>).request.requestId);
  await until(events, "question-resolved", 3);
  assert.equal((events.filter((e) => e.type === "question-resolved").at(-1) as Extract<SessionEvent, { type: "question-resolved" }>).outcome, "rejected");
});
