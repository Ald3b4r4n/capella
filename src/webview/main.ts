import type { SessionEvent } from "../opencode/session.ts";
import type { AttachmentView, ChangeRowView, FileChangeView, FromWebview, ModeRow, ModelRow, SessionRowView, ToWebview, UsageView } from "../ui/protocol.ts";
import type { ReplayItem } from "../opencode/history.ts";
import { findLocalUrl } from "../ui/preview.ts";
import { renderMarkdown } from "./markdown.ts";

declare function acquireVsCodeApi(): { postMessage(message: FromWebview): void };
const vscode = acquireVsCodeApi();
const post = (message: FromWebview): void => vscode.postMessage(message);

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const timeline = $<HTMLElement>("timeline");
const input = $<HTMLTextAreaElement>("input");
const sendBtn = $<HTMLButtonElement>("send");
const stopBtn = $<HTMLButtonElement>("stop");
const modeBtn = $<HTMLButtonElement>("modeBtn");
const modelBtn = $<HTMLButtonElement>("modelBtn");
const menu = $<HTMLElement>("menu");
const notice = $<HTMLElement>("notice");
const usageEl = $<HTMLElement>("usage");
const chipsEl = $<HTMLElement>("chips");
const plusBtn = $<HTMLButtonElement>("plusBtn");
const micBtn = $<HTMLButtonElement>("micBtn");
const voiceStatus = $<HTMLElement>("voiceStatus");

let modes: ModeRow[] = [];
let models: ModelRow[] = [];
let mode = "plan";
let model: string | undefined;
let busy = false;
let attachments: AttachmentView[] = [];

// The current turn: the rail that every step of the reply hangs off, and the blocks still receiving text.
let turn: HTMLElement | undefined;
const blocks = new Map<string, { el: HTMLElement; raw: string; kind: "text" | "reasoning" }>();
const tools = new Map<string, HTMLElement>();
const approvals = new Map<string, HTMLElement>();
let tokens = { input: 0, output: 0 };
let renderQueued = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stickToBottom<T>(action: () => T): T {
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80;
  const result = action();
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight;
  return result;
}

function say(text: string, error = false): void {
  notice.textContent = text;
  notice.className = error ? "notice error" : "notice";
  notice.hidden = text === "";
}

function setBusy(value: boolean): void {
  busy = value;
  sendBtn.hidden = value;
  stopBtn.hidden = !value;
  input.placeholder = value ? "opencode is working…" : "Ask opencode…  (Enter sends, Shift+Enter adds a line)";
  turn?.classList.toggle("live", value);
}

function paintChips(): void {
  const current = modes.find((m) => m.id === mode);
  modeBtn.textContent = current ? current.label : mode;
  modeBtn.dataset.tone = current?.tone ?? "";
  modeBtn.title = current?.description ?? "";
  const picked = models.find((m) => m.ref === model);
  modelBtn.textContent = picked ? picked.label : model ?? "Default model";
}

/** The user's message with what went along: image thumbnails and file names. */
function userBubble(text: string, files: Array<{ name: string; mime: string; thumb?: string }> = []): HTMLElement {
  const you = el("div", "you");
  const bubble = el("div", "bubble");
  if (files.length > 0) {
    const row = el("div", "sent-files");
    for (const f of files) {
      const chip = el("span", "sent-file");
      if (f.thumb) {
        const img = el("img");
        img.src = f.thumb;
        img.alt = f.name;
        chip.append(img);
      }
      chip.append(el("span", undefined, f.name));
      row.append(chip);
    }
    bubble.append(row);
  }
  if (text !== "") bubble.append(el("div", undefined, text));
  you.append(bubble);
  return you;
}

function startTurn(): HTMLElement {
  $<HTMLElement>("welcome")?.remove();
  tokens = { input: 0, output: 0 };
  turn = el("div", "turn live");
  timeline.append(turn);
  return turn;
}

function ensureTurn(): HTMLElement {
  return turn ?? startTurn();
}

