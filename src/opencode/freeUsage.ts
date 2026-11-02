/**
 * Free models (Zen `-free`, or zero price) have no allowance endpoint: opencode 2.2.5 exposes OpenCode Go's windows and
 * Console budgets, nothing for free models, and the provider only says "no" with an HTTP 429 when a cap is hit. So
 * Capella keeps its OWN count of what it has seen (requests and tokens per day) and the moment a cap was last hit.
 * Everything derived here is labelled as Capella's count, never as the provider's remaining quota.
 */

export interface DayCount {
  requests: number;
  tokens: number;
}

export interface LimitHit {
  atMs: number;
  /** Requests Capella had seen that day for that model before the cap stopped it. */
  requestsBefore: number;
  /** Seconds the provider asked to wait, when it said so. */
  retryAfterMs?: number;
}

export interface FreeUsageState {
  /** Local date (YYYY-MM-DD) → model ref → counts. Old days are pruned. */
  days: Record<string, Record<string, DayCount>>;
  hits: Record<string, LimitHit>;
}

export const emptyFreeUsage = (): FreeUsageState => ({ days: {}, hits: {} });

const KEEP_DAYS = 14;

export function dayKey(now: number): string {
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function prune(days: FreeUsageState["days"], now: number): FreeUsageState["days"] {
  const oldest = dayKey(now - KEEP_DAYS * 86_400_000);
  return Object.fromEntries(Object.entries(days).filter(([key]) => key >= oldest));
}

/** One finished model step on a free model. */
export function recordStep(state: FreeUsageState, model: string, tokens: number, now: number): FreeUsageState {
  const key = dayKey(now);
  const day = { ...(state.days[key] ?? {}) };
  const before = day[model] ?? { requests: 0, tokens: 0 };
  day[model] = { requests: before.requests + 1, tokens: before.tokens + Math.max(0, tokens) };
  return { ...state, days: prune({ ...state.days, [key]: day }, now) };
}

/** The provider refused a free-model call because a cap was reached. */
export function recordLimitHit(state: FreeUsageState, model: string, now: number, retryAfterMs?: number): FreeUsageState {
  const requestsBefore = state.days[dayKey(now)]?.[model]?.requests ?? 0;
  return { ...state, hits: { ...state.hits, [model]: { atMs: now, requestsBefore, retryAfterMs } } };
}

export interface FreeUsageView {
  model: string;
  requestsToday: number;
  tokensToday: number;
  /** A cap was hit within the last 24 hours. */
  blocked: boolean;
  /** Epoch ms when the provider said it would be available again; otherwise undefined (it did not say). */
  resetsAtMs?: number;
  lastHitMs?: number;
  requestsBeforeHit?: number;
}

const DAY_MS = 86_400_000;

export function viewFor(state: FreeUsageState, model: string, now: number): FreeUsageView {
  const today = state.days[dayKey(now)]?.[model] ?? { requests: 0, tokens: 0 };
  const hit = state.hits[model];
  const recent = hit !== undefined && now - hit.atMs < DAY_MS;
  const resetsAtMs = recent && hit.retryAfterMs !== undefined ? hit.atMs + hit.retryAfterMs : undefined;
  // A stated wait that already passed means the cap has lifted.
  const blocked = recent && (resetsAtMs === undefined || resetsAtMs > now);
  return { model, requestsToday: today.requests, tokensToday: today.tokens, blocked, resetsAtMs, lastHitMs: recent ? hit.atMs : undefined, requestsBeforeHit: recent ? hit.requestsBefore : undefined };
}

/** Text for the chat notice, in the voice the rest of Capella uses: what is known, what is Capella's own count. */
export function describeFree(view: FreeUsageView, now: number): string {
  const counted = `Capella has counted ${view.requestsToday} request${view.requestsToday === 1 ? "" : "s"} on this free model today (${view.tokensToday.toLocaleString()} tokens). This is Capella's own count, not the provider's.`;
  if (!view.blocked) return counted;
  const when = view.resetsAtMs !== undefined ? ` Usage should return in about ${Math.max(1, Math.round((view.resetsAtMs - now) / 60000))} min, as the provider said.` : " The provider did not say when it resets; free-model limits are usually daily, so try again later or pick another model.";
  const before = view.requestsBeforeHit !== undefined ? ` The cap hit after ${view.requestsBeforeHit} counted request${view.requestsBeforeHit === 1 ? "" : "s"}.` : "";
  return `The free usage limit for this model was reached.${before}${when} ${counted}`;
}
