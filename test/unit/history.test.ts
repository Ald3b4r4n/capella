import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAge, mapSessionRows, replayItems } from "../../src/opencode/history.ts";
import { dayKey, describeFree, emptyFreeUsage, recordLimitHit, recordStep, viewFor } from "../../src/opencode/freeUsage.ts";
import { mapFrame, mapTurnError, parseFrame, parseRetryAfter } from "../../src/opencode/events.ts";
import { findLocalUrl, localPreviewUrl } from "../../src/ui/preview.ts";

test("session rows are sorted newest first and tolerate missing fields", () => {
  const rows = mapSessionRows({ data: [{ id: "ses_a", title: "Old", time: { created: 1, updated: 10 }, cost: 0.5 }, { id: "ses_b", title: " ", time: { created: 5, updated: 50 }, fork: { sessionID: "ses_a", boundary: {} } }, { nope: 1 }, null] });
  assert.deepEqual(rows.map((r) => [r.id, r.title, r.forked]), [["ses_b", "Untitled chat", true], ["ses_a", "Old", false]]);
  assert.deepEqual(mapSessionRows(undefined), []);
});

test("messages replay oldest first, with text, reasoning and tool parts", () => {
  const items = replayItems({
    data: [
      { id: "m4", type: "idle", time: { created: 40 }, outcome: "succeeded" },
      { id: "m3", type: "assistant", time: { created: 30 }, finish: "stop", tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 1, write: 0 } }, content: [{ type: "text", text: "It says hi." }] },
      {
        id: "m2",
        type: "assistant",
        time: { created: 20 },
        finish: "tool-calls",
        content: [
          { type: "reasoning", text: "need to read" },
          { type: "tool", id: "call_1", name: "read", executed: true, time: { created: 21 }, state: { status: "completed", input: { path: "hello.txt" }, content: [{ type: "text", text: "1: hi" }] } },
          { type: "tool", id: "call_2", name: "bash", time: { created: 22 }, state: { status: "error", input: { command: "x" }, error: { type: "permission.rejected", message: "rejected" } } },
        ],
      },
      { id: "m1", type: "user", time: { created: 10 }, text: "Read hello.txt" },
      { id: "m0", type: "model-switched", time: { created: 5 } },
    ],
  });
  assert.deepEqual(items.map((i) => i.kind), ["user", "assistant", "assistant"]);
  const tools = items[1]?.kind === "assistant" ? items[1].parts.filter((p) => p.kind === "tool") : [];
  assert.deepEqual(tools.map((t) => (t.kind === "tool" ? [t.name, t.status, t.text, t.error] : [])), [["read", "done", "1: hi", undefined], ["bash", "failed", "", "rejected"]]);
  const last = items[2];
  assert.equal(last?.kind === "assistant" && last.tokens?.cacheRead, 1);
});

test("a failed assistant step is kept even with no content", () => {
  const items = replayItems({ data: [{ id: "m", type: "assistant", time: { created: 1 }, finish: "error", error: { message: "Missing Authentication header" }, content: [] }] });
  assert.equal(items[0]?.kind === "assistant" && items[0].failed, "Missing Authentication header");
});

