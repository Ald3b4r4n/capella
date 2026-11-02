import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { ChangeTracker } from "./changes.ts";
import type { OriginalProvider } from "./originalProvider.ts";
import { buildReport } from "../opencode/diagnostics.ts";
import { featureFlags } from "../opencode/compat.ts";
import { describeFree, emptyFreeUsage, recordLimitHit, recordStep, viewFor, type FreeUsageState } from "../opencode/freeUsage.ts";
import { MAX_ATTACHMENTS, decodeBase64, describeSize, fromBytes, fromSelection, loadFile, type Attachment, type Loaded } from "./attachments.ts";
import { describeAge } from "../opencode/history.ts";
import { locateOpencode } from "../opencode/locate.ts";
import { localPreviewUrl } from "./preview.ts";
import { MODES, DEFAULT_MODE, modeById, type ModeId } from "../opencode/modes.ts";
import { OpencodeSession, type SessionEvent } from "../opencode/session.ts";
import { chatHtml } from "./chatHtml.ts";
import type { AttachmentView, FromWebview, ModeRow, ModelRow, ToWebview } from "./protocol.ts";
import type { UpdateMonitor } from "./updateMonitor.ts";
import { VoiceBridge } from "./voiceBridge.ts";
import type { UsageTracker } from "./usageTracker.ts";

const FREE_KEY = "capella.freeUsage";

/** How often usage is re-read while a chat is open. The tracker itself never asks more than once a minute. */
const USAGE_POLL_MS = 5 * 60_000;

const TONES: Record<ModeId, ModeRow["tone"]> = { plan: "plan", review: "ask", "accept-edits": "edit", bypass: "danger" };