function addStep(kind: string): HTMLElement {
  const step = el("div", `step ${kind}`);
  ensureTurn().append(step);
  return step;
}

function paintBlock(key: string): void {
  const block = blocks.get(key);
  if (!block) return;
  if (block.kind === "text") block.el.innerHTML = renderMarkdown(block.raw);
  else block.el.textContent = block.raw;
}

function queuePaint(key: string): void {
  if (renderQueued.has(key)) return;
  renderQueued.add(key);
  requestAnimationFrame(() => {
    renderQueued.delete(key);
    stickToBottom(() => paintBlock(key));
  });
}

function blockFor(messageId: string, ordinal: number, kind: "text" | "reasoning"): { el: HTMLElement; raw: string; kind: "text" | "reasoning" } {
  const key = `${kind}:${messageId}:${ordinal}`;
  const found = blocks.get(key);
  if (found) return found;
  let container: HTMLElement;
  if (kind === "text") {
    const step = addStep("text");
    container = el("div", "md");
    step.append(container);
  } else {
    const step = addStep("think");
    const details = el("details", "think");
    details.append(el("summary", undefined, "Thinking"));
    container = el("div", "body");
    details.append(container);
    step.append(details);
  }
  const block = { el: container, raw: "", kind };
  blocks.set(key, block);
  return block;
}

/** The first short string argument of a tool call: enough to read the step without opening it. */
function summarize(input: unknown): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["path", "filePath", "file_path", "file", "command", "query", "url", "pattern"]) {
      const preferred = record[key];
      if (typeof preferred === "string" && preferred !== "") return preferred.length > 160 ? `${preferred.slice(0, 157)}\u2026` : preferred;
    }
    for (const value of Object.values(input as Record<string, unknown>)) if (typeof value === "string" && value !== "") return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  }
  return "";
}

const SHELL_TOOL = /^(bash|shell|powershell|sh|cmd)$/i;

function toolLabel(name: string): string {
  if (/web/i.test(name) && /search/i.test(name)) return "Web search";
  if (/web/i.test(name) && /fetch/i.test(name)) return "Fetch page";
  return name;
}

/** The short argument shown next to the tool name: for a page fetch only the host and path, never a long URL. */
function toolArg(name: string, input: unknown): string {
  if (/web/i.test(name) && /fetch/i.test(name) && input && typeof input === "object") {
    const url = (input as Record<string, unknown>).url;
    if (typeof url === "string") {
      try {
        const parsed = new URL(url);
        return parsed.host + (parsed.pathname !== "/" ? parsed.pathname : "");
      } catch {
        // not a URL: fall through to the generic summary
      }
    }
  }
  return summarize(input);
}

/** A dev server the agent started prints a local address: offer to open it in the editor's browser. */
function offerPreview(step: HTMLElement, text: string): void {
  if (!SHELL_TOOL.test(step.dataset.tool ?? "") || step.querySelector(".preview")) return;
  const url = findLocalUrl(text);
  if (!url) return;
  const button = el("button", "btn preview", `Open preview · ${new URL(url).host}`);
  button.type = "button";
  button.title = `Open ${url} in the editor's browser`;
  button.addEventListener("click", () => post({ type: "openPreview", url }));
  step.append(button);
}

function finishTool(step: HTMLElement, status: "done" | "failed" | "running", text: string, error?: string): void {
  step.className = `step tool ${status}${step.classList.contains("web") ? " web" : ""}`;
  if (text) {
    const out = el("pre", "out");
    out.hidden = true;
    out.textContent = text.length > 6000 ? text.slice(0, 6000) + "\n… (" + (text.length - 6000) + " more characters)" : text;
    step.append(out);
    offerPreview(step, text);
  }
  if (error !== undefined) step.append(el("div", "err", error));
}

