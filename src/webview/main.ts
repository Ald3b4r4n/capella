import type { SessionEvent } from "../opencode/session.ts";
import type { AttachmentView, ChangeRowView, FileChangeView, FromWebview, ModeRow, ModelRow, QueueItemView, SessionRowView, SlashEntryView, ToolsView, ToWebview, UsageView } from "../ui/protocol.ts";
import type { ReplayItem } from "../opencode/history.ts";
import { findLocalUrl } from "../ui/preview.ts";
import { renderMarkdown } from "./markdown.ts";
import type { QuestionField, QuestionRequest, QuestionValue } from "../opencode/events.ts";
import { visible } from "../ui/questions.ts";
import { describeApproval } from "./approvalDetail.ts";

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
const effortBtn = $<HTMLButtonElement>("effortBtn");
const webBtn = $<HTMLButtonElement>("webBtn");
const voiceStatus = $<HTMLElement>("voiceStatus");
const slashMenu = $<HTMLElement>("slashMenu");
const queueTray = $<HTMLElement>("queueTray");
const foldersEl = $<HTMLElement>("folders");
const todosEl = $<HTMLDetailsElement>("todos");
const todosSummary = $<HTMLElement>("todosSummary");
const todosList = $<HTMLElement>("todosList");

let modes: ModeRow[] = [];
let models: ModelRow[] = [];
let mode = "plan";
let model: string | undefined;
let effort: string | undefined;
let web: "mode" | "allow" | "deny" = "mode";
let busy = false;
let attachments: AttachmentView[] = [];
/** Whether this opencode takes a message while a turn runs (2.x; 1.x does not). */
let canQueue = false;
let queueItems: QueueItemView[] = [];

// The current turn: the rail that every step of the reply hangs off, and the blocks still receiving text.
let turn: HTMLElement | undefined;
const blocks = new Map<string, { el: HTMLElement; raw: string; kind: "text" | "reasoning" }>();
const tools = new Map<string, HTMLElement>();
const approvals = new Map<string, HTMLElement>();
/** The tool calls seen so far (name, then input), so that an approval can say what its call would do. */
const callInfo = new Map<string, { name: string; input?: unknown }>();
/** The detail box of each approval card still waiting, by the call it belongs to: filled when the call's input is known. */
const approvalDetails = new Map<string, { box: HTMLElement; res: HTMLElement; action: string }>();

function fillApprovalDetail(callId: string): void {
  const waiting = approvalDetails.get(callId);
  const call = callInfo.get(callId);
  if (!waiting || !call) return;
  const detail = describeApproval(waiting.action, call.name, call.input);
  if (!detail) return;
  waiting.box.replaceChildren();
  if (detail.headline) waiting.box.append(el("div", "ad-head", detail.headline));
  for (const line of detail.lines) waiting.box.append(el("div", "ad-line", line));
  if (detail.code) {
    const more = el("details", "ad-code");
    more.append(el("summary", undefined, "Show the whole code"), el("pre", undefined, detail.code));
    waiting.box.append(more);
  }
  waiting.box.hidden = false;
  // opencode often sends only `*` as the resource: the lines above say more, so the bare star is not repeated
  if (waiting.res.textContent?.trim() === "*") waiting.res.hidden = true;
}
let tokens = { input: 0, output: 0 };
let renderQueued = new Set<string>();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Following the output. The view follows while the user has not scrolled away on purpose. "Near the bottom" is NOT used to
 * decide that: content that shrinks for a moment (a block repainted, a card collapsing) moves the scroll position up
 * without the user doing anything, and a check of the position would switch following off by itself (the Antares 0.1.3 bug).
 * Only a real action (wheel up, an arrow or page key, dragging the scrollbar, touch) stops it; reaching the bottom again
 * resumes it. A button offers the jump back.
 */
let following = true;
const jump = $<HTMLButtonElement>("jumpBottom");
const atBottom = (): boolean => timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 8;
function paintJump(): void {
  jump.hidden = following || atBottom();
  timeline.dataset.following = String(following);
}
function scrollToEnd(): void {
  // `instant`: the stylesheet smooths scrolling, and an animation that restarts on every token never catches up with the end.
  timeline.scrollTo({ top: timeline.scrollHeight, behavior: "instant" });
}
function leave(): void {
  following = false;
  paintJump();
}
timeline.addEventListener("wheel", (e) => e.deltaY < 0 && leave(), { passive: true });
timeline.addEventListener("touchmove", leave, { passive: true });
timeline.addEventListener("keydown", (e) => ["ArrowUp", "PageUp", "Home"].includes(e.key) && leave());
// A press on the scrollbar itself (the area right of the content) is a user action too.
timeline.addEventListener("mousedown", (e) => e.offsetX > timeline.clientWidth && leave());
// Resuming needs the view to MOVE DOWN to the end. Merely being near the end is not enough: a smooth scroll up starts
// there, and its first events would otherwise switch following back on (measured in a real window).
let lastTop = 0;
timeline.addEventListener("scroll", () => {
  if (timeline.scrollTop > lastTop && atBottom()) following = true;
  lastTop = timeline.scrollTop;
  paintJump();
});
jump.addEventListener("click", () => {
  following = true;
  scrollToEnd();
  paintJump();
});
// Heights that change without any DOM change of ours (an image loading, the footer resizing) must keep the end in view too.
new ResizeObserver(() => following && scrollToEnd()).observe(timeline);
const content = new MutationObserver(() => following && scrollToEnd());
content.observe(timeline, { childList: true, subtree: true, characterData: true });

