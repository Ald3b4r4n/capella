// Serves the real chat page (src/ui/chatHtml.ts + dist/chat.js + media/chat.css) in a normal browser with a scripted fake
// extension host, so the look and the flow can be checked without opening an editor.
// Usage: node esbuild.mjs && node scripts/preview.ts [port]    then open http://127.0.0.1:PORT/?demo=1
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chatHtml } from "../src/ui/chatHtml.ts";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(process.argv[2] ?? 4719);

const fakeHost = `
(function () {
  var listeners = [];
  var pendingApproval = null;
  function toPage(m) { window.postMessage(m, "*"); }
  function ev(event, delay) { return new Promise(function (r) { setTimeout(function () { toPage({ type: "event", event: event }); r(); }, delay || 0); }); }
  var S = "ses_demo", M = "msg_1";
  var modes = [
    { id: "plan", label: "Plan", description: "Reads and plans; editing and shell commands are denied.", dangerous: false, tone: "plan" },
    { id: "review", label: "Review each change", description: "Asks before every edit, shell command and web access.", dangerous: false, tone: "ask" },
    { id: "accept-edits", label: "Accept edits", description: "Edits files without asking; still asks before shell and web.", dangerous: false, tone: "edit" },
    { id: "bypass", label: "Bypass permissions", description: "opencode's own default. Use with care.", dangerous: true, tone: "danger" }
  ];
  var models = [
    { ref: "opencode/glm-5.3-flash-free", label: "GLM-5.3-Flash Free", family: "zen", free: true },
    { ref: "opencode/claude-sonnet-5-5", label: "Claude Sonnet 5.5", family: "zen", free: false },
    { ref: "opencode-go/kimi-k3", label: "Kimi K3", family: "go", free: false },
    { ref: "opencode-go/qwen-4-coder", label: "Qwen 4 Coder", family: "go", free: false },
    { ref: "openrouter/mistral/large", label: "Mistral Large", family: "other", free: false }
  ];
  async function play(text) {
    toPage({ type: "user", text: text });
    toPage({ type: "busy", value: true });
    await ev({ type: "turn-started", sessionId: S }, 150);
    await ev({ type: "reasoning", sessionId: S, messageId: M, ordinal: 0, delta: "The user wants the landing page checked. " }, 250);
    await ev({ type: "reasoning", sessionId: S, messageId: M, ordinal: 0, delta: "I should read index.html first, then run the dev server." }, 250);
    await ev({ type: "tool-started", sessionId: S, messageId: M, callId: "c1", name: "read" }, 200);
    await ev({ type: "tool-called", sessionId: S, messageId: M, callId: "c1", input: { path: "index.html" } }, 100);
    await ev({ type: "tool-result", sessionId: S, messageId: M, callId: "c1", text: "<!doctype html>\\n<title>Aurora</title>\\n<h1>Hello</h1>" }, 350);
    await ev({ type: "tool-started", sessionId: S, messageId: M, callId: "c2", name: "bash" }, 200);
    await ev({ type: "tool-called", sessionId: S, messageId: M, callId: "c2", input: { command: "npx serve -l 5173 ." } }, 100);
    pendingApproval = "per_1";
    await ev({ type: "approval-requested", sessionId: S, requestId: "per_1", action: "shell", resources: ["npx serve -l 5173 ."], saves: ["npx serve *"], source: { messageId: M, callId: "c2" } }, 150);
  }
  async function finish(decision) {
    await ev({ type: "approval-resolved", sessionId: S, requestId: "per_1", reply: decision }, 100);
    if (decision === "reject") await ev({ type: "tool-failed", sessionId: S, messageId: M, callId: "c2", errorType: "permission.rejected", message: "rejected" }, 100);
    else await ev({ type: "tool-result", sessionId: S, messageId: M, callId: "c2", text: "Serving! Local: http://localhost:5173" }, 200);
    var answer = decision === "reject"
      ? "I did not start the server, so I could only **read** the page. Here is what I found:\\n\\n- the title is \`Aurora\`\\n- there is one heading\\n\\nWant me to try again with a different command?"
      : "The page is up at [localhost:5173](https://localhost:5173). I found:\\n\\n1. the title is \`Aurora\`\\n2. one \`<h1>\` that says Hello\\n\\n\`\`\`html\\n<h1>Hello</h1>\\n\`\`\`\\n\\nShall I add a hero section?";
    var parts = answer.match(/[\\s\\S]{1,14}/g);
    for (var i = 0; i < parts.length; i++) await ev({ type: "text", sessionId: S, messageId: "msg_2", ordinal: 0, delta: parts[i] }, 25);
    await ev({ type: "text-end", sessionId: S, messageId: "msg_2", ordinal: 0, text: answer }, 20);
    await ev({ type: "step-ended", sessionId: S, messageId: "msg_2", finish: "stop", tokens: { input: 14157, output: 211, reasoning: 29, cacheRead: 320, cacheWrite: 0 } }, 20);
    await ev({ type: "turn-ended", sessionId: S, outcome: "succeeded" }, 20);
  }
  window.acquireVsCodeApi = function () {
    return {
      postMessage: function (m) {
        if (m.type === "ready") {
          setTimeout(function () { toPage({ type: "init", version: "2.2.5", workspace: "landing", modes: modes, mode: "plan", models: models, model: "opencode/glm-5.3-flash-free" }); if (location.search.indexOf("demo") >= 0) setTimeout(function () { play("Open my landing page and check that it works."); }, 400); }, 50);
        } else if (m.type === "send") play(m.text);
        else if (m.type === "decide") finish(m.decision);
        else if (m.type === "setMode") toPage({ type: "mode", id: m.id });
        else if (m.type === "setModel") toPage({ type: "model", ref: m.ref });
        else if (m.type === "newChat") { toPage({ type: "reset" }); setTimeout(function () { toPage({ type: "init", version: "2.2.5", workspace: "landing", modes: modes, mode: "plan", models: models, model: "opencode/glm-5.3-flash-free" }); }, 50); }
      }
    };
  };
})();`;

const types: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(chatHtml({ cspSource: "'self'", nonce: "preview", mediaUri: (file) => (file === "chat.js" ? "/dist/chat.js" : `/media/${file}`), preScript: fakeHost }));
    return;
  }
  const file = normalize(join(root, url.pathname));
  if (!file.startsWith(join(root, "media")) && !file.startsWith(join(root, "dist"))) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`preview on http://127.0.0.1:${port}/?demo=1`));
