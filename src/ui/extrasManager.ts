/**
 * Installing, updating and removing plugins and skills, with the editor's own questions. Both bring things that steer or run
 * inside opencode, so each change is described first (what, from where, where it goes, what it can do) and confirmed.
 *
 * Plugins: update and check go through the running opencode's own routes; adding and removing run the official
 * `opencode plugin add|remove`, which edits opencode's GLOBAL configuration (so the question says it applies outside Capella
 * too). Skills: a folder is inspected, then copied into the project's `.opencode/skills` or the user's opencode folder.
 */
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import type { OpencodeSession } from "../opencode/session.ts";
import { npmPage, validPluginSpec } from "./pluginSpec.ts";
import { copySkill, inspectSkillFolder, removeSkillDir, skillsDir, validSkillName, type SkillScope } from "./skillInstall.ts";

const STORE = "capella.skills";

export interface InstalledSkill {
  name: string;
  scope: SkillScope;
  dir: string;
}

export class ExtrasManager {
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

  // ---- plugins -------------------------------------------------------------------------------------------------

  private runCli(binary: string, args: string[]): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      // The program is opencode itself and the arguments are a list that was validated: no shell is involved.
      const child = spawn(binary, args, { windowsHide: true });
      let output = "";
      const take = (c: Buffer) => (output = (output + String(c)).slice(-3000));
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const timer = setTimeout(() => child.kill(), 240_000);
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

