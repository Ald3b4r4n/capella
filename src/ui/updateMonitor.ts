import * as vscode from "vscode";
import tested from "../opencode/tested.json" with { type: "json" };
import { decideNotices, fetchLatest, packageFor } from "../opencode/updates.ts";

const STATE_KEY = "capella.updates";

interface State {
  latest?: string;
  package?: string;
  checkedAtMs?: number;
  /** Notices already shown: `update:<version>` and `tested:<version>`, each said once. */
  told: string[];
}

/**
 * Compares the installed opencode with the newest published one, and with the version Capella was last tested with.
 * Only a version number is requested from npm. Capella never installs or updates anything: it shows the command and
 * lets the user run it. Switched off by `capella.updates.check`.
 */
export class UpdateMonitor {
  private readonly context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  private get state(): State {
    return this.context.globalState.get<State>(STATE_KEY) ?? { told: [] };
  }

  get enabled(): boolean {
    return vscode.workspace.getConfiguration("capella").get<boolean>("updates.check", true);
  }

  /** What the diagnostics report shows. */
  get snapshot(): { enabled: boolean; latest?: string; checkedAtMs?: number; package?: string } {
    const { latest, checkedAtMs, package: pkg } = this.state;
    return { enabled: this.enabled, latest, checkedAtMs, package: pkg };
  }

  /** Called when opencode has started. Asks npm at most once per interval; the "newer than tested" notice needs no network. */
  async check(installed: string | undefined, force = false): Promise<void> {
    if (!installed) return;
    const state = this.state;
    const told = new Set(state.told);
    let latest = state.latest;
    const hours = Math.max(1, vscode.workspace.getConfiguration("capella").get<number>("updates.intervalHours", 12));
    const due = force || state.checkedAtMs === undefined || Date.now() - state.checkedAtMs > hours * 3_600_000;
    if (this.enabled && due) {
      const pkg = packageFor(installed);
      const found = await fetchLatest(pkg);
      if (found) latest = found;
      await this.context.globalState.update(STATE_KEY, { ...state, latest, package: pkg, checkedAtMs: Date.now() });
    }
    // With the check switched off nothing is learned from the network, but a version newer than the tested one is still said.
    for (const notice of decideNotices(installed, this.enabled ? latest : undefined, tested.version, told)) {
      told.add(notice.kind === "update-available" ? `update:${latest}` : `tested:${installed}`);
      await this.context.globalState.update(STATE_KEY, { ...this.state, told: [...told] });
      const actions = notice.command ? ["Copy command"] : [];
      void vscode.window.showInformationMessage(`Capella: ${notice.text}${notice.command ? `\n${notice.command}` : ""}`, ...actions).then((choice) => {
        if (choice === "Copy command" && notice.command) void vscode.env.clipboard.writeText(notice.command);
      });
    }
  }
}
