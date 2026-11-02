/**
 * OpenCode Go allowance and Console budgets, from `GET /api/experimental/usage/limits` (observed on opencode 2.2.5).
 * Pure and defensive: the endpoint is experimental, so every field is checked and anything unexpected is dropped.
 * `data` is `null` when the location is not signed in to the OpenCode Console; that is "no usage to show", not an error.
 */

export type WindowKey = "rolling" | "weekly" | "monthly";

export interface UsageWindow {
  key: WindowKey;
  label: string;
  percent: number;
  limited: boolean;
  resetsAtMs: number;
}

export interface UsageBudget {
  id: string;
  limitUsd: number;
  spentUsd: number;
  resetsAtMs: number;
  /** Models the budget covers, by display name; empty means all. */
  models: string[];
}

export interface UsageSnapshot {
  workspace?: { name?: string; usageURL: string };
  windows: UsageWindow[];
  budgets: UsageBudget[];
  fetchedAtMs: number;
}

const LABELS: Record<WindowKey, string> = { rolling: "5-hour", weekly: "Weekly", monthly: "Monthly" };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Maps the response body. Returns undefined when the host reports no sign-in (`data: null`) or the shape is unusable. */
export function mapUsageLimits(body: unknown, now: number = Date.now()): UsageSnapshot | undefined {
  if (!isRecord(body) || !isRecord(body.data)) return undefined;
  const data = body.data;
  const windows: UsageWindow[] = [];
  if (isRecord(data.go)) {
    for (const key of ["rolling", "weekly", "monthly"] as const) {
      const meter = data.go[key];
      if (!isRecord(meter)) continue;
      const percent = finite(meter.percent);
      const resetsAtMs = finite(meter.resetsAt);
      if (percent === undefined || resetsAtMs === undefined) continue;
      windows.push({ key, label: LABELS[key], percent: Math.max(0, Math.min(100, percent)), limited: meter.limited === true, resetsAtMs });
    }
  }
  const budgets: UsageBudget[] = [];
  for (const row of Array.isArray(data.budgets) ? data.budgets : []) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const limitUsd = finite(row.limit);
    const spentUsd = finite(row.spent);
    if (limitUsd === undefined || spentUsd === undefined) continue;
    const models = (Array.isArray(row.models) ? row.models : []).map((m) => (isRecord(m) && typeof m.name === "string" ? m.name : undefined)).filter((m): m is string => m !== undefined);
    budgets.push({ id: row.id, limitUsd, spentUsd, resetsAtMs: finite(row.resetsAt) ?? 0, models });
  }
  const workspace = isRecord(data.workspace) ? httpsUrl(data.workspace.usageURL) : undefined;
  return {
    workspace: workspace ? { name: isRecord(data.workspace) && typeof data.workspace.name === "string" ? data.workspace.name : undefined, usageURL: workspace } : undefined,
    windows,
    budgets,
    fetchedAtMs: now,
  };
}

export interface UsageAlert {
  /** Window key or `budget:<id>`. */
  source: string;
  label: string;
  threshold: number;
  percent: number;
  resetsAtMs: number;
}

/** Per source: the highest threshold already announced for the current window, and which window that was. */
export type AlertState = Record<string, { announced: number; resetsAtMs: number }>;

export function budgetPercent(budget: UsageBudget): number {
  return budget.limitUsd > 0 ? Math.min(100, (budget.spentUsd / budget.limitUsd) * 100) : 0;
}

/**
 * Decides which alerts a new snapshot raises. Each threshold fires once per window: after it fired, nothing more is
 * said until the usage falls back below it or the window resets (a new `resetsAtMs`). Crossing two thresholds at once
 * raises only the highest.
 */
export function evaluateAlerts(prev: AlertState, snapshot: UsageSnapshot, thresholds: number[]): { alerts: UsageAlert[]; state: AlertState } {
  const sorted = [...new Set(thresholds)].filter((t) => t > 0 && t <= 100).sort((a, b) => a - b);
  const state: AlertState = { ...prev };
  const alerts: UsageAlert[] = [];
  const sources: Array<{ source: string; label: string; percent: number; resetsAtMs: number }> = [
    ...snapshot.windows.map((w) => ({ source: w.key, label: `${w.label} usage`, percent: w.percent, resetsAtMs: w.resetsAtMs })),
    ...snapshot.budgets.map((b) => ({ source: `budget:${b.id}`, label: "Console budget", percent: budgetPercent(b), resetsAtMs: b.resetsAtMs })),
  ];
  for (const s of sources) {
    const before = state[s.source];
    const sameWindow = before !== undefined && before.resetsAtMs === s.resetsAtMs;
    let announced = sameWindow ? before.announced : 0;
    // Falling back below what was announced re-arms the alert.
    while (announced > 0 && s.percent < announced) announced = [...sorted].reverse().find((t) => t < announced && s.percent >= t) ?? 0;
    const crossed = [...sorted].reverse().find((t) => s.percent >= t);
    if (crossed !== undefined && crossed > announced) {
      alerts.push({ source: s.source, label: s.label, threshold: crossed, percent: s.percent, resetsAtMs: s.resetsAtMs });
      announced = crossed;
    }
    state[s.source] = { announced, resetsAtMs: s.resetsAtMs };
  }
  return { alerts, state };
}

export function formatReset(resetsAtMs: number, now: number = Date.now()): string {
  const minutes = Math.round((resetsAtMs - now) / 60000);
  if (!Number.isFinite(minutes) || resetsAtMs <= 0) return "";
  if (minutes <= 0) return "resets now";
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `resets in ${hours} h ${minutes % 60 > 0 ? `${minutes % 60} min` : ""}`.trim();
  return `resets in ${Math.round(hours / 24)} days`;
}

export function describeAlert(alert: UsageAlert, now: number = Date.now()): string {
  const reset = formatReset(alert.resetsAtMs, now);
  return `${alert.label} is at ${Math.round(alert.percent)}% (alert at ${alert.threshold}%)${reset ? `, ${reset}` : ""}.`;
}

/** One line per window and budget, for the notification and the tooltip. */
export function summarize(snapshot: UsageSnapshot | undefined, now: number = Date.now()): string {
  if (!snapshot) return "No OpenCode Go or Console usage to show. Sign in with `opencode auth` to see it here.";
  const lines = snapshot.windows.map((w) => `${w.label}: ${Math.round(w.percent)}%${w.limited ? " (limit reached)" : ""} ${formatReset(w.resetsAtMs, now)}`.trim());
  for (const b of snapshot.budgets) lines.push(`Budget${b.models.length ? ` (${b.models.join(", ")})` : ""}: $${b.spentUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)} ${formatReset(b.resetsAtMs, now)}`.trim());
  if (lines.length === 0) lines.push("Signed in, but no Go allowance or budget is set for this workspace.");
  return lines.join("\n");
}

/** The tightest window decides the status-bar colour and text. */
export function tightest(snapshot: UsageSnapshot): { label: string; percent: number } | undefined {
  const rows = [...snapshot.windows.map((w) => ({ label: w.label, percent: w.percent })), ...snapshot.budgets.map((b) => ({ label: "Budget", percent: budgetPercent(b) }))];
  return rows.sort((a, b) => b.percent - a.percent)[0];
}
