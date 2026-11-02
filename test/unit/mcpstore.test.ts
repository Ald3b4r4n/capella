import assert from "node:assert/strict";
import { test } from "node:test";
import { validEnvName, validHeaderName, validSecretValue } from "../../src/ui/mcpInput.ts";
import { readManaged, secretKey, summarize, toConfig, valid, type ManagedMcp } from "../../src/ui/mcpStore.ts";

test("what 0.1.4 stored is still read, and anything invalid in the storage is dropped", () => {
  const out = readManaged([
    { name: "old-local", config: { type: "local", command: ["node", "x.js"] } },
    { name: "old-remote", config: { type: "remote", url: "https://example.com/mcp" } },
    { name: "new", type: "local", command: ["srv"], envNames: ["API_TOKEN", "bad name"], cwd: "/work" },
    { name: "../evil", type: "local", command: ["x"] },
    { name: "nocommand", type: "local", command: [] },
    { name: "http-remote", type: "remote", url: "http://example.com/mcp" },
    "junk",
    null,
  ]);
  assert.deepEqual(out.map((s) => s.name), ["old-local", "old-remote", "new"]);
  assert.deepEqual(out[2], { name: "new", type: "local", command: ["srv"], cwd: "/work", envNames: ["API_TOKEN"], headerNames: [] });
  assert.deepEqual(readManaged("nope"), []);
});

test("the config opencode is given is the structure plus the secret values, and a missing value is reported instead of half-starting the server", () => {
  const local: ManagedMcp = { name: "srv", type: "local", command: ["node", "s.js"], cwd: "/work", envNames: ["API_TOKEN", "REGION"], headerNames: [] };
  const values: Record<string, string> = { "env:API_TOKEN": "tok-123", "env:REGION": "eu" };
  const full = toConfig(local, (kind, key) => values[`${kind}:${key}`]);
  assert.deepEqual(full, { config: { type: "local", command: ["node", "s.js"], cwd: "/work", environment: { API_TOKEN: "tok-123", REGION: "eu" } }, missing: [] });
  const partial = toConfig(local, (kind, key) => (key === "REGION" ? values[`${kind}:${key}`] : undefined));
  assert.deepEqual(partial.missing, ["API_TOKEN"]);
  const remote: ManagedMcp = { name: "r", type: "remote", url: "https://example.com/mcp", envNames: [], headerNames: ["Authorization"] };
  assert.deepEqual(toConfig(remote, () => "Bearer abc").config, { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer abc" } });
  assert.deepEqual(toConfig({ ...remote, headerNames: [] }, () => undefined).config, { type: "remote", url: "https://example.com/mcp" });
});

test("what the list and the question show are names, never values", () => {
  const entry: ManagedMcp = { name: "srv", type: "local", command: ["node", "a b.js"], cwd: "/work", envNames: ["API_TOKEN"], headerNames: [] };
  assert.equal(summarize(entry), 'node "a b.js" · env: API_TOKEN');
  assert.equal(summarize(entry, true), "Program: node\nArguments: \"a b.js\"\nWorking folder: /work\nEnvironment variables: API_TOKEN (values are kept in your system's keychain and never shown)");
  assert.match(summarize({ name: "r", type: "remote", url: "https://example.com/mcp", envNames: [], headerNames: ["Authorization"] }, true), /^Address: https:\/\/example.com\/mcp\nHeaders: Authorization \(values/);
});

test("a secret is kept under a key that tells projects, servers and variables apart", () => {
  assert.equal(secretKey("abc123", "srv", "env", "API_TOKEN"), "capella.mcp:abc123:srv:env:API_TOKEN");
  assert.notEqual(secretKey("abc123", "srv", "env", "A"), secretKey("def456", "srv", "env", "A"));
  assert.notEqual(secretKey("abc123", "srv", "env", "A"), secretKey("abc123", "srv", "hdr", "A"));
});

test("names and values are checked before they are stored or sent", () => {
  for (const ok of ["API_TOKEN", "_x", "A1"]) assert.equal(validEnvName(ok), true, ok);
  for (const bad of ["", "1A", "A-B", "A B", "A=1", "x".repeat(65), 3]) assert.equal(validEnvName(bad), false, String(bad));
  for (const ok of ["Authorization", "X-Api-Key", "x_y"]) assert.equal(validHeaderName(ok), true, ok);
  for (const bad of ["", "A B", "A:B", "A\nB", "x".repeat(65)]) assert.equal(validHeaderName(bad), false, JSON.stringify(bad));
  assert.equal(validSecretValue("Bearer abc"), true);
  for (const bad of ["", "   ", "a\nb", "a\r\nX-Evil: 1", "a\0b", 5]) assert.equal(validSecretValue(bad), false, JSON.stringify(bad));
});

test("a server is only sent when it is well-formed", () => {
  const base: ManagedMcp = { name: "srv", type: "local", command: ["x"], envNames: [], headerNames: [] };
  assert.equal(valid(base), true);
  assert.equal(valid({ ...base, envNames: ["A", "A"] }), false, "a repeated variable");
  assert.equal(valid({ ...base, command: [] }), false);
  assert.equal(valid({ ...base, name: "bad name" }), false);
  const remote: ManagedMcp = { name: "r", type: "remote", url: "https://example.com/mcp", envNames: [], headerNames: ["Authorization", "authorization"] };
  assert.equal(valid(remote), false, "headers are case-insensitive");
  assert.equal(valid({ ...remote, headerNames: ["Authorization"] }), true);
  assert.equal(valid({ ...remote, url: "http://example.com/mcp", headerNames: [] }), false);
});
