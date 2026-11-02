import assert from "node:assert/strict";
import { test } from "node:test";
import { changeOf, countOps, diffLines, hunksOf, splitLines, unifiedPatch } from "../../src/ui/diff.ts";

const apply = (ops: ReturnType<typeof diffLines>, side: "old" | "new"): string[] => (ops ?? []).filter((op) => (side === "old" ? op.kind !== "add" : op.kind !== "del")).map((op) => op.text);

test("lines are counted the way an editor counts them", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\r\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("the edit seen on opencode 2.2.5 gives the same counts as its own patch (1 added, 1 removed)", () => {
  const ops = diffLines(splitLines("alpha\nbeta\ngamma\n"), splitLines("alpha\nBETA\ngamma\n"));
  assert.deepEqual(countOps(ops!), { additions: 1, deletions: 1 });
  const patch = unifiedPatch("plan.txt", "alpha\nbeta\ngamma\n", "alpha\nBETA\ngamma\n");
  assert.equal(patch, "--- a/plan.txt\n+++ b/plan.txt\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n");
});

test("a new file is all additions and a deleted one all deletions", () => {
  assert.deepEqual(changeOf(null, "# Notes\n"), { status: "added", additions: 1, deletions: 0, lines: ["@@ -0,0 +1,1 @@", "+# Notes"] });
  const gone = changeOf("x\ny\n", null);
  assert.equal(gone?.status, "deleted");
  assert.equal(gone?.deletions, 2);
});

test("the script always rebuilds both sides exactly (random edits)", () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: rand(30) }, () => `line ${rand(8)}`);
    const b = a.filter(() => rand(4) !== 0);
    for (let i = rand(5); i > 0; i--) b.splice(rand(b.length + 1), 0, `new ${rand(8)}`);
    const ops = diffLines(a, b);
    assert.ok(ops);
    assert.deepEqual(apply(ops, "old"), a);
    assert.deepEqual(apply(ops, "new"), b);
  }
});

test("a small edit in a big file is cheap, and distant edits are separate hunks", () => {
  const big = Array.from({ length: 5000 }, (_, i) => `row ${i}`);
  const edited = [...big];
  edited[10] = "changed ten";
  edited[4000] = "changed four thousand";
  const ops = diffLines(big, edited)!;
  assert.deepEqual(countOps(ops), { additions: 2, deletions: 2 });
  const hunks = hunksOf(ops, 3);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]?.oldStart, 8);
  assert.equal(hunks[1]?.oldStart, 3998);
});

test("hunks that touch are merged, and identical texts have none", () => {
  const ops = diffLines(["a", "b", "c", "d", "e", "f", "g", "h"], ["a", "B", "c", "d", "e", "f", "G", "h"])!;
  assert.equal(hunksOf(ops, 3).length, 1);
  assert.equal(hunksOf(ops, 1).length, 2);
  assert.equal(unifiedPatch("x", "same\n", "same\n"), "");
  assert.deepEqual(changeOf("same\n", "same\n")?.lines, []);
});

test("texts too different to diff cheaply give up instead of hanging", () => {
  const a = Array.from({ length: 6000 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 6000 }, (_, i) => `b${i}`);
  assert.equal(diffLines(a, b), undefined);
});

test("a patch is reversed onto the 'after' text, and a mismatch is refused instead of guessed", async () => {
  const { reversePatch } = await import("../../src/ui/diff.ts");
  const patch = "@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
  assert.equal(reversePatch("alpha\nBETA\ngamma\n", patch), "alpha\nbeta\ngamma\n");
  assert.equal(reversePatch("alpha\nOTHER\ngamma\n", patch), undefined, "the file does not hold what the patch says it produced");
  assert.equal(reversePatch("alpha\nBETA\ngamma\n", "no hunks here"), undefined);
  // a creation: everything is added, so the 'before' is empty
  assert.equal(reversePatch("# Notes\n", "@@ -0,0 +1,1 @@\n+# Notes\n"), "");
  // two hunks far apart, and a file with a long unchanged middle
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[2] = "CHANGED 2";
  after[27] = "CHANGED 27";
  const forward = unifiedPatch("f.txt", before.join("\n") + "\n", after.join("\n") + "\n")!;
  assert.equal(reversePatch(after.join("\n") + "\n", forward), before.join("\n") + "\n");
});
