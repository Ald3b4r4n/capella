import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveShim } from "../../src/opencode/locate.ts";

test("resolves an npm .cmd shim to the real executable", () => {
  const dir = mkdtempSync(join(tmpdir(), "capella-shim-"));
  const exeDir = join(dir, "node_modules", "@opencode", "cli", "bin");
  mkdirSync(exeDir, { recursive: true });
  const exe = join(exeDir, "opencode.exe");
  writeFileSync(exe, "");
  const shim = join(dir, "opencode.cmd");
  writeFileSync(shim, String.raw`@ECHO off
SETLOCAL
"%dp0%\node_modules\@opencode\cli\bin\opencode.exe"   %*
`);
  assert.equal(resolveShim(shim), exe);
});

test("leaves a shim it cannot resolve, and non-shims, alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "capella-shim-"));
  const shim = join(dir, "opencode.cmd");
  writeFileSync(shim, "@echo hi");
  assert.equal(resolveShim(shim), shim);
  assert.equal(resolveShim("C:\bin\opencode.exe"), "C:\bin\opencode.exe");
});
