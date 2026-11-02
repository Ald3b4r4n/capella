import assert from "node:assert/strict";
import { test } from "node:test";
import { SseParser } from "../../src/opencode/client.ts";

test("parses a message split across chunks", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: session.idle\nda"), []);
  const out = parser.push('ta: {"a":1}\n\n');
  assert.deepEqual(out, [{ id: undefined, event: "session.idle", data: '{"a":1}' }]);
});

test("joins multi-line data, skips comments and handles CRLF", () => {
  const parser = new SseParser();
  const out = parser.push(": keepalive\r\nid: 7\r\ndata: one\r\ndata: two\r\n\r\n");
  assert.deepEqual(out, [{ id: "7", event: "message", data: "one\ntwo" }]);
});

test("a lone CR at the end of a chunk waits for the rest of a CRLF", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: x\r"), []);
  assert.deepEqual(parser.push("\n\r\n"), [{ id: undefined, event: "message", data: "x" }]);
});

test("the event name resets between messages", () => {
  const parser = new SseParser();
  const out = parser.push("event: a\ndata: 1\n\ndata: 2\n\n");
  assert.deepEqual(out.map((m) => m.event), ["a", "message"]);
});

test("a message without data is dropped", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("event: ping\n\n"), []);
});