function toolStep(callId: string, name?: string): HTMLElement {
  const found = tools.get(callId);
  if (found) return found;
  const step = addStep("tool running");
  step.dataset.tool = name ?? "tool";
  if (/web/i.test(name ?? "")) step.classList.add("web");
  const head = el("div", "head");
  head.append(el("span", "name", toolLabel(name ?? "tool")), el("span", "arg"));
  step.append(head);
  head.addEventListener("click", () => {
    const out = step.querySelector<HTMLElement>(".out");
    if (out) out.hidden = !out.hidden;
  });
  tools.set(callId, step);
  return step;
}

function approvalCard(event: Extract<SessionEvent, { type: "approval-requested" }>): void {
  const step = addStep("approval");
  const card = el("div", "approval-card");
  card.append(el("div", "what", `Allow ${event.action}?`));
  const res = el("div", "res");
  res.textContent = event.resources.join("\n") || "(no details)";
  card.append(res);
  if (event.saves.length > 0) card.append(el("div", "hint", `"Always allow" remembers: ${event.saves.join(", ")}`));
  const btns = el("div", "btns");
  const make = (label: string, cls: string, decision: "once" | "always" | "reject") => {
    const button = el("button", `btn ${cls}`, label);
    button.type = "button";
    button.addEventListener("click", () => {
      for (const b of btns.querySelectorAll("button")) b.disabled = true;
      post({ type: "decide", requestId: event.requestId, decision });
      card.append(el("div", "verdict", "Answer sent…"));
    });
    btns.append(button);
  };
  make("Allow once", "allow", "once");
  if (event.saves.length > 0) make("Always allow", "allow", "always");
  make("Reject", "reject", "reject");
  card.append(btns);
  step.append(card);
  approvals.set(event.requestId, card);
}

function explainError(error: Extract<SessionEvent, { type: "turn-ended" }>["error"]): string {
  if (!error) return "The turn failed. Check the Capella output channel.";
  if (error.rateLimited) return "Usage limit reached for this model" + (error.retryAfterMs ? " (the provider asked to wait " + Math.max(1, Math.round(error.retryAfterMs / 60000)) + " min)." : ". The provider did not say when it resets; try again later or pick another model.");
  if (error.type === "provider.auth" || error.status === 401 || error.status === 403) return "This provider refused the request (" + (error.message || "not authorised") + "). Check that opencode is signed in to it (opencode auth).";
  return error.message ? "The turn failed: " + error.message : "The turn failed (" + error.type + ").";
}

function onEvent(event: SessionEvent): void {
  stickToBottom(() => {
    switch (event.type) {
      case "turn-started":
        if (!turn) startTurn();
        setBusy(true);
        break;
      case "reasoning": {
        const block = blockFor(event.messageId, event.ordinal, "reasoning");
        block.raw += event.delta;
        queuePaint(`reasoning:${event.messageId}:${event.ordinal}`);
        break;
      }
      case "reasoning-end": {
        const block = blockFor(event.messageId, event.ordinal, "reasoning");
        if (event.text) block.raw = event.text;
        paintBlock(`reasoning:${event.messageId}:${event.ordinal}`);
        break;
      }
      case "text": {
        const block = blockFor(event.messageId, event.ordinal, "text");
        block.raw += event.delta;
        queuePaint(`text:${event.messageId}:${event.ordinal}`);
        break;
      }
      case "text-end": {
        const block = blockFor(event.messageId, event.ordinal, "text");
        if (event.text) block.raw = event.text;
        paintBlock(`text:${event.messageId}:${event.ordinal}`);
        break;
      }
      case "tool-started":
        toolStep(event.callId, event.name);
        break;
      case "tool-called": {
        const step = toolStep(event.callId);
        const arg = step.querySelector(".arg");
        if (arg) arg.textContent = toolArg(step.dataset.tool ?? "", event.input);
        offerPreview(step, JSON.stringify(event.input ?? ""));
        break;
      }
      case "tool-result": {
        finishTool(toolStep(event.callId), "done", event.text);
        break;
      }
      case "tool-failed": {
        finishTool(toolStep(event.callId), "failed", "", event.errorType === "permission.rejected" ? "Rejected" : event.message || event.errorType);
        break;
      }
      case "approval-requested":
        approvalCard(event);
        break;
      case "approval-resolved": {
        const card = approvals.get(event.requestId);
        if (card) {
          card.classList.add("resolved");
          for (const b of card.querySelectorAll("button")) b.disabled = true;
          card.querySelector(".verdict")?.remove();
          card.append(el("div", "verdict", event.reply === "reject" ? "Rejected" : event.reply === "always" ? "Allowed, and remembered" : "Allowed once"));
        }
        break;
      }
      case "step-started":
        break;
      case "step-ended":
        if (event.tokens) {
          tokens.input += event.tokens.input;
          tokens.output += event.tokens.output;
        }
        break;
      case "turn-ended": {
        setBusy(false);
        turn?.classList.remove("live");
        if (turn && (tokens.input || tokens.output)) turn.append(el("div", "foot", `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out`));
        if (event.outcome === "failed") turn?.append(el("div", "error-line", explainError(event.error)));
        if (event.outcome === "interrupted") turn?.append(el("div", "foot", "Stopped"));
        turn = undefined;
        blocks.clear();
        tools.clear();
        break;
      }
      case "resync":
        say("Reconnected to opencode. Anything streamed while disconnected may be missing from this view.");
        break;
      case "server-exit":
        setBusy(false);
        say("The opencode server stopped. Start a new chat to restart it.", true);
        break;
    }
  });
}