function stickToBottom<T>(action: () => T): T {
  const result = action();
  if (following) scrollToEnd();
  return result;
}

function say(text: string, error = false): void {
  notice.textContent = text;
  notice.className = error ? "notice error" : "notice";
  notice.hidden = text === "";
}

function setBusy(value: boolean): void {
  busy = value;
  // While the agent works, Send stays when the message can be queued; Stop is always there.
  sendBtn.hidden = value && !canQueue;
  sendBtn.title = value ? "Queue this message (Ctrl+Enter sends it into the current turn)" : "Send";
  stopBtn.hidden = !value;
  input.placeholder = value ? (canQueue ? "opencode is working… Enter queues your message, Ctrl+Enter sends it into the turn" : "opencode is working…") : "Ask opencode…  (Enter sends, Shift+Enter adds a line, / for commands)";
  turn?.classList.toggle("live", value);
}

function paintChips(): void {
  const current = modes.find((m) => m.id === mode);
  modeBtn.textContent = current ? current.label : mode;
  modeBtn.dataset.tone = current?.tone ?? "";
  modeBtn.title = current?.description ?? "";
  const picked = models.find((m) => m.ref === model);
  modelBtn.textContent = picked ? picked.label : model ?? "Default model";
  // The effort chip exists only for a model that offers variants.
  const options = picked?.variants ?? [];
  effortBtn.hidden = options.length === 0;
  effortBtn.textContent = effort ? `Effort: ${effort}` : "Effort: default";
  webBtn.textContent = web === "mode" ? "Web: per mode" : web === "allow" ? "Web: on" : "Web: off";
  webBtn.dataset.tone = web === "deny" ? "plan" : web === "allow" ? "edit" : "";
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
  if (block.kind === "text") {
    block.el.innerHTML = renderMarkdown(block.raw);
    hydrateImages(block.el);
  } else block.el.textContent = block.raw;
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
  card.append(el("div", "what", event.action === "external_directory" ? "Let the agent use a folder outside the project?" : `Allow ${event.action}?`));
  const detailBox = el("div", "ad");
  detailBox.hidden = true;
  card.append(detailBox);
  const res = el("div", "res");
  res.textContent = event.resources.join("\n") || "(no details)";
  card.append(res);
  if (event.source) {
    approvalDetails.set(event.source.callId, { box: detailBox, res, action: event.action });
    fillApprovalDetail(event.source.callId);
  }
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

// ---- the agent asks the user ---------------------------------------------------------------------------------------

const questionCards = new Map<string, { card: HTMLElement; values: Record<string, QuestionValue | undefined> }>();

const summary = (value: QuestionValue | undefined): string => (value === undefined ? "" : Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? "Yes" : "No") : String(value));

/**
 * A question of the agent, as a card in the conversation: the options as buttons, a box for an answer of the user's own where
 * that is allowed, and Send / Don't answer. Nothing is sent until the user presses Send, and a field that does not apply
 * yet (a `when` condition of a 2.x form) is not shown. The agent waits for the answer, so the card stays until it is resolved.
 */
