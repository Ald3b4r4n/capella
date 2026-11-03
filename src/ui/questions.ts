/**
 * What the page may send back as the answer to a question of the agent. The page is untrusted input to the extension: the
 * answer is checked to be plain data of the shapes opencode takes (text, a number, a yes or no, a list of texts), small, and
 * keyed by simple names, before it is forwarded. Pure, so it is unit-tested.
 */
import type { QuestionValue } from "../opencode/events.ts";

const MAX_TEXT = 20_000;
const MAX_KEYS = 50;
const MAX_ITEMS = 100;

export function sanitizeAnswers(raw: unknown): Record<string, QuestionValue> | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_KEYS) return undefined;
  const out: Record<string, QuestionValue> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) return undefined;
    if (typeof value === "string") {
      if (value.length > MAX_TEXT) return undefined;
      out[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) return undefined;
      out[key] = value;
    } else if (typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.length <= MAX_ITEMS && value.every((v) => typeof v === "string" && v.length <= MAX_TEXT)) out[key] = value as string[];
    else return undefined;
  }
  return out;
}

/** Whether a field is shown, given what has been answered so far (`when` conditions of 2.x forms). */
export function visible(field: { hidden?: boolean; when?: Array<{ key: string; op: "eq" | "neq"; value: string | number | boolean }> }, answers: Record<string, QuestionValue | undefined>): boolean {
  if (field.hidden) return false;
  return (field.when ?? []).every((w) => (w.op === "eq" ? answers[w.key] === w.value : answers[w.key] !== w.value));
}
