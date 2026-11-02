import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_MODE, MODES, modeById, modeOf, nextMode } from "../../src/opencode/modes.ts";

test("the default mode is the read-only one", () => {
  assert.equal(DEFAULT_MODE, "plan");
  const plan = modeById(undefined);
  assert.equal(plan.agent, "plan");
  assert.ok(plan.rules.some((r) => r.action === "shell" && r.effect === "deny"));
  assert.ok(plan.rules.some((r) => r.action === "edit" && r.effect === "deny"));
});

test("only bypass is dangerous and it is outside the Shift+Tab cycle", () => {
  assert.deepEqual(MODES.filter((m) => m.dangerous).map((m) => m.id), ["bypass"]);
  const seen = new Set<string>();
  let mode = nextMode("plan");
  for (let i = 0; i < 10; i++) {
    seen.add(mode);
    mode = nextMode(mode);
  }
  assert.equal(seen.has("bypass"), false);
  assert.deepEqual([...seen].sort(), ["accept-edits", "plan", "review"]);
  assert.equal(nextMode("bypass"), "plan");
});

test("no mode except bypass leaves shell unasked, and no mode ever allows by rule", () => {
  for (const mode of MODES) {
    assert.equal(mode.rules.some((r) => r.effect === "allow"), false, mode.id);
    if (mode.id !== "bypass") assert.ok(mode.rules.some((r) => r.action === "shell" && r.effect !== "allow"), mode.id);
  }
});

test("modeOf recognises a session by its agent and rules", () => {
  const review = modeById("review");
  assert.equal(modeOf("build", [...review.rules].reverse()), "review");
  assert.equal(modeOf("build", []), "bypass");
  assert.equal(modeOf("plan", []), undefined);
});

test("web access is laid over the mode: follow it, allow, or deny", async () => {
  const { rulesWith, v1Rules } = await import("../../src/opencode/modes.ts");
  const review = modeById("review");
  assert.deepEqual(rulesWith(review, "mode"), review.rules);
  const web = (rules: ReturnType<typeof rulesWith>) => rules.filter((r) => /^web/.test(r.action)).map((r) => `${r.action}:${r.effect}`);
  assert.deepEqual(web(rulesWith(review, "deny")), ["webfetch:deny", "websearch:deny"]);
  assert.deepEqual(web(rulesWith(review, "allow")), ["webfetch:allow", "websearch:allow"]);
  // the rest of the mode is untouched
  assert.deepEqual(rulesWith(review, "deny").filter((r) => !/^web/.test(r.action)), review.rules.filter((r) => !/^web/.test(r.action)));
  // on 1.x every action is explicit so that the new set overrides the old
  assert.deepEqual(v1Rules(modeById("plan"), "deny").map((r) => `${r.permission}:${r.action}`), ["edit:deny", "bash:deny", "webfetch:deny", "websearch:deny"]);
  assert.deepEqual(v1Rules(modeById("accept-edits"), "allow").map((r) => `${r.permission}:${r.action}`), ["edit:allow", "bash:ask", "webfetch:allow", "websearch:allow"]);
});
