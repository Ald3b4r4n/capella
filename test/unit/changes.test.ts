import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ChatEvent } from "../../src/opencode/events.ts";
import { ChangeTracker, targetOf } from "../../src/ui/changes.ts";

const S = "ses_1";
const started = (callId: string, name: string): ChatEvent => ({ type: "tool-started", sessionId: S, messageId: "m", callId, name });
const input = (callId: string, value: unknown): ChatEvent => ({ type: "tool-input", sessionId: S, messageId: "m", callId, input: value });
const done = (callId: string): ChatEvent => ({ type: "tool-result", sessionId: S, messageId: "m", callId, text: "ok" });

function project() {
  const root = mkdtempSync(join(tmpdir(), "capella-chg-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "plan.txt"), "alpha\nbeta\ngamma\n");
  // Real files are older than the call that edits them: wait, so the creation-time check sees a file that predates it.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
  return root;
}

test("only edit-like tools with a path are tracked", () => {
  assert.equal(targetOf("edit", { path: "plan.txt", oldString: "a", newString: "b" }), "plan.txt");
  assert.equal(targetOf("write", { filePath: "a.md", content: "x" }), "a.md");
  assert.equal(targetOf("read", { path: "plan.txt" }), undefined);
  assert.equal(targetOf("edit", { newString: "x" }), undefined);
  assert.equal(targetOf("edit", "nope"), undefined);
});

test("an edit is seen as before and after, the way opencode's own patch counts it (+1 −1)", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("c1", "edit"));
  await tracker.handle(input("c1", { path: "plan.txt", oldString: "beta", newString: "BETA" }));
  writeFileSync(join(root, "plan.txt"), "alpha\nBETA\ngamma\n");
  const change = await tracker.handle(done("c1"));
  assert.deepEqual([change?.rel, change?.status, change?.additions, change?.deletions], ["plan.txt", "modified", 1, 1]);
  assert.deepEqual(change?.lines, ["@@ -1,3 +1,3 @@", " alpha", "-beta", "+BETA", " gamma"]);
});

test("a new file is 'added' and several edits of one file make one row against the ORIGINAL", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("w1", "write"));
  await tracker.handle(input("w1", { path: "src/new.ts", content: "export {}\n" }));
  writeFileSync(join(root, "src", "new.ts"), "export {}\n");
  const added = await tracker.handle(done("w1"));
  assert.equal(added?.status, "added");

  for (const [id, text] of [["e1", "alpha\nBETA\ngamma\n"], ["e2", "alpha\nBETA\nGAMMA\n"]] as const) {
    await tracker.handle(started(id, "edit"));
    await tracker.handle(input(id, { path: "plan.txt" }));
    writeFileSync(join(root, "plan.txt"), text);
    await tracker.handle(done(id));
  }
  const rows = await tracker.rows();
  assert.deepEqual(rows.map((r) => [r.rel, r.status, r.additions, r.deletions, r.edits]), [["plan.txt", "modified", 2, 2, 2], ["src/new.ts", "added", 1, 0, 1]]);
  assert.equal(tracker.original(rows[0]!.id)?.text, "alpha\nbeta\ngamma\n", "the 'before' is the text before the chat's first edit");
  assert.equal(tracker.original(rows[1]!.id)?.text, null);
});

test("a later change by someone else is flagged, and a file edited back to its original disappears", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("c1", "edit"));
  await tracker.handle(input("c1", { path: "plan.txt" }));
  writeFileSync(join(root, "plan.txt"), "alpha\nBETA\ngamma\n");
  await tracker.handle(done("c1"));
  writeFileSync(join(root, "plan.txt"), "alpha\nBETA\ngamma\nuser added this\n");
  assert.equal((await tracker.rows())[0]?.changedSince, true);
  writeFileSync(join(root, "plan.txt"), "alpha\nbeta\ngamma\n");
  assert.deepEqual(await tracker.rows(), []);
});

test("a failed or rejected edit leaves no trace", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("c1", "edit"));
  await tracker.handle(input("c1", { path: "plan.txt" }));
  await tracker.handle({ type: "tool-failed", sessionId: S, messageId: "m", callId: "c1", errorType: "permission.rejected", message: "no" });
  assert.equal(await tracker.handle(done("c1")), undefined);
  assert.equal(tracker.count, 0);
  await tracker.handle(started("c2", "edit"));
  await tracker.handle(input("c2", { path: "plan.txt" }));
  assert.equal(await tracker.handle(done("c2")), undefined, "a 'success' that changed nothing is not a change");
});

test("a path outside the open folder is never read, however the model writes it", async () => {
  const root = project();
  const outside = mkdtempSync(join(tmpdir(), "capella-chg-out-"));
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  const tracker = new ChangeTracker([root]);
  for (const [id, path] of [["a", join(outside, "secret.txt")], ["b", `..${"\\"}${outside.split(/[\\/]/).pop()}${"\\"}secret.txt`], ["c", join(outside, "brand-new.txt")]] as const) {
    await tracker.handle(started(id, "edit"));
    await tracker.handle(input(id, { path }));
    writeFileSync(path.includes("brand-new") ? join(outside, "brand-new.txt") : join(outside, "secret.txt"), "changed\n");
    assert.equal(await tracker.handle(done(id)), undefined, path);
  }
  assert.equal(tracker.count, 0);
});

test("binary and oversized files are skipped instead of read", async () => {
  const root = project();
  writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 0]));
  writeFileSync(join(root, "huge.txt"), "x".repeat(1024 * 1024 + 10));
  const tracker = new ChangeTracker([root]);
  for (const name of ["blob.bin", "huge.txt"]) {
    await tracker.handle(started(name, "write"));
    await tracker.handle(input(name, { path: name, content: "y" }));
    assert.equal(await tracker.handle(done(name)), undefined, name);
  }
});

test("when opencode writes before Capella can look (a lost race), a new file is still 'added' (it was born during the call)", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("w1", "write"));
  writeFileSync(join(root, "notes.md"), "# Notes\n"); // the write wins the race: the file exists when Capella looks
  await tracker.handle(input("w1", { path: "notes.md", content: "# Notes\n" }));
  const change = await tracker.handle(done("w1"));
  assert.deepEqual([change?.status, change?.additions, change?.deletions], ["added", 1, 0]);
});

test("when an edit wins the race, the patch opencode reports is applied backwards to recover the 'before'", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("e1", "edit"));
  writeFileSync(join(root, "plan.txt"), "alpha\nBETA\ngamma\n");
  await tracker.handle(input("e1", { path: "plan.txt" }));
  const patch = "Index: plan.txt\n===================================================================\n--- plan.txt\n+++ plan.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
  const change = await tracker.handle({ ...done("e1"), files: [{ file: "plan.txt", patch }] } as ChatEvent);
  assert.deepEqual([change?.status, change?.additions, change?.deletions], ["modified", 1, 1]);
  assert.equal(tracker.original((await tracker.rows())[0]!.id)?.text, "alpha\nbeta\ngamma\n");
});

test("a rewritten file whose earlier text cannot be recovered is left out rather than guessed", async () => {
  const root = project();
  const tracker = new ChangeTracker([root]);
  await tracker.handle(started("w1", "write"));
  writeFileSync(join(root, "plan.txt"), "completely new text\n"); // overwritten before the look, and no patch to go on
  await tracker.handle(input("w1", { path: "plan.txt", content: "completely new text\n" }));
  assert.equal(await tracker.handle(done("w1")), undefined);
});
