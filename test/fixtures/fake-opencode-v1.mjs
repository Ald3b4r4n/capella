// A stand-in for `opencode serve` 1.x (the stable legacy routes) for tests: same announce line, Basic auth and the routes
// and event shapes observed on 1.19.5 (scripts/probe-v1.ts, probe-v1-turn.ts). Prompts: "ask:<command>" raises a bash
// permission and finishes after the reply; anything else answers "echo: <text>".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "none";
const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const calls = [];
const listeners = new Set();
const pending = new Map();
let n = 0;

const emit = (type, properties) => {
  const frame = JSON.stringify({ id: "evt_" + ++n, type, properties });
  for (const res of listeners) res.write(`data: ${frame}\n\n`);
};
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text ? JSON.parse(text) : {}));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(sid, text) {
  const user = "msg_u" + n;
  const assistant = "msg_a" + n;
  emit("session.status", { sessionID: sid, status: { type: "busy" } });
  emit("message.updated", { sessionID: sid, info: { id: user, role: "user", sessionID: sid } });
  emit("message.part.updated", { sessionID: sid, part: { id: "prt_u" + n, messageID: user, sessionID: sid, type: "text", text } });
  emit("message.updated", { sessionID: sid, info: { id: assistant, role: "assistant", sessionID: sid } });
  emit("message.part.updated", { sessionID: sid, part: { id: "prt_s" + n, messageID: assistant, sessionID: sid, type: "step-start" } });
  if (text.startsWith("ask:")) {
    const command = text.slice(4);
    const part = { id: "prt_t" + n, messageID: assistant, sessionID: sid, type: "tool", tool: "bash", callID: "call_1" };
    emit("message.part.updated", { sessionID: sid, part: { ...part, state: { status: "pending", input: {}, raw: "" } } });
    emit("message.part.updated", { sessionID: sid, part: { ...part, state: { status: "running", input: { command } } } });
    const request = { id: "per_1", sessionID: sid, permission: "bash", patterns: [command], metadata: { command }, always: [command.split(" ")[0] + " *"], tool: { messageID: assistant, callID: "call_1" } };
    pending.set(request.id, request);
    emit("permission.asked", request);
    await new Promise((resolve) => (request.resolve = resolve));
    pending.delete(request.id);
    emit("permission.replied", { sessionID: sid, requestID: request.id, reply: request.reply });
    if (request.reply === "reject") emit("message.part.updated", { sessionID: sid, part: { ...part, state: { status: "error", input: { command }, error: "The user rejected permission to use this specific tool call." } } });
    else emit("message.part.updated", { sessionID: sid, part: { ...part, state: { status: "completed", input: { command }, output: "ran " + command } } });
  } else {
    const part = { id: "prt_x" + n, messageID: assistant, sessionID: sid, type: "text" };
    emit("message.part.updated", { sessionID: sid, part: { ...part, text: "", time: { start: 1 } } });
    emit("message.part.delta", { sessionID: sid, messageID: assistant, partID: part.id, field: "text", delta: "echo: " });
    emit("message.part.delta", { sessionID: sid, messageID: assistant, partID: part.id, field: "text", delta: text });
    emit("message.part.updated", { sessionID: sid, part: { ...part, text: "echo: " + text, time: { start: 1, end: 2 } } });
  }
  emit("message.part.updated", { sessionID: sid, part: { id: "prt_f" + n, messageID: assistant, sessionID: sid, type: "step-finish", reason: "stop", tokens: { total: 3, input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } });
  if (process.env.FAKE_V1_FAIL) {
    emit("session.error", { sessionID: sid, error: { name: "APIError", data: { message: "Too many requests", statusCode: 429 } } });
    emit("session.idle", { sessionID: sid });
    return;
  }
  emit("session.idle", { sessionID: sid });
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  if (req.method === "GET" && path === "/api/info") return res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>web app</title>"); // 1.x answers the web app here
  if (req.method === "GET" && path === "/global/health") return json(res, 200, { healthy: true, version: "1.19.5-fake" });
  if (req.method === "GET" && path === "/api/calls") return json(res, 200, calls);
  if (req.method === "GET" && path === "/doc") {
    const tested = JSON.parse(readFileSync(new URL("../../src/opencode/tested.v1.json", import.meta.url), "utf8"));
    const paths = {};
    for (const route of tested.usedRoutes) {
      const [method, p] = route.split(" ");
      (paths[p] ??= {})[method.toLowerCase()] = {};
    }
    return json(res, 200, { openapi: "3.1.0", paths });
  }
  if (req.method === "GET" && path === "/config/providers")
    return json(res, 200, {
      providers: [
        { id: "opencode", name: "OpenCode", options: { apiKey: "SECRET-KEY" }, models: { m1: { id: "m1", name: "Zen One Free", variants: { low: {}, high: {} }, cost: { input: 0, output: 0 }, capabilities: { input: { text: true, image: true } }, limit: { context: 1000 } } } },
        { id: "opencode-go", name: "Go", options: { apiKey: "SECRET-KEY" }, models: { m2: { id: "m2", name: "Go Two", cost: { input: 1, output: 2 }, capabilities: { input: { text: true, image: false } } } } },
      ],
      default: { opencode: "m1" },
    });
  if (req.method === "GET" && path === "/config") return json(res, 200, { username: "x" });
  if (req.method === "GET" && path === "/permission") return json(res, 200, [...pending.values()].map(({ resolve, reply, ...row }) => row));
  if (req.method === "GET" && path === "/session")
    return json(res, 200, [
      { id: "ses_old", title: "Old chat", time: { created: 100, updated: 200 }, cost: 0.01 },
      { id: "ses_sub", title: "A subagent", parentID: "ses_old", time: { created: 150, updated: 160 } },
    ]);
  if (req.method === "GET" && path === "/session/ses_old") return json(res, 200, { id: "ses_old", model: { id: "m2", providerID: "opencode-go" } });
  if (req.method === "GET" && /^\/session\/ses_(old|fork)\/message$/.test(path))
    return json(res, 200, [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "Read hello.txt" }] },
      { info: { id: "a1", role: "assistant" }, parts: [{ type: "step-start" }, { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: { filePath: "hello.txt" }, output: "1: hi" } }, { type: "step-finish", reason: "tool-calls", tokens: { input: 5, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }] },
      { info: { id: "a2", role: "assistant" }, parts: [{ type: "text", text: "It says hi." }, { type: "step-finish", reason: "stop", tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } }] },
    ]);
  if (req.method === "GET" && path === "/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  const body = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : {};
  calls.push({ method: req.method, path, body });
  if (req.method === "POST" && path === "/session") return json(res, 200, { id: "ses_1", title: body.title });
  if (req.method === "PATCH" && /^\/session\/ses_\w+$/.test(path)) return json(res, 200, { id: path.split("/").pop() });
  if (req.method === "POST" && path === "/session/ses_old/fork") return json(res, 200, { id: "ses_fork" });
  if (req.method === "POST" && /^\/session\/(ses_\w+)\/prompt_async$/.test(path)) {
    const sid = /^\/session\/(ses_\w+)\//.exec(path)[1];
    const text = body.parts?.find((p) => p.type === "text")?.text ?? "";
    res.writeHead(204).end();
    void wait(30).then(() => runTurn(sid, text));
    return;
  }
  if (req.method === "POST" && /\/abort$/.test(path)) return json(res, 200, true);
  const reply = /^\/session\/ses_\w+\/permissions\/(per_\w+)$/.exec(path);
  if (req.method === "POST" && reply) {
    const request = pending.get(reply[1]);
    if (!request) return json(res, 404, { message: "no such request" });
    request.reply = body.response;
    request.resolve();
    return json(res, 200, true);
  }
  return json(res, 404, { message: "not found: " + path });
});

server.listen(0, "127.0.0.1", () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