// ---- file edits: the diff under a tool card, and the Changes list ----------------------------------------------

const SHOWN_DIFF_LINES = 60;

function diffBlock(change: FileChangeView): HTMLElement {
  const box = el("div", "diff");
  const head = el("div", "diff-head");
  head.append(el("span", "diff-file", change.rel), el("span", "diff-counts", `${change.status === "added" ? "new · " : ""}+${change.additions} \u2212${change.deletions}`));
  const open = el("button", "btn small", "Open diff");
  open.type = "button";
  open.addEventListener("click", () => post({ type: "openDiff", id: change.id }));
  const file = el("button", "btn small", "Open file");
  file.type = "button";
  file.addEventListener("click", () => post({ type: "openFile", id: change.id }));
  head.append(open, file);
  const body = el("pre", "diff-body");
  for (const line of change.lines.slice(0, SHOWN_DIFF_LINES)) {
    const row = el("span", `dl ${line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "hunk" : "ctx"}`, line + "\n");
    body.append(row);
  }
  if (change.lines.length > SHOWN_DIFF_LINES || change.more) body.append(el("span", "dl hunk", "\u2026 the rest is in Open diff\n"));
  box.append(head, body);
  return box;
}

function showFileChange(change: FileChangeView): void {
  const step = tools.get(change.callId);
  if (!step || step.querySelector(".diff")) return;
  step.append(diffBlock(change));
}

const changesEl = $<HTMLElement>("changes");
const changesList = $<HTMLElement>("changesList");
const changesBtn = $<HTMLButtonElement>("changesBtn");

function paintChanges(rows: ChangeRowView[]): void {
  changesBtn.hidden = rows.length === 0;
  changesBtn.textContent = `Changes (${rows.length})`;
  if (changesEl.hidden) return;
  changesList.replaceChildren();
  if (rows.length === 0) changesList.append(el("div", "faint pad", "No file changes in this chat."));
  for (const row of rows) {
    const item = el("div", "session");
    const text = el("div", "session-text");
    text.append(el("div", "session-title", row.rel), el("div", "session-meta faint", [row.status === "added" ? "new file" : "", `${row.edits} edit${row.edits === 1 ? "" : "s"}`, `+${row.additions} \u2212${row.deletions}`, row.changedSince ? "changed again since" : ""].filter(Boolean).join(" \u00b7 ")));
    const actions = el("div", "session-actions");
    for (const [label, kind] of [["Open diff", "openDiff"], ["Open file", "openFile"]] as const) {
      const button = el("button", "btn", label);
      button.type = "button";
      button.addEventListener("click", () => post({ type: kind, id: row.id }));
      actions.append(button);
    }
    item.append(text, actions);
    changesList.append(item);
  }
}

