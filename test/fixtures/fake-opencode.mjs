// A stand-in for `opencode serve` (v2 API) for tests: same announce line, Basic auth, the endpoints Capella uses and an SSE
// stream, driven by what the prompt text says. Run as: node fake-opencode.mjs serve --port 0 --hostname 127.0.0.1
// Prompts: "ask:<command>" raises a shell permission and finishes after the reply; anything else answers "echo: <text>".
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const password = process.env.OPENCODE_SERVER_PASSWORD ?? "none";
const expected = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
const calls = [];
const listeners = new Set();
const pending = new Map();
let session;
let selected;
let catalogFails = false;
let startingAnswers = Number(process.env.FAKE_MODEL_503 ?? 0);
let catalog = [
  { id: "m1", modelID: "m1", providerID: "opencode", name: "Zen One Free", variants: [{ id: "low" }, { id: "high" }], settings: { apiKey: "SECRET-KEY", baseURL: "https://secret.example" } },
  { id: "m2", modelID: "m2", providerID: "opencode-go", name: "Go Two" },
];

const emit = (type, data) => {
  const frame = JSON.stringify({ id: "evt_" + Math.random().toString(36).slice(2), created: Date.now(), type, data });
  for (const res of listeners) res.write(`event: message\ndata: ${frame}\n\n`);
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

// Messages sent while a turn runs: `delivery: "queue"` waits for the end of the work, `steer` joins it at the next step.
const inbox = [];
let pendingForm;
let formResolve;
let mcp = [{ name: "docs", status: { status: "connected" } }];
let pluginsChecked = false;
// Worktrees: the project is the folder the server runs in; a worktree whose name has "dirty" in it refuses removal without force.
const worktrees = [];
// Providers and their stored credentials. `GET /api/credential` carries the secrets themselves, like the real one.
let credentials = [{ id: "cred_zen1", integrationID: "opencode", label: "Default", active: true, method: "oauth", value: { type: "oauth", access: "SECRET-ACCESS", refresh: "SECRET-REFRESH" } }];
let oauthPolls = 0;
let credentialCounter = 0;
const integrations = () => [
  { id: "opencode", name: "OpenCode Console", metadata: {}, methods: [{ type: "key", label: "API key (service account)" }, { type: "env", names: ["OPENCODE_API_KEY"] }, { id: "device", type: "oauth", label: "OpenCode Console account", form: [{ key: "server", hidden: true, type: "string", default: "https://opencode.ai/console" }] }] },
  { id: "opencode-go", name: "OpenCode Go", metadata: {}, methods: [{ type: "key" }, { type: "env", names: ["OPENCODE_API_KEY"] }] },
  { id: "github-copilot", name: "GitHub Copilot", metadata: {}, methods: [{ id: "device", type: "oauth", label: "Login with GitHub Copilot", form: [{ key: "deploymentType", title: "Select GitHub deployment type", required: true, type: "string", options: [{ value: "github.com", label: "GitHub.com" }, { value: "enterprise", label: "GitHub Enterprise" }] }] }] },
].map((i) => ({ ...i, connections: credentials.filter((c) => c.integrationID === i.id).map((c) => ({ type: "credential", id: c.id, label: c.label, method: c.method })) }));
let running = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn(text) {
  running = true;
  emit("session.execution.started", { sessionID: session.id });
  await runStep(text);
  // The queue drains inside the same execution, like the real server.
  while (inbox.length > 0) {
    const next = inbox.shift();
    emit("session.inbox.delivered", { sessionID: session.id, inboxID: next.id });
    await runStep(next.payload.text);
  }
  running = false;
  emit("session.execution.succeeded", { sessionID: session.id });
}

async function runStep(text) {
  const sid = session.id;
  const msg = "msg_1";
  if (text.startsWith("slow:")) {
    await wait(700);
    text = text.slice(5);
  }
  emit("session.step.started", { sessionID: sid, assistantMessageID: msg, agent: session.agent, model: { id: selected?.id, providerID: selected?.providerID } });
  if (text.startsWith("form:") || text.startsWith("richform:")) {
    // The agent's question tool: the tool call, then a form that waits for the user (answered or declined).
    const rich = text.startsWith("richform:");
    const fields = rich
      ? [
          { key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true, required: true },
          { key: "q1", title: "Extras", type: "multiselect", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], minItems: 1 },
          { key: "q2", title: "Ship it?", type: "boolean" },
          { key: "q3", title: "Why blue?", type: "string", when: [{ key: "q0", op: "eq", value: "Blue" }] },
          { key: "q4", title: "How many?", type: "integer", minimum: 1, maximum: 9 },
          { key: "q5", title: "Read this first", type: "external", url: "https://example.com/doc" },
        ]
      : [{ key: "q0", title: "Colour preference", description: "Which colour do you prefer?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue" }], custom: true }];
    const form = { id: "frm_1", sessionID: sid, title: "Questions", metadata: { kind: "question", tool: { messageID: msg, id: "call_q" } }, fields };
    emit("session.tool.input.started", { sessionID: sid, assistantMessageID: msg, id: "call_q", name: "question" });
    emit("session.tool.called", { sessionID: sid, assistantMessageID: msg, id: "call_q", input: { questions: [] }, executed: false });
    pendingForm = form;
    emit("form.created", { form });
    const outcome = await new Promise((resolve) => (formResolve = resolve));
    pendingForm = undefined;
    if (outcome.rejected) emit("session.tool.failed", { sessionID: sid, assistantMessageID: msg, id: "call_q", error: { type: "tool.execution", message: outcome.message ?? "declined" }, executed: false });
    else {
      emit("session.tool.success", { sessionID: sid, assistantMessageID: msg, id: "call_q", content: [{ type: "text", text: "User has answered: " + JSON.stringify(outcome.answer) }] });
      emit("session.text.started", { sessionID: sid, assistantMessageID: msg, ordinal: 0 });
      emit("session.text.ended", { sessionID: sid, assistantMessageID: msg, ordinal: 0, text: "You picked " + JSON.stringify(outcome.answer) });
    }
  } else if (text.startsWith("todo:")) {
    // A task list the agent keeps: the tool call carries the whole list.
    const todos = [{ content: "Read the file", status: "completed" }, { content: "Write the summary", status: "in_progress" }, { content: "Check it", status: "pending" }];
    emit("session.tool.input.started", { sessionID: sid, assistantMessageID: msg, id: "call_todo", name: "todowrite" });
    emit("session.tool.input.ended", { sessionID: sid, assistantMessageID: msg, id: "call_todo", text: JSON.stringify({ todos }) });
    emit("session.tool.called", { sessionID: sid, assistantMessageID: msg, id: "call_todo", input: { todos }, executed: false });
    emit("session.tool.success", { sessionID: sid, assistantMessageID: msg, id: "call_todo", content: [{ type: "text", text: "ok" }] });
  } else if (text.startsWith("ask:")) {
    const command = text.slice(4);
    emit("session.tool.input.started", { sessionID: sid, assistantMessageID: msg, id: "call_1", name: "bash" });
    emit("session.tool.called", { sessionID: sid, assistantMessageID: msg, id: "call_1", input: { command }, executed: false });
    const request = { id: "per_1", sessionID: sid, action: "shell", resources: [command], save: [command.split(" ")[0] + " *"], source: { type: "tool", messageID: msg, id: "call_1" } };
    pending.set(request.id, request);
    emit("permission.asked", request);
    await new Promise((resolve) => (request.resolve = resolve));
    pending.delete(request.id);
    emit("permission.replied", { sessionID: sid, requestID: request.id, reply: request.reply });
    if (request.reply === "reject") emit("session.tool.failed", { sessionID: sid, assistantMessageID: msg, id: "call_1", error: { type: "permission.rejected", message: "rejected" }, executed: false });
    else emit("session.tool.success", { sessionID: sid, assistantMessageID: msg, id: "call_1", content: [{ type: "text", text: "ran " + command }] });
  } else {
    emit("session.text.started", { sessionID: sid, assistantMessageID: msg, ordinal: 0 });
    emit("session.text.delta", { sessionID: sid, assistantMessageID: msg, ordinal: 0, delta: "echo: " + text });
    emit("session.text.ended", { sessionID: sid, assistantMessageID: msg, ordinal: 0, text: "echo: " + text });
  }
  emit("session.step.ended", { sessionID: sid, assistantMessageID: msg, finish: "stop", tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
}

const server = createServer(async (req, res) => {
  if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });
  const url = new URL(req.url, "http://x");
  const path = url.pathname;
  const record = (body) => calls.push({ method: req.method, path, body });
  if (req.method === "GET" && path === "/api/info") return json(res, 200, { version: "9.9.9-fake", capabilities: {} });
  if (req.method === "GET" && path === "/openapi.json") {
    // The routes Capella was tested against, minus what a scenario removes.
    const tested = JSON.parse(readFileSync(new URL("../../src/opencode/tested.json", import.meta.url), "utf8"));
    const drop = (process.env.FAKE_DROP_ROUTES ?? "").split(",").filter(Boolean);
    const paths = {};
    if (process.env.FAKE_OPENAPI === "v1") paths["/session"] = { get: {} };
    else
      for (const route of tested.usedRoutes) {
        if (drop.includes(route)) continue;
        const [method, p] = route.split(" ");
        (paths[p] ??= {})[method.toLowerCase()] = {};
      }
    return json(res, 200, { openapi: "3.1.0", paths });
  }
  if (req.method === "GET" && path === "/api/experimental/usage/limits") {
    if (process.env.FAKE_NO_USAGE === "404") return json(res, 404, { message: "not found" });
    const data = process.env.FAKE_USAGE === "signed-out" ? null : { workspace: { id: "wrk_1", name: "Default", usageURL: "https://opencode.ai/console/wrk_1/activity/overview" }, go: { rolling: { percent: 42, limited: false, resetsAt: Date.now() + 3600000 }, weekly: { percent: 10, limited: false, resetsAt: Date.now() + 86400000 }, monthly: { percent: 3, limited: false, resetsAt: Date.now() + 9e8 } }, budgets: [] };
    return json(res, 200, { location: { directory: "x" }, data });
  }
  if (req.method === "GET" && path === "/api/calls") return json(res, 200, calls);
  // Tests change the catalog and make the server announce it: POST /api/test {models?: [...], fail?: bool, emit?: "model.updated"}.
  if (req.method === "POST" && path === "/api/test") {
    const b = await readBody(req);
    if (b.models) catalog = b.models;
    if (b.fail !== undefined) catalogFails = b.fail;
    if (b.emit) emit(b.emit, {});
    return json(res, 200, true);
  }
  if (req.method === "GET" && path === "/api/model") {
    // A server whose plugins are still activating answers 503 for a while (FAKE_MODEL_503 = how many times).
    if (startingAnswers > 0) {
      startingAnswers--;
      return json(res, 503, { _tag: "ServiceUnavailableError", message: "Location plugins did not finish activating", service: "plugin" });
    }
    if (catalogFails) return json(res, 500, { message: "catalog unavailable" });
    return json(res, 200, { data: catalog });
  }
  if (req.method === "GET" && path === "/api/model/default") return json(res, 200, { data: { id: "m2", modelID: "m2", providerID: "opencode-go", settings: { apiKey: "SECRET-KEY" } } });
  if (req.method === "GET" && path === "/api/permission/request") return json(res, 200, { data: [...pending.values()].map(({ resolve, reply, ...row }) => row) });
  if (req.method === "GET" && path === "/api/event") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write(`event: message\ndata: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
    listeners.add(res);
    req.on("close", () => listeners.delete(res));
    return;
  }
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method) ? await readBody(req) : {};
  record(body);
  // Stored sessions: a list, one old session with a model and a short conversation, and forking.
  if (req.method === "GET" && path === "/api/session")
    return json(res, 200, { data: [
      { id: "ses_old", title: "Old chat", time: { created: 100, updated: 200 }, cost: 0.01 },
      { id: "ses_new", title: "", time: { created: 300, updated: 400 }, fork: { sessionID: "ses_old", boundary: {} } },
    ] });
  if (req.method === "GET" && path === "/api/session/ses_old") return json(res, 200, { data: { id: "ses_old", model: { id: "m2", providerID: "opencode-go" } } });
  if (req.method === "GET" && path === "/api/session/ses_old/message" && url.searchParams.get("order") === "asc")
    return json(res, 200, { data: [
      { id: "u1", type: "user", time: { created: 1 }, text: "Read hello.txt" },
      { id: "a1", type: "assistant", time: { created: 2 }, finish: "stop", content: [{ type: "tool", id: "c1", name: "read", state: { status: "completed", input: { path: "hello.txt" }, content: [{ type: "text", text: "1: hi" }] } }, { type: "text", text: "It says hi." }] },
    ] });
  if (req.method === "POST" && path === "/api/session/ses_old/fork") return json(res, 200, { data: { id: "ses_fork" } });
  if (req.method === "GET" && path === "/api/session/ses_fork") return json(res, 200, { data: { id: "ses_fork", model: { id: "m1", providerID: "opencode" } } });
  if (req.method === "GET" && path === "/api/session/ses_fork/message") return json(res, 200, { data: [] });
  // Any stored session accepts the same mode and model calls as the live one.
  if (/^\/api\/session\/ses_(old|fork)\b/.test(path) && ["PATCH", "POST"].includes(req.method)) {
    const live = session;
    session = { id: "ses_1", agent: live?.agent, permissions: live?.permissions };
    const routed = path.replace(/^\/api\/session\/ses_(old|fork)/, "/api/session/ses_1");
    if (req.method === "PATCH") session.permissions = body.permissions;
    if (routed.endsWith("/agent")) session.agent = body.agent;
    if (routed.endsWith("/model")) selected = body.model;
    return json(res, 200);
  }
  if (req.method === "POST" && path === "/api/session") {
    session = { id: "ses_1", agent: body.agent, permissions: body.permissions };
    return json(res, 200, { data: { id: session.id } });
  }
  if (req.method === "PATCH" && path === "/api/session/ses_1") {
    session.permissions = body.permissions;
    return json(res, 200, { data: { id: session.id } });
  }
  if (req.method === "POST" && path === "/api/session/ses_1/agent") {
    session.agent = body.agent;
    return json(res, 200);
  }
  if (req.method === "POST" && path === "/api/session/ses_1/model") {
    if (body.model?.id === "bad") return json(res, 400, { message: "no such model" });
    selected = body.model;
    return json(res, 200);
  }
  // MCP servers: one from the user's own config, and whatever a test adds at runtime.
  if (req.method === "GET" && path === "/api/mcp") return json(res, 200, { location: { directory: "x" }, data: mcp.map((s) => ({ name: s.name, status: s.status })) });
  const mcpRoute = /^\/api\/experimental\/mcp\/([^/]+)(?:\/(connect|disconnect))?$/.exec(path);
  if (mcpRoute && req.method === "PUT") {
    const name = decodeURIComponent(mcpRoute[1]);
    const bad = body.config?.type === "local" && String(body.config.command?.[0]).includes("nonexistent");
    mcp = mcp.filter((s) => s.name !== name).concat([{ name, config: body.config, status: bad ? { status: "failed", error: "Connection closed: no such program" } : { status: "connected" } }]);
    return json(res, 200);
  }
  if (mcpRoute && req.method === "DELETE") {
    mcp = mcp.filter((s) => s.name !== decodeURIComponent(mcpRoute[1]));
    return json(res, 200);
  }
  if (mcpRoute && req.method === "POST") {
    const server = mcp.find((s) => s.name === decodeURIComponent(mcpRoute[1]));
    if (!server) return json(res, 404, { message: "no such server" });
    server.status = mcpRoute[2] === "connect" ? { status: "connected" } : { status: "disabled" };
    return json(res, 200);
  }
  if (req.method === "GET" && path === "/api/integration") return json(res, 200, { location: { directory: "x" }, data: integrations() });
  if (req.method === "GET" && path === "/api/credential") return json(res, 200, { data: credentials.map(({ method, ...c }) => c) });
  const keyRoute = /^\/api\/integration\/([^/]+)\/connect\/key$/.exec(path);
  if (keyRoute && req.method === "POST") {
    if (body.key === "BAD-KEY") return json(res, 400, { message: "The key BAD-KEY was rejected" });
    for (const c of credentials) if (c.integrationID === keyRoute[1]) c.active = false;
    credentials.push({ id: "cred_new" + ++credentialCounter, integrationID: keyRoute[1], label: body.label ?? "API key", active: true, method: "key", value: { type: "key", key: body.key } });
    return json(res, 200);
  }
  const oauthStartRoute = /^\/api\/integration\/([^/]+)\/connect\/oauth$/.exec(path);
  if (oauthStartRoute && req.method === "POST") {
    oauthPolls = 0;
    const code = body.methodID === "code-flow";
    return json(res, 200, { location: { directory: "x" }, data: { attemptID: "con_attempt1", url: "https://example.com/device?user_code=ABCD", instructions: "Enter code: ABCD", mode: code ? "code" : "auto", time: { created: 1, expires: Date.now() + 600000 } } });
  }
  const oauthAttempt = /^\/api\/integration\/([^/]+)\/connect\/oauth\/(con_\w+)(\/complete)?$/.exec(path);
  if (oauthAttempt && req.method === "GET") {
    oauthPolls++;
    if (oauthPolls >= 2 && !credentials.some((c) => c.id === "cred_oauth1")) credentials.push({ id: "cred_oauth1", integrationID: oauthAttempt[1], label: "Default", active: true, method: "oauth", value: { type: "oauth", access: "SECRET-ACCESS2" } });
    return json(res, 200, { location: { directory: "x" }, data: { status: oauthPolls >= 2 ? "complete" : "pending", time: { created: 1, expires: 2 } } });
  }
  if (oauthAttempt && req.method === "POST" && oauthAttempt[3]) {
    if (body.code === "WRONG") return json(res, 400, { message: "bad code WRONG" });
    credentials.push({ id: "cred_oauth2", integrationID: oauthAttempt[1], label: "Default", active: true, method: "oauth", value: { type: "oauth", access: "SECRET-ACCESS3" } });
    return json(res, 200);
  }
  if (oauthAttempt && req.method === "DELETE") return json(res, 200);
  const credRoute = /^\/api\/credential\/(cred_\w+)(\/activate)?$/.exec(path);
  if (credRoute && req.method === "DELETE") {
    credentials = credentials.filter((c) => c.id !== credRoute[1]);
    return json(res, 200);
  }
  if (credRoute && req.method === "POST" && credRoute[2]) {
    const target = credentials.find((c) => c.id === credRoute[1]);
    if (!target) return json(res, 404, { message: "no such credential" });
    for (const c of credentials) if (c.integrationID === target.integrationID) c.active = c.id === target.id;
    return json(res, 200);
  }
  if (req.method === "GET" && path === "/api/project") return json(res, 200, [{ id: "a".repeat(40), canonical: process.cwd(), vcs: "git", time: { created: 1, updated: 1 }, sandboxes: [] }]);
  if (path === "/api/worktree") {
    if (url.searchParams.get("projectID") !== "a".repeat(40) && body.projectID !== "a".repeat(40)) return json(res, 400, { _tag: "InvalidRequestError", message: "Missing key\n  at [\"projectID\"]" });
    if (req.method === "GET") return json(res, 200, [{ directory: process.cwd() }, ...worktrees.map((directory) => ({ directory, strategy: "git" }))]);
    if (req.method === "POST") {
      const directory = process.cwd() + "-worktrees/" + body.name;
      worktrees.push(directory);
      record(body);
      return json(res, 200, { directory });
    }
    if (req.method === "DELETE") {
      record(body);
      if (!worktrees.includes(body.directory)) return json(res, 400, { _tag: "WorktreeError", name: "WorktreeError", data: { message: "not a worktree", forceRequired: false } });
      if (body.directory.includes("dirty") && !body.force) return json(res, 400, { _tag: "WorktreeError", name: "WorktreeError", data: { message: "has uncommitted changes", forceRequired: true } });
      worktrees.splice(worktrees.indexOf(body.directory), 1);
      res.writeHead(204);
      return res.end();
    }
  }
  if (req.method === "GET" && path === "/api/plugin") return json(res, 200, { location: { directory: "x" }, data: [{ id: "opencode.core", source: { type: "builtin" }, features: {}, state: { status: "active" } }, { id: "my-plugin", source: { type: "package", target: "my-plugin", version: "1.0.0", ...(pluginsChecked ? { outdated: true } : {}) }, features: {}, state: { status: "active" } }, { id: "broken-plugin", source: { type: "package", target: "broken-plugin" }, features: {}, state: { status: "failed", error: "Plugin must export a default definition" } }] });
  if (req.method === "POST" && path === "/api/plugin/check") {
    pluginsChecked = true;
    return json(res, 200, { location: { directory: "x" }, data: [{ id: "my-plugin", source: { type: "package", target: "my-plugin", version: "1.0.0", outdated: true }, features: {}, state: { status: "active" } }] });
  }
  if (req.method === "POST" && path === "/api/plugin/update") {
    pluginsChecked = false;
    return json(res, 200);
  }
  if (req.method === "GET" && path === "/api/session/ses_1/form") return json(res, 200, { data: pendingForm ? [pendingForm] : [] });
  const formRoute = /^\/api\/session\/ses_1\/form\/(frm_\w+)(\/reply)?$/.exec(path);
  if (formRoute && req.method === "POST" && formRoute[2]) {
    if (!pendingForm) return json(res, 404, { message: "no such form" });
    emit("form.replied", { id: pendingForm.id, sessionID: "ses_1", answer: body.answer });
    formResolve({ answer: body.answer });
    return json(res, 200);
  }
  if (formRoute && req.method === "DELETE") {
    if (!pendingForm) return json(res, 404, { message: "no such form" });
    emit("form.cancelled", { id: pendingForm.id, sessionID: "ses_1" });
    formResolve({ rejected: true, message: url.searchParams.get("message") ?? undefined });
    return json(res, 200);
  }
  if (req.method === "GET" && path === "/api/command") return json(res, 200, { location: { directory: "x" }, data: [{ name: "review", description: "Review the changes" }, { name: "init" }] });
  if (req.method === "GET" && path === "/api/skill") return json(res, 200, { location: { directory: "x" }, data: [{ id: "skl_pdf", name: "pdf", description: "Work with PDF files", path: "/x", content: "" }] });
  if (req.method === "POST" && path === "/api/session/ses_1/command") {
    json(res, 200, { data: { id: "msg_c" } });
    void runTurn("command " + body.name + " " + body.text);
    return;
  }
  if (req.method === "POST" && path === "/api/session/ses_1/compact") return json(res, 200, { data: true });
  if (req.method === "GET" && path === "/api/session/ses_1/inbox") return json(res, 200, { data: inbox });
  const queued = /^\/api\/session\/ses_1\/inbox\/(msg_\w+)$/.exec(path);
  if (queued && req.method === "DELETE") {
    const at = inbox.findIndex((i) => i.id === queued[1]);
    if (at >= 0) inbox.splice(at, 1);
    return json(res, 200);
  }
  if (queued && req.method === "PATCH") {
    const item = inbox.find((i) => i.id === queued[1]);
    if (item) item.delivery = body.delivery;
    return json(res, 200);
  }
  if (req.method === "POST" && path === "/api/session/ses_1/prompt") {
    if (running && (body.delivery === "queue" || body.delivery === "steer")) {
      const item = { id: "msg_q" + (inbox.length + 1) + Math.random().toString(36).slice(2, 6), sessionID: "ses_1", type: "user", payload: { text: body.text, files: body.files }, delivery: body.delivery };
      inbox.push(item);
      emit("session.inbox.enqueued", { inboxID: item.id, sessionID: "ses_1", item });
      return json(res, 200, { data: { id: item.id, delivery: body.delivery } });
    }
    json(res, 200, { data: { id: "msg_u", type: "user", delivery: body.delivery ?? "steer", skills: body.skills } });
    void runTurn(body.text);
    return;
  }
  if (req.method === "POST" && path === "/api/session/ses_1/interrupt") return json(res, 200, { interrupted: true });
  const reply = /^\/api\/session\/ses_1\/permission\/(per_\w+)\/reply$/.exec(path);
  if (req.method === "POST" && reply) {
    const request = pending.get(reply[1]);
    if (!request) return json(res, 404, { message: "no such request" });
    request.reply = body.decision;
    request.resolve();
    return json(res, 200);
  }
  return json(res, 404, { message: "not found: " + path });
});

server.listen(0, "127.0.0.1", () => console.log(`server listening on http://127.0.0.1:${server.address().port}`));
