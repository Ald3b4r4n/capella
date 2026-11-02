import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, parse } from "node:path";
import { appendFileSync } from "node:fs";
import * as vscode from "vscode";
import { ChangeTracker } from "./changes.ts";
import type { OriginalProvider } from "./originalProvider.ts";
import { buildReport } from "../opencode/diagnostics.ts";
import { featureFlags } from "../opencode/compat.ts";
import { describeFree, emptyFreeUsage, recordLimitHit, recordStep, viewFor, type FreeUsageState } from "../opencode/freeUsage.ts";
import { MAX_ATTACHMENTS, insideRoots, loadAnswerImage, decodeBase64, describeSize, fromBytes, fromSelection, loadFile, type Attachment, type Loaded } from "./attachments.ts";
import { describeAge } from "../opencode/history.ts";
import { locateOpencode } from "../opencode/locate.ts";
import { localPreviewUrl } from "./preview.ts";
import { extractLocalUrls, isPreviewableUrl, startPreviewServer, type PreviewServer } from "./staticServer.ts";
import { MODES, DEFAULT_MODE, modeById, type ModeId } from "../opencode/modes.ts";
import { OpencodeSession, type SessionEvent } from "../opencode/session.ts";
import { chatHtml } from "./chatHtml.ts";
import type { AccountView, AttachmentView, FromWebview, McpRowView, ModeRow, ModelRow, QueueItemView, SlashEntryView, ToolsView, ToWebview } from "./protocol.ts";
import type { AccountInfo, McpConfig } from "../opencode/backend.ts";
import { parseCommandLine, validMcpName, validMcpUrl, describeMcp } from "./mcpInput.ts";
import type { Delivery, SlashEntry } from "../opencode/backend.ts";
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
  /** Local addresses a tool printed (a dev server's banner), newest last, so Preview can offer them. */
  private localUrls: string[] = [];
  private previewServer: PreviewServer | undefined;
  private previewConfirmed = false;
  private readonly voice: VoiceBridge;
  /** Serves the "before" side of diffs; set once when the extension activates. */
  static originals: OriginalProvider | undefined;
  private changes!: ChangeTracker;
  /** Events are folded into the tracker one at a time, in order: reading a file is asynchronous. */
  private changeQueue: Promise<void> = Promise.resolve();
  /** Waiting to go with the next message. Their content lives here; the page only gets names and thumbnails. */
  private attachments: Attachment[] = [];
  /** Messages sent while the agent worked, keyed by the id the server gave them, until their turn comes. */
  private queue: Array<{ id: string; text: string; files: Attachment[]; delivery: Delivery }> = [];
  /** Ids delivered while their `send` call had not returned yet. */
  private deliveredEarly = new Set<string>();
  private queueSending = 0;
  /** Folders outside the project that this chat may use (the agent asks about every other one). */
  private extraFolders: string[] = [];
  private slashCache?: { at: number; entries: SlashEntry[] };
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
      .map((m) => ({ ref: `${m.providerId}/${m.modelId}`, label: m.label, family: m.family, free: m.free, images: m.images, variants: m.variants }))
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
      if (event.type === "catalog") return this.onCatalog(event, session);
      if (event.type === "inbox-delivered") {
        this.onDelivered(event.inboxId);
        return;
      }
      if (event.type === "turn-ended") void this.reconcileQueue(session);
      this.post({ type: "event", event });
      this.countFreeUsage(event, session);
      if (event.type !== "resync" && event.type !== "server-exit") this.trackChanges(event);
      if (event.type === "tool-result") for (const url of extractLocalUrls(event.text)) if (!this.localUrls.includes(url)) this.localUrls.push(url);
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
    void this.registerStoredMcp(session);
    void this.updates.check(session.version);
    void this.tracker.refresh(session, true);
    clearInterval(this.usageTimer);
    this.usageTimer = setInterval(() => void this.tracker.refresh(session), USAGE_POLL_MS);
    return session;
  }

  /** MCP servers added through Capella, kept in this project's own storage (never in a settings file a repository could carry). */
  private storedMcp(): Array<{ name: string; config: McpConfig }> {
    return this.context.workspaceState.get<Array<{ name: string; config: McpConfig }>>("capella.mcp", []).filter((s) => validMcpName(s.name));
  }

  /** opencode forgets servers added at runtime when it restarts: the ones the user added are registered again for each chat. */
  private async registerStoredMcp(session: OpencodeSession): Promise<void> {
    const stored = this.storedMcp();
    if (stored.length === 0) return;
    const have = new Set((await session.mcpList().catch(() => [])).map((s) => s.name));
    for (const server of stored) {
      if (have.has(server.name)) continue;
      await session.mcpAdd(server.name, server.config).catch((error) => this.output.appendLine(`MCP ${server.name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private async toolsView(session: OpencodeSession): Promise<ToolsView> {
    const stored = new Map(this.storedMcp().map((s) => [s.name, s.config]));
    const [servers, skills, plugins] = await Promise.all([session.mcpList().catch(() => []), session.skills(), session.plugins()]);
    const mcp: McpRowView[] = servers.map((s) => ({ name: s.name, status: s.status, detail: s.detail, managed: stored.has(s.name), summary: stored.has(s.name) ? describeMcp(stored.get(s.name)!) : undefined }));
    const openable = await Promise.all(skills.map(async (s) => !!s.path && isAbsolute(s.path) && (await stat(s.path).then((i) => i.isFile()).catch(() => false))));
    const accounts = (await session.accounts().catch(() => [] as AccountInfo[])).map((a): AccountView => ({ id: a.id, name: a.name, featured: a.id === "opencode" || a.id === "opencode-go", canKey: a.key, oauth: a.oauth.map((o) => ({ id: o.id, label: o.label })), connections: a.connections }));
    return { accounts, canOauth: session.generation === "v2", mcp, skills: skills.map((s, i) => ({ name: s.name, description: s.description, openable: openable[i]! })), plugins: plugins.map((p) => ({ source: p.source, state: p.state })), removeForgets: session.generation === "v2" };
  }

  private async postTools(): Promise<void> {
    const session = await this.ensureSession();
    if (session) this.post({ type: "tools", tools: await this.toolsView(session) });
  }

  /**
   * "Add MCP server": starting a program or reaching a server is a grant like no other, so the user types the name and the
   * command or address, sees exactly what will run, and has to confirm. It is kept for this project (registered again in
   * each chat) and removable.
   */
  private async addMcp(): Promise<void> {
    if (this.busy) {
      this.notice("Wait for the current turn to finish before adding a server.", true);
      return;
    }
    const session = await this.ensureSession();
    if (!session) return;
    const existing = new Set((await session.mcpList().catch(() => [])).map((s) => s.name));
    let name: string | undefined;
    let config: McpConfig | undefined;
    {
      const kind = await vscode.window.showQuickPick(
        [
          { label: "A program on this computer", description: "local", detail: "Capella starts it (for example: npx -y some-mcp-server) and talks to it over standard input and output.", remote: false },
          { label: "A server on the web", description: "remote", detail: "Capella connects to its address. What the agent sends to its tools goes to that server.", remote: true },
        ],
        { title: "Add an MCP server", placeHolder: "What kind of server is it?" },
      );
      if (!kind) return;
      name = await vscode.window.showInputBox({ title: "Name of the server", prompt: "Letters, digits, - and _ (the agent sees its tools as name_tool)", validateInput: (v) => (!validMcpName(v) ? "Use 1 to 40 letters, digits, - or _." : existing.has(v) ? "There is a server with this name already." : undefined) });
      if (!name) return;
      if (kind.remote) {
        const url = await vscode.window.showInputBox({ title: "Address of the server", prompt: "https://… (http is accepted only for this computer)", validateInput: (v) => (validMcpUrl(v) ? undefined : "Use an https:// address, or http://localhost / 127.0.0.1.") });
        if (!url) return;
        config = { type: "remote", url: url.trim() };
      } else {
        const line = await vscode.window.showInputBox({ title: "Command that starts the server", prompt: "The program and its arguments, as you would type them. No shell is used.", placeHolder: "npx -y @modelcontextprotocol/server-everything", validateInput: (v) => (parseCommandLine(v).length === 0 ? "Type the command." : undefined) });
        if (!line) return;
        config = { type: "local", command: parseCommandLine(line) };
      }
      const go = "Add server";
      const choice = await vscode.window.showWarningMessage(`Add the MCP server "${name}"?`, {
        modal: true,
        detail: `${describeMcp(config, true)}\n\n${config.type === "local" ? "This program runs on your computer with your user's permissions, now and every time a chat opens in this project." : "The agent will send what it passes to this server's tools to that address."}\nIts tools are asked about before they run (except in Bypass mode). Remove it at any time in Tools.`,
      }, go);
      if (choice !== go) return;
    }
    if (!name || !config || !validMcpName(name) || existing.has(name)) {
      this.notice("That server could not be added: the name is invalid or already used.", true);
      return;
    }
    if (config.type === "remote" && !validMcpUrl(config.url)) {
      this.notice("That address is not accepted: use https://, or http:// for this computer.", true);
      return;
    }
    try {
      await session.mcpAdd(name, config);
    } catch (error) {
      this.notice(`Could not add the server: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    await this.context.workspaceState.update("capella.mcp", [...this.storedMcp().filter((s) => s.name !== name), { name, config }]);
    this.notice(`MCP server ${name} added. It may take a few seconds to connect.`);
    setTimeout(() => void this.postTools(), 2500);
    await this.postTools();
  }

  /** An error text with the secret that was being sent taken out of it, in case a server repeats what it was given. */
  private scrub(text: string, secret?: string): string {
    return secret && secret.length >= 4 ? text.split(secret).join("***") : text;
  }

  /**
   * Connecting a provider. The key is typed into the editor's own masked box and goes straight to the local opencode, which
   * stores it: it never reaches the page, a log or a message of Capella's, and it is taken out of an error text. A browser
   * sign-in is run by opencode (Capella opens the address it gives and waits); Capella never sees the token.
   */
  private async connectAccount(integrationId: string, method: string): Promise<void> {
    const session = await this.ensureSession();
    if (!session) return;
    const account = (await session.accounts()).find((a) => a.id === integrationId);
    if (!account) {
      this.notice("That provider is not offered by this opencode.", true);
      return;
    }
    if (method === "key") {
      if (!account.key) {
        this.notice(`${account.name} cannot be connected with a key.`, true);
        return;
      }
      const key = await vscode.window.showInputBox({ title: `Connect ${account.name}`, prompt: `Paste the API key for ${account.name}. It is stored by opencode, not by Capella.`, password: true, ignoreFocusOut: true, validateInput: (v) => (v.trim() === "" ? "Paste the key." : /\s/.test(v.trim()) ? "A key has no spaces or line breaks." : undefined) });
      if (!key) return;
      const secret = key.trim();
      try {
        await session.connectKey(account.id, secret, "Capella");
      } catch (error) {
        this.notice(`Could not connect ${account.name}: ${this.scrub(error instanceof Error ? error.message : String(error), secret)}`, true);
        return;
      }
      this.notice(`${account.name} is connected.`);
      await this.afterAccountChange(session);
      return;
    }
    const oauth = account.oauth.find((o) => o.id === method);
    if (!oauth) {
      this.notice("That sign-in is not offered.", true);
      return;
    }
    const answers: Record<string, string> = {};
    for (const field of oauth.form) {
      if (field.hidden) {
        if (field.default !== undefined) answers[field.key] = field.default;
        continue;
      }
      let value: string | undefined;
      if (field.options) {
        const picked = await vscode.window.showQuickPick(field.options.map((o) => ({ label: o.label, value: o.value })), { title: field.title, placeHolder: field.title });
        value = picked?.value;
      } else {
        value = await vscode.window.showInputBox({ title: field.title, prompt: field.title, value: field.default, ignoreFocusOut: true });
      }
      if (value === undefined || (field.required && value === "")) return;
      answers[field.key] = value;
    }
    let attempt;
    try {
      attempt = await session.oauthStart(account.id, oauth.id, answers);
    } catch (error) {
      this.notice(`Could not start the sign-in: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    let target: URL;
    try {
      target = new URL(attempt.url);
    } catch {
      await session.oauthCancel(account.id, attempt.attemptId);
      this.notice("opencode gave an address that is not valid; the sign-in was cancelled.", true);
      return;
    }
    if (target.protocol !== "https:") {
      await session.oauthCancel(account.id, attempt.attemptId);
      this.notice("The sign-in address is not https; it was not opened.", true);
      return;
    }
    const open = "Open in browser";
    const choice = await vscode.window.showInformationMessage(`Sign in to ${account.name}`, { modal: true, detail: `${attempt.instructions}\n\nCapella will open ${target.origin} in your browser. Sign in there; opencode receives the result, Capella never sees it.` }, open);
    if (choice !== open) {
      await session.oauthCancel(account.id, attempt.attemptId);
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(target.toString()));
    if (attempt.mode === "code") {
      const code = await vscode.window.showInputBox({ title: `Sign in to ${account.name}`, prompt: "Paste the code the page shows", password: true, ignoreFocusOut: true });
      if (!code) {
        await session.oauthCancel(account.id, attempt.attemptId);
        return;
      }
      try {
        await session.oauthComplete(account.id, attempt.attemptId, code.trim());
      } catch (error) {
        this.notice(`Could not finish the sign-in: ${this.scrub(error instanceof Error ? error.message : String(error), code.trim())}`, true);
        return;
      }
      this.notice(`${account.name} is connected.`);
      await this.afterAccountChange(session);
      return;
    }
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Waiting for the sign-in to ${account.name}… ${attempt.instructions}`, cancellable: true }, async (_progress, token) => {
      const until = Math.min(attempt.expiresAt ?? Date.now() + 10 * 60_000, Date.now() + 10 * 60_000);
      while (Date.now() < until && !token.isCancellationRequested) {
        await new Promise((r) => setTimeout(r, 2000));
        const status = await session.oauthStatus(account.id, attempt.attemptId).catch(() => ({ status: "unknown" as const }));
        if (status.status === "complete") return "complete";
        if (status.status === "failed" || status.status === "expired") return status.status;
      }
      return token.isCancellationRequested ? "cancelled" : "expired";
    });
    if (outcome === "complete") {
      this.notice(`${account.name} is connected.`);
      await this.afterAccountChange(session);
    } else {
      await session.oauthCancel(account.id, attempt.attemptId);
      this.notice(outcome === "cancelled" ? "Sign-in cancelled." : `The sign-in did not complete (${outcome}).`, outcome !== "cancelled");
    }
  }

  private async disconnectAccount(integrationId: string, connectionId?: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const account = (await session.accounts()).find((a) => a.id === integrationId);
    const connection = account?.connections.find((c) => c.id === connectionId);
    if (!account || !connection || connection.kind !== "credential") {
      this.notice("That connection can not be removed from here (an environment variable has to be unset where it is set).", true);
      return;
    }
    const go = "Sign out";
    const choice = await vscode.window.showWarningMessage(`Sign out of ${account.name}?`, { modal: true, detail: `opencode will forget the stored credential "${connection.label}". Chats that use ${account.name} models stop working until it is connected again.` }, go);
    if (choice !== go) return;
    try {
      await session.disconnect(account.id, connection.id);
    } catch (error) {
      this.notice(`Could not sign out: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    this.notice(`Signed out of ${account.name}.`);
    await this.afterAccountChange(session);
  }

  /** The model list and the usage meter change with an account: read them again. */
  private async afterAccountChange(session: OpencodeSession): Promise<void> {
    await this.postTools();
    void session.refreshModels().catch(() => undefined);
    void this.tracker.refresh(session, true);
  }

  private async openSkill(name: string): Promise<void> {
    const session = this.session;
    if (!session) return;
    const skill = (await session.skills()).find((s) => s.name === name);
    if (!skill?.path || !isAbsolute(skill.path) || !(await stat(skill.path).then((i) => i.isFile()).catch(() => false))) {
      this.notice("This skill has no file on disk to open.", true);
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(skill.path), { preview: true });
  }

  private postFolders(): void {
    this.post({ type: "folders", items: this.extraFolders.map((path) => ({ path, name: basename(path) || path })) });
  }

  /**
   * "Add folder": lets the agent use one more folder in this chat without asking about it each time. It is a grant of
   * access, so it is asked for and explained, the folder is the real one (links resolved), and a whole drive or the home
   * folder is refused. It lasts for this chat only. (A development host's test can name the folder through
   * CAPELLA_DEV_ADD_FOLDER instead of the system's folder picker, which a script cannot drive; the question is asked all the same.)
   */
  private async addFolder(): Promise<void> {
    const workspace = vscode.workspace.workspaceFolders ?? [];
    const root = workspace[0]?.uri.fsPath;
    if (!root) {
      this.notice("Open a folder first: opencode works inside a project folder.", true);
      return;
    }
    if (this.busy) {
      this.notice("Wait for the current turn to finish before adding a folder.", true);
      return;
    }
    const session = await this.ensureSession();
    if (!session) return;
    const dev = this.context.extensionMode === vscode.ExtensionMode.Development ? process.env.CAPELLA_DEV_ADD_FOLDER : undefined;
    const picked = dev
      ? vscode.Uri.file(dev)
      : (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, defaultUri: vscode.Uri.file(dirname(root)), openLabel: "Add folder", title: "Add a folder to this chat" }))?.[0];
    if (!picked) return;
    let real: string;
    try {
      real = await realpath(picked.fsPath);
    } catch {
      this.notice(`${picked.fsPath} could not be found.`, true);
      return;
    }
    const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
    if (parse(real).root === real || fold(real) === fold(homedir()) || fold(dirname(homedir())) === fold(real)) {
      this.notice(`${real} is too broad to give to the agent. Pick the folder of the project or library itself.`, true);
      return;
    }
    if (await insideRoots(real, workspace.map((f) => f.uri.fsPath))) {
      this.notice(`${real} is already part of the open project.`);
      return;
    }
    if (this.extraFolders.some((f) => fold(f) === fold(real))) {
      this.notice(`${real} is already added to this chat.`);
      return;
    }
    {
      const go = "Add folder";
      const mode = modeById(this.mode);
      const choice = await vscode.window.showWarningMessage(`Let the agent use ${real}?`, {
        modal: true,
        detail: `In this chat the agent will be able to read and list this folder without asking each time${mode.id === "plan" ? "" : " and, where the current mode lets it edit, change files in it"}. Edits and shell commands still follow the mode (${mode.label}).\n\nIt applies to this chat only. Remove it at any time with the x on its chip; \`New chat\` starts without it.`,
      }, go);
      if (choice !== go) return;
    }
    try {
      await session.setFolders([...this.extraFolders, real]);
    } catch (error) {
      this.notice(`Could not add the folder: ${error instanceof Error ? error.message : String(error)}`, true);
      return;
    }
    this.extraFolders = [...session.folders];
    this.postFolders();
    this.notice(`${basename(real)} was added to this chat.`);
  }

  private async removeFolder(path: string): Promise<void> {
    if (!this.extraFolders.includes(path) || !this.session) return;
    if (this.busy) {
      this.notice("Wait for the current turn to finish before removing a folder.", true);
      return;
    }
    await this.session.setFolders(this.extraFolders.filter((f) => f !== path));
    this.extraFolders = [...this.session.folders];
    this.postFolders();
  }

  private postQueue(): void {
    const items: QueueItemView[] = this.queue.map((q) => ({ id: q.id, text: q.text, files: q.files.map((f) => f.name), delivery: q.delivery }));
    this.post({ type: "queue", items, canQueue: this.session?.canQueue ?? false });
  }

  private viewOfFiles(files: readonly Attachment[]): Array<{ name: string; mime: string; thumb?: string }> {
    return files.map((a) => ({ name: a.name, mime: a.mime, thumb: a.thumb }));
  }

  /** A queued message was taken into the turn: it leaves the tray and joins the conversation. */
  private onDelivered(inboxId: string): void {
    const at = this.queue.findIndex((q) => q.id === inboxId);
    if (at < 0) {
      if (this.queueSending > 0) this.deliveredEarly.add(inboxId);
      return;
    }
    const [item] = this.queue.splice(at, 1);
    if (!item) return;
    this.post({ type: "delivered", text: item.text, files: this.viewOfFiles(item.files) });
    this.postQueue();
  }

  /** After a turn: whatever the server no longer holds is dropped from the tray. */
  private async reconcileQueue(session: OpencodeSession): Promise<void> {
    if (this.queue.length === 0) return;
    const held = await session.queued().catch(() => undefined);
    if (!held) return;
    const before = this.queue.length;
    this.queue = this.queue.filter((q) => held.includes(q.id));
    if (this.queue.length !== before) this.postQueue();
  }

  private async queueMessage(session: OpencodeSession, text: string, delivery: Delivery): Promise<void> {
    if (!session.canQueue) {
      this.notice("This opencode (1.x) cannot take a message while it works. Wait for the turn to finish.", true);
      return;
    }
    const sending = this.attachments;
    this.attachments = [];
    this.postAttachments();
    const shown = text.trim() === "" && sending.length > 0 ? "Please look at the attached file(s)." : text;
    this.queueSending++;
    try {
      const id = await session.send(shown, sending, { delivery });
      if (!id) {
        // The server did not name the message, so it cannot be tracked: show it as sent.
        this.post({ type: "delivered", text: shown, files: this.viewOfFiles(sending) });
        return;
      }
      if (this.deliveredEarly.delete(id)) {
        this.post({ type: "delivered", text: shown, files: this.viewOfFiles(sending) });
        return;
      }
      this.queue.push({ id, text: shown, files: sending, delivery });
      this.postQueue();
    } catch (error) {
      this.attachments = sending;
      this.postAttachments();
      this.notice(`Could not queue the message: ${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      if (--this.queueSending === 0) this.deliveredEarly.clear();
    }
  }

  private async slashEntries(session: OpencodeSession): Promise<SlashEntry[]> {
    if (this.slashCache && Date.now() - this.slashCache.at < 60_000) return this.slashCache.entries;
    const entries = await session.slash();
    this.slashCache = { at: Date.now(), entries };
    return entries;
  }

  /**
   * `/name args` is a command when the name is one of Capella's own, or one the server lists as a command or skill; any
   * other text starting with a slash (a path, say) is an ordinary message.
   */
  private async resolveSlash(session: OpencodeSession, text: string): Promise<{ builtin: "new" | "compact" } | { entry: SlashEntry; args: string } | undefined> {
    const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
    if (!match) return undefined;
    const name = match[1]!.toLowerCase();
    if (name === "new" || name === "compact") return { builtin: name };
    const entry = (await this.slashEntries(session)).find((e) => e.name.toLowerCase() === name);
    return entry ? { entry, args: (match[2] ?? "").trim() } : undefined;
  }

  private async runSlash(session: OpencodeSession, text: string, found: NonNullable<Awaited<ReturnType<ChatPanel["resolveSlash"]>>>): Promise<void> {
    if ("builtin" in found) {
      if (found.builtin === "new") await this.newChat();
      else {
        this.notice("Asking opencode to summarise this conversation…");
        await session.compact();
      }
      return;
    }
    const sending = this.attachments;
    this.attachments = [];
    this.postAttachments();
    this.post({ type: "user", text: text.trim(), files: this.viewOfFiles(sending) });
    this.busy = true;
    this.post({ type: "busy", value: true });
    try {
      const { entry, args } = found;
      if (entry.kind === "skill" && entry.id) await session.send(args !== "" ? args : `Use the ${entry.name} skill.`, sending, { skillIds: [entry.id] });
      else await session.runCommand(entry.name, args, sending);
    } catch (error) {
      this.busy = false;
      this.post({ type: "busy", value: false });
      this.notice(error instanceof Error ? error.message : String(error), true);
    }
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
        const skippedBefore = tracker.skipped.length;
        const change = await tracker.handle(event, at);
        for (const reason of tracker.skipped.slice(skippedBefore)) this.trace(`changes: not tracked: ${reason}`);
        if (event.type === "tool-result") this.trace(`changes: ${event.callId} result -> ${change ? `${change.rel} ${change.status} +${change.additions} -${change.deletions}` : "no change recorded"}`);
        if (!change || tracker !== this.changes) return;
        this.post({ type: "fileChange", change });
        this.post({ type: "changes", rows: await tracker.rows() });
      })
      .catch((error) => this.output.appendLine(`change tracking failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** A line for the Capella output channel; also appended to the file named by CAPELLA_TRACE_FILE (a development aid for the end-to-end run). */
  private trace(line: string): void {
    this.output.appendLine(line);
    const file = process.env.CAPELLA_TRACE_FILE;
    if (file) {
      try {
        appendFileSync(file, `${new Date().toISOString()} ${line}
`);
      } catch {
        // a development aid must never break the chat
      }
    }
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
    // Another chat does not inherit the folders opened to this one.
    await session.setFolders([]);
    this.extraFolders = [];
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

  /** Opens an address the USER chose (typed, or an HTML file of this folder served here): any http(s) address is allowed. */
  private async openChosen(url: string): Promise<void> {
    if (!isPreviewableUrl(url)) {
      this.notice("Only http and https addresses can be previewed.", true);
      return;
    }
    try {
      await vscode.commands.executeCommand("simpleBrowser.show", url);
    } catch {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  /** Preview: a dev server address a tool printed, an address you type, or an HTML file of this folder (served read-only on 127.0.0.1). */
  private async previewMenu(): Promise<void> {
    type Pick = vscode.QuickPickItem & { act: "url" | "type" | "file"; url?: string };
    const items: Pick[] = [
      ...this.localUrls.slice(-5).reverse().map((url): Pick => ({ label: url, description: "printed by a tool in this chat", act: "url", url })),
      { label: "Open an address…", description: "an http or https address you type", act: "type" },
      { label: "Preview an HTML file from this folder…", description: "served read-only on 127.0.0.1 while this chat is open", act: "file" },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: "Preview a page in the editor", placeHolder: "Pick what to open" });
    if (!picked) return;
    if (picked.act === "url" && picked.url) return this.openChosen(picked.url);
    if (picked.act === "type") {
      const url = await vscode.window.showInputBox({ title: "Open an address in the editor", prompt: "http or https", value: this.localUrls.at(-1) ?? "http://localhost:3000/", validateInput: (v) => (isPreviewableUrl(v) ? undefined : "Use an http:// or https:// address.") });
      if (url) await this.openChosen(url);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.notice("Open a folder first.", true);
      return;
    }
    const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*.{html,htm}"), "**/{node_modules,.git,dist,build}/**", 200);
    if (found.length === 0) {
      this.notice("There is no HTML file in this folder to preview.");
      return;
    }
    const files = found.map((uri) => vscode.workspace.asRelativePath(uri, false)).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
    const rel = await vscode.window.showQuickPick(files, { title: "Which page?", placeHolder: "An HTML file of this folder" });
    if (!rel) return;
    if (!this.previewConfirmed) {
      const go = "Serve and preview";
      const choice = await vscode.window.showInformationMessage("Serve this folder for the preview?", { modal: true, detail: `Capella will serve ${folder.uri.fsPath} read-only on 127.0.0.1 (this computer only) while this chat is open, so the page's own files load. Dotfiles such as .env and .git are never served.` }, go);
      if (choice !== go) return;
      this.previewConfirmed = true;
    }
    try {
      this.previewServer ??= await startPreviewServer(folder.uri.fsPath);
      await this.openChosen(this.previewServer.baseUrl + rel.split("/").map(encodeURIComponent).join("/"));
    } catch (error) {
      this.notice(`Could not start the preview: ${error instanceof Error ? error.message : String(error)}`, true);
    }
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

  /** The model list changed or was re-read: the picker gets it, and a change is said in words (ids), once. */
  private onCatalog(event: Extract<SessionEvent, { type: "catalog" }>, session: OpencodeSession): void {
    if (event.stale) {
      this.notice(`The model list may be out of date: ${event.stale}. The last good list is kept.`, true);
      return;
    }
    this.post({ type: "models", models: this.modelRows(session), model: this.model });
    const list = (ids: string[]) => ids.slice(0, 4).join(", ") + (ids.length > 4 ? ` and ${ids.length - 4} more` : "");
    const parts: string[] = [];
    if (event.added.length > 0) parts.push(`New models: ${list(event.added)}.`);
    if (event.removed.length > 0) parts.push(`No longer offered: ${list(event.removed)}.`);
    if (this.model && event.removed.includes(this.model)) parts.push("The model this chat uses is no longer offered: pick another before the next message.");
    if (parts.length > 0) this.notice(parts.join(" "), !!this.model && event.removed.includes(this.model));
  }

  private async sendInit(): Promise<void> {
    const session = await this.ensureSession();
    if (!session) return;
    this.post({ type: "init", version: session.version, workspace: vscode.workspace.workspaceFolders?.[0]?.name ?? "", modes: this.modeRows(), mode: this.mode, models: this.modelRows(session), model: this.model, features: { history: featureFlags(session.compat).history } });
    this.post({ type: "usage", usage: this.tracker.view() });
    this.postModelNote(session);
    this.postQueue();
    this.postFolders();
  }

  private async onMessage(message: FromWebview): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
          await this.sendInit();
          break;
        case "loadImage": {
          const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
          const result = await loadAnswerImage(message.src, roots);
          this.post(result.ok ? { type: "image", src: message.src, uri: result.uri } : { type: "image", src: message.src, error: result.reason });
          break;
        }
        case "listTools":
          await this.postTools();
          break;
        case "mcpToggle":
          if (this.session && validMcpName(message.name)) await this.session.mcpSetEnabled(message.name, message.on).catch((e) => this.notice(e instanceof Error ? e.message : String(e), true));
          setTimeout(() => void this.postTools(), 1500);
          await this.postTools();
          break;
        case "mcpAdd":
          await this.addMcp();
          break;
        case "mcpRemove": {
          const stored = this.storedMcp().find((s) => s.name === message.name);
          if (!stored || !this.session) break;
          await this.session.mcpRemove(stored.name).catch((e) => this.notice(e instanceof Error ? e.message : String(e), true));
          await this.context.workspaceState.update("capella.mcp", this.storedMcp().filter((s) => s.name !== stored.name));
          // The rules no longer need to name it.
          await this.session.setFolders(this.session.folders).catch(() => undefined);
          await this.postTools();
          break;
        }
        case "openSkill":
          await this.openSkill(message.name);
          break;
        case "accountConnect":
          await this.connectAccount(message.id, message.method);
          break;
        case "accountDisconnect":
          await this.disconnectAccount(message.id, message.connectionId);
          break;
        case "accountActivate":
          if (this.session && typeof message.connectionId === "string") {
            await this.session.activate(message.connectionId).catch((e) => this.notice(e instanceof Error ? e.message : String(e), true));
            await this.afterAccountChange(this.session);
          }
          break;
        case "addFolder":
          await this.addFolder();
          break;
        case "removeFolder":
          await this.removeFolder(message.path);
          break;
        case "listSlash": {
          const session = await this.ensureSession();
          if (!session) break;
          const entries: SlashEntryView[] = [
            { kind: "builtin", name: "new", description: "Start a new chat" },
            { kind: "builtin", name: "compact", description: "Summarise the conversation to free up context" },
            ...(await this.slashEntries(session)).map((e): SlashEntryView => ({ kind: e.kind, name: e.name, description: e.description })),
          ];
          this.post({ type: "slash", entries });
          break;
        }
        case "unqueue": {
          const item = this.queue.find((q) => q.id === message.id);
          if (!item || !this.session) break;
          await this.session.dequeue(item.id);
          this.queue = this.queue.filter((q) => q !== item);
          this.postQueue();
          break;
        }
        case "steerNow": {
          const item = this.queue.find((q) => q.id === message.id);
          if (!item || !this.session) break;
          await this.session.steer(item.id);
          item.delivery = "steer";
          this.postQueue();
          break;
        }
        case "send": {
          const session = await this.ensureSession();
          if (!session) return;
          if (this.busy) {
            await this.queueMessage(session, message.text, message.delivery ?? "queue");
            return;
          }
          const slash = await this.resolveSlash(session, message.text);
          if (slash) {
            await this.runSlash(session, message.text, slash);
            return;
          }
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
          this.post({ type: "effort", effort: undefined });
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
        case "setWeb": {
          if (this.busy) {
            this.notice("Wait for the current turn to finish before changing web access.", true);
            break;
          }
          if (message.policy === "allow") {
            const go = "Allow web access";
            const choice = await vscode.window.showWarningMessage("Let this chat use the web without asking?", { modal: true, detail: "The agent will be able to search the web and fetch pages without asking you first. A page it reads can carry instructions meant to mislead it. Turn this off again at any time." }, go);
            if (choice !== go) break;
          }
          await this.session?.setWeb(message.policy);
          this.post({ type: "web", policy: this.session?.web ?? message.policy });
          break;
        }
        case "setEffort":
          if (this.busy) {
            this.notice("Wait for the current turn to finish before changing the effort.", true);
            break;
          }
          await this.session?.setEffort(message.effort);
          this.post({ type: "effort", effort: this.session?.effort });
          break;
        case "refreshModels":
          if (this.session) {
            await this.session.refreshModels();
            this.notice(`Model list read again: ${this.session.models.length} models.`);
          }
          break;
        case "previewMenu":
          await this.previewMenu();
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
    this.queue = [];
    this.extraFolders = [];
    this.slashCache = undefined;
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
    void this.previewServer?.close();
    this.voice.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
    await session?.dispose();
  }
}