changesBtn.addEventListener("click", () => {
  changesEl.hidden = false;
  post({ type: "listChanges" });
});
$<HTMLButtonElement>("changesClose").addEventListener("click", () => (changesEl.hidden = true));

// ---- replay of a stored chat -------------------------------------------------------------------------------------

let replaySeq = 0;
function replay(items: ReplayItem[]): void {
  $<HTMLElement>("welcome")?.remove();
  for (const item of items) {
    if (item.kind === "user") {
      timeline.append(userBubble(item.text, item.files));
      continue;
    }
    turn = el("div", "turn");
    timeline.append(turn);
    const id = `replay${++replaySeq}`;
    item.parts.forEach((part, index) => {
      if (part.kind === "text" || part.kind === "reasoning") {
        const block = blockFor(id, index, part.kind);
        block.raw = part.text;
        paintBlock(`${part.kind}:${id}:${index}`);
      } else {
        const step = toolStep(`${id}:${part.callId}`, part.name);
        const arg = step.querySelector(".arg");
        if (arg) arg.textContent = toolArg(part.name, part.input);
        finishTool(step, part.status, part.text, part.status === "failed" ? (/reject/i.test(part.error ?? "") ? "Rejected" : (part.error ?? "Failed")) : undefined);
        offerPreview(step, JSON.stringify(part.input ?? ""));
      }
    });
    if (item.failed) turn.append(el("div", "error-line", item.failed));
    if (item.tokens) turn.append(el("div", "foot", `${(item.tokens.input + item.tokens.cacheRead).toLocaleString()} in · ${item.tokens.output.toLocaleString()} out`));
    turn = undefined;
    blocks.clear();
    tools.clear();
  }
  timeline.scrollTop = timeline.scrollHeight;
}

// ---- history ---------------------------------------------------------------------------------------------------

const historyEl = $<HTMLElement>("history");
const historyList = $<HTMLElement>("historyList");
const historySearch = $<HTMLInputElement>("historySearch");
let searchTimer: number | undefined;

function openHistory(): void {
  historyEl.hidden = false;
  historyList.replaceChildren(el("div", "faint pad", "Loading…"));
  post({ type: "listSessions", search: historySearch.value });
  historySearch.focus();
}

function paintSessions(rows: SessionRowView[]): void {
  historyList.replaceChildren();
  if (rows.length === 0) {
    historyList.append(el("div", "faint pad", "No stored chats in this folder yet."));
    return;
  }
  for (const row of rows) {
    const item = el("div", "session");
    const text = el("div", "session-text");
    text.append(el("div", "session-title", row.title), el("div", "session-meta faint", [row.age, row.forked ? "fork" : "", row.costUsd ? "$" + row.costUsd.toFixed(2) : ""].filter(Boolean).join(" · ")));
    const actions = el("div", "session-actions");
    for (const [label, fork] of [["Continue", false], ["Fork", true]] as const) {
      const button = el("button", "btn", label);
      button.type = "button";
      button.title = fork ? "Start a new chat from a copy of this one; the original stays as it is" : "Reopen this chat";
      button.addEventListener("click", () => {
        historyEl.hidden = true;
        post({ type: "openSession", id: row.id, fork });
      });
      actions.append(button);
    }
    item.append(text, actions);
    historyList.append(item);
  }
}

$<HTMLButtonElement>("historyBtn").addEventListener("click", openHistory);
$<HTMLButtonElement>("historyClose").addEventListener("click", () => (historyEl.hidden = true));
historySearch.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => post({ type: "listSessions", search: historySearch.value }), 250);
});

// ---- voice dictation --------------------------------------------------------------------------------------------
// The extension host records (the editors deny the webview the microphone) and transcribes on this computer; the page
// only shows the state and receives the text, which lands in the message box for review. Nothing is sent by itself.

let voiceTimer: number | undefined;
const engineName = (id: string | undefined): string => (id === "windows" ? "Windows speech" : "faster-whisper");