  /** Asks which package plugins have a newer version (a network call to the registry). */
  async checkPlugins(session: OpencodeSession): Promise<void> {
    try {
      const plugins = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Checking plugins for updates…" }, () => session.pluginsCheck());
      const outdated = plugins.filter((p) => p.outdated);
      this.notice(outdated.length > 0 ? `Newer versions exist for: ${outdated.map((p) => p.name).join(", ")}.` : plugins.some((p) => p.kind === "package") ? "Every package plugin is up to date." : "There are no package plugins to check.");
    } catch (error) {
      this.notice(`Could not check for updates: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, true);
    }
  }

  async updatePlugin(session: OpencodeSession, target: string): Promise<void> {
    if (!validPluginSpec(target)) return;
    const go = "Update";
    const choice = await vscode.window.showWarningMessage(`Update the plugin ${target}?`, { modal: true, detail: `opencode will download the newest version of ${target} from npm and use it. A plugin runs inside opencode with your permissions, so this is new third-party code arriving on your computer. (${npmPage(target)})` }, go);
    if (choice !== go) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating ${target}…` }, () => session.pluginsUpdate([target]));
      this.notice(`${target} was updated. A new chat loads the new version.`);
    } catch (error) {
      this.notice(`Could not update ${target}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, true);
    }
  }

  async addPlugin(binary: string): Promise<boolean> {
    const spec = await vscode.window.showInputBox({ title: "Add a plugin", prompt: "An npm package, for example opencode-some-plugin or @scope/name@1.2.3", validateInput: (v) => (validPluginSpec(v.trim()) ? undefined : "Type an npm package name (with an optional @version). Addresses and paths are not accepted.") });
    if (!spec) return false;
    const target = spec.trim();
    const go = "Install and add";
    const detail = [
      `Package: ${target}\n${npmPage(target)}`,
      "opencode will install it from npm and add it to your GLOBAL opencode configuration, so it also applies to opencode outside Capella until you remove it.",
      "A plugin is code that runs inside opencode with your permissions: it can read your files, run programs and use the network. Only add one you trust.",
      "It loads when opencode starts: open a new chat to use it.",
    ].join("\n\n");
    if ((await vscode.window.showWarningMessage(`Add the plugin ${target}?`, { modal: true, detail }, go)) !== go) return false;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Installing ${target}…` }, () => this.runCli(binary, ["plugin", "add", target]));
    if (result.code !== 0) {
      this.log(`opencode plugin add ${target}: ${result.output}`);
      this.notice(`Could not add ${target}: ${result.output.split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "opencode did not say why"}`, true);
      return false;
    }
    this.notice(`${target} was installed and added. Open a new chat to load it.`);
    return true;
  }

  async removePlugin(binary: string, target: string): Promise<boolean> {
    if (!validPluginSpec(target)) return false;
    const go = "Remove";
    if ((await vscode.window.showWarningMessage(`Remove the plugin ${target}?`, { modal: true, detail: `opencode plugin remove ${target} takes it out of your GLOBAL opencode configuration (a plugin listed in a project's own configuration has to be removed there). It stops loading when opencode starts again.` }, go)) !== go) return false;
    const result = await this.runCli(binary, ["plugin", "remove", target]);
    if (result.code !== 0) {
      this.log(`opencode plugin remove ${target}: ${result.output}`);
      this.notice(`Could not remove ${target}: ${result.output.split("\n").filter(Boolean).pop()?.slice(0, 200) ?? "opencode did not say why"}`, true);
      return false;
    }
    this.notice(`${target} was removed. It is gone from the next chat.`);
    return true;
  }

  // ---- skills --------------------------------------------------------------------------------------------------

  installedSkills(): InstalledSkill[] {
    const raw = this.context.workspaceState.get<unknown>(STORE, []);
    return Array.isArray(raw) ? raw.filter((s): s is InstalledSkill => typeof s === "object" && s !== null && validSkillName((s as InstalledSkill).name) && typeof (s as InstalledSkill).dir === "string" && ((s as InstalledSkill).scope === "project" || (s as InstalledSkill).scope === "user")) : [];
  }

  private parents(): string[] {
    const root = this.root();
    return [...(root ? [skillsDir("project", root)] : []), skillsDir("user", root ?? "")];
  }

  /**
   * "Install a skill": a folder with a SKILL.md. It is inspected (and refused when it holds links, too much, or no usable
   * front matter), described, and copied only after the user has said where. (A development host's test can name the
   * folder through CAPELLA_DEV_SKILL_FOLDER instead of the system's folder picker; the questions are asked all the same.)
   */
  async installSkill(session: OpencodeSession, live = true): Promise<boolean> {
    const root = this.root();
    const dev = this.context.extensionMode === vscode.ExtensionMode.Development ? process.env.CAPELLA_DEV_SKILL_FOLDER : undefined;
    const picked = dev ? vscode.Uri.file(dev) : (await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: false, canSelectFolders: true, openLabel: "Install this skill", title: "Choose the folder of a skill (it holds a SKILL.md)" }))?.[0];
    if (!picked) return false;
    const inspected = await inspectSkillFolder(picked.fsPath);
    if (!inspected.ok) {
      this.notice(`That folder cannot be installed as a skill: ${inspected.reason}`, true);
      return false;
    }
    const skill = inspected.skill;
    const scope = await vscode.window.showQuickPick(
      [
        ...(root ? [{ label: "This project only", description: ".opencode/skills", detail: `Installed in ${skillsDir("project", root)}`, scope: "project" as SkillScope }] : []),
        { label: "All my projects", description: "opencode's own folder", detail: `Installed in ${skillsDir("user", root ?? "")}`, scope: "user" as SkillScope },
      ],
      { title: `Install the skill "${skill.name}"`, placeHolder: "Where should it be available?" },
    );
    if (!scope) return false;
    const parent = skillsDir(scope.scope, root ?? "");
    const previous = this.installedSkills().find((s) => s.name === skill.name && s.scope === scope.scope);
    const clash = (await session.skills()).filter((s) => s.name.toLowerCase() === skill.name.toLowerCase());
    const go = previous ? "Replace" : "Install skill";
    const detail = [
      `${skill.name}: ${skill.description}`,
      `${skill.files.length} file${skill.files.length === 1 ? "" : "s"}, ${(skill.bytes / 1024).toFixed(1)} KB, copied to ${parent}${previous ? " (replacing the copy Capella installed before)" : ""}.`,
      skill.scripts.length > 0 ? `It carries ${skill.scripts.length} file${skill.scripts.length === 1 ? "" : "s"} that ${skill.scripts.length === 1 ? "looks" : "look"} like ${skill.scripts.length === 1 ? "a program" : "programs"}: ${skill.scripts.slice(0, 6).join(", ")}${skill.scripts.length > 6 ? ", …" : ""}. The agent could be told to run them; each run still asks you first.` : "It carries no program-like files.",
      clash.length > 0 && !previous ? `There is a skill called ${skill.name} already (${clash[0]!.path ?? "built in"}): which one opencode uses depends on its own order.` : "",
      "The instructions of a skill are given to the model: install one only from a source you trust.",
    ].filter(Boolean).join("\n\n");
    if ((await vscode.window.showWarningMessage(`Install the skill "${skill.name}"?`, { modal: true, detail }, go)) !== go) return false;
    try {
      if (previous) await removeSkillDir(previous.dir, this.parents());
      const dir = await copySkill(picked.fsPath, parent, skill);
      await this.context.workspaceState.update(STORE, [...this.installedSkills().filter((s) => !(s.name === skill.name && s.scope === scope.scope)), { name: skill.name, scope: scope.scope, dir }]);
    } catch (error) {
      this.notice(`Could not install the skill: ${error instanceof Error ? error.message : String(error)}`, true);
      return false;
    }
    this.notice(live ? `The skill ${skill.name} was installed. opencode notices it within a few seconds.` : `The skill ${skill.name} was installed. This opencode (1.x) reads its skills when it starts: open a new chat to use it.`);
    return true;
  }

  async removeSkill(name: string): Promise<boolean> {
    const found = this.installedSkills().find((s) => s.name === name);
    if (!found) return false;
    const go = "Remove";
    if ((await vscode.window.showWarningMessage(`Remove the skill "${name}"?`, { modal: true, detail: `The folder ${found.dir} that Capella installed is deleted.` }, go)) !== go) return false;
    try {
      await removeSkillDir(found.dir, this.parents());
    } catch (error) {
      this.notice(`Could not remove the skill: ${error instanceof Error ? error.message : String(error)}`, true);
      return false;
    }
    await this.context.workspaceState.update(STORE, this.installedSkills().filter((s) => s !== found && !(s.name === found.name && s.scope === found.scope)));
    this.notice(`The skill ${name} was removed.`);
    return true;
  }
}