function questionCard(request: QuestionRequest): void {
  if (questionCards.has(request.requestId)) return;
  const step = addStep("approval question");
  const card = el("div", "approval-card question-card");
  card.append(el("div", "what", request.title));
  const values: Record<string, QuestionValue | undefined> = {};
  for (const f of request.fields) if (f.default !== undefined) values[f.key] = f.default;
  questionCards.set(request.requestId, { card, values });
  const body = el("div", "q-fields");
  const send = el("button", "btn allow", "Send answer");
  const decline = el("button", "btn reject", "Don't answer");
  send.type = decline.type = "button";

  const complete = (): boolean =>
    request.fields.every((f) => {
      if (!visible(f, values) || f.kind === "link" || f.required !== true) return true;
      const v = values[f.key];
      return !(v === undefined || v === "" || (Array.isArray(v) && v.length === 0));
    });
  const refresh = (): void => {
    send.disabled = !complete();
    paintFields();
  };

  const option = (field: QuestionField, o: { value: string; label: string; description?: string }, selected: boolean, onPick: () => void, multi: boolean): HTMLElement => {
    const b = el("button", `opt${selected ? " on" : ""}`);
    b.type = "button";
    b.setAttribute("role", multi ? "checkbox" : "radio");
    b.setAttribute("aria-checked", String(selected));
    b.append(el("span", "mark", multi ? (selected ? "\u2611" : "\u2610") : selected ? "\u25c9" : "\u25cb"), el("span", "opt-text", o.label));
    if (o.description && o.description !== o.label) b.append(el("small", "faint", o.description));
    b.addEventListener("click", onPick);
    return b;
  };

  const paintFields = (): void => {
    body.replaceChildren();
    for (const f of request.fields) {
      if (!visible(f, values)) continue;
      const box = el("div", "q-field");
      box.append(el("div", "q-title", f.title));
      if (f.description && f.description !== f.title) box.append(el("div", "faint small", f.description));
      if (f.kind === "choice" || f.kind === "multi") {
        const multi = f.kind === "multi";
        const chosen = multi ? ((values[f.key] as string[] | undefined) ?? []) : values[f.key] === undefined ? [] : [String(values[f.key])];
        const known = new Set((f.options ?? []).map((o) => o.value));
        for (const o of f.options ?? []) {
          box.append(
            option(f, o, chosen.includes(o.value), () => {
              if (multi) values[f.key] = chosen.includes(o.value) ? chosen.filter((c) => c !== o.value) : [...chosen, o.value];
              else values[f.key] = o.value;
              refresh();
            }, multi),
          );
        }
        if (f.custom) {
          const own = el("input");
          own.type = "text";
          own.placeholder = multi ? "Or add your own…" : "Or type your own answer…";
          own.setAttribute("aria-label", `Your own answer to: ${f.title}`);
          own.value = chosen.filter((c) => !known.has(c)).join(", ");
          own.addEventListener("input", () => {
            const mine = own.value.trim();
            if (multi) values[f.key] = [...chosen.filter((c) => known.has(c)), ...(mine ? [mine] : [])];
            else values[f.key] = mine === "" ? undefined : mine;
            send.disabled = !complete();
          });
          box.append(own);
        }
      } else if (f.kind === "boolean") {
        for (const [label, v] of [["Yes", true], ["No", false]] as const) box.append(option(f, { value: String(v), label }, values[f.key] === v, () => { values[f.key] = v; refresh(); }, false));
      } else if (f.kind === "link") {
        const open = el("button", "btn", f.url ? `Open ${(() => { try { return new URL(f.url!).host; } catch { return "the page"; } })()}` : "Open the page");
        open.type = "button";
        open.addEventListener("click", () => f.url && post({ type: "openLink", url: f.url }));
        box.append(open);
      } else {
        const input = f.kind === "text" ? el("textarea") : el("input");
        if (input instanceof HTMLInputElement) {
          input.type = "number";
          if (f.kind === "integer") input.step = "1";
          if (f.min !== undefined) input.min = String(f.min);
          if (f.max !== undefined) input.max = String(f.max);
        } else input.rows = 2;
        input.value = summary(values[f.key]);
        input.setAttribute("aria-label", f.title);
        input.addEventListener("input", () => {
          const raw = input.value;
          values[f.key] = f.kind === "text" ? raw : raw.trim() === "" ? undefined : Number(raw);
          send.disabled = !complete();
        });
        box.append(input);
      }
      body.append(box);
    }
  };

  const finish = (text: string): void => {
    send.disabled = decline.disabled = true;
    for (const b of body.querySelectorAll<HTMLElement>("button, input, textarea")) (b as HTMLButtonElement).disabled = true;
    card.querySelector(".verdict")?.remove();
    card.append(el("div", "verdict", text));
  };
  send.addEventListener("click", () => {
    const answers: Record<string, QuestionValue> = {};
    for (const f of request.fields) {
      const v = values[f.key];
      if (visible(f, values) && f.kind !== "link" && v !== undefined && v !== "") answers[f.key] = v;
    }
    finish("Answer sent…");
    post({ type: "answerQuestion", requestId: request.requestId, answers });
  });
  decline.addEventListener("click", () => {
    finish("Declining…");
    post({ type: "rejectQuestion", requestId: request.requestId });
  });
  const btns = el("div", "btns");
  btns.append(send, decline);
  card.append(body, btns);
  step.append(card);
  paintFields();
  send.disabled = !complete();
  card.dataset.requestId = request.requestId;
}

function questionResolved(requestId: string, outcome: "answered" | "rejected", answers?: Record<string, QuestionValue>): void {
  const found = questionCards.get(requestId);
  if (!found) return;
  const { card, values } = found;
  card.classList.add("resolved");
  for (const b of card.querySelectorAll<HTMLElement>("button, input, textarea")) (b as HTMLButtonElement).disabled = true;
  card.querySelector(".verdict")?.remove();
  const shown = answers && Object.keys(answers).length > 0 ? Object.values(answers).map((v) => summary(v as QuestionValue)).filter(Boolean).join(" · ") : Object.values(values).map((v) => summary(v)).filter(Boolean).join(" · ");
  card.append(el("div", "verdict", outcome === "answered" ? (shown ? `You answered: ${shown}` : "Answered") : "You chose not to answer."));
}

