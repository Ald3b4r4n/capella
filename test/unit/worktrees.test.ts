import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../../src/opencode/client.ts";
import { OpencodeSession } from "../../src/opencode/session.ts";
import { mapWorktrees, projectIdFromRoots, removalFailure, samePath, validWorktreeName, worktreeNameProblem } from "../../src/opencode/worktrees.ts";

test("a worktree name is plain: it becomes a folder and a branch", () => {
  for (const ok of ["a", "try-new-layout", "fix_1.2", "A1", "x".repeat(40)]) assert.equal(validWorktreeName(ok), true, ok);
  for (const bad of ["", "-a", ".a", "a b", "a/b", "a\\b", "a..b", "a.", "a.lock", "x".repeat(41), "ação", "a;b", "$(x)"]) assert.equal(validWorktreeName(bad), false, bad);
  assert.equal(worktreeNameProblem(""), "Give the worktree a name.");
  assert.match(worktreeNameProblem("a b")!, /letters, digits/);
  assert.equal(worktreeNameProblem("ok-name"), undefined);
});

test("the listing: the project first, then each worktree by name; odd entries are dropped", () => {
  const project = "C:\\Work\\app";
  const rows = mapWorktrees([{ directory: "C:\\data\\worktree\\ab\\zeta", strategy: "git" }, { directory: "c:\\work\\app\\" }, { directory: "C:\\data\\worktree\\ab\\alpha", strategy: "git" }, { directory: "relative/dir" }, { directory: 5 }, null, "x", { directory: "C:\\data\\worktree\\ab\\alpha", strategy: "git" }], project);
  assert.deepEqual(rows.map((r) => [r.kind, r.name]), [["project", "app"], ["worktree", "alpha"], ["worktree", "zeta"]]);
  // Only what opencode made itself (it names a strategy) can be removed; the project never.
  assert.deepEqual(rows.map((r) => r.removable), [false, true, true]);
  assert.equal(mapWorktrees([{ directory: "C:\\other\\folder" }], project).find((r) => r.name === "folder")?.removable, false);
  // The project is there even when the server leaves it out, and a non-list is no list.
  assert.deepEqual(mapWorktrees([], project).map((r) => r.kind), ["project"]);
  assert.deepEqual(mapWorktrees({ nope: 1 }, project).map((r) => r.directory), [project]);
  assert.equal(samePath("C:\\a\\b\\", "c:/a/b"), true);
  assert.equal(samePath("C:\\a\\b", "C:\\a\\bc"), false);
});

test("a refused removal says why and whether it asks for force", () => {
  const body = JSON.stringify({ _tag: "WorktreeError", name: "WorktreeError", data: { message: "error: failed to delete", forceRequired: true } });
  assert.deepEqual(removalFailure(body), { message: "error: failed to delete", forceRequired: true });
  assert.deepEqual(removalFailure(JSON.stringify({ message: "plain" })), { message: "plain", forceRequired: false });
  assert.deepEqual(removalFailure("not json"), { message: "not json", forceRequired: false });
  assert.equal(new ApiError("DELETE", "/api/worktree", 400, body).body, body);
});

test("the project id of a git folder is its single first commit", () => {
  const sha = "3e4fcd28f5276735031360434e625c80257fd1c2";
  assert.equal(projectIdFromRoots(`${sha}\n`), sha);
  assert.equal(projectIdFromRoots(`${sha}\r\n`), sha);
  assert.equal(projectIdFromRoots(`${sha}\n${sha.replace(/^3/, "4")}\n`), undefined, "several first commits: not certain, so not guessed");
  assert.equal(projectIdFromRoots(""), undefined);
  assert.equal(projectIdFromRoots("fatal: not a git repository"), undefined);
});

test("2.x: worktrees are listed, made and removed through the server, and only the ones it lists can be removed", async () => {
  const fixture = new URL("../fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const session = new OpencodeSession({ binary: process.execPath, binaryArgs: [fixture], workspaceRoot: process.cwd() });
  try {
    await session.start();
    assert.equal(session.canWorktree, true);
    assert.deepEqual((await session.worktrees()).map((r) => r.kind), ["project"]);
    const made = await session.createWorktree("try-it");
    assert.match(made, /try-it$/);
    const dirty = await session.createWorktree("dirty-one");
    const rows = await session.worktrees();
    assert.deepEqual(rows.map((r) => [r.kind, r.name]), [["project", rows[0]!.name], ["worktree", "dirty-one"], ["worktree", "try-it"]]);
    // Not a name, not a listed folder, not the project: refused before any request.
    await assert.rejects(() => session.createWorktree("../escape"), /not a name/);
    await assert.rejects(() => session.removeWorktree(process.cwd(), false), /not one of this project's worktrees/);
    await assert.rejects(() => session.removeWorktree(made + "-other", false), /not one of this project's worktrees/);
    await session.removeWorktree(made, false);
    // Changes that are not committed: the server asks for force, and only then is it removed.
    await assert.rejects(
      () => session.removeWorktree(dirty, false),
      (error: unknown) => error instanceof ApiError && removalFailure(error.body).forceRequired,
    );
    await session.removeWorktree(dirty, true);
    assert.deepEqual((await session.worktrees()).map((r) => r.kind), ["project"]);
  } finally {
    await session.dispose();
  }
});