test("age text", () => {
  const now = 1_000_000_000_000;
  assert.equal(describeAge(now - 30_000, now), "just now");
  assert.equal(describeAge(now - 5 * 60_000, now), "5 min ago");
  assert.equal(describeAge(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(describeAge(now - 86_400_000 * 1.2, now), "yesterday");
});

test("a provider failure is classified (shape observed on opencode 2.2.5), and a usage cap is told apart", () => {
  const auth = mapTurnError({ type: "provider.auth", message: "Missing Authentication header", status: 401, response: { body: "{}" } });
  assert.deepEqual(auth, { type: "provider.auth", message: "Missing Authentication header", status: 401, rateLimited: false, retryAfterMs: undefined });
  assert.equal(mapTurnError({ type: "provider.rate_limit", message: "Rate limited", status: 429 })?.rateLimited, true);
  const cap = mapTurnError({ type: "provider.error", message: "FreeUsageLimitError: free usage limit reached, try again in 3 hours", status: 400 });
  assert.equal(cap?.rateLimited, true);
  assert.equal(cap?.retryAfterMs, 3 * 3_600_000);
  assert.equal(mapTurnError("nope"), undefined);
  const frame = parseFrame(JSON.stringify({ type: "session.execution.failed", data: { sessionID: "s", error: { type: "provider.auth", message: "m", status: 401 } } }));
  const mapped = frame && mapFrame(frame, "s");
  assert.equal(mapped?.kind === "event" && mapped.event.type === "turn-ended" && mapped.event.outcome, "failed");
});

test("retry-after text", () => {
  assert.equal(parseRetryAfter("Retry-After: 30"), 30_000);
  assert.equal(parseRetryAfter("please try again in 15 minutes"), 15 * 60_000);
  assert.equal(parseRetryAfter("resets in 2 hours"), 2 * 3_600_000);
  assert.equal(parseRetryAfter("nothing useful"), undefined);
});

test("the free-model ledger counts per model and day and never claims the provider's quota", () => {
  const t0 = new Date(2026, 10, 2, 9, 0, 0).getTime();
  let s = emptyFreeUsage();
  s = recordStep(s, "opencode/glm-free", 1000, t0);
  s = recordStep(s, "opencode/glm-free", 500, t0 + 1000);
  s = recordStep(s, "opencode/other-free", 10, t0 + 2000);
  assert.deepEqual(viewFor(s, "opencode/glm-free", t0 + 3000), { model: "opencode/glm-free", requestsToday: 2, tokensToday: 1500, blocked: false, resetsAtMs: undefined, lastHitMs: undefined, requestsBeforeHit: undefined });
  assert.match(describeFree(viewFor(s, "opencode/glm-free", t0), t0), /Capella's own count, not the provider's/);
  // tomorrow starts at zero
  assert.equal(viewFor(s, "opencode/glm-free", t0 + 86_400_000 + 1000).requestsToday, 0);
  assert.notEqual(dayKey(t0), dayKey(t0 + 86_400_000));
});

test("a limit hit blocks for 24 h, or until the provider's stated time", () => {
  const t0 = new Date(2026, 10, 2, 9, 0, 0).getTime();
  let s = recordStep(emptyFreeUsage(), "m", 1, t0);
  s = recordLimitHit(s, "m", t0 + 1000);
  let v = viewFor(s, "m", t0 + 60_000);
  assert.equal(v.blocked, true);
  assert.equal(v.requestsBeforeHit, 1);
  assert.match(describeFree(v, t0 + 60_000), /did not say when it resets/);
  assert.equal(viewFor(s, "m", t0 + 90_000_000).blocked, false, "older than a day: no longer shown as blocked");
  s = recordLimitHit(s, "m", t0 + 1000, 30 * 60_000);
  v = viewFor(s, "m", t0 + 10 * 60_000);
  assert.equal(v.blocked, true);
  assert.match(describeFree(v, t0 + 10 * 60_000), /about 20 min/);
  assert.equal(viewFor(s, "m", t0 + 40 * 60_000).blocked, false, "the stated wait has passed");
});

test("preview opens only addresses on this machine", () => {
  assert.equal(localPreviewUrl("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(localPreviewUrl("http://127.0.0.1:3000/app"), "http://127.0.0.1:3000/app");
  assert.equal(localPreviewUrl("http://[::1]:8080/"), "http://[::1]:8080/");
  for (const bad of ["https://example.com", "http://localhost.evil.com:80/", "http://user:pw@localhost:3000/", "file:///c:/x", "javascript:alert(1)", "http://localhost:99999/", "not a url"]) assert.equal(localPreviewUrl(bad), undefined, bad);
  assert.equal(findLocalUrl("  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.0.2:5173/"), "http://localhost:5173/");
  assert.equal(findLocalUrl("Serving on http://127.0.0.1:8000."), "http://127.0.0.1:8000/");
  assert.equal(findLocalUrl("see https://example.com and nothing local"), undefined);
});

test("a stored message with attachments replays their names, and small images their thumbnail", () => {
  const png = "iVBORw0KGgo=";
  const items = replayItems({ data: [{ id: "u", type: "user", time: { created: 1 }, text: "look", files: [{ name: "red.png", mime: "image/png", data: png, source: { type: "inline" } }, { name: "notes.txt", mime: "text/plain", data: "aGk=", source: { type: "uri", uri: "file:///x/notes.txt" } }] }, { id: "v", type: "user", time: { created: 2 }, text: "", files: [] }] });
  assert.equal(items.length, 1, "a message with neither text nor files is dropped");
  const first = items[0];
  assert.deepEqual(first?.kind === "user" && first.files, [{ name: "red.png", mime: "image/png", thumb: `data:image/png;base64,${png}` }, { name: "notes.txt", mime: "text/plain", thumb: undefined }]);
});
