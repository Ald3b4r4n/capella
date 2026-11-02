import * as vscode from "vscode";
import type { OpencodeSession } from "../opencode/session.ts";
import { budgetPercent, describeAlert, evaluateAlerts, formatReset, summarize, tightest, type AlertState, type UsageSnapshot } from "../opencode/usage.ts";
import type { UsageView } from "./protocol.ts";

const SNAPSHOT_KEY = "capella.usage.snapshot";
const ALERTS_KEY = "capella.usage.alerts";
/** The endpoint is experimental and asks the Console: never hit it more than once a minute. */
const MIN_INTERVAL_MS = 60_000;
/** A snapshot older than this is shown as stale in the status bar. */
const STALE_MS = 15 * 60_000;

/**
 * Keeps the last OpenCode Go / Console usage, shows it in the status bar and raises threshold alerts.
 * The numbers come only from the opencode server (`/api/experimental/usage/limits`); Capella never reads credentials
 * or calls the Console itself. The last snapshot is remembered across restarts and marked stale when old.
 */
export class UsageTracker implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly item: vscode.StatusBarItem;
  private snapshot: UsageSnapshot | undefined;
  private lastAttemptMs = 0;
  private inFlight?: Promise<UsageSnapshot | undefined>;
  /** Fired with a view-model after every refresh, for the chat header. */
  readonly onDidChange = new vscode.EventEmitter<UsageView>();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.snapshot = context.globalState.get<UsageSnapshot>(SNAPSHOT_KEY);
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.item.command = "capella.showUsage";
    this.paint();
  }

  private config<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration("capella").get<T>(key, fallback);
  }

  get current(): UsageSnapshot | undefined {
    return this.snapshot;
  }

  summary(): string {
    return summarize(this.snapshot);
  }

  /** Reads fresh usage from the running opencode, at most once a minute unless `force`. Never throws. */
  refresh(session: OpencodeSession, force = false): Promise<UsageSnapshot | undefined> {
    if (this.inFlight) return this.inFlight;
    if (!force && Date.now() - this.lastAttemptMs < MIN_INTERVAL_MS) return Promise.resolve(this.snapshot);
    this.lastAttemptMs = Date.now();
    this.inFlight = session
      .usage()
      .then((snapshot) => {
        this.apply(snapshot);
        return snapshot;
      })
      .catch(() => this.snapshot)
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private apply(snapshot: UsageSnapshot | undefined): void {
    this.snapshot = snapshot;
    void this.context.globalState.update(SNAPSHOT_KEY, snapshot);
    if (snapshot && this.config("usage.alerts", true)) {
      const thresholds = this.config<number[]>("usage.alertThresholds", [80, 95]);
      const { alerts, state } = evaluateAlerts(this.context.globalState.get<AlertState>(ALERTS_KEY) ?? {}, snapshot, thresholds);
      void this.context.globalState.update(ALERTS_KEY, state);
      for (const alert of alerts) {
        const text = `Capella: ${describeAlert(alert)}`;
        const show = alert.threshold >= 95 ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void show(text, ...(snapshot.workspace ? ["Open Console usage"] : [])).then((choice) => {
          if (choice && snapshot.workspace) void vscode.env.openExternal(vscode.Uri.parse(snapshot.workspace.usageURL));
        });
      }
    }
    this.paint();
    this.onDidChange.fire(this.view());
  }

  /** What the chat header draws: plain numbers, no URLs it could navigate to by itself. */
  view(): UsageView {
    const snapshot = this.snapshot;
    if (!snapshot) return { windows: [], stale: false };
    return {
      windows: [
        ...snapshot.windows.map((w) => ({ label: w.label, percent: Math.round(w.percent), limited: w.limited, reset: formatReset(w.resetsAtMs) })),
        ...snapshot.budgets.map((b) => ({ label: "Budget", percent: Math.round(budgetPercent(b)), limited: false, reset: formatReset(b.resetsAtMs) })),
      ],
      stale: Date.now() - snapshot.fetchedAtMs > STALE_MS,
    };
  }

  private paint(): void {
    const snapshot = this.snapshot;
    const worst = snapshot ? tightest(snapshot) : undefined;
    if (!snapshot || !worst || !this.config("usage.statusBar", true)) {
      this.item.hide();
      return;
    }
    const stale = Date.now() - snapshot.fetchedAtMs > STALE_MS;
    this.item.text = `$(pulse) ${worst.label} ${Math.round(worst.percent)}%${stale ? " ~" : ""}`;
    this.item.tooltip = `Capella: OpenCode usage${stale ? " (as of the last time Capella asked; may be out of date)" : ""}\n${summarize(snapshot)}`;
    this.item.backgroundColor = worst.percent >= 95 ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
    this.onDidChange.dispose();
  }
}