function onVoiceState(message: Extract<ToWebview, { type: "voice" }>): void {
  window.clearInterval(voiceTimer);
  micBtn.classList.toggle("recording", message.state === "recording");
  micBtn.classList.toggle("busy", message.state === "transcribing");
  micBtn.setAttribute("aria-pressed", String(message.state === "recording"));
  if (message.state === "recording") {
    const tick = () => {
      const s = Math.floor((Date.now() - (message.startedAt ?? Date.now())) / 1000);
      voiceStatus.textContent = `Recording ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} (${engineName(message.engine)}). Click the microphone to stop, Esc to cancel.`;
    };
    tick();
    voiceTimer = window.setInterval(tick, 500);
    voiceStatus.hidden = false;
  } else if (message.state === "transcribing") {
    voiceStatus.textContent = `Transcribing on your computer (${engineName(message.engine)})\u2026`;
    voiceStatus.hidden = false;
  } else {
    voiceStatus.hidden = true;
    voiceStatus.textContent = "";
  }
}

function onVoiceResult(message: Extract<ToWebview, { type: "voiceResult" }>): void {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const sep = before && !/\s$/.test(before) ? " " : "";
  input.value = before + sep + message.text + after;
  const caret = (before + sep + message.text).length;
  input.setSelectionRange(caret, caret);
  grow();
  input.focus();
  if (message.note) say(message.note);
  // With "auto", Whisper guesses the language of each clip and a short one can be taken for another: say what it heard.
  if (message.language && message.engine === "faster-whisper") {
    voiceStatus.hidden = false;
    voiceStatus.textContent = `Heard as language: ${message.language}. Wrong? Set Capella \u203A Voice \u203A Language (for example pt) in Settings.`;
    window.clearTimeout(voiceTimer);
    voiceTimer = window.setTimeout(() => (voiceStatus.hidden = true), 9000);
  }
}

function onVoiceError(message: Extract<ToWebview, { type: "voiceError" }>): void {
  say(message.message, true);
  if (message.canSetup) {
    const button = el("button", "btn small", "Set up local voice");
    button.type = "button";
    button.style.marginLeft = "10px";
    button.addEventListener("click", () => post({ type: "voice", action: "setup" }));
    notice.append(button);
  }
}

micBtn.addEventListener("click", () => post({ type: "voice", action: "toggle" }));
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && micBtn.classList.contains("recording")) post({ type: "voice", action: "cancel" });
});

// ---- usage meter ----------------------------------------------------------------------------------------------

function paintUsage(usage: UsageView): void {
  usageEl.replaceChildren();
  usageEl.hidden = usage.windows.length === 0;
  for (const w of usage.windows) {
    const ring = el("span", `ring${w.limited || w.percent >= 95 ? " full" : w.percent >= 80 ? " hot" : ""}`);
    const dial = el("i");
    dial.style.setProperty("--p", String(Math.max(0, Math.min(100, w.percent))));
    ring.append(dial, el("span", undefined, `${w.label.replace("-hour", "h")} ${w.percent}%`));
    ring.title = `${w.label}: ${w.percent}%${w.limited ? " (limit reached)" : ""}${w.reset ? `, ${w.reset}` : ""}${usage.stale ? ". May be out of date." : ""}`;
    usageEl.append(ring);
  }
  usageEl.classList.toggle("stale", usage.stale);
  usageEl.title = "OpenCode Go usage. Click to open the Console.";
}
usageEl.addEventListener("click", () => post({ type: "openUsage" }));

// ---- menus ----------------------------------------------------------------------------------------------------