/** One Copy button under the last text of a finished turn: copies the whole answer (code blocks keep their own button). */
function addCopyAnswer(finished: HTMLElement): void {
  const parts = [...finished.querySelectorAll<HTMLElement>(".md")];
  if (parts.length === 0 || finished.querySelector(".copy-answer")) return;
  const button = el("button", "btn small copy-answer", "Copy answer");
  button.type = "button";
  button.addEventListener("click", () => {
    post({ type: "copy", text: parts.map((p) => p.textContent ?? "").join("\n\n").trim() });
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy answer"), 1200);
  });
  finished.append(button);
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
        callInfo.set(event.callId, { name: event.name });
        if (/todo/i.test(event.name)) todoCalls.add(event.callId);
        toolStep(event.callId, event.name);
        break;
      case "tool-input":
        callInfo.set(event.callId, { name: callInfo.get(event.callId)?.name ?? "tool", input: event.input });
        fillApprovalDetail(event.callId);
        if (todoCalls.has(event.callId)) paintTodos(event.input);
        break;
      case "tool-called": {
        callInfo.set(event.callId, { name: callInfo.get(event.callId)?.name ?? "tool", input: event.input });
        fillApprovalDetail(event.callId);
        if (todoCalls.has(event.callId)) paintTodos(event.input);
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
      case "question-asked":
        questionCard(event.request);
        break;
      case "question-resolved":
        questionResolved(event.requestId, event.outcome, event.answers);
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
        // a question the agent is no longer waiting for (the turn was stopped, or failed)
        for (const [id, found] of questionCards) if (!found.card.classList.contains("resolved")) {
          found.card.classList.add("resolved");
          for (const b of found.card.querySelectorAll<HTMLElement>("button, input, textarea")) (b as HTMLButtonElement).disabled = true;
          found.card.querySelector(".verdict")?.remove();
          found.card.append(el("div", "verdict", "The agent is no longer waiting for this."));
          questionCards.delete(id);
        }
        turn?.classList.remove("live");
        if (turn) addCopyAnswer(turn);
        if (turn && (tokens.input || tokens.output)) turn.append(el("div", "foot", `${tokens.input.toLocaleString()} in · ${tokens.output.toLocaleString()} out`));
        if (event.outcome === "failed") turn?.append(el("div", "error-line", explainError(event.error)));
        if (event.outcome === "interrupted") turn?.append(el("div", "foot", "Stopped"));
        turn = undefined;
        blocks.clear();
        tools.clear();
        callInfo.clear();
        approvalDetails.clear();
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
        if (/todo/i.test(part.name)) paintTodos(part.input);
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
  following = true;
  scrollToEnd();
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
$<HTMLButtonElement>("previewBtn").addEventListener("click", () => post({ type: "previewMenu" }));
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

/** The button that opened the menu: a click on it is the click that opened it, not an outside click that closes it. */
let menuAnchor: HTMLElement | undefined;

function openMenu(anchor: HTMLElement, build: (box: HTMLElement) => void): void {
  menuAnchor = anchor;
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

/** Which provider group the model menu shows. Kept while the chat is open: most people use one provider. */
let modelTab: ModelRow["family"] | "all" = "all";

function modelMenu(): void {
  openMenu(modelBtn, (box) => {
    const refresh = el("button", "item");
    refresh.type = "button";
    refresh.append(el("span", undefined, "\u21bb Read the model list again"), el("small", undefined, "Asks opencode; no model is called"));
    refresh.addEventListener("click", () => {
      closeMenu();
      post({ type: "refreshModels" });
    });
    box.append(refresh);
    const search = el("input");
    search.type = "search";
    search.placeholder = "Filter models…";
    const list = el("div");
    const tabs = el("div", "tabs");
    tabs.setAttribute("role", "tablist");
    const groups: Array<[string, ModelRow["family"], string]> = [["OpenCode Zen", "zen", "Zen"], ["OpenCode Go", "go", "Go"], ["Other providers", "other", "Other"]];
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const matches = (m: ModelRow): boolean => q === "" || `${m.label} ${m.ref}`.toLowerCase().includes(q);
      // one tab for each provider group that has models, with how many, and "All"
      tabs.replaceChildren();
      const tab = (label: string, key: ModelRow["family"] | "all", count: number): void => {
        const b = el("button", `tab${modelTab === key ? " on" : ""}`, label);
        b.type = "button";
        b.dataset.family = key;
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(modelTab === key));
        b.append(el("span", "count", String(count)));
        b.addEventListener("click", (e) => {
          // the button is replaced by the repaint: the page-wide click handler must not take it for a click outside the menu
          e.stopPropagation();
          modelTab = key;
          paint();
        });
        tabs.append(b);
      };
      tab("All", "all", models.filter(matches).length);
      for (const [, family, short] of groups) {
        const n = models.filter((m) => m.family === family && matches(m)).length;
        if (models.some((m) => m.family === family)) tab(short, family, n);
      }
      list.replaceChildren();
      for (const [title, family] of groups) {
        if (modelTab !== "all" && modelTab !== family) continue;
        const rows = models.filter((m) => m.family === family && matches(m)).slice(0, family === "other" ? 40 : 200);
        if (rows.length === 0) continue;
        const head = el("div", "group", title);
        head.dataset.family = family;
        head.append(el("span", "count", String(rows.length)));
        list.append(head);
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
    box.append(search, tabs, list);
  });
}

// ---- composer ---------------------------------------------------------------------------------------------------

function send(delivery?: "queue" | "steer"): void {
  const text = input.value.trim();
  if (text === "" && attachments.length === 0) return;
  if (busy && !canQueue) {
    say("Wait for opencode to finish this turn: this version (1.x) cannot take a message while it works.", true);
    return;
  }
  input.value = "";
  grow();
  say("");
  closeSlash();
  post(busy ? { type: "send", text, delivery: delivery ?? "queue" } : { type: "send", text });
}

// ---- messages waiting for their turn (opencode 2.x) ----------------------------------------------------------------

function paintQueue(): void {
  queueTray.replaceChildren();
  queueTray.hidden = queueItems.length === 0;
  for (const item of queueItems) {
    const row = el("div", "q-row");
    const label = item.text.length > 140 ? item.text.slice(0, 140) + "…" : item.text;
    row.append(el("span", "q-kind", item.delivery === "steer" ? "steering" : "queued"), el("span", "q-text", label));
    if (item.files.length > 0) row.append(el("span", "q-files faint", item.files.join(", ")));
    if (item.delivery === "queue") {
      const now = el("button", "btn small", "Send now");
      now.type = "button";
      now.title = "Hand it to the agent at its next step, without waiting for the end of the turn";
      now.addEventListener("click", () => post({ type: "steerNow", id: item.id }));
      row.append(now);
    }
    const remove = el("button", "x", "\u00d7");
    remove.type = "button";
    remove.title = "Remove this message from the queue";
    remove.setAttribute("aria-label", "Remove this message from the queue");
    remove.addEventListener("click", () => post({ type: "unqueue", id: item.id }));
    row.append(remove);
    queueTray.append(row);
  }
}

/** A queued message has just joined the turn: the turn so far is closed off and the message opens the next part. */
function joinMessage(text: string, files: Array<{ name: string; mime: string; thumb?: string }> | undefined): void {
  if (turn) {
    turn.classList.remove("live");
    addCopyAnswer(turn);
    turn = undefined;
    blocks.clear();
  }
  timeline.append(userBubble(text, files));
  following = true;
  scrollToEnd();
}

// ---- folders outside the project that this chat may use ---------------------------------------------------------------

function paintFolders(items: Array<{ path: string; name: string }>): void {
  foldersEl.replaceChildren();
  foldersEl.hidden = items.length === 0;
  for (const folder of items) {
    const chip = el("span", "chip-file folder");
    chip.title = `The agent may use this folder in this chat: ${folder.path}`;
    chip.append(el("span", "glyph", "\u25a4"), el("span", "fname", folder.name));
    const remove = el("button", "x", "\u00d7");
    remove.type = "button";
    remove.title = `Stop using ${folder.name}`;
    remove.setAttribute("aria-label", `Remove the folder ${folder.name}`);
    remove.addEventListener("click", () => post({ type: "removeFolder", path: folder.path }));
    chip.append(remove);
    foldersEl.append(chip);
  }
}

// ---- Tools: MCP servers, skills, plugins -------------------------------------------------------------------------------

const toolsEl = $<HTMLElement>("tools");
const toolsBody = $<HTMLElement>("toolsBody");

function toolsSection(title: string, hint?: string): HTMLElement {
  const box = el("section", "tools-section");
  box.append(el("h3", undefined, title));
  if (hint) box.append(el("p", "faint small", hint));
  toolsBody.append(box);
  return box;
}

let accountFilter = "";

function paintAccounts(tools: ToolsView, into: HTMLElement): void {
  const search = el("input");
  search.type = "search";
  search.placeholder = "Search providers…";
  search.value = accountFilter;
  search.setAttribute("aria-label", "Search providers");
  const list = el("div");
  const rows = (): void => {
    list.replaceChildren();
    const q = accountFilter.trim().toLowerCase();
    const connectedOf = (a: ToolsView["accounts"][number]) => a.connections.length > 0;
    const shown = tools.accounts
      .filter((a) => (q === "" ? a.featured || connectedOf(a) : `${a.name} ${a.id}`.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.featured) - Number(a.featured) || Number(connectedOf(b)) - Number(connectedOf(a)) || a.name.localeCompare(b.name))
      .slice(0, 40);
    for (const account of shown) {
      const row = el("div", "session");
      const text = el("div", "session-text");
      text.append(el("div", "session-title", account.id === "opencode" ? "OpenCode Zen (console)" : account.name));
      const parts = account.connections.map((c) => (c.kind === "env" ? `variable ${c.envName ?? c.label}` : `${c.label}${c.method ? " (" + c.method + ")" : ""}${c.active === false ? ", not in use" : ""}`));
      text.append(el("div", "session-meta faint", parts.length > 0 ? "Connected: " + parts.join("; ") : "Not connected"));
      const actions = el("div", "session-actions");
      actions.append(el("span", `badge ${account.connections.length > 0 ? "connected" : "disabled"}`, account.connections.length > 0 ? "connected" : "not connected"));
      const addButton = (label: string, method: string, title?: string): void => {
        const b = el("button", "btn", label);
        b.type = "button";
        if (title) b.title = title;
        b.addEventListener("click", () => post({ type: "accountConnect", id: account.id, method }));
        actions.append(b);
      };
      if (account.canKey) addButton(account.connections.some((c) => c.kind === "credential") ? "Add another key" : "API key", "key", "Paste an API key: it is typed in the editor's own box and stored by opencode");
      for (const o of account.oauth) addButton(o.label.length > 28 ? o.label.slice(0, 27) + "\u2026" : o.label, o.id, o.label);
      const credentials = account.connections.filter((c) => c.kind === "credential" && c.id);
      for (const c of credentials) {
        if (credentials.length > 1 && c.active === false) {
          const use = el("button", "btn", "Use");
          use.type = "button";
          use.title = `Use ${c.label}`;
          use.addEventListener("click", () => post({ type: "accountActivate", connectionId: c.id! }));
          actions.append(use);
        }
        const out = el("button", "btn", credentials.length > 1 ? `Sign out ${c.label}` : "Sign out");
        out.type = "button";
        out.addEventListener("click", () => post({ type: "accountDisconnect", id: account.id, connectionId: c.id }));
        actions.append(out);
      }
      row.append(text, actions);
      list.append(row);
    }
    if (shown.length === 0) list.append(el("div", "faint pad", q === "" ? "No provider is connected." : "No provider matches."));
    if (q === "") list.append(el("div", "faint small pad", `${tools.accounts.length} providers are available: search to connect another.`));
  };
  search.addEventListener("input", () => {
    accountFilter = search.value;
    rows();
  });
  into.append(search, list);
  rows();
}

function paintTools(tools: ToolsView): void {
  toolsBody.replaceChildren();
  const accounts = toolsSection("Accounts", tools.canOauth ? "Zen and Go, and every other provider opencode knows. A key is stored by opencode, not by Capella." : "Zen and Go, and every other provider opencode knows. A key is stored by opencode, not by Capella. Browser sign-ins need opencode 2.x (use \`opencode auth login\` here).");
  paintAccounts(tools, accounts);
  const mcp = toolsSection("MCP servers", "Their tools are asked about before they run, except in Bypass mode.");
  for (const server of tools.mcp) {
    const row = el("div", "session");
    const text = el("div", "session-text");
    text.append(el("div", "session-title", server.name), el("div", "session-meta faint", [server.managed ? "added in Capella" : "from your opencode config", server.summary ?? ""].filter(Boolean).join(" · ")));
    if (server.detail) text.append(el("div", "session-meta error-text", server.detail));
    const actions = el("div", "session-actions");
    actions.append(el("span", `badge ${server.status}`, server.status));
    const on = server.status === "connected" || server.status === "pending";
    const toggle = el("button", "btn", on ? "Turn off" : "Turn on");
    toggle.type = "button";
    toggle.addEventListener("click", () => post({ type: "mcpToggle", name: server.name, on: !on }));
    actions.append(toggle);
    const test = el("button", "btn", "Test");
    test.type = "button";
    test.title = server.managed ? "Start it again and say how it went" : "Disconnect and connect it again, and say how it went";
    test.addEventListener("click", () => post({ type: "mcpTest", name: server.name }));
    actions.append(test);
    if (server.status === "needs-auth" && server.integrationId) {
      const signIn = el("button", "btn", "Sign in");
      signIn.type = "button";
      signIn.title = "Sign in to this server in your browser (opencode runs it)";
      signIn.addEventListener("click", () => post({ type: "mcpSignIn", name: server.name }));
      actions.append(signIn);
    }
    if (server.managed) {
      const edit = el("button", "btn", "Edit");
      edit.type = "button";
      edit.title = "Change the command or address, its environment variables or headers (values stay hidden)";
      edit.addEventListener("click", () => post({ type: "mcpEdit", name: server.name }));
      actions.append(edit);
      const remove = el("button", "btn", "Remove");
      remove.type = "button";
      remove.title = tools.removeForgets ? "Forget this server" : "Disconnect it and stop starting it in new chats (opencode 1.x keeps it listed until it restarts)";
      remove.addEventListener("click", () => post({ type: "mcpRemove", name: server.name }));
      actions.append(remove);
    }
    row.append(text, actions);
    mcp.append(row);
  }
  if (tools.mcp.length === 0) mcp.append(el("div", "faint pad", "No MCP servers."));
  const add = el("button", "btn", "Add an MCP server\u2026");
  add.type = "button";
  add.addEventListener("click", () => post({ type: "mcpAdd" }));
  mcp.append(add);
  const browser = el("button", "btn", "Add the browser (Playwright)\u2026");
  browser.type = "button";
  browser.title = "Let the agent open a page, click and take screenshots: Microsoft's Playwright MCP, installed after a question, in a throwaway profile";
  browser.addEventListener("click", () => post({ type: "mcpAddBrowser" }));
  mcp.append(" ", browser);

  const skills = toolsSection(`Skills (${tools.skills.length})`, "Type / in the message box to use one. A skill is a folder with a SKILL.md: install one from a folder you trust.");
  for (const skill of tools.skills) {
    const row = el("div", "session");
    const text = el("div", "session-text");
    text.append(el("div", "session-title", skill.name));
    if (skill.description) text.append(el("div", "session-meta faint", skill.description.length > 160 ? skill.description.slice(0, 160) + "…" : skill.description));
    const actions = el("div", "session-actions");
    if (skill.managed) actions.append(el("span", "badge connected", "installed in Capella"));
    if (skill.openable) {
      const open = el("button", "btn", "Open");
      open.type = "button";
      open.addEventListener("click", () => post({ type: "openSkill", name: skill.name }));
      actions.append(open);
    }
    if (skill.managed) {
      const remove = el("button", "btn", "Remove");
      remove.type = "button";
      remove.title = "Delete the folder Capella installed";
      remove.addEventListener("click", () => post({ type: "skillRemove", name: skill.name }));
      actions.append(remove);
    }
    row.append(text, actions);
    skills.append(row);
  }
  const installSkill = el("button", "btn", "Install a skill from a folder…");
  installSkill.type = "button";
  installSkill.addEventListener("click", () => post({ type: "skillInstall" }));
  skills.append(installSkill);

  const plugins = toolsSection(`Plugins (${tools.plugins.length})`, tools.canManagePlugins ? "Plugins other than opencode's own. A plugin is code that runs inside opencode with your permissions: add only ones you trust. Adding and removing change your global opencode configuration." : "Plugins from your opencode configuration (listed only: managing them needs opencode 2.x).");
  for (const plugin of tools.plugins) {
    const row = el("div", "session");
    const text = el("div", "session-text");
    text.append(el("div", "session-title", plugin.version ? `${plugin.name} ${plugin.version}` : plugin.name), el("div", "session-meta faint", plugin.kind === "package" ? "npm package" : plugin.kind === "local" ? "local file" : plugin.kind === "config" ? "from your opencode configuration" : plugin.kind));
    if (plugin.error) text.append(el("div", "session-meta error-text", plugin.error));
    const actions = el("div", "session-actions");
    actions.append(el("span", `badge ${plugin.state === "active" ? "connected" : plugin.state === "failed" ? "failed" : ""}`, plugin.updating ? "updating…" : plugin.state));
    if (plugin.outdated) {
      actions.append(el("span", "badge needs-auth", "update available"));
      if (tools.canManagePlugins && plugin.kind === "package") {
        const update = el("button", "btn", "Update");
        update.type = "button";
        update.addEventListener("click", () => post({ type: "pluginUpdate", target: plugin.name }));
        actions.append(update);
      }
    }
    if (tools.canManagePlugins && plugin.removable) {
      const remove = el("button", "btn", "Remove");
      remove.type = "button";
      remove.title = "Take it out of your global opencode configuration";
      remove.addEventListener("click", () => post({ type: "pluginRemove", target: plugin.name }));
      actions.append(remove);
    }
    row.append(text, actions);
    plugins.append(row);
  }
  if (tools.plugins.length === 0) plugins.append(el("div", "faint pad", "No plugins besides opencode's own."));
  if (tools.canManagePlugins) {
    const check = el("button", "btn", "Check for updates");
    check.type = "button";
    check.title = "Asks the npm registry whether the package plugins have a newer version";
    check.addEventListener("click", () => post({ type: "pluginCheck" }));
    const addPlugin = el("button", "btn", "Add a plugin…");
    addPlugin.type = "button";
    addPlugin.addEventListener("click", () => post({ type: "pluginAdd" }));
    plugins.append(check, " ", addPlugin);
  }
}

function openTools(): void {
  toolsEl.hidden = false;
  post({ type: "listTools" });
}
$<HTMLButtonElement>("toolsBtn").addEventListener("click", openTools);
$<HTMLButtonElement>("toolsRefresh").addEventListener("click", () => post({ type: "listTools" }));
$<HTMLButtonElement>("toolsClose").addEventListener("click", () => (toolsEl.hidden = true));

// ---- the / palette ------------------------------------------------------------------------------------------------

let slashEntries: SlashEntryView[] | undefined;
let slashAsked = false;
let slashShown: SlashEntryView[] = [];
let slashIndex = 0;

function closeSlash(): void {
  slashMenu.hidden = true;
  slashShown = [];
}

function pickSlash(entry: SlashEntryView): void {
  input.value = "/" + entry.name + " ";
  closeSlash();
  input.focus();
  grow();
}

function paintSlash(): void {
  const value = input.value;
  if (!value.startsWith("/") || /\s/.test(value)) {
    closeSlash();
    return;
  }
  const query = value.slice(1).toLowerCase();
  if (!slashEntries) {
    if (!slashAsked) {
      slashAsked = true;
      post({ type: "listSlash" });
    }
    return;
  }
  // What matches the start of the word first; then Capella's own, the server's commands, the skills.
  const kindOrder = { builtin: 0, command: 1, skill: 2 } as const;
  const rank = (e: SlashEntryView): number => (query !== "" && e.name.toLowerCase().startsWith(query) ? 0 : 3) + kindOrder[e.kind] * 0.1;
  slashShown = slashEntries.filter((e) => e.name.toLowerCase().includes(query)).sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 40);
  slashIndex = Math.min(slashIndex, Math.max(0, slashShown.length - 1));
  slashMenu.replaceChildren();
  slashMenu.hidden = slashShown.length === 0;
  slashShown.forEach((entry, i) => {
    const row = el("button", `slash-row${i === slashIndex ? " on" : ""}`);
    row.type = "button";
    row.setAttribute("role", "option");
    row.append(el("span", "slash-name", "/" + entry.name), el("span", `slash-kind ${entry.kind}`, entry.kind), el("span", "slash-desc faint", entry.description ?? ""));
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSlash(entry);
    });
    slashMenu.append(row);
  });
  slashMenu.querySelector(".on")?.scrollIntoView({ block: "nearest" });
}

