/**
 * The MCP servers a user adds from Capella: add, edit, test and remove, with the editor's own input boxes and questions.
 * opencode forgets a server added while it runs, so the list is kept in the project's storage (never in a settings file a
 * repository could carry) and registered again in each chat. Secret values (environment variables, headers) are typed in
 * masked boxes and kept only in the editor's secret storage, the system keychain; they are read at the moment a server is
 * started, handed to opencode in memory and never shown, logged or sent to the page again.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import type { McpConfig, McpServerInfo } from "../opencode/backend.ts";
import type { OpencodeSession } from "../opencode/session.ts";
import { browserChannel, browserCommand, LOCAL_ORIGINS, PLAYWRIGHT_MCP_VERSION, type BrowserScope } from "./browserPreset.ts";
import { parseCommandLine, validEnvName, validHeaderName, validMcpName, validMcpUrl, validSecretValue } from "./mcpInput.ts";
import { readManaged, secretKey, summarize, toConfig, valid, type ManagedMcp } from "./mcpStore.ts";

const STORE = "capella.mcp";

type Pending = Map<string, string>;

export class McpManager {
  private readonly context: vscode.ExtensionContext;
  private readonly notice: (text: string, error?: boolean) => void;
  private readonly log: (line: string) => void;
  private readonly root: () => string | undefined;

  constructor(context: vscode.ExtensionContext, notice: (text: string, error?: boolean) => void, log: (line: string) => void, root: () => string | undefined) {
    this.context = context;
    this.notice = notice;
    this.log = log;
    this.root = root;
  }

  /** Separates the secrets of one project from another's: the keychain is shared by every window of the editor. */
  private scope(): string {
    return createHash("sha256").update(this.root() ?? "").digest("hex").slice(0, 12);
  }

  stored(): ManagedMcp[] {
    return readManaged(this.context.workspaceState.get<unknown>(STORE, []));
  }

  private async save(list: ManagedMcp[]): Promise<void> {
    await this.context.workspaceState.update(STORE, list);
  }

  private key(entry: ManagedMcp, kind: "env" | "hdr", key: string): string {
    return secretKey(this.scope(), entry.name, kind, key);
  }

  /** The secret values this server needs, read from the keychain. */
  private async load(entry: ManagedMcp): Promise<Pending> {
    const out: Pending = new Map();
    for (const [kind, names] of [["env", entry.envNames], ["hdr", entry.headerNames]] as const) for (const key of names) {
      const value = await this.context.secrets.get(this.key(entry, kind, key));
      if (value !== undefined) out.set(`${kind}:${key}`, value);
    }
    return out;
  }

  private config(entry: ManagedMcp, values: Pending): { config: McpConfig; missing: string[] } {
    return toConfig(entry, (kind, key) => values.get(`${kind}:${key}`));
  }

  /** opencode forgets what was added while it ran: the servers the user added are started again for each chat. */
  async register(session: OpencodeSession): Promise<void> {
    const entries = this.stored();
    if (entries.length === 0) return;
    const have = new Set((await session.mcpList().catch(() => [] as McpServerInfo[])).map((s) => s.name));
    for (const entry of entries) {
      if (have.has(entry.name) || !valid(entry)) continue;
      const { config, missing } = this.config(entry, await this.load(entry));
      if (missing.length > 0) {
        this.log(`MCP ${entry.name}: not started, no stored value for ${missing.join(", ")}`);
        this.notice(`The MCP server ${entry.name} was not started: the stored value for ${missing.join(", ")} is gone. Edit it in Tools to give it again.`, true);
        continue;
      }
      await session.mcpAdd(entry.name, config).catch((error) => this.log(`MCP ${entry.name}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  /** The environment variables or headers of a server: add or replace a value, remove one, until Done. Undefined when cancelled. */
  private async editPairs(kind: "env" | "hdr", names: string[], pending: Pending): Promise<string[] | undefined> {
    const label = kind === "env" ? "environment variable" : "header";
    const list = [...names];
    for (;;) {
      const choice = await vscode.window.showQuickPick(
        [
          { label: `$(add) Add or replace a ${label}…`, action: "add" as const, key: "" },
          ...list.map((key) => ({ label: `$(trash) Remove ${key}`, description: pending.has(`${kind}:${key}`) ? "new value, not applied yet" : "value kept in the keychain", action: "remove" as const, key })),
          { label: "$(check) Done", action: "done" as const, key: "" },
        ],
        { title: kind === "env" ? "Environment variables of the server" : "Headers sent to the server", placeHolder: list.length > 0 ? `Names: ${list.join(", ")}. Values are never shown.` : "None yet. Values are kept in your system's keychain and never shown." },
      );
      if (!choice) return undefined;
      if (choice.action === "done") return list;
      if (choice.action === "remove") {
        list.splice(list.indexOf(choice.key), 1);
        pending.delete(`${kind}:${choice.key}`);
        continue;
      }
      const name = await vscode.window.showInputBox({ title: `Name of the ${label}`, prompt: kind === "env" ? "For example API_TOKEN" : "For example Authorization", validateInput: (v) => ((kind === "env" ? validEnvName(v) : validHeaderName(v)) ? undefined : "That is not a valid name.") });
      if (!name) continue;
      const value = await vscode.window.showInputBox({ title: `Value of ${name}`, prompt: "It is kept in your system's keychain and never shown again.", password: true, ignoreFocusOut: true, validateInput: (v) => (validSecretValue(v) ? undefined : "Type a value on a single line.") });
      if (value === undefined) continue;
      if (!list.some((k) => (kind === "env" ? k === name : k.toLowerCase() === name.toLowerCase()))) list.push(name);
      pending.set(`${kind}:${name}`, value);
    }
  }

  private async confirm(title: string, entry: ManagedMcp, changed: string[], action: string): Promise<boolean> {
    const what = entry.type === "local" ? "This program runs on your computer with your user's permissions, now and every time a chat opens in this project." : "The agent will send what it passes to this server's tools to that address.";
    const detail = `${summarize(entry, true)}${changed.length > 0 ? `\n\nNew values for: ${changed.join(", ")}` : ""}\n\n${what}\nIts tools are asked about before they run (except in Bypass mode). Remove it at any time in Tools.`;
    return (await vscode.window.showWarningMessage(title, { modal: true, detail }, action)) === action;
  }

  /** Where the browser server saves its screenshots: a folder Capella owns, outside the project. The chat shows pictures from here and nowhere else. */
  browserOutDir(): string {
    return join(this.context.globalStorageUri.fsPath, "browser-output");
  }

  private runNpm(cwd: string, args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      // npm is a .cmd file on Windows, which needs a shell; every argument here is fixed by Capella, none comes from a user.
      const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd, shell: process.platform === "win32", windowsHide: true });
      let output = "";
      const take = (c: Buffer) => (output = (output + String(c)).slice(-4000));
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill(), 180_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({ code: null, output: String(error) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  /**
   * "Add the browser": Microsoft's Playwright MCP server, so that the agent can open a page, click and take a screenshot.
   * It is third-party code from npm, so it is installed at a pinned version with install scripts off, into this extension's
   * own storage, after a question that says so, and it drives the user's installed Edge or Chrome in a throwaway profile.
   * It is an ordinary MCP server afterwards: its tools are asked about like any other.
   */
  async addBrowser(session: OpencodeSession): Promise<boolean> {
    const existing = new Set((await session.mcpList().catch(() => [] as McpServerInfo[])).map((s) => s.name));
    const name = ["browser", "playwright", "browser2"].find((n) => !existing.has(n));
    if (!name) {
      this.notice("There are servers called browser, playwright and browser2 already.", true);
      return false;
    }
    const channel = browserChannel(process.platform, existsSync);
    if (!channel) {
      this.notice("No Microsoft Edge or Google Chrome was found: Capella drives an installed browser and does not download one.", true);
      return false;
    }
    const scope = await vscode.window.showQuickPick(
      [
        { label: "Only this computer", description: "localhost, 127.0.0.1", detail: "To look at the page you are building. The browser is asked to load only pages served from this computer.", scope: "local" as BrowserScope },
        { label: "Any website", description: "", detail: "The agent can open any address, for research or to test something online.", scope: "web" as BrowserScope },
      ],
      { title: "Add the browser: which pages may it open?", placeHolder: "You can change this later with Edit." },
    );
    if (!scope) return false;
    const browserName = channel === "msedge" ? "Microsoft Edge" : "Google Chrome";
    const go = "Install and add";
    const detail = [
      `Capella will install @playwright/mcp ${PLAYWRIGHT_MCP_VERSION} (Microsoft's Playwright, Apache-2.0, about 19 MB) from npm into its own storage, with npm's install scripts turned off, and add it as the MCP server "${name}". This is third-party code that runs on your computer.`,
      `It drives your installed ${browserName} (nothing is downloaded), headless, in a throwaway profile: no cookies, no logins, nothing kept.`,
      scope.scope === "local" ? `Pages: only this computer (${LOCAL_ORIGINS.split(";").join(", ")}). That is a filter on the browser's requests, not a security boundary: a page can redirect.` : "Pages: any website.",
      "Every action it takes (open a page, click, type, take a screenshot) asks you first, except in Bypass mode, and you decide whether to Always allow one. What a web page says is not an instruction, but a page can try to mislead the agent: read what it is about to do.",
      "Screenshots are shown in the chat. Remove it at any time in Tools.",
    ].join("\n\n");
    if ((await vscode.window.showWarningMessage("Add the browser (Playwright)?", { modal: true, detail }, go)) !== go) return false;

    const dir = join(this.context.globalStorageUri.fsPath, "playwright-mcp");
    mkdirSync(dir, { recursive: true });
    const cli = join(dir, "node_modules", "@playwright", "mcp", "cli.js");
    const installed = (): boolean => {
      try {
        return existsSync(cli) && (JSON.parse(readFileSync(join(dir, "node_modules", "@playwright", "mcp", "package.json"), "utf8")) as { version?: string }).version === PLAYWRIGHT_MCP_VERSION;
      } catch {
        return false;
      }
    };
    if (!installed()) {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing @playwright/mcp ${PLAYWRIGHT_MCP_VERSION}…` }, () =>
        this.runNpm(dir, ["install", "--prefix", ".", "--ignore-scripts", "--no-audit", "--no-fund", `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`]),
      );
      if (result.code !== 0 || !installed()) {
        this.log(`npm install of the browser server failed: ${result.output}`);
        this.notice("The browser server could not be installed (is npm available and online?). See the Capella output for npm's message.", true);
        return false;
      }
    }
    mkdirSync(this.browserOutDir(), { recursive: true });
    const entry: ManagedMcp = { name, type: "local", command: browserCommand(cli, channel, scope.scope, this.browserOutDir()), cwd: this.browserOutDir(), envNames: [], headerNames: [] };
    if (!valid(entry) || !(await this.apply(session, entry, new Map()))) return false;
    this.notice(`The browser was added as "${name}". It may take a few seconds to start.`);
    return true;
  }

  /** Starts (or restarts, with a changed configuration) the server, then keeps the structure and the secrets. */
  private async apply(session: OpencodeSession, entry: ManagedMcp, pending: Pending, previous?: ManagedMcp): Promise<boolean> {
    const values = await this.load(previous ?? entry);
    for (const [k, v] of pending) values.set(k, v);
    const { config, missing } = this.config(entry, values);
    if (missing.length > 0) {
      this.notice(`There is no value for ${missing.join(", ")}: add it first.`, true);
      return false;
    }
    try {
      await session.mcpAdd(entry.name, config);
    } catch (error) {
      this.notice(`Could not start the server: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, true);
      return false;
    }
    for (const [k, v] of pending) {
      const [kind, ...rest] = k.split(":");
      await this.context.secrets.store(this.key(entry, kind as "env" | "hdr", rest.join(":")), v);
    }
    // what was removed from the list leaves the keychain too
    if (previous) {
      for (const [kind, before, now] of [["env", previous.envNames, entry.envNames], ["hdr", previous.headerNames, entry.headerNames]] as const) {
        for (const key of before) if (!now.some((n) => n.toLowerCase() === key.toLowerCase())) await this.context.secrets.delete(this.key(previous, kind, key));
      }
    }
    await this.save([...this.stored().filter((s) => s.name !== entry.name), entry]);
    return true;
  }

  async add(session: OpencodeSession): Promise<boolean> {
    const existing = new Set((await session.mcpList().catch(() => [] as McpServerInfo[])).map((s) => s.name));
    const kind = await vscode.window.showQuickPick(
      [
        { label: "A program on this computer", description: "local", detail: "Capella starts it (for example: npx -y some-mcp-server) and talks to it over standard input and output.", remote: false },
        { label: "A server on the web", description: "remote", detail: "Capella connects to its address. What the agent sends to its tools goes to that server.", remote: true },
      ],
      { title: "Add an MCP server", placeHolder: "What kind of server is it?" },
    );
    if (!kind) return false;
    const name = await vscode.window.showInputBox({ title: "Name of the server", prompt: "Letters, digits, - and _ (the agent sees its tools as name_tool)", validateInput: (v) => (!validMcpName(v) ? "Use 1 to 40 letters, digits, - or _." : existing.has(v) ? "There is a server with this name already." : undefined) });
    if (!name) return false;
    let entry: ManagedMcp;
    if (kind.remote) {
      const url = await vscode.window.showInputBox({ title: "Address of the server", prompt: "https://… (http is accepted only for this computer)", validateInput: (v) => (validMcpUrl(v) ? undefined : "Use an https:// address, or http://localhost / 127.0.0.1.") });
      if (!url) return false;
      entry = { name, type: "remote", url: url.trim(), envNames: [], headerNames: [] };
    } else {
      const line = await vscode.window.showInputBox({ title: "Command that starts the server", prompt: "The program and its arguments, as you would type them. No shell is used.", placeHolder: "npx -y @modelcontextprotocol/server-everything", validateInput: (v) => (parseCommandLine(v).length === 0 ? "Type the command." : undefined) });
      if (!line) return false;
      entry = { name, type: "local", command: parseCommandLine(line), envNames: [], headerNames: [] };
    }
    const pending: Pending = new Map();
    const more = await vscode.window.showQuickPick(
      [
        { label: "No, add it as it is", add: false },
        { label: entry.type === "local" ? "Yes, give it environment variables (for a token, say)" : "Yes, send headers (for a token, say)", add: true },
      ],
      { title: `Does ${name} need ${entry.type === "local" ? "environment variables" : "headers"}?`, placeHolder: "Values are typed masked and kept in your system's keychain." },
    );
    if (!more) return false;
    if (more.add) {
      const names = await this.editPairs(entry.type === "local" ? "env" : "hdr", [], pending);
      if (!names) return false;
      if (entry.type === "local") entry.envNames = names;
      else entry.headerNames = names;
    }
    if (!valid(entry)) {
      this.notice("That server could not be added: something in it is not valid.", true);
      return false;
    }
    if (!(await this.confirm(`Add the MCP server "${name}"?`, entry, [...pending.keys()].map((k) => k.split(":").slice(1).join(":")), "Add server"))) return false;
    if (!(await this.apply(session, entry, pending))) return false;
    this.notice(`MCP server ${name} added. It may take a few seconds to connect.`);
    return true;
  }

  async edit(session: OpencodeSession, name: string): Promise<boolean> {
    const previous = this.stored().find((s) => s.name === name);
    if (!previous) return false;
    const entry: ManagedMcp = { ...previous, command: previous.command ? [...previous.command] : undefined, envNames: [...previous.envNames], headerNames: [...previous.headerNames] };
    const pending: Pending = new Map();
    for (;;) {
      const items = [
        ...(entry.type === "local"
          ? [
              { label: "$(terminal) Change the command", action: "command" },
              { label: "$(folder) Change the working folder", action: "cwd", description: entry.cwd ?? "the project folder" },
              { label: "$(symbol-variable) Environment variables…", action: "env", description: entry.envNames.join(", ") || "none" },
            ]
          : [
              { label: "$(globe) Change the address", action: "url", description: entry.url },
              { label: "$(symbol-key) Headers…", action: "hdr", description: entry.headerNames.join(", ") || "none" },
            ]),
        { label: "$(check) Apply and restart the server", action: "apply" },
      ];
      const choice = await vscode.window.showQuickPick(items, { title: `Edit ${name}`, placeHolder: "Escape cancels the changes" });
      if (!choice) return false;
      if (choice.action === "command") {
        const line = await vscode.window.showInputBox({ title: "Command that starts the server", value: (entry.command ?? []).map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(" "), validateInput: (v) => (parseCommandLine(v).length === 0 ? "Type the command." : undefined) });
        if (line) entry.command = parseCommandLine(line);
      } else if (choice.action === "cwd") {
        const folder = await vscode.window.showInputBox({ title: "Working folder", prompt: "An absolute folder, or empty for the project folder", value: entry.cwd ?? "" });
        if (folder !== undefined) entry.cwd = folder.trim() === "" ? undefined : folder.trim();
      } else if (choice.action === "url") {
        const url = await vscode.window.showInputBox({ title: "Address of the server", value: entry.url, validateInput: (v) => (validMcpUrl(v) ? undefined : "Use an https:// address, or http://localhost / 127.0.0.1.") });
        if (url) entry.url = url.trim();
      } else if (choice.action === "env" || choice.action === "hdr") {
        const names = await this.editPairs(choice.action, choice.action === "env" ? entry.envNames : entry.headerNames, pending);
        if (names) {
          if (choice.action === "env") entry.envNames = names;
          else entry.headerNames = names;
        }
      } else {
        if (!valid(entry)) {
          this.notice("Something in the server is not valid.", true);
          continue;
        }
        if (!(await this.confirm(`Apply the changes to "${name}"?`, entry, [...pending.keys()].map((k) => k.split(":").slice(1).join(":")), "Apply"))) continue;
        if (!(await this.apply(session, entry, pending, previous))) return false;
        this.notice(`${name} was restarted with the new configuration.`);
        return true;
      }
    }
  }

  /** Starts the server again and says how it went: the server's own answer, not a guess. */
  async test(session: OpencodeSession, name: string): Promise<void> {
    const entry = this.stored().find((s) => s.name === name);
    try {
      if (entry) {
        const { config, missing } = this.config(entry, await this.load(entry));
        if (missing.length > 0) {
          this.notice(`There is no stored value for ${missing.join(", ")}: edit the server to give it again.`, true);
          return;
        }
        await session.mcpAdd(entry.name, config);
      } else {
        await session.mcpSetEnabled(name, false);
        await session.mcpSetEnabled(name, true);
      }
    } catch (error) {
      this.notice(`The test could not start: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, true);
      return;
    }
    let status: McpServerInfo | undefined;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      status = (await session.mcpList().catch(() => [] as McpServerInfo[])).find((s) => s.name === name);
      if (status && status.status !== "pending") break;
    }
    if (status?.status === "connected") this.notice(`${name} started and answered: it is connected.`);
    else if (status?.status === "needs-auth") this.notice(`${name} started but needs a sign-in: use Sign in in Tools.`, true);
    else this.notice(`${name} did not connect (${status?.status ?? "not listed"})${status?.detail ? `: ${status.detail}` : ""}`, true);
  }

  async remove(session: OpencodeSession, name: string): Promise<void> {
    const entry = this.stored().find((s) => s.name === name);
    if (!entry) return;
    await session.mcpRemove(name).catch((e) => this.notice(e instanceof Error ? e.message : String(e), true));
    for (const key of entry.envNames) await this.context.secrets.delete(this.key(entry, "env", key));
    for (const key of entry.headerNames) await this.context.secrets.delete(this.key(entry, "hdr", key));
    await this.save(this.stored().filter((s) => s.name !== name));
  }
}
