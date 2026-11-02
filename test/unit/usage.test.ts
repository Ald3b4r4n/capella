import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAlert, evaluateAlerts, formatReset, mapUsageLimits, summarize, tightest, type AlertState, type UsageSnapshot } from "../../src/opencode/usage.ts";

const NOW = 1_800_000_000_000;
const body = (go: Record<string, { percent: number; limited: boolean; resetsAt: number }> | undefined, budgets: unknown[] = []) => ({
  location: { directory: "x" },
  data: { workspace: { id: "wrk_1", name: "Default", usageURL: "https://opencode.ai/console/wrk_1/activity/overview" }, go, budgets },
});

test("maps the three Go windows (shape observed on opencode 2.2.5)", () => {
  const snapshot = mapUsageLimits(body({ rolling: { percent: 0, limited: false, resetsAt: NOW + 3_600_000 }, weekly: { percent: 12.5, limited: false, resetsAt: NOW + 86_400_000 }, monthly: { percent: 1, limited: false, resetsAt: NOW + 9e8 } }), NOW);
  assert.deepEqual(snapshot?.windows.map((w) => [w.key, w.label, w.percent]), [["rolling", "5-hour", 0], ["weekly", "Weekly", 12.5], ["monthly", "Monthly", 1]]);
  assert.equal(snapshot?.workspace?.usageURL, "https://opencode.ai/console/wrk_1/activity/overview");
});

test("data: null means not signed in, and garbage is dropped instead of thrown", () => {
  assert.equal(mapUsageLimits({ data: null }), undefined);
  assert.equal(mapUsageLimits(undefined), undefined);
  assert.equal(mapUsageLimits("nope"), undefined);
  const odd = mapUsageLimits({ data: { workspace: { usageURL: "javascript:alert(1)" }, go: { rolling: { percent: "x" }, weekly: { percent: 250, limited: true, resetsAt: NOW } }, budgets: [null, { id: 3 }, { id: "b", limit: 10, spent: 2.5, resetsAt: NOW, models: [{ name: "M" }] }] } }, NOW);
  assert.equal(odd?.workspace, undefined, "only https links are kept");
  assert.deepEqual(odd?.windows.map((w) => [w.key, w.percent, w.limited]), [["weekly", 100, true]]);
  assert.deepEqual(odd?.budgets.map((b) => [b.id, b.spentUsd, b.models]), [["b", 2.5, ["M"]]]);
});

const snap = (percent: number, resetsAtMs = NOW + 1000): UsageSnapshot => ({ windows: [{ key: "rolling", label: "5-hour", percent, limited: false, resetsAtMs }], budgets: [], fetchedAtMs: NOW });

test("each threshold fires once per window, only the highest when two are crossed, and re-arms below it", () => {
  let state: AlertState = {};
  const step = (p: number, resets?: number) => {
    const r = evaluateAlerts(state, snap(p, resets), [80, 95]);
    state = r.state;
    return r.alerts.map((a) => a.threshold);
  };
  assert.deepEqual(step(50), []);
  assert.deepEqual(step(82), [80]);
  assert.deepEqual(step(85), [], "already announced");
  assert.deepEqual(step(96), [95]);
  assert.deepEqual(step(97), []);
  assert.deepEqual(step(60), [], "fell back below both");
  assert.deepEqual(step(81), [80], "re-armed");
  assert.deepEqual(step(99, NOW + 5000), [95], "a new window announces again, jumping straight to the highest threshold");
});

test("budgets raise alerts by spent/limit", () => {
  const snapshot: UsageSnapshot = { windows: [], budgets: [{ id: "b1", limitUsd: 10, spentUsd: 9, resetsAtMs: NOW + 1000, models: [] }], fetchedAtMs: NOW };
  const { alerts } = evaluateAlerts({}, snapshot, [80, 95]);
  assert.deepEqual(alerts.map((a) => [a.source, a.threshold]), [["budget:b1", 80]]);
  assert.equal(tightest(snapshot)?.percent, 90);
});

test("text for humans", () => {
  assert.equal(formatReset(NOW + 90 * 60000, NOW), "resets in 1 h 30 min");
  assert.equal(formatReset(NOW + 20 * 60000, NOW), "resets in 20 min");
  assert.equal(formatReset(NOW - 1, NOW), "resets now");
  assert.match(describeAlert({ source: "rolling", label: "5-hour usage", threshold: 95, percent: 96.2, resetsAtMs: NOW + 125 * 60000 }, NOW), /5-hour usage is at 96% \(alert at 95%\), resets in 2 h 5 min\./);
  assert.match(summarize(undefined), /opencode auth/);
  assert.match(summarize(snap(40), NOW), /5-hour: 40%/);
});