// ---- the task list the agent keeps ---------------------------------------------------------------------------------

const todoCalls = new Set<string>();

function paintTodos(raw: unknown): void {
  const list = typeof raw === "object" && raw !== null ? (raw as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(list)) return;
  const rows = list.flatMap((t): Array<{ text: string; status: string }> => {
    if (typeof t !== "object" || t === null) return [];
    const row = t as { content?: unknown; text?: unknown; status?: unknown };
    const text = typeof row.content === "string" ? row.content : typeof row.text === "string" ? row.text : "";
    return text === "" ? [] : [{ text, status: typeof row.status === "string" ? row.status : "pending" }];
  });
  todosList.replaceChildren();
  todosEl.hidden = rows.length === 0;
  const done = rows.filter((r) => r.status === "completed").length;
  const doing = rows.find((r) => r.status === "in_progress");
  todosSummary.textContent = `Tasks ${done}/${rows.length}${doing ? " · " + doing.text : ""}`;
  for (const row of rows) {
    const glyph = row.status === "completed" ? "\u2611" : row.status === "in_progress" ? "\u25d0" : row.status === "cancelled" ? "\u2612" : "\u2610";
    const li = el("li", `todo ${row.status}`);
    li.append(el("span", "glyph", glyph), el("span", undefined, row.text));
    todosList.append(li);
  }
}