/** The Capella chat panel: one webview, one opencode server and session at a time. */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly output: vscode.OutputChannel;
  private readonly tracker: UsageTracker;
  private readonly context: vscode.ExtensionContext;
  private readonly updates: UpdateMonitor;
  /** Why the last attempt to start opencode failed, for the diagnostics report. */
  private startError?: string;
  private usageTimer?: NodeJS.Timeout;
  private session?: OpencodeSession;
  private mode: ModeId = DEFAULT_MODE;
  /** `providerID/modelID` the user picked; remembered across new chats. */
  private model?: string;
  private busy = false;
  private readonly voice: VoiceBridge;
  /** Serves the "before" side of diffs; set once when the extension activates. */
  static originals: OriginalProvider | undefined;
  private changes!: ChangeTracker;
  /** Events are folded into the tracker one at a time, in order: reading a file is asynchronous. */
  private changeQueue: Promise<void> = Promise.resolve();
  /** Waiting to go with the next message. Their content lives here; the page only gets names and thumbnails. */
  private attachments: Attachment[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  static get(): ChatPanel | undefined {
    return ChatPanel.current;
  }

  static show(context: vscode.ExtensionContext, output: vscode.OutputChannel, tracker: UsageTracker, updates: UpdateMonitor): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return ChatPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("capella.chat", "Capella", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media"), vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "capella.svg");
    ChatPanel.current = new ChatPanel(panel, context, output, tracker, updates);
    return ChatPanel.current;
  }

  static async disposeCurrent(): Promise<void> {
    await ChatPanel.current?.dispose();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, output: vscode.OutputChannel, tracker: UsageTracker, updates: UpdateMonitor) {
    this.panel = panel;
    this.updates = updates;
    this.output = output;
    this.resetChanges();
    this.voice = new VoiceBridge(context, (m) => this.post(m));
    this.tracker = tracker;
    this.context = context;
    const nonce = randomBytes(16).toString("base64");
    const mediaUri = (file: string): string => {
      const folder = file === "chat.js" ? "dist" : "media";
      return panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, folder, file)).toString();
    };
    panel.webview.html = chatHtml({ cspSource: panel.webview.cspSource, nonce, mediaUri });
    this.disposables.push(
      tracker.onDidChange.event((usage) => this.post({ type: "usage", usage })),
      panel.webview.onDidReceiveMessage((message: FromWebview) => void this.onMessage(message)),
      panel.onDidDispose(() => {
        ChatPanel.current = undefined;
        void this.dispose();
      }),
    );
  }

  /** The running session, if the chat has started one. Used by commands that need the live opencode. */
  activeSession(): OpencodeSession | undefined {
    return this.session;
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private notice(text: string, error = false): void {
    this.post({ type: "notice", text, error });
  }

  private modeRows(): ModeRow[] {
    return MODES.map((m) => ({ id: m.id, label: m.label, description: m.description, dangerous: m.dangerous, tone: TONES[m.id] }));
  }

  private modelRows(session: OpencodeSession): ModelRow[] {
    const order = { zen: 0, go: 1, other: 2 } as const;
    return session.models
      .map((m) => ({ ref: `${m.providerId}/${m.modelId}`, label: m.label, family: m.family, free: m.free, images: m.images }))
      .sort((a, b) => order[a.family] - order[b.family] || a.label.localeCompare(b.label));
  }

  /** Starts the opencode server for this chat if it is not running yet. Makes no model call. */
  private async ensureSession(): Promise<OpencodeSession | undefined> {
    if (this.session) return this.session;
    const binary = locateOpencode(vscode.workspace.getConfiguration("capella").get<string>("opencodePath"));
    if (!binary) {
      this.startError = "the opencode executable was not found";
      this.notice("opencode was not found. Install it, or set capella.opencodePath in Settings.", true);
      return undefined;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      this.notice("Open a folder first: opencode works inside a project folder.", true);
      return undefined;
    }
    const session = new OpencodeSession({ binary, workspaceRoot: folder, mode: this.mode, model: this.model });
    session.on("event", (event: SessionEvent) => {
      if (event.type === "turn-started") this.busy = true;
      if (event.type === "turn-ended" || event.type === "server-exit") this.busy = false;
      this.post({ type: "event", event });
      this.countFreeUsage(event, session);
      if (event.type !== "resync" && event.type !== "server-exit") this.trackChanges(event);
      // A finished turn is the moment the numbers moved; the tracker rate-limits the actual request.
      if (event.type === "turn-ended") void this.tracker.refresh(session);
    });
    session.on("stderr", (line: string) => this.output.appendLine(line));
    this.session = session;
    try {
      await session.start();
      if (!this.model) {
        // Show the model the chat will really use (the user's own opencode default) before the first message.
        const resolved = await session.resolveModel().catch(() => undefined);
        if (resolved) this.model = `${resolved.providerId}/${resolved.modelId}`;
      }
    } catch (error) {
      this.session = undefined;
      await session.dispose();
      this.startError = error instanceof Error ? error.message : String(error);
      this.notice(`Could not start opencode: ${this.startError}`, true);
      return undefined;
    }
    this.startError = undefined;
    this.output.appendLine(`opencode ${session.version ?? "?"} ready in ${folder}; compatibility: ${session.compat?.status ?? "unchecked"}`);
    const compat = session.compat;
    if (compat && (compat.status === "broken" || compat.status === "unsupported")) this.notice(compat.summary + " See \"Capella: Compatibility diagnostics\".", true);
    else if (compat && compat.status === "degraded") this.notice(compat.summary);
    void this.updates.check(session.version);
    void this.tracker.refresh(session, true);
    clearInterval(this.usageTimer);
    this.usageTimer = setInterval(() => void this.tracker.refresh(session), USAGE_POLL_MS);
    return session;
  }

  private isFree(session: OpencodeSession): boolean {
    return !!this.model && session.models.some((m) => `${m.providerId}/${m.modelId}` === this.model && m.free);
  }

  private freeState(): FreeUsageState {
    return this.context.globalState.get<FreeUsageState>(FREE_KEY) ?? emptyFreeUsage();
  }

  /**
   * Free models have no allowance endpoint, so Capella counts what it sees and notes when a cap stopped a turn. The
   * note is always worded as Capella's own count: the provider's real remaining quota is not available to it.
   */
  private countFreeUsage(event: SessionEvent, session: OpencodeSession): void {
    if (!this.model || !this.isFree(session)) return;
    const now = Date.now();
    if (event.type === "step-ended" && event.tokens) {
      const total = event.tokens.input + event.tokens.output + event.tokens.reasoning;
      void this.context.globalState.update(FREE_KEY, recordStep(this.freeState(), this.model, total, now));
      this.postModelNote(session);
    } else if (event.type === "turn-ended" && event.error?.rateLimited) {
      void this.context.globalState.update(FREE_KEY, recordLimitHit(this.freeState(), this.model, now, event.error.retryAfterMs));
      this.notice(describeFree(viewFor(this.freeState(), this.model, now), now), true);
      this.postModelNote(session);
    }
  }

  private postModelNote(session: OpencodeSession): void {
    if (!this.model || !this.isFree(session)) {
      this.post({ type: "modelNote", text: "" });
      return;
    }
    const now = Date.now();
    this.post({ type: "modelNote", text: describeFree(viewFor(this.freeState(), this.model, now), now) });
  }

  private resetChanges(): void {
    this.changes = new ChangeTracker((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
    ChatPanel.originals?.clear();
    this.changeQueue = Promise.resolve();
  }

  private trackChanges(event: Parameters<ChangeTracker["handle"]>[0]): void {
    const tracker = this.changes;
    const at = Date.now();
    this.changeQueue = this.changeQueue
      .then(async () => {
        const change = await tracker.handle(event, at);
        if (!change || tracker !== this.changes) return;
        this.post({ type: "fileChange", change });
        this.post({ type: "changes", rows: await tracker.rows() });
      })
      .catch((error) => this.output.appendLine(`change tracking failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async openChange(id: string, diff: boolean): Promise<void> {
    const original = this.changes.original(id);
    if (!original) return;
    const file = vscode.Uri.file(original.abs);
    if (!diff) {
      await vscode.commands.executeCommand("vscode.open", file);
      return;
    }
    const before = ChatPanel.originals?.put(id, original.rel, original.text);
    if (!before) return;
    await vscode.commands.executeCommand("vscode.diff", before, file, `${original.rel} (before this chat \u2194 now)`);
  }

  private roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  private postAttachments(): void {
    const items: AttachmentView[] = this.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: describeSize(a.bytes), thumb: a.thumb }));
    this.post({ type: "attachments", items });
  }

  /** Adds a checked attachment, or says why not. The model's image support is only a hint, never a block. */
  private accept(loaded: Loaded): void {
    if (!loaded.ok) {
      this.notice(loaded.reason, true);
      return;
    }
    if (this.attachments.length >= MAX_ATTACHMENTS) {
      this.notice(`At most ${MAX_ATTACHMENTS} attachments go with one message.`, true);
      return;
    }
    this.attachments.push(loaded.attachment);
    this.postAttachments();
    const ref = this.model;
    const model = ref && this.session?.models.find((m) => `${m.providerId}/${m.modelId}` === ref);
    if (loaded.attachment.kind === "image" && model && model.images === false) this.notice(`${model.label} does not list image input in opencode's catalog, so it may ignore this image. Pick a vision model if it matters.`);
  }

  private async pickFiles(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach", defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri, filters: { "Text files and images": ["*"] } });
    for (const uri of picked ?? []) this.accept(await loadFile(uri.fsPath, this.roots()));
  }

  private async addCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.notice("No file is open in the editor.", true);
      return;
    }
    const doc = editor.document;
    if (doc.uri.scheme === "file" && !doc.isDirty) {
      this.accept(await loadFile(doc.uri.fsPath, this.roots()));
      return;
    }
    // Unsaved edits are not on disk: send the text as it is in the editor, and say so.
    this.accept(fromBytes(doc.fileName.split(/[\\/]/).pop() ?? "untitled", Buffer.from(doc.getText(), "utf8")));
    if (doc.isDirty) this.notice("This file has unsaved changes; the attachment holds the text as it is in the editor, not the saved file.");
  }

  private addSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.notice("Select some text in an editor first.", true);
      return;
    }
    const { start, end } = editor.selection;
    this.accept(fromSelection(editor.document.fileName, start.line + 1, end.line + 1, editor.document.getText(editor.selection)));
  }

  private async openSession(id: string, fork: boolean): Promise<void> {
    if (this.busy) {
      this.notice("Wait for the current turn to finish before opening another chat.", true);
      return;
    }
    const session = await this.ensureSession();
    if (!session) return;
    const openId = fork ? await session.fork(id) : id;
    const items = await session.resume(openId);
    const current = session.currentModel;
    if (current) this.model = `${current.providerId}/${current.modelId}`;
    this.resetChanges();
    this.post({ type: "reset" });
    this.post({ type: "changes", rows: [] });
    if (this.model) this.post({ type: "model", ref: this.model });
    this.post({ type: "mode", id: this.mode });
    this.post({ type: "replay", items });
    this.postModelNote(session);
    this.notice(fork ? "Continuing from a copy of that chat; the original is untouched." : `Reopened in ${modeById(this.mode).label} mode: the permissions of the stored chat were replaced by this mode's.`);
  }

  /** Starts opencode if needed and opens the compatibility report in an editor tab. */
  async showDiagnostics(): Promise<void> {
    const session = await this.ensureSession();
    const setting = vscode.workspace.getConfiguration("capella").get<string>("opencodePath");
    const binary = locateOpencode(setting);
    const report = buildReport({
      capellaVersion: (this.context.extension.packageJSON as { version?: string }).version ?? "?",
      editor: { name: vscode.env.appName, version: vscode.version },
      platform: process.platform,
      startError: session ? undefined : this.startError,
      opencode: session || binary ? { version: session?.version, executable: binary, foundBy: setting && setting.trim() !== "" ? "setting" : "search" } : undefined,
      compat: session?.compat,
      unknownEvents: session?.unknownEvents ?? new Map(),
      updates: this.updates.snapshot,
      now: Date.now(),
    });
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: report });
    await vscode.window.showTextDocument(doc, { preview: false });
    void vscode.window.showInformationMessage("Capella: the report has no keys, paths or chat content, so it is safe to paste into a bug report.", "Copy report").then((choice) => {
      if (choice === "Copy report") void vscode.env.clipboard.writeText(report);
    });
  }

  private async openPreview(url: string): Promise<void> {
    const local = localPreviewUrl(url);
    if (!local) {
      this.notice("Capella only previews pages served from this machine (localhost).", true);
      return;
    }
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", local);
    } catch {
      await vscode.env.openExternal(vscode.Uri.parse(local));
    }
  }

  private async sendInit(): Promise<void> {
    const session = await this.ensureSession();
    if (!session) return;
    this.post({ type: "init", version: session.version, workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "", modes: this.modeRows(), mode: this.mode, models: this.modelRows(session), model: this.model, features: { history: featureFlags(session.compat).history } });
    this.post({ type: "usage", usage: this.tracker.view() });
    this.postModelNote(session);
  }

  private async onMessage(message: FromWebview): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.sendInit();
          break;
        case "send": {
          if (this.busy) return;
          const session = await this.ensureSession();
          if (!session) return;
          const sending = this.attachments;
          this.attachments = [];
          this.postAttachments();
          this.post({ type: "user", text: message.text, files: sending.map((a) => ({ name: a.name, mime: a.mime, thumb: a.thumb })) });
          this.busy = true;
          this.post({ type: "busy", value: true });
          try {
            await session.send(message.text.trim() === "" && sending.length > 0 ? "Please look at the attached file(s)." : message.text, sending);
          } catch (error) {
            this.busy = false;
            this.post({ type: "busy", value: false });
            this.notice(error instanceof Error ? error.message : String(error), true);
          }
          break;
        }
        case "stop":
          await this.session?.interrupt();
          break;
        case "newChat":
          await this.newChat();
          break;
        case "setMode":
          await this.setMode(message.id);
          break;
        case "setModel":
          if (this.busy) {
            this.notice("Wait for the current turn to finish before changing the model.", true);
            break;
          }
          await this.session?.setModel(message.ref);
          this.model = message.ref;
          this.post({ type: "model", ref: message.ref });
          if (this.session) this.postModelNote(this.session);
          break;
        case "decide":
          await this.session?.answerApproval(message.requestId, message.decision, message.message);
          break;
        case "copy":
          await vscode.env.clipboard.writeText(message.text);
          break;
        case "openLink":
          await this.openLink(message.url);
          break;
        case "pickFiles":
          await this.pickFiles();
          break;
        case "addCurrentFile":
          await this.addCurrentFile();
          break;
        case "addSelection":
          this.addSelection();
          break;
        case "addData": {
          // A pasted or dropped image, or a dropped text file, arriving from the page as base64.
          const name = message.name.split(/[\\/]/).pop()?.slice(0, 80) || "pasted";
          this.accept(fromBytes(name, decodeBase64(message.base64)));
          break;
        }
        case "dropUris": {
          for (const text of message.uris.slice(0, MAX_ATTACHMENTS)) {
            let uri: vscode.Uri;
            try {
              uri = vscode.Uri.parse(text);
            } catch {
              continue;
            }
            if (uri.scheme === "file") this.accept(await loadFile(uri.fsPath, this.roots()));
          }
          break;
        }
        case "voice":
          await this.voice.handle(message.action);
          break;
        case "listChanges":
          this.post({ type: "changes", rows: await this.changes.rows() });
          break;
        case "openDiff":
          await this.openChange(message.id, true);
          break;
        case "openFile":
          await this.openChange(message.id, false);
          break;
        case "removeAttachment":
          this.attachments = this.attachments.filter((a) => a.id !== message.id);
          this.postAttachments();
          break;
        case "listSessions": {
          const session = await this.ensureSession();
          if (!session) break;
          const rows = await session.listSessions(message.search);
          this.post({ type: "sessions", rows: rows.map((r) => ({ id: r.id, title: r.title, age: describeAge(r.updatedMs), forked: r.forked, costUsd: r.costUsd })) });
          break;
        }
        case "openSession":
          await this.openSession(message.id, message.fork);
          break;
        case "openPreview":
          await this.openPreview(message.url);
          break;
        case "openUsage": {
          // The address comes from the opencode server's own answer and was checked as https when it was read.
          const url = this.tracker.current?.workspace?.usageURL;
          if (url) await this.openLink(url);
          break;
        }
      }
    } catch (error) {
      this.notice(error instanceof Error ? error.message : String(error), true);
    }
  }

  private async setMode(id: string): Promise<void> {
    if (this.busy) {
      this.notice("Wait for the current turn to finish before changing the mode.", true);
      return;
    }
    const mode = modeById(id);
    if (mode.dangerous) {
      const choice = await vscode.window.showWarningMessage(
        `Switch to “${mode.label}”?`,
        { modal: true, detail: `${mode.description}\n\nCapella will not ask before editing files or running commands, except where opencode itself does.` },
        "Switch",
      );
      if (choice !== "Switch") return;
    }
    await this.session?.setMode(mode.id);
    this.mode = mode.id;
    this.post({ type: "mode", id: mode.id });
  }

  private async newChat(): Promise<void> {
    const old = this.session;
    this.session = undefined;
    this.busy = false;
    await old?.dispose();
    this.attachments = [];
    this.resetChanges();
    this.post({ type: "reset" });
    await this.sendInit();
  }

  private async openLink(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
    const choice = await vscode.window.showInformationMessage(`Open ${parsed.origin} in your browser?`, { modal: true, detail: url }, "Open");
    if (choice === "Open") await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async dispose(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    clearInterval(this.usageTimer);
    this.voice.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    await session?.dispose();
  }
}
