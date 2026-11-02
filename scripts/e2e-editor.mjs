// End-to-end check inside a REAL editor window (VS Code or a fork), driven over the Chrome DevTools Protocol (the
// editors are Electron). It launches the editor with Capella as a development extension in a throwaway profile and
// folder, opens the panel from the command palette, drives the real webview with the real opencode, and saves
// screenshots of the real window to spike-output/e2e/.
//
// The one real turn uses a FREE Zen model, selected through the picker, and every approval is REJECTED: nothing is
// ever approved, no file is written and no command runs.
//
// Usage: node scripts/e2e-editor.mjs <path-to-editor-exe> [label] [providerID/modelID]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.argv[2];
const label = process.argv[3] ?? "editor";
// The free models have a usage cap of their own (a real one was hit while testing: HTTP 429, `provider.free-limit`, per model), so the model is a parameter.
const modelRef = process.argv[4] ?? "opencode/glm-5.3-flash-free";
const modelTail = modelRef.split("/")[1] ?? "";
const modelTag = modelTail.split("-")[0] ?? "";
// The model of the attachment step must accept images: the free vision model by default (E2E_VISION overrides).
const visionRef = process.env.E2E_VISION ?? "opencode/nemotron-3.5-super-vl-free";
const visionTail = visionRef.split("/")[1] ?? "";
if (!exe) {
  console.error("usage: node scripts/e2e-editor.mjs <editor-exe> [label] [providerID/modelID]");
  process.exit(2);
}
const root = resolve(import.meta.dirname, "..");
const shots = join(root, "spike-output", "e2e");
mkdirSync(shots, { recursive: true });
const port = 9340 + Math.floor(Math.random() * 200);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const work = mkdtempSync(join(tmpdir(), `capella-e2e-${label}-`));
const workspace = join(work, "workspace");
const userData = join(work, "user-data");
for (const d of [workspace, join(userData, "User")]) mkdirSync(d, { recursive: true });
writeFileSync(
  join(userData, "User", "settings.json"),
  JSON.stringify({ "window.dialogStyle": "custom", "workbench.startupEditor": "none", "security.workspace.trust.enabled": false, "telemetry.telemetryLevel": "off", "update.mode": "none", "extensions.autoCheckUpdates": false, "workbench.tips.enabled": false, "window.restoreWindows": "none", "workbench.colorTheme": "Default Dark Modern", "chat.disableAIFeatures": true, "window.dialogStyle": "custom", "workbench.secondarySideBar.defaultVisibility": "hidden" }, null, 2),
);
writeFileSync(join(workspace, "hello.txt"), "hello from the capella e2e\n");
writeFileSync(join(workspace, "index.html"), "<!doctype html><title>Capella static preview</title><h1>Static page OK</h1>");
writeFileSync(join(workspace, "plan.txt"), "alpha\nbeta\ngamma\n");
// Dictation without a microphone or an engine: the fake recorder and transcriber (setting capella.dev.voice).
mkdirSync(join(workspace, ".vscode"), { recursive: true });
// E2E_V1=<path to an opencode 1.x executable>: a shorter run against that 1.x, in a throwaway opencode home with the user's
// credentials stripped (its free models answer with a public key), so none of your accounts is used.
const V1 = process.env.E2E_V1;
writeFileSync(join(workspace, ".vscode", "settings.json"), JSON.stringify({ "capella.dev.voice": true }, null, 2));
// capella.opencodePath is machine-scoped: a folder cannot set it, so it goes in the throwaway USER settings.
if (V1) {
  const userSettings = join(userData, "User", "settings.json");
  writeFileSync(userSettings, JSON.stringify({ ...JSON.parse(readFileSync(userSettings, "utf8")), "capella.opencodePath": V1 }, null, 2));
}
const traceFile = join(work, "trace.log");
// "Add folder" opens a native dialog and a native question, which a script cannot drive: a development host (this one) takes the folder from here instead.
const libFolder = join(work, "shared-lib");
mkdirSync(libFolder, { recursive: true });
// "Add an MCP server" is driven for real (quick picks, input boxes and the question), with a tiny stdio server of the test fixtures.
const miniMcp = join(root, "test", "fixtures", "mini-mcp.mjs");
const childEnv = { ...process.env, CAPELLA_TRACE_FILE: traceFile, CAPELLA_DEV_ADD_FOLDER: libFolder };
if (V1) {
  const v1Home = join(work, "v1-home");
  Object.assign(childEnv, { HOME: v1Home, USERPROFILE: v1Home, XDG_CONFIG_HOME: join(v1Home, "c"), XDG_DATA_HOME: join(v1Home, "d"), XDG_STATE_HOME: join(v1Home, "s"), XDG_CACHE_HOME: join(v1Home, "k") });
  for (const name of Object.keys(childEnv)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete childEnv[name];
}

const child = spawn(
  exe,
  [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${join(work, "extensions")}`, `--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`, "--disable-workspace-trust", "--skip-release-notes", "--skip-welcome", "--new-window"],
  { stdio: "ignore", env: childEnv },
);
child.on("error", (e) => console.error("launch error:", e.message));

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error("websocket error"));
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function waitFor(what, fn, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` - ${detail}` : ""}`);
};

let browser;
try {
  await waitFor("the debugging endpoint", async () => (await fetch(`http://127.0.0.1:${port}/json`)).json(), 40000);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  browser = new Cdp(version.webSocketDebuggerUrl);
  await browser.ready;
  console.log(`[${label}] connected to`, version.Browser);

  const page = await waitFor("the workbench page", async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return list.find((t) => t.type === "page" && /workbench/.test(t.url));
  }, 60000);
  const attach = async (targetId) => (await browser.send("Target.attachToTarget", { targetId, flatten: true })).sessionId;
  const pageSession = await attach(page.id);
  const evalPage = async (expression) => {
    const r = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, pageSession);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  };
  await waitFor("the workbench to load", () => evalPage("!!document.querySelector('.monaco-workbench .part.editor')"), 60000);
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  await sleep(800);

  const shot = async (name, session = pageSession) => {
    const r = await browser.send("Page.captureScreenshot", { format: "png" }, session);
    const file = join(shots, `${label}-${name}.png`);
    writeFileSync(file, Buffer.from(r.data, "base64"));
    console.log("shot:", file);
    return file;
  };
  await shot("01-workbench");

  // A first-run welcome overlay (seen in Antigravity IDE) can sit on top of the workbench. Step through plain "next"
  // buttons only; never sign in or create an account on the user's behalf.
  for (let step = 0; step < 4; step++) {
    const buttons = await evalPage("[...document.querySelectorAll('button, .monaco-button, a.monaco-button')].filter(b => b.offsetParent !== null).map(b => b.textContent.trim()).filter(Boolean).slice(0, 12)");
    const advance = buttons.find((b) => /^(get started|skip|continue|next|got it|close)$/i.test(b));
    if (!advance) break;
    console.log(`[${label}] onboarding button:`, advance);
    await evalPage(`(() => { const b = [...document.querySelectorAll('button, .monaco-button, a.monaco-button')].find(x => x.offsetParent !== null && x.textContent.trim().toLowerCase() === ${JSON.stringify(advance.toLowerCase())}); if (b) b.click(); return !!b; })()`);
    await sleep(1500);
    await shot(`01b-onboarding-${step + 1}`);
  }

  const key = (type, k, extra = {}) => browser.send("Input.dispatchKeyEvent", { type, key: k, code: k, ...extra }, pageSession);
  const openFromPalette = async (shotName, command = "Capella: Open") => {
    await key("rawKeyDown", "F1", { windowsVirtualKeyCode: 112 });
    await key("keyUp", "F1", { windowsVirtualKeyCode: 112 });
    await waitFor("the command palette", () => evalPage("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), 10000);
    await browser.send("Input.insertText", { text: ">" + command }, pageSession);
    await sleep(700);
    if (shotName) await shot(shotName);
    await key("rawKeyDown", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
    await key("keyUp", "Enter", { windowsVirtualKeyCode: 13 });
  };
  await openFromPalette("02-palette");

  const evalIn = async (session, expression) => {
    const wrapped = "(async () => { const f = document.getElementById('active-frame') || document.querySelector('iframe'); const d = (f && f.contentDocument) || document; const w = (f && f.contentWindow) || window; return (" + expression + "); })()";
    const r = await browser.send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " " + (r.exceptionDetails.exception?.description ?? ""));
    return r.result.value;
  };
  let webSession;
  const findWebview = async () => {
    const { targetInfos } = await browser.send("Target.getTargets");
    for (const t of targetInfos.filter((x) => x.type === "iframe" && x.url.startsWith("vscode-webview://"))) {
      let session;
      try {
        session = await attach(t.targetId);
        if (await evalIn(session, "!!d.getElementById('modeBtn') && !!d.getElementById('timeline')")) {
          webSession = session;
          return true;
        }
      } catch {
        /* not ours */
      }
      if (session) await browser.send("Target.detachFromTarget", { sessionId: session }).catch(() => undefined);
    }
    return false;
  };
  try {
    await waitFor("the Capella webview", findWebview, 20000);
  } catch {
    await key("rawKeyDown", "Escape", { windowsVirtualKeyCode: 27 });
    await key("keyUp", "Escape", { windowsVirtualKeyCode: 27 });
    await sleep(500);
    await openFromPalette();
    await waitFor("the Capella webview (second attempt)", findWebview, 30000);
  }
  const evalWeb = (expression) => evalIn(webSession, expression);
  await sleep(1500);
  check("panel opens from the command palette in the real editor", true);
  await shot("03-panel-open");

  // The page asks the extension to start opencode; the version chip fills in when the real server answered.
  // Following the output (a function so that E2E_UI_ONLY can run it without any model turn).
  async function scrollChecks() {
    // Following the output: it keeps following while text streams and blocks repaint, stops only on a real scroll up, and
    // the jump button brings it back.
    await evalWeb(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const send = (event) => w.postMessage({ type: 'event', event }, '*');
      send({ type: 'turn-started', sessionId: 's' });
      for (let i = 0; i < 120; i++) {
        send({ type: 'text', sessionId: 's', messageId: 'scroll-msg', ordinal: 0, delta: 'word' + i + ' with **bold** and a long tail of words to make the block grow ' + (i % 9 === 0 ? '\\n\\n' : '') });
        if (i % 20 === 0) { send({ type: 'tool-started', sessionId: 's', messageId: 'scroll-msg', callId: 'sc' + i, name: 'bash' }); send({ type: 'tool-result', sessionId: 's', messageId: 'scroll-msg', callId: 'sc' + i, text: 'line\\nline\\nline' }); }
        await sleep(6);
      }
      return true; })()`);
    await sleep(600);
    const followed = await evalWeb("(() => { const m = d.getElementById('timeline'); return { gap: m.scrollHeight - m.scrollTop - m.clientHeight, jump: !d.getElementById('jumpBottom').hidden }; })()");
    check("while a long answer streams and blocks repaint, the view stays at the end and shows no jump button", followed.gap < 6 && !followed.jump, JSON.stringify(followed));
    await evalWeb("(() => { const m = d.getElementById('timeline'); m.scrollTop = Math.max(0, m.scrollTop - 600); m.dispatchEvent(new w.WheelEvent('wheel', { deltaY: -120, bubbles: true })); return true; })()");
    await evalWeb(`(async () => { for (let i = 0; i < 20; i++) { w.postMessage({ type: 'event', event: { type: 'text', sessionId: 's', messageId: 'scroll-msg', ordinal: 0, delta: ' more more more more more more more more more more more more ' } }, '*'); await new Promise((r) => setTimeout(r, 10)); } return true; })()`);
    await sleep(400);
    const left = await evalWeb("(() => { const m = d.getElementById('timeline'); return { gap: m.scrollHeight - m.scrollTop - m.clientHeight, jump: !d.getElementById('jumpBottom').hidden, following: m.dataset.following }; })()");
    check("after the user scrolls up the view stays where they put it and a jump button appears", left.gap > 100 && left.jump, JSON.stringify(left));
    await shot("26-scrolled-up");
    await evalWeb("(() => { d.getElementById('jumpBottom').click(); return true; })()");
    await sleep(300);
    const back = await evalWeb("(() => { const m = d.getElementById('timeline'); return { gap: m.scrollHeight - m.scrollTop - m.clientHeight, jump: !d.getElementById('jumpBottom').hidden }; })()");
    check("the jump button returns to the end and following resumes", back.gap < 6 && !back.jump, JSON.stringify(back));
    await evalWeb("(() => { w.postMessage({ type: 'event', event: { type: 'turn-ended', sessionId: 's', outcome: 'succeeded' } }, '*'); return true; })()");
    const copyBtn = await waitFor("the Copy answer button", () => evalWeb("(() => { const t = [...d.querySelectorAll('.turn')].pop(); return t.querySelector('.copy-answer') ? t.querySelector('.copy-answer').textContent : null; })()"), 5000).catch(() => null);
    check("a finished turn has one Copy answer button", copyBtn === "Copy answer", String(copyBtn));


  }

  // The new controls, with no model turn: the effort of the model, web access, and the model list read again.
  async function controlChecks() {
    const effortInfo = await evalWeb("(() => { const b = d.getElementById('effortBtn'); return { hidden: b.hidden, text: b.textContent }; })()");
    check("the effort chip shows for a model that has variants", !effortInfo.hidden && /Effort: default/.test(effortInfo.text), JSON.stringify(effortInfo));
    await evalWeb("(() => { d.getElementById('effortBtn').click(); return true; })()");
    await waitFor("the effort menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
    const options = await evalWeb("[...d.querySelectorAll('#menu .item')].map(x => x.textContent)");
    check("the effort menu offers the model's own options and the default", options[0] === "Model default" && options.length >= 3, JSON.stringify(options));
    await evalWeb("(() => { [...d.querySelectorAll('#menu .item')].find(x => x.textContent === 'high').click(); return true; })()");
    const picked = await waitFor("Effort: high", () => evalWeb("d.getElementById('effortBtn').textContent === 'Effort: high' ? true : null"), 8000).catch(() => null);
    check("choosing an effort shows it on the chip", !!picked);
    await shot("27-effort");

    await evalWeb("(() => { d.getElementById('webBtn').click(); return true; })()");
    await waitFor("the web menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
    await evalWeb("(() => { [...d.querySelectorAll('#menu .item')].find(x => /Turn off/.test(x.textContent)).click(); return true; })()");
    const off = await waitFor("Web: off", () => evalWeb("d.getElementById('webBtn').textContent === 'Web: off' ? true : null"), 8000).catch(() => null);
    check("turning web access off shows it on the chip", !!off);

    await evalWeb("(() => { d.getElementById('modelBtn').click(); return true; })()");
    await waitFor("the model menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
    const hasRefresh = await evalWeb("[...d.querySelectorAll('#menu .item')].some(x => /Read the model list again/.test(x.textContent))");
    check("the model menu has a button to read the list again", hasRefresh);
    await evalWeb("(() => { [...d.querySelectorAll('#menu .item')].find(x => /Read the model list again/.test(x.textContent)).click(); return true; })()");
    const again = await waitFor("the refresh notice", () => evalWeb("/Model list read again/.test(d.getElementById('notice').textContent) ? d.getElementById('notice').textContent : null"), 15000).catch(() => null);
    check("reading the list again says how many models it found", !!again, String(again));
    await evalWeb("(() => { d.getElementById('plusBtn').click(); return true; })()");
    const plus = await waitFor("the + menu", () => evalWeb("(() => { const m = d.getElementById('menu'); return m.hidden ? null : [...m.querySelectorAll('.item span')].map(x => x.textContent); })()"), 5000).catch(() => null);
    check("the + menu opens and stays open, with the attach choices", !!plus && plus.length === 4 && /current file/.test(plus.join(" ")), JSON.stringify(plus));
    await evalWeb("(() => { d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()");
    await shot("28-controls");
  }

  const chips = await waitFor("opencode to start and the page to be initialised", () => evalWeb("(() => { const v = d.getElementById('version').textContent; const m = d.getElementById('modeBtn').textContent; return v && m ? { version: v, mode: m, model: d.getElementById('modelBtn').textContent, notice: d.getElementById('notice').textContent } : null; })()"), 60000);
  console.log("chips:", JSON.stringify(chips));
  check("the real opencode started and Capella shows its version", /^opencode \d/.test(chips.version), chips.version);
  check("the chat starts in Plan mode", chips.mode === "Plan", chips.mode);
  check("styles and the brand mark loaded through the webview", await evalWeb("getComputedStyle(d.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && d.querySelector('.welcome img').naturalWidth > 0"));
  // The editor's own dialogs and input boxes (the real ones: nothing is skipped).
  const clickDialog = async (label, timeout = 15000) => {
    await waitFor(`the dialog button "${label}"`, () => evalPage(`[...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].some(b => b.textContent.trim() === ${JSON.stringify(label)})`), timeout);
    await evalPage(`(() => { [...document.querySelectorAll('.monaco-dialog-box .dialog-buttons .monaco-button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click(); return true; })()`);
    await sleep(500);
  };
  const dialogText = () => evalPage("(() => { const d = document.querySelector('.monaco-dialog-box'); return d ? d.innerText : null; })()");
  const inputBox = async (text) => {
    await waitFor("the input box", () => evalPage("!!document.querySelector('.quick-input-widget:not([style*=\"display: none\"]) input')"), 15000);
    await sleep(300);
    if (text !== undefined) await browser.send("Input.insertText", { text }, pageSession);
    await sleep(300);
    await key("rawKeyDown", "Enter", { windowsVirtualKeyCode: 13, text: "\r" });
    await key("keyUp", "Enter", { windowsVirtualKeyCode: 13 });
    await sleep(400);
  };

  // The / palette, the task list and a picture in an answer: none needs a model turn (the page is given the events a turn would send).
  const paletteChecks = async () => {
    const type = (value) => evalWeb(`(() => { const i = d.getElementById('input'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); i.focus(); return true; })()`);
    const youBefore = await evalWeb("d.querySelectorAll('.you').length");
    await type("/");
    const listed = await waitFor("the palette", () => evalWeb("(() => { const m = d.getElementById('slashMenu'); return m.hidden ? null : [...m.querySelectorAll('.slash-row')].map(r => r.querySelector('.slash-name').textContent + ':' + r.querySelector('.slash-kind').textContent); })()"), 20000).catch(() => null);
    console.log("palette:", JSON.stringify(listed));
    check("typing / opens the palette with Capella's own commands and the server's", !!listed && listed.includes("/new:builtin") && listed.includes("/compact:builtin") && listed.some((r) => r.endsWith(":command") || r.endsWith(":skill")), JSON.stringify(listed));
    await shot("27-palette");
    await type("/comp");
    const narrowed = await evalWeb("[...d.querySelectorAll('#slashMenu .slash-name')].map(x => x.textContent)");
    check("typing narrows the palette", narrowed.length >= 1 && narrowed[0] === "/compact" && !narrowed.includes("/new"), JSON.stringify(narrowed));
    await evalWeb("(() => { const i = d.getElementById('input'); i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    check("Enter picks the highlighted entry instead of sending, and the palette closes", (await evalWeb("d.getElementById('input').value")) === "/compact " && (await evalWeb("d.getElementById('slashMenu').hidden")) && (await evalWeb("d.querySelectorAll('.you').length")) === youBefore);
    await type("/usr/bin is a path, not a command");
    check("text with a space after the slash is not a palette", await evalWeb("d.getElementById('slashMenu').hidden"));
    await type("");

    // The task list: the page is told a todowrite call happened.
    const todos = [{ content: "Read the file", status: "completed" }, { content: "Write the summary", status: "in_progress" }, { content: "Check it", status: "pending" }];
    const post = (event) => evalWeb(`(() => { w.postMessage({ type: 'event', event: ${JSON.stringify(event)} }, '*'); return true; })()`);
    await post({ type: "tool-started", sessionId: "s", messageId: "m_inj", callId: "call_todo", name: "todowrite" });
    await post({ type: "tool-called", sessionId: "s", messageId: "m_inj", callId: "call_todo", input: { todos } });
    const tasks = await waitFor("the task list", () => evalWeb("(() => { const t = d.getElementById('todos'); return t.hidden ? null : { summary: t.querySelector('summary').textContent, rows: [...t.querySelectorAll('li')].map(li => li.className + ':' + li.textContent) }; })()"), 10000).catch(() => null);
    check("the agent's task list shows with its progress", !!tasks && /^Tasks 1\/3/.test(tasks.summary) && tasks.summary.includes("Write the summary") && tasks.rows.length === 3 && tasks.rows[0].startsWith("todo completed"), JSON.stringify(tasks));
    await evalWeb("(() => { d.getElementById('todos').open = true; return true; })()");
    await shot("28-task-list");

    // A picture an answer points to: read by the extension from the open folder; one outside the folder is refused.
    writeFileSync(join(workspace, "chart.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    // text-end paints at once; a webview behind another editor tab gets no animation frames, which the streamed deltas wait for.
    const answer = "Here it is: ![the chart](chart.png) and ![elsewhere](../outside.png) and ![web](https://example.com/p.png)";
    await post({ type: "text", sessionId: "s", messageId: "m_inj", ordinal: 0, delta: answer });
    await post({ type: "text-end", sessionId: "s", messageId: "m_inj", ordinal: 0, text: answer });
    const pics = await waitFor("the picture", () => evalWeb("(() => { const i = d.querySelector('img.answer-pic'); return i && i.naturalWidth > 0 ? { src: i.src.slice(0, 22), alt: i.alt, failed: [...d.querySelectorAll('.answer-img.failed')].map(x => x.textContent), web: !!d.querySelector('.md img[src^=http]') } : null; })()"), 15000).catch(() => null);
    console.log("answer pictures:", JSON.stringify(pics));
    check("a picture from the open folder is shown in the answer", !!pics && pics.src.startsWith("data:image/png;base64") && pics.alt === "the chart", JSON.stringify(pics));
    check("a picture outside the folder is refused, and a web picture is never loaded", !!pics && pics.failed.length === 1 && /picture not shown/.test(pics.failed[0]) && pics.web === false, JSON.stringify(pics));
    await shot("29-answer-picture");
    await post({ type: "turn-ended", sessionId: "s", outcome: "succeeded" });

    // Always allowing the web asks first; Cancel leaves it as it was.
    const webMenuItem = (label) => `(() => { [...d.querySelectorAll('#menu .item')].find(i => i.querySelector('span').textContent === ${JSON.stringify(label)}).click(); return true; })()`;
    const webBefore = await evalWeb("d.getElementById('webBtn').textContent");
    await evalWeb("(() => { d.getElementById('webBtn').click(); return true; })()");
    await waitFor("the web menu", () => evalWeb("!d.getElementById('menu').hidden"), 10000);
    await evalWeb(webMenuItem("Always allow"));
    const webQuestion = await waitFor("the web question", dialogText, 15000).catch(() => null);
    check("allowing the web asks first and says what it means", !!webQuestion && /use the web without asking/.test(webQuestion), String(webQuestion));
    await clickDialog("Cancel");
    await sleep(600);
    check("Cancel leaves web access as it was", (await evalWeb("d.getElementById('webBtn').textContent")) === webBefore, webBefore);
    await evalWeb("(() => { d.getElementById('webBtn').click(); return true; })()");
    await waitFor("the web menu", () => evalWeb("!d.getElementById('menu').hidden"), 10000);
    await evalWeb(webMenuItem("Always allow"));
    await clickDialog("Allow web access");
    const webOn = await waitFor("web on", () => evalWeb("/Web: on/.test(d.getElementById('webBtn').textContent)"), 15000).catch(() => false);
    check("accepting turns web access on for this chat", !!webOn);
    await evalWeb("(() => { d.getElementById('webBtn').click(); return true; })()");
    await waitFor("the web menu", () => evalWeb("!d.getElementById('menu').hidden"), 10000);
    await evalWeb(webMenuItem("Follow the mode"));
    await waitFor("web back to the mode", () => evalWeb("/per mode/.test(d.getElementById('webBtn').textContent)"), 15000);

    // A folder outside the project, from the + menu: a chip with a remove button; removing it takes the chip away.
    await evalWeb("(() => { d.getElementById('plusBtn').click(); return true; })()");
    await waitFor("the + menu", () => evalWeb("!d.getElementById('menu').hidden"), 10000);
    const hasItem = await evalWeb("[...d.querySelectorAll('#menu .item')].some(i => /^Add a folder/.test(i.querySelector('span').textContent))");
    check("the + menu offers Add a folder", hasItem);
    const addFolderMenu = "(() => { d.getElementById('plusBtn').click(); return true; })()";
    const clickAddFolder = "(() => { [...d.querySelectorAll('#menu .item')].find(i => /^Add a folder/.test(i.querySelector('span').textContent)).click(); return true; })()";
    await evalWeb(clickAddFolder);
    const question = await waitFor("the question", dialogText, 15000).catch(() => null);
    console.log("folder question:", JSON.stringify(question));
    check("adding a folder asks first, naming the folder and what it allows", !!question && /Let the agent use/.test(question) && /shared-lib/.test(question) && /this chat only/.test(question), String(question));
    await shot("35-folder-question");
    await clickDialog("Cancel");
    check("answering Cancel adds nothing", await evalWeb("d.getElementById('folders').hidden"));
    await evalWeb(addFolderMenu);
    await waitFor("the + menu", () => evalWeb("!d.getElementById('menu').hidden"), 10000);
    await evalWeb(clickAddFolder);
    await clickDialog("Add folder");
    const folder = await waitFor("the folder chip", () => evalWeb("(() => { const f = d.getElementById('folders'); return f.hidden ? null : { names: [...f.querySelectorAll('.fname')].map(x => x.textContent), title: f.querySelector('.chip-file').title, notice: d.getElementById('notice').textContent }; })()"), 20000).catch(() => null);
    console.log("folder chip:", JSON.stringify(folder));
    check("the folder appears as a chip, named after the folder, and the chat says it was added", !!folder && folder.names.length === 1 && folder.names[0] === "shared-lib" && /shared-lib/.test(folder.title) && /was added/.test(folder.notice), JSON.stringify(folder));
    await shot("32-folder-chip");
    await evalWeb("(() => { d.querySelector('#folders .x').click(); return true; })()");
    const gone = await waitFor("the chip to go", () => evalWeb("d.getElementById('folders').hidden"), 15000).catch(() => false);
    check("removing the chip takes the folder away", !!gone);
  };

  // The Tools panel: MCP servers (add, switch off and on, remove), skills and plugins. No model turn.
  const toolsChecks = async () => {
    await evalWeb("(() => { d.getElementById('toolsBtn').click(); return true; })()");
    const first = await waitFor("the Tools panel", () => evalWeb("(() => { const t = d.getElementById('tools'); const b = d.getElementById('toolsBody'); return !t.hidden && b.querySelector('.tools-section') ? [...b.querySelectorAll('h3')].map(h => h.textContent) : null; })()"), 20000).catch(() => null);
    check("the Tools panel lists MCP servers, skills and plugins", !!first && first.length === 3 && /^MCP servers/.test(first[0]) && /^Skills \(\d+\)/.test(first[1]) && /^Plugins/.test(first[2]), JSON.stringify(first));
    await shot("33-tools");
    const rowOf = (name) => `[...d.querySelectorAll('#toolsBody .session')].find(r => r.querySelector('.session-title').textContent === ${JSON.stringify(name)})`;
    const addMcp = "(() => { [...d.querySelectorAll('#toolsBody .btn')].find(b => /^Add an MCP server/.test(b.textContent)).click(); return true; })()";
    const quoted = (p) => '"' + p + '"';
    // a first attempt that is cancelled at the question
    await evalWeb(addMcp);
    await inputBox(); // the kind: the first choice, a program on this computer
    await inputBox("e2ecancel");
    await inputBox(quoted(process.execPath) + " " + quoted(miniMcp));
    const mcpQuestion = await waitFor("the MCP question", dialogText, 15000).catch(() => null);
    console.log("mcp question:", JSON.stringify(mcpQuestion));
    check("adding a server asks first, with the exact program and arguments", !!mcpQuestion && /e2ecancel/.test(mcpQuestion) && /Program: /.test(mcpQuestion) && /mini-mcp\.mjs/.test(mcpQuestion) && /with your user's permissions/.test(mcpQuestion), String(mcpQuestion));
    await shot("36-mcp-question");
    await clickDialog("Cancel");
    await sleep(1500);
    check("answering Cancel adds nothing", await evalWeb(`!${rowOf("e2ecancel")}`));
    // and the real one
    await evalWeb(addMcp);
    await inputBox();
    await inputBox("e2eprobe");
    await inputBox(quoted(process.execPath) + " " + quoted(miniMcp));
    await clickDialog("Add server");
    const added = await waitFor("the server to connect", () => evalWeb(`(() => { const r = ${rowOf("e2eprobe")}; return r ? { badge: r.querySelector('.badge').textContent, meta: r.querySelector('.session-meta').textContent } : null; })()`), 30000).catch(() => null);
    const connected = await waitFor("connected", () => evalWeb(`(() => { const r = ${rowOf("e2eprobe")}; return r && r.querySelector('.badge').textContent === 'connected'; })()`), 30000).catch(() => false);
    console.log("mcp row:", JSON.stringify(added));
    check("a server added through Capella shows up, says where it came from and what it runs, and connects", !!added && !!connected && /added in Capella/.test(added.meta) && /mini-mcp\.mjs/.test(added.meta), JSON.stringify(added));
    await shot("34-tools-added");
    await evalWeb(`(() => { ${rowOf("e2eprobe")}.querySelector('.btn').click(); return true; })()`);
    const off = await waitFor("disabled", () => evalWeb(`(() => { const r = ${rowOf("e2eprobe")}; return r && r.querySelector('.badge').textContent === 'disabled'; })()`), 20000).catch(() => false);
    check("Turn off disconnects it", !!off);
    await evalWeb(`(() => { ${rowOf("e2eprobe")}.querySelector('.btn').click(); return true; })()`);
    const on = await waitFor("connected again", () => evalWeb(`(() => { const r = ${rowOf("e2eprobe")}; return r && r.querySelector('.badge').textContent === 'connected'; })()`), 30000).catch(() => false);
    check("Turn on connects it again", !!on);
    await evalWeb(`(() => { [...${rowOf("e2eprobe")}.querySelectorAll('.btn')].find(b => b.textContent === 'Remove').click(); return true; })()`);
    const gone = await waitFor("the server to go", () => evalWeb(`!${rowOf("e2eprobe")}`), 20000).catch(() => false);
    check("Remove forgets a server that was added in Capella", !!gone);
    await evalWeb("(() => { d.getElementById('toolsClose').click(); return true; })()");
    check("Close hides the panel", await evalWeb("d.getElementById('tools').hidden"));
  };

  if (process.env.E2E_UI_ONLY) {
    // Only the checks that need no model turn (the free models have a cap of their own).
    await scrollChecks();
    await controlChecks();
    await paletteChecks();
    await toolsChecks();
    console.log(failed === 0 ? `[${label}] ALL CHECKS PASSED (UI only)` : `[${label}] ${failed} CHECK(S) FAILED (UI only)`);
    throw Object.assign(new Error("ui-only run finished"), { v1Done: true });
  }
  if (V1) {
    // opencode 1.x: it has no usage endpoint, so there is no meter. Pick the free model, send one message, read the answer.
    check("the chat shows opencode 1.x", /^opencode 1./.test(chips.version), chips.version);
    check("no usage meter is shown on 1.x", await evalWeb("d.getElementById('usage').hidden"));
    await shot("04-ready");
    await evalWeb("(() => { d.getElementById('modelBtn').click(); return true; })()");
    await waitFor("the model menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
    await evalWeb("(() => { const s = d.querySelector('#menu input'); s.value = 'mimo-v2.6'; s.dispatchEvent(new Event('input')); return true; })()");
    await sleep(400);
    const picked1 = await evalWeb("(() => { const it = [...d.querySelectorAll('#menu .item')].find(x => x.querySelector('small').textContent === 'opencode/mimo-v2.6-flash-free'); if (!it) return false; it.click(); return true; })()");
    check("the free Zen model is in the 1.x catalog and can be picked", picked1);
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Read hello.txt and tell me what it says, in one short sentence.'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
    await waitFor("the 1.x turn to end", () => evalWeb("(() => { const t = [...d.querySelectorAll('.turn')].pop(); return t && !d.querySelector('.turn.live') && !d.getElementById('stop').offsetParent && t.querySelector('.md') ? true : false; })()"), 150000);
    const answer = await evalWeb("[...[...d.querySelectorAll('.turn')].pop().querySelectorAll('.md')].map(x => x.textContent).join(' ')");
    const toolNames = await evalWeb("[...d.querySelectorAll('.turn .tool .name')].map(x => x.textContent)");
    console.log("1.x answer:", JSON.stringify(answer), "| tools:", JSON.stringify(toolNames));
    check("the 1.x turn streamed an answer that mentions the file's content", /capella/i.test(answer), answer);
    check("the tool call of the 1.x turn is shown on the timeline", toolNames.includes("read"), JSON.stringify(toolNames));
    await shot("09-answer");
    await evalWeb("(() => { d.getElementById('historyBtn').click(); return true; })()");
    const rows1 = await waitFor("the 1.x stored chats", () => evalWeb("(() => { const r = [...d.querySelectorAll('#historyList .session')]; return r.length ? r.map(x => x.querySelector('.session-title').textContent) : null; })()"), 20000).catch(() => null);
    check("History lists the 1.x chat of this folder", !!rows1 && rows1.length >= 1, JSON.stringify(rows1));
    await shot("14-history");
    console.log(failed === 0 ? `[${label}] ALL CHECKS PASSED (1.x)` : `[${label}] ${failed} CHECK(S) FAILED (1.x)`);
    throw Object.assign(new Error("v1 run finished"), { v1Done: true });
  }
  // Usage: the real account's Go allowance (read by opencode from the Console) appears in the chat header and the status bar.
  const meter = await waitFor("the usage meter", () => evalWeb("(() => { const u = d.getElementById('usage'); return u && !u.hidden ? { text: u.textContent, rings: u.querySelectorAll('.ring').length } : null; })()"), 30000).catch(() => null);
  console.log("usage meter:", JSON.stringify(meter));
  check("the chat header shows the Go usage windows (5h, Weekly, Monthly) read from the real account", !!meter && meter.rings === 3 && /5h \d+%/.test(meter.text) && /Weekly \d+%/.test(meter.text) && /Monthly \d+%/.test(meter.text), JSON.stringify(meter));
  const statusItem = await waitFor("the usage status bar item", () => evalPage("(() => { const i = [...document.querySelectorAll('.statusbar-item')].find(x => /\\d+%/.test(x.textContent) && /pulse|Capella|5-hour|Weekly|Monthly|Budget/.test(x.textContent + (x.getAttribute('aria-label') || ''))); return i ? i.textContent.trim() : null; })()"), 15000).catch(() => null);
  check("the status bar shows the tightest window", !!statusItem, JSON.stringify(statusItem));
  await shot("04-ready");

  // Model picker: grouped list, then pick the free model.
  await evalWeb("(() => { d.getElementById('modelBtn').click(); return true; })()");
  const menuInfo = await waitFor("the model menu", () => evalWeb("(() => { const m = d.getElementById('menu'); return m.hidden ? null : { groups: [...m.querySelectorAll('.group')].map(g => g.textContent), items: m.querySelectorAll('.item').length }; })()"), 10000);
  console.log("model menu:", JSON.stringify(menuInfo));
  check("the model menu groups Zen and Go models", menuInfo.groups.includes("OpenCode Zen") && menuInfo.groups.includes("OpenCode Go"), JSON.stringify(menuInfo.groups));
  await evalWeb(`(() => { const s = d.querySelector('#menu input'); s.value = ${JSON.stringify(modelTail.replace(/-free$/, ""))}; s.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(400);
  await shot("05-model-menu");
  const picked = await evalWeb(`(() => { const it = [...d.querySelectorAll('#menu .item')].find(x => x.querySelector('small').textContent === ${JSON.stringify(modelRef)}); if (!it) return false; it.click(); return true; })()`);
  check(`the free model ${modelRef} is in the catalog and can be picked`, picked);
  await waitFor("the model chip to change", () => evalWeb(`new RegExp(${JSON.stringify(modelTag)}, 'i').test(d.getElementById('modelBtn').textContent)`), 15000).catch(() => undefined);
  const modelChip = await evalWeb("d.getElementById('modelBtn').textContent");
  check("the model chip shows the picked model", new RegExp(modelTag, "i").test(modelChip), modelChip);

  // Mode menu: switch to "Review each change" so the shell command has to ask.
  await evalWeb("(() => { d.getElementById('modeBtn').click(); return true; })()");
  await waitFor("the mode menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
  await sleep(300);
  await shot("06-mode-menu");
  await evalWeb("(() => { [...d.querySelectorAll('#menu .item')].find(x => /Review each change/.test(x.textContent)).click(); return true; })()");
  await waitFor("the mode chip to change", () => evalWeb("d.getElementById('modeBtn').textContent === 'Review each change'"), 8000);
  check("the mode switched to Review each change", true);

  // One real turn: ask for a shell command. The host must ask; the test REJECTS.
  await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Run the shell command: echo hello-from-capella'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
  const card = await waitFor("the real approval card", () => evalWeb("(() => { const c = d.querySelector('.approval-card'); return c ? { what: c.querySelector('.what').textContent, res: c.querySelector('.res').textContent, buttons: [...c.querySelectorAll('button')].map(b => b.textContent) } : null; })()"), 120000);
  console.log("approval:", JSON.stringify(card));
  check("a real approval card appears for the shell command, with Allow once / Always allow / Reject", /shell/.test(card.what) && /echo hello-from-capella/.test(card.res) && card.buttons.includes("Reject") && card.buttons.includes("Allow once"), JSON.stringify(card));
  await shot("07-approval");
  await evalWeb("(() => { [...d.querySelectorAll('.approval-card button')].find(b => b.textContent === 'Reject').click(); return true; })()");
  await waitFor("the turn to end", () => evalWeb("(() => !d.getElementById('stop').offsetParent && !!d.querySelector('.approval-card.resolved'))()"), 120000);
  const verdict = await evalWeb("d.querySelector('.approval-card .verdict')?.textContent");
  check("the rejection was acknowledged by the host and the turn ended", verdict === "Rejected", verdict);
  await sleep(800);
  await shot("08-after-reject");

  // A second turn that needs no permission: reads a file in the folder (Review mode allows reads).
  await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Read hello.txt and tell me what it says, in one short sentence.'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
  await waitFor("the second turn to end", () => evalWeb("(() => d.querySelectorAll('.turn').length >= 2 && !d.querySelector('.turn.live') && !d.getElementById('stop').offsetParent)()"), 120000);
  const second = await evalWeb("(() => { const t = [...d.querySelectorAll('.turn')].pop(); return { tools: [...t.querySelectorAll('.tool .name')].map(x => x.textContent), text: [...t.querySelectorAll('.md')].map(x => x.textContent).join(' '), foot: t.querySelector('.foot')?.textContent ?? '' }; })()");
  console.log("second turn:", JSON.stringify(second));
  check("the second turn streamed an answer that mentions the file's content", /capella/i.test(second.text), second.text.slice(0, 120));
  check("tokens were counted", /in ·/.test(second.foot), second.foot);
  await shot("09-answer");
  await evalWeb("(() => { [...d.querySelectorAll('.tool .head')].find(Boolean)?.click(); return true; })()");
  await sleep(300);
  await shot("10-tool-open");

  // Free-model count: the model is a free one, so the picker's tooltip carries Capella's own count (never a provider quota).
  const note = await evalWeb("d.getElementById('modelBtn').title");
  console.log("model tooltip:", note);
  if (modelRef.endsWith("-free")) check("the free model's tooltip shows Capella's own request count, labelled as such", /Capella has counted \d+ request/.test(note) && /not the provider's/.test(note), note);

  // Web cards and the preview button, from synthetic events (a real page is served by this script, nothing is approved).
  const http = await import("node:http");
  const pageServer = http.createServer((_req, res) => res.end("<!doctype html><title>Capella preview check</title><h1>Capella preview OK</h1>"));
  await new Promise((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  const pagePort = pageServer.address().port;
  await evalWeb(`(() => {
    const send = (event) => w.postMessage({ type: 'event', event }, '*');
    send({ type: 'turn-started', sessionId: 's' });
    send({ type: 'tool-started', sessionId: 's', messageId: 'syn', callId: 'w1', name: 'websearch' });
    send({ type: 'tool-called', sessionId: 's', messageId: 'syn', callId: 'w1', input: { query: 'capella star auriga' } });
    send({ type: 'tool-result', sessionId: 's', messageId: 'syn', callId: 'w1', text: 'Capella is the sixth-brightest star in the night sky.' });
    send({ type: 'tool-started', sessionId: 's', messageId: 'syn', callId: 'w2', name: 'webfetch' });
    send({ type: 'tool-called', sessionId: 's', messageId: 'syn', callId: 'w2', input: { url: 'https://en.wikipedia.org/wiki/Capella' } });
    send({ type: 'tool-result', sessionId: 's', messageId: 'syn', callId: 'w2', text: '# Capella' });
    send({ type: 'tool-started', sessionId: 's', messageId: 'syn', callId: 'p1', name: 'bash' });
    send({ type: 'tool-called', sessionId: 's', messageId: 'syn', callId: 'p1', input: { command: 'node serve.js' } });
    send({ type: 'tool-result', sessionId: 's', messageId: 'syn', callId: 'p1', text: 'Serving on http://127.0.0.1:${pagePort}/' });
    send({ type: 'turn-ended', sessionId: 's', outcome: 'succeeded' });
    return true; })()`);
  const cards = await evalWeb("(() => { const t = [...d.querySelectorAll('.turn')].pop(); return { web: [...t.querySelectorAll('.tool.web')].map(s => s.querySelector('.name').textContent + ' | ' + s.querySelector('.arg').textContent), preview: t.querySelector('.preview')?.textContent ?? null }; })()");
  console.log("web cards:", JSON.stringify(cards));
  check("web search and page fetch get their own labels, and a fetch shows only host and path", JSON.stringify(cards.web) === JSON.stringify(["Web search | capella star auriga", "Fetch page | en.wikipedia.org/wiki/Capella"]), JSON.stringify(cards.web));
  check("a dev server address in a shell result offers an Open preview button", cards.preview === `Open preview · 127.0.0.1:${pagePort}`, cards.preview);
  await shot("12-web-cards");
  await evalWeb("(() => { d.querySelector('.preview').click(); return true; })()");
  const browserTab = await waitFor("the editor's Simple Browser", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /Capella preview check|Simple Browser|Jetski Preview/.test(x.textContent)); return tab ? tab.textContent.trim() : null; })()"), 20000).catch(() => null);
  check("Open preview opens the page in the editor's browser", !!browserTab, JSON.stringify(browserTab));
  await sleep(1500);
  await shot("13-preview-open");
  pageServer.close();

  // Preview of a static HTML file: the Preview button -> quick pick -> the file -> the confirmation -> the editor's browser.
  await evalWeb("(() => { d.getElementById('previewBtn').click(); return true; })()");
  await waitFor("the preview menu", () => evalPage("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(r => /Preview an HTML file/.test(r.textContent))"), 15000);
  await shot("24-preview-menu");
  await evalPage("(() => { [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(r => /Preview an HTML file/.test(r.textContent)).click(); return true; })()");
  await waitFor("the file list", () => evalPage("[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some(r => /index\.html/.test(r.textContent))"), 15000);
  await evalPage("(() => { [...document.querySelectorAll('.quick-input-widget .monaco-list-row')].find(r => /index\.html/.test(r.textContent)).click(); return true; })()");
  await waitFor("the confirmation", () => evalPage("[...document.querySelectorAll('.monaco-dialog-box .monaco-button')].some(b => /Serve and preview/.test(b.textContent))"), 15000);
  await evalPage("(() => { [...document.querySelectorAll('.monaco-dialog-box .monaco-button')].find(b => /Serve and preview/.test(b.textContent)).click(); return true; })()");
  const staticTab = await waitFor("the static page in the editor's browser", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /Capella static preview|Jetski Preview/.test(x.textContent)); return tab ? tab.textContent.trim() : null; })()"), 20000).catch(() => null);
  check("an HTML file of the folder is served read-only and opens in the editor's browser", !!staticTab, JSON.stringify(staticTab));
  await sleep(1500);
  await shot("25-static-preview");

  // A usage-cap failure is explained in words, not as a generic error.
  await evalWeb("(() => { const send = (event) => w.postMessage({ type: 'event', event }, '*'); send({ type: 'turn-started', sessionId: 's' }); send({ type: 'turn-ended', sessionId: 's', outcome: 'failed', error: { type: 'provider.rate_limit', message: 'x', status: 429, rateLimited: true } }); return true; })()");
  const capLine = await evalWeb("[...d.querySelectorAll('.error-line')].pop()?.textContent");
  check("a usage cap says so and admits when the provider gave no reset time", /Usage limit reached/.test(capLine) && /did not say when it resets/.test(capLine), capLine);

  // History: stored chats of the folder, fork one, and check the replay and that the mode did not loosen.
  await evalWeb("(() => { d.getElementById('historyBtn').click(); return true; })()");
  const rows = await waitFor("the stored chats", () => evalWeb("(() => { const r = [...d.querySelectorAll('#historyList .session')]; return r.length ? r.map(x => x.querySelector('.session-title').textContent + ' | ' + x.querySelector('.session-meta').textContent) : null; })()"), 20000);
  console.log("history rows:", JSON.stringify(rows));
  check("History lists this folder's stored chat", rows.length >= 1, JSON.stringify(rows));
  await shot("14-history");
  await evalWeb("(() => { [...d.querySelectorAll('#historyList .session')][0].querySelectorAll('button')[1].click(); return true; })()");
  await waitFor("the forked chat to replay", () => evalWeb("/copy/.test(d.getElementById('notice').textContent)"), 30000);
  const replayed = await evalWeb("({ users: [...d.querySelectorAll('.you .bubble')].map(x => x.textContent), tools: [...d.querySelectorAll('.tool .name')].map(x => x.textContent), mode: d.getElementById('modeBtn').textContent, notice: d.getElementById('notice').textContent })");
  console.log("replayed:", JSON.stringify(replayed));
  check("the fork replays both messages and the tool calls of the original chat", replayed.users.some((u) => /echo hello-from-capella/.test(u)) && replayed.users.some((u) => /hello[.]txt/.test(u)) && replayed.tools.includes("read"), JSON.stringify(replayed));
  check("the reopened chat stays in the mode the chat was in, and says it is a copy", replayed.mode === "Review each change" && /copy/.test(replayed.notice), JSON.stringify({ mode: replayed.mode, notice: replayed.notice }));
  await shot("15-fork-replayed");

  // File edits: a real turn in Accept edits mode (edits are allowed in this throwaway folder, shell is still asked and not
  // used). The tool cards must carry diffs, Changes must list both files, and Open diff must open the editor's diff.
  await evalWeb("(() => { d.getElementById('modeBtn').click(); return true; })()");
  await waitFor("the mode menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
  await evalWeb("(() => { [...d.querySelectorAll('#menu .item')].find(x => /Accept edits/.test(x.textContent)).click(); return true; })()");
  await waitFor("Accept edits", () => evalWeb("d.getElementById('modeBtn').textContent === 'Accept edits'"), 8000);
  const turnsBefore = await evalWeb("d.querySelectorAll('.turn').length");
  await evalWeb("(() => { const i = d.getElementById('input'); i.value = \"Use your edit tool to change the line 'beta' to 'BETA' in plan.txt, then create a file notes.md whose only line is '# Notes'. Do not run any command.\"; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
  await waitFor("the edit turn to end", () => evalWeb(`(() => d.querySelectorAll('.turn').length > ${turnsBefore} && !d.querySelector('.turn.live') && !d.getElementById('stop').offsetParent)()`), 180000);
  await sleep(1500);
  const diffs = await evalWeb("[...d.querySelectorAll('.diff')].map(x => ({ file: x.querySelector('.diff-file').textContent, counts: x.querySelector('.diff-counts').textContent, lines: [...x.querySelectorAll('.dl')].map(l => l.className.replace('dl ', '') + ':' + l.textContent.trim()) }))");
  console.log("diff cards:", JSON.stringify(diffs));
  console.log("tools in the last turn:", JSON.stringify(await evalWeb("[...[...d.querySelectorAll('.turn')].pop().querySelectorAll('.tool')].map(s => (s.dataset.tool || '?') + ' | ' + s.querySelector('.arg').textContent + ' | ' + s.className)")));
  const planDiff = diffs.find((x) => x.file === "plan.txt");
  const notesDiff = diffs.find((x) => x.file === "notes.md");
  check("the edit card of plan.txt shows its diff with +1 and -1", !!planDiff && /\+1 \u22121/.test(planDiff.counts) && planDiff.lines.includes("del:-beta") && planDiff.lines.includes("add:+BETA"), JSON.stringify(planDiff));
  check("the created file notes.md shows as new, with its line", !!notesDiff && /new/.test(notesDiff.counts) && notesDiff.lines.includes("add:+# Notes"), JSON.stringify(notesDiff));
  const changesLabel = await evalWeb("d.getElementById('changesBtn').hidden ? null : d.getElementById('changesBtn').textContent");
  check("the header shows Changes (2)", changesLabel === "Changes (2)", String(changesLabel));
  await shot("20-diff-cards");
  await evalWeb("(() => { d.getElementById('changesBtn').click(); return true; })()");
  const changeRows = await waitFor("the Changes list", () => evalWeb("(() => { const r = [...d.querySelectorAll('#changesList .session')]; return r.length === 2 ? r.map(x => x.querySelector('.session-title').textContent + ' | ' + x.querySelector('.session-meta').textContent) : null; })()"), 15000).catch(() => null);
  console.log("changes rows:", JSON.stringify(changeRows));
  check("Changes lists both files with their totals", !!changeRows && changeRows.some((r) => /^notes\.md \| new file/.test(r)) && changeRows.some((r) => /^plan\.txt \| 1 edit · \+1 \u22121/.test(r)), JSON.stringify(changeRows));
  await shot("21-changes-list");
  await evalWeb("(() => { const row = [...d.querySelectorAll('#changesList .session')].find(x => /plan.txt/.test(x.textContent)); [...row.querySelectorAll('button')].find(b => b.textContent === 'Open diff').click(); return true; })()");
  const diffTab = await waitFor("the editor's diff", () => evalPage("(() => { const tab = [...document.querySelectorAll('.tab')].find(x => /before this chat/.test(x.textContent)); return document.querySelector('.monaco-diff-editor') && tab ? tab.textContent.trim() : null; })()"), 20000).catch(() => null);
  check("Open diff opens the editor's diff for plan.txt", !!diffTab && /plan\.txt \(before this chat/.test(diffTab), JSON.stringify(diffTab));
  await waitFor("the diff to paint", () => evalPage("document.querySelectorAll('.monaco-diff-editor .editor.original .view-line').length > 1 && document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line').length > 1"), 15000).catch(() => undefined);
  const sides = await evalPage("(() => ({ original: [...document.querySelectorAll('.monaco-diff-editor .editor.original .view-line')].map(x => x.textContent.split(String.fromCharCode(160)).join(' ')), modified: [...document.querySelectorAll('.monaco-diff-editor .editor.modified .view-line')].map(x => x.textContent.split(String.fromCharCode(160)).join(' ')) }))()");
  check("the before side has 'beta' and the after side 'BETA'", sides.original.some((l) => /beta/.test(l)) && !sides.original.some((l) => /BETA/.test(l)) && sides.modified.some((l) => /BETA/.test(l)), JSON.stringify(sides));
  await shot("22-editor-diff");


  await scrollChecks();

  // Attachments: a pasted image, a dropped file from the open folder, a refused one from outside it, and a real turn with a
  // free vision model that has to see the image.
  const { pathToFileURL } = await import("node:url");
  // A 256x256 solid red PNG built here: a 48 px one made some vision models answer "white" or "gray" at random, while the same
  // image at 256 px was read as red every time (DeepSeek V4.1 Flash, 5 of 5).
  const { deflateSync } = await import("node:zlib");
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const pngChunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, sum]); };
  const RED_PNG = (() => { const n = 256; const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4); ihdr[8] = 8; ihdr[9] = 2; const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: n }, () => Buffer.from([220, 20, 30])))]); return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: n }, () => row)))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64"); })();
  writeFileSync(join(work, "outside.txt"), "not in the open folder\n");
  const withVision = !process.env.E2E_SKIP_VISION; // the vision step needs a model that takes images, and the free ones have a cap
  if (withVision) {
    await evalWeb("(() => { d.getElementById('modelBtn').click(); return true; })()");
    await waitFor("the model menu", () => evalWeb("!d.getElementById('menu').hidden"), 5000);
    await evalWeb(`(() => { const s = d.querySelector('#menu input'); s.value = ${JSON.stringify(visionTail.replace(/-free$/, ""))}; s.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(400);
    const visionPicked = await evalWeb(`(() => { const it = [...d.querySelectorAll('#menu .item')].find(x => x.querySelector('small').textContent === ${JSON.stringify(visionRef)}); if (!it) return false; it.click(); return true; })()`);
    check("the free vision model is in the catalog and can be picked", visionPicked);
    await waitFor("the model chip to change", () => evalWeb("/Nemotron/i.test(d.getElementById('modelBtn').textContent)"), 15000).catch(() => undefined);

  }
  await evalWeb(`(() => { const bytes = Uint8Array.from(atob(${JSON.stringify(RED_PNG)}), (c) => c.charCodeAt(0)); const dt = new w.DataTransfer(); dt.items.add(new w.File([bytes], 'red.png', { type: 'image/png' })); d.getElementById('input').dispatchEvent(new w.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  const pasted = await waitFor("the pasted image chip", () => evalWeb("(() => { const c = [...d.querySelectorAll('#chips .chip-file')]; return c.length === 1 ? { name: c[0].querySelector('.fname').textContent, thumb: !!c[0].querySelector('img') } : null; })()"), 15000).catch(() => null);
  check("a pasted image becomes a chip with a thumbnail", !!pasted && pasted.name === "red.png" && pasted.thumb, JSON.stringify(pasted));
  const dropUri = (uri) => evalWeb(`(() => { const dt = new w.DataTransfer(); dt.setData('text/uri-list', ${JSON.stringify(uri)}); d.body.dispatchEvent(new w.DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
  await dropUri(pathToFileURL(join(workspace, "hello.txt")).href);
  const two = await waitFor("two chips", () => evalWeb("(() => { const c = [...d.querySelectorAll('#chips .chip-file .fname')].map(x => x.textContent); return c.length === 2 ? c : null; })()"), 15000).catch(() => null);
  check("a file dropped from the open folder is attached by name", !!two && two.includes("hello.txt"), JSON.stringify(two));
  await dropUri(pathToFileURL(join(work, "outside.txt")).href);
  const refused = await waitFor("the refusal", () => evalWeb("/outside the open folder/.test(d.getElementById('notice').textContent) ? d.getElementById('notice').textContent : null"), 15000).catch(() => null);
  const stillTwo = await evalWeb("d.querySelectorAll('#chips .chip-file').length");
  check("a file outside the open folder is refused with the reason, and nothing was added", !!refused && stillTwo === 2, JSON.stringify({ refused, stillTwo }));
  await evalWeb("(() => { [...d.querySelectorAll('#chips .chip-file')].find(c => c.querySelector('.fname').textContent === 'hello.txt').querySelector('.x').click(); return true; })()");
  await waitFor("the chip to be removed", () => evalWeb("d.querySelectorAll('#chips .chip-file').length === 1"), 10000);
  await dropUri(pathToFileURL(join(workspace, "hello.txt")).href);
  await waitFor("two chips again", () => evalWeb("d.querySelectorAll('#chips .chip-file').length === 2"), 15000);
  check("a chip can be removed and the file attached again", true);
  await shot("18-attachments");

  if (withVision) {
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'What colour is the attached image (one word), and what does hello.txt say (one short sentence)?'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
    const sent = await waitFor("the message with attachments", () => evalWeb("(() => { const y = [...d.querySelectorAll('.you')].pop(); return y && y.querySelector('.sent-file img') ? [...y.querySelectorAll('.sent-file')].map(x => x.textContent) : null; })()"), 20000).catch(() => null);
    check("the sent message shows what went with it, including the image thumbnail", !!sent && sent.length === 2, JSON.stringify(sent));
    check("sending clears the chips", (await evalWeb("d.querySelectorAll('#chips .chip-file').length")) === 0);
    await waitFor("the vision turn to end", () => evalWeb("(() => { const t = [...d.querySelectorAll('.turn')].pop(); return !d.querySelector('.turn.live') && !d.getElementById('stop').offsetParent && t && t.querySelector('.md') ? true : false; })()"), 150000);
    const lastAnswer = () => evalWeb("[...[...d.querySelectorAll('.turn')].pop().querySelectorAll('.md')].map(x => x.textContent).join(' ')");
    let seen = await lastAnswer();
    console.log("vision answer:", JSON.stringify(seen));
    // A small model can misjudge a flat colour now and then (the same image answered "red" or "white" on different runs),
    // so one more try in the same chat is allowed: the check is that the image reaches the model, not that the model is perfect.
    if (!/red/i.test(seen)) {
      const turns = await evalWeb("d.querySelectorAll('.turn').length");
      await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Look at the image red.png again. What colour is it? One word.'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
      await waitFor("the second vision turn to end", () => evalWeb(`(() => { const all = [...d.querySelectorAll('.turn')]; const t = all.pop(); return all.length >= ${turns} && !d.querySelector('.turn.live') && !d.getElementById('stop').offsetParent && t && t.querySelector('.md') ? true : false; })()`), 150000);
      seen = await lastAnswer();
      console.log("vision answer (second try):", JSON.stringify(seen));
    }
    check("the model saw the attached image (it names the colour red)", /red/i.test(seen), seen);
    await shot("19-attachments-answer");
  }

  await paletteChecks();
  await toolsChecks();

  // A message sent while the agent works waits in the queue and joins the same turn (opencode 2.x only).
  if (!V1 && !process.env.E2E_SKIP_QUEUE) {
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Write a detailed story of about 400 words about a lighthouse keeper. Plain text.'; i.dispatchEvent(new Event('input')); d.getElementById('send').click(); return true; })()");
    await waitFor("the agent to start working", () => evalWeb("!d.getElementById('stop').hidden"), 30000);
    const canType = await evalWeb("!d.getElementById('send').hidden && /queues your message/.test(d.getElementById('input').placeholder)");
    check("while the agent works, Send stays and the box says Enter queues", canType, await evalWeb("d.getElementById('input').placeholder"));
    await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'Now answer with only the word PINEAPPLE.'; i.dispatchEvent(new Event('input')); i.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); return true; })()");
    const tray = await waitFor("the queue tray", () => evalWeb("(() => { const t = d.getElementById('queueTray'); return t.hidden ? null : [...t.querySelectorAll('.q-row')].map(r => r.textContent); })()"), 15000).catch(() => null);
    console.log("queue tray:", JSON.stringify(tray));
    check("the message waits in the tray as queued, with Send now and a remove button", !!tray && tray.length === 1 && /queued/.test(tray[0]) && /PINEAPPLE/.test(tray[0]) && (await evalWeb("!!d.querySelector('#queueTray .btn') && !!d.querySelector('#queueTray .x')")), JSON.stringify(tray));
    check("the box is empty again and the message is not in the conversation yet", (await evalWeb("d.getElementById('input').value")) === "" && (await evalWeb("[...d.querySelectorAll('.you')].every(y => !/PINEAPPLE/.test(y.textContent))")));
    await shot("30-queue");
    await waitFor("the queued message to join the turn", () => evalWeb("[...d.querySelectorAll('.you')].some(y => /PINEAPPLE/.test(y.textContent))"), 120000);
    await waitFor("the whole turn to end", () => evalWeb("d.getElementById('stop').hidden && d.getElementById('queueTray').hidden"), 120000);
    const joined = await evalWeb("(() => { const bubbles = [...d.querySelectorAll('.you')]; const last = bubbles[bubbles.length - 1]; const after = [...d.querySelectorAll('.turn')].filter(t => last.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); return { tray: d.getElementById('queueTray').hidden, answer: after.map(t => t.textContent).join(' ').includes('PINEAPPLE'), live: !!d.querySelector('.turn.live') }; })()");
    check("the queued message joined the conversation, the tray emptied and the answer follows it", joined.tray && joined.answer && !joined.live, JSON.stringify(joined));
    await shot("31-queue-delivered");
  }

  // Voice dictation with the fake recorder and transcriber: the button records, stops, and the text lands in the box
  // (never sent by itself); Esc cancels.
  await evalWeb("(() => { const i = d.getElementById('input'); i.value = 'antes:'; i.dispatchEvent(new Event('input')); i.focus(); i.setSelectionRange(i.value.length, i.value.length); return true; })()");
  await evalWeb("(() => { d.getElementById('micBtn').click(); return true; })()");
  const recording = await waitFor("recording to start", () => evalWeb("d.getElementById('micBtn').classList.contains('recording') ? d.getElementById('voiceStatus').textContent : null"), 15000).catch(() => null);
  check("the microphone button shows that it is recording", !!recording && /Recording/.test(recording), String(recording));
  await shot("23-voice-recording");
  await evalWeb("(() => { d.getElementById('micBtn').click(); return true; })()");
  const dictated = await waitFor("the dictated text", () => evalWeb("d.getElementById('input').value.includes('ditado') ? d.getElementById('input').value : null"), 20000).catch(() => null);
  check("the dictated text is inserted in the message box, after what was already typed, and not sent", dictated === "antes: texto ditado de teste" && (await evalWeb("!d.getElementById('stop').offsetParent")), JSON.stringify(dictated));
  await evalWeb("(() => { d.getElementById('micBtn').click(); return true; })()");
  await waitFor("recording again", () => evalWeb("d.getElementById('micBtn').classList.contains('recording')"), 15000);
  await evalWeb("(() => { w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true; })()");
  const cancelled = await waitFor("the cancel", () => evalWeb("!d.getElementById('micBtn').classList.contains('recording') && d.getElementById('voiceStatus').hidden"), 15000).catch(() => false);
  check("Esc cancels a recording and inserts nothing", !!cancelled && (await evalWeb("d.getElementById('input').value")) === "antes: texto ditado de teste");
  await evalWeb("(() => { const i = d.getElementById('input'); i.value = ''; i.dispatchEvent(new Event('input')); return true; })()");

  // A narrow side panel, as the panel usually sits beside the editor.
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  await sleep(800);
  await shot("11-narrow");
  await browser.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  // Compatibility diagnostics: the command opens a report that says the real opencode is compatible and leaks no path.
  await sleep(1500); // let the page settle after the narrow-panel resize before the palette takes the keyboard
  await openFromPalette("16-palette-diagnostics", "Capella: Compatibility diagnostics");
  const reportScript = "(() => { const t = [...document.querySelectorAll('.monaco-editor .view-lines')].map(x => x.textContent.split(String.fromCharCode(160)).join(' ')).join(' '); return /compatibility diagnostics/i.test(t) && /Verdict/.test(t) ? t : null; })()";
  const reportText = await waitFor("the diagnostics report", () => evalPage(reportScript), 30000).catch(() => null);
  console.log("report:", JSON.stringify((reportText ?? "").slice(0, 400)));
  check("the diagnostics command opens a report with a verdict for the real opencode", !!reportText && /Verdict: OK/.test(reportText) && /opencode 2[.]2[.]5/.test(reportText), (reportText ?? "").slice(0, 160));
  check("the report has no folder path", !!reportText && !/Users[/]/.test(reportText) && !/[A-Z]:[\\]/.test(reportText));
  await sleep(800);
  await shot("17-diagnostics");
  console.log(failed === 0 ? `[${label}] ALL CHECKS PASSED` : `[${label}] ${failed} CHECK(S) FAILED`);
} catch (error) {
  // The short 1.x run ends by throwing a marker on purpose: that is not an error.
  if (!error.v1Done) {
    failed++;
    console.error(`[${label}] ERROR:`, error instanceof Error ? error.message : String(error));
  }
} finally {
  if (failed > 0) {
    try {
      console.log("--- change tracking trace ---");
      console.log(readFileSync(traceFile, "utf8"));
    } catch {
      // no trace written
    }
  }
  browser?.close();
  child.kill();
  // The Electron main process hands off to children; wait a moment, then clean the throwaway profile.
  await sleep(2500);
  rmSync(work, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