// ---- pictures an answer points to ----------------------------------------------------------------------------------

const imageCache = new Map<string, string | { error: string }>();
const imageAsked = new Set<string>();

function hydrateImages(root: ParentNode): void {
  for (const span of root.querySelectorAll<HTMLElement>("span.answer-img")) {
    const src = span.dataset.src ?? "";
    const known = imageCache.get(src);
    if (typeof known === "string") {
      const img = el("img", "answer-pic");
      img.src = known;
      img.alt = span.title || src;
      span.replaceWith(img);
    } else if (known) {
      span.classList.add("failed");
      span.textContent = `[picture not shown: ${known.error}]`;
    } else if (!imageAsked.has(src)) {
      imageAsked.add(src);
      post({ type: "loadImage", src });
    }
  }
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
      ["Add a folder\u2026", "Let the agent use a folder outside the project, in this chat only", { type: "addFolder" }],
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

function effortMenu(): void {
  const options = models.find((m) => m.ref === model)?.variants ?? [];
  openMenu(effortBtn, (box) => {
    for (const choice of [undefined, ...options]) {
      const item = el("button", `item${choice === effort ? " on" : ""}`);
      item.type = "button";
      item.append(el("span", undefined, choice ?? "Model default"));
      item.addEventListener("click", () => {
        closeMenu();
        post({ type: "setEffort", effort: choice });
      });
      box.append(item);
    }
  });
}
effortBtn.addEventListener("click", effortMenu);

function webMenu(): void {
  const rows: Array<["mode" | "allow" | "deny", string, string]> = [
    ["mode", "Follow the mode", "Plan and Bypass let web search and page fetch through; Review and Accept edits ask first"],
    ["allow", "Always allow", "Search and fetch without asking (asks you to confirm)"],
    ["deny", "Turn off", "The agent gets no web search and no page fetch in this chat"],
  ];
  openMenu(webBtn, (box) => {
    for (const [policy, label, hint] of rows) {
      const item = el("button", `item${policy === web ? " on" : ""}`);
      item.type = "button";
      item.append(el("span", undefined, label), el("small", undefined, hint));
      item.addEventListener("click", () => {
        closeMenu();
        post({ type: "setWeb", policy });
      });
      box.append(item);
    }
  });
}
webBtn.addEventListener("click", webMenu);

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
  if (!slashMenu.hidden && slashShown.length > 0 && !e.isComposing) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashIndex = (slashIndex + (e.key === "ArrowDown" ? 1 : slashShown.length - 1)) % slashShown.length;
      paintSlash();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pickSlash(slashShown[slashIndex]!);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlash();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send(e.ctrlKey || e.metaKey ? "steer" : undefined);
  } else if (e.key === "Tab" && e.shiftKey) {
    e.preventDefault();
    const cycle = modes.filter((m) => !m.dangerous);
    const next = cycle[(cycle.findIndex((m) => m.id === mode) + 1) % cycle.length];
    if (next) post({ type: "setMode", id: next.id });
  }
});
sendBtn.addEventListener("click", () => send());
input.addEventListener("input", paintSlash);
stopBtn.addEventListener("click", () => post({ type: "stop" }));
$<HTMLButtonElement>("newChat").addEventListener("click", () => post({ type: "newChat" }));
modeBtn.addEventListener("click", modeMenu);
modelBtn.addEventListener("click", modelMenu);
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!menu.hidden && !menu.contains(target) && !menuAnchor?.contains(target)) closeMenu();
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
      following = true;
      scrollToEnd();
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
    case "queue":
      canQueue = message.canQueue;
      queueItems = message.items;
      paintQueue();
      setBusy(busy);
      break;
    case "delivered":
      joinMessage(message.text, message.files);
      break;
    case "folders":
      paintFolders(message.items);
      break;
    case "tools":
      paintTools(message.tools);
      break;
    case "toolImages": {
      const step = tools.get(message.callId);
      if (!step) break;
      const strip = el("div", "tool-images");
      for (const uri of message.images) {
        const img = el("img", "answer-pic");
        img.src = uri;
        img.alt = "Screenshot taken by the agent";
        strip.append(img);
      }
      step.append(strip);
      break;
    }
    case "slash":
      slashEntries = message.entries;
      paintSlash();
      break;
    case "image":
      imageAsked.delete(message.src);
      imageCache.set(message.src, message.uri ?? { error: message.error ?? "could not be read" });
      hydrateImages(timeline);
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
      effort = undefined;
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
    case "effort":
      effort = message.effort;
      paintChips();
      break;
    case "web":
      web = message.policy;
      paintChips();
      break;
    case "models":
      models = message.models;
      if (message.model !== undefined) model = message.model;
      paintChips();
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
      effort = undefined;
      web = "mode";
      queueItems = [];
      paintQueue();
      paintFolders([]);
      slashEntries = undefined;
      slashAsked = false;
      closeSlash();
      todoCalls.clear();
      todosEl.hidden = true;
      // what the Tools panel showed belonged to the chat that is gone
      toolsEl.hidden = true;
      toolsBody.replaceChildren();
      todosList.replaceChildren();
      paintChips();
      timeline.replaceChildren();
      blocks.clear();
      tools.clear();
      approvals.clear();
      callInfo.clear();
      approvalDetails.clear();
      questionCards.clear();
      turn = undefined;
      setBusy(false);
      say("");
      break;
  }
});

post({ type: "ready" });