function openMenu(anchor: HTMLElement, build: (box: HTMLElement) => void): void {
  menu.replaceChildren();
  build(menu);
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const height = Math.min(menu.scrollHeight, window.innerHeight * 0.6);
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, rect.top - height - 8)}px`;
  menu.querySelector<HTMLElement>("input, .item")?.focus();
}
const closeMenu = (): void => {
  menu.hidden = true;
};

function modeMenu(): void {
  openMenu(modeBtn, (box) => {
    for (const m of modes) {
      const item = el("button", `item${m.id === mode ? " on" : ""}`);
      item.type = "button";
      item.append(el("span", undefined, m.label), el("small", undefined, m.description));
      item.addEventListener("click", () => {
        closeMenu();
        post({ type: "setMode", id: m.id });
      });
      box.append(item);
    }
  });
}

function modelMenu(): void {
  openMenu(modelBtn, (box) => {
    const search = el("input");
    search.type = "search";
    search.placeholder = "Filter models…";
    const list = el("div");
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren();
      const groups: Array<[string, ModelRow["family"]]> = [["OpenCode Zen", "zen"], ["OpenCode Go", "go"], ["Other providers", "other"]];
      for (const [title, family] of groups) {
        const rows = models.filter((m) => m.family === family && (q === "" || `${m.label} ${m.ref}`.toLowerCase().includes(q))).slice(0, family === "other" ? 40 : 200);
        if (rows.length === 0) continue;
        list.append(el("div", "group", title));
        for (const row of rows) {
          const item = el("button", `item${row.ref === model ? " on" : ""}`);
          item.type = "button";
          const label = el("span", undefined, row.label);
          if (row.free) label.append(el("span", "tag free", "free"));
          item.append(label, el("small", undefined, row.ref));
          item.addEventListener("click", () => {
            closeMenu();
            post({ type: "setModel", ref: row.ref });
          });
          list.append(item);
        }
      }
      if (list.childElementCount === 0) list.append(el("div", "group", "No model matches"));
    };
    search.addEventListener("input", paint);
    paint();
    box.append(search, list);
  });
}

// ---- composer ---------------------------------------------------------------------------------------------------

function send(): void {
  const text = input.value.trim();
  if ((text === "" && attachments.length === 0) || busy) return;
  input.value = "";
  grow();
  say("");
  post({ type: "send", text });
}

function grow(): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
}

function paintAttachments(): void {
  chipsEl.replaceChildren();
  chipsEl.hidden = attachments.length === 0;
  for (const a of attachments) {
    const chip = el("span", `chip-file ${a.kind}`);
    if (a.thumb) {
      const img = el("img");
      img.src = a.thumb;
      img.alt = "";
      chip.append(img);
    } else chip.append(el("span", "glyph", a.kind === "selection" ? "\u2702" : "\u2759"));
    chip.append(el("span", "fname", a.name), el("span", "fsize faint", a.size));
    const remove = el("button", "x", "\u00d7");
    remove.type = "button";
    remove.title = `Remove ${a.name}`;
    remove.setAttribute("aria-label", `Remove ${a.name}`);
    remove.addEventListener("click", () => post({ type: "removeAttachment", id: a.id }));
    chip.append(remove);
    chipsEl.append(chip);
  }
}

function plusMenu(): void {
  openMenu(plusBtn, (box) => {
    const rows: Array<[string, string, FromWebview]> = [
      ["Add files or photos\u2026", "Choose files from the open folder (text, PNG, JPEG, GIF, WebP)", { type: "pickFiles" }],
      ["Add the current file", "The file open in the editor", { type: "addCurrentFile" }],
      ["Add the selection", "The selected lines, as text", { type: "addSelection" }],
    ];
    for (const [label, hint, message] of rows) {
      const item = el("button", "item");
      item.type = "button";
      item.append(el("span", undefined, label), el("small", undefined, hint));
      item.addEventListener("click", () => {
        closeMenu();
        post(message);
      });
      box.append(item);
    }
  });
}
plusBtn.addEventListener("click", plusMenu);

/** Reads a File from the page as base64 (no `data:` prefix) and hands it to the extension, which decides if it may be attached. */
function sendFile(file: File, fallbackName: string): void {
  if (file.size > 6 * 1024 * 1024) {
    say(`${file.name || fallbackName} is too large to attach (over 6 MB).`, true);
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const url = String(reader.result ?? "");
    const comma = url.indexOf(",");
    if (comma > 0) post({ type: "addData", name: file.name || fallbackName, base64: url.slice(comma + 1) });
  };
  reader.readAsDataURL(file);
}

input.addEventListener("paste", (e) => {
  let handled = false;
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) {
      sendFile(file, "pasted-image.png");
      handled = true;
    }
  }
  // A paste that carries files must not also paste a file name into the text.
  if (handled) e.preventDefault();
});

const hasDroppable = (e: DragEvent): boolean => Array.from(e.dataTransfer?.types ?? []).some((t) => t === "Files" || t === "text/uri-list" || t === "application/vnd.code.uri-list" || t === "resourceurls");
document.addEventListener("dragover", (e) => {
  if (hasDroppable(e)) e.preventDefault();
});
document.addEventListener("drop", (e) => {
  if (!hasDroppable(e)) return;
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;
  for (const file of Array.from(dt.files)) sendFile(file, "dropped-file");
  // Dragging from the editor's Explorer carries addresses, not bytes.
  const list = [dt.getData("text/uri-list"), dt.getData("application/vnd.code.uri-list")].join("\n");
  const uris = list.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "" && !s.startsWith("#"));
  if (uris.length > 0 && dt.files.length === 0) post({ type: "dropUris", uris });
});

input.addEventListener("input", grow);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    const cycle = modes.filter((m) => !m.dangerous);
    const next = cycle[(cycle.findIndex((m) => m.id === mode) + 1) % cycle.length];
    if (next) post({ type: "setMode", id: next.id });
  }
});
sendBtn.addEventListener("click", send);
stopBtn.addEventListener("click", () => post({ type: "stop" }));
$<HTMLButtonElement>("newChat").addEventListener("click", () => post({ type: "newChat" }));
modeBtn.addEventListener("click", modeMenu);
modelBtn.addEventListener("click", modelMenu);
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!menu.hidden && !menu.contains(target) && target !== modeBtn && target !== modelBtn) closeMenu();
  const link = target.closest<HTMLElement>("a[data-href]");
  if (link?.dataset.href) post({ type: "openLink", url: link.dataset.href });
  const copy = target.closest<HTMLElement>("button.copy");
  if (copy) {
    post({ type: "copy", text: copy.parentElement?.querySelector("code")?.textContent ?? "" });
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy"), 1200);
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

window.addEventListener("message", (e: MessageEvent<ToWebview>) => {
  const message = e.data;
  switch (message.type) {
    case "init":
      modes = message.modes;
      models = message.models;
      mode = message.mode;
      model = message.model;
      $<HTMLElement>("historyBtn").hidden = message.features?.history === false;
      $<HTMLElement>("version").textContent = message.version ? `opencode ${message.version}` : "";
      paintChips();
      break;
    case "event":
      onEvent(message.event);
      break;
    case "user":
      $<HTMLElement>("welcome")?.remove();
      timeline.append(userBubble(message.text, message.files));
      timeline.scrollTop = timeline.scrollHeight;
      break;
    case "fileChange":
      showFileChange(message.change);
      break;
    case "changes":
      paintChanges(message.rows);
      break;
    case "attachments":
      attachments = message.items;
      paintAttachments();
      break;
    case "busy":
      setBusy(message.value);
      break;
    case "mode":
      mode = message.id;
      paintChips();
      break;
    case "model":
      model = message.ref;
      paintChips();
      break;
    case "notice":
      say(message.text, message.error);
      break;
    case "usage":
      paintUsage(message.usage);
      break;
    case "voice":
      onVoiceState(message);
      break;
    case "voiceResult":
      onVoiceResult(message);
      break;
    case "voiceError":
      onVoiceError(message);
      break;
    case "sessions":
      paintSessions(message.rows);
      break;
    case "replay":
      replay(message.items);
      break;
    case "modelNote":
      modelBtn.title = message.text !== "" ? `Model. ${message.text}` : "Model";
      break;
    case "reset":
      timeline.replaceChildren();
      blocks.clear();
      tools.clear();
      approvals.clear();
      turn = undefined;
      setBusy(false);
      say("");
      break;
  }
});

post({ type: "ready" });
