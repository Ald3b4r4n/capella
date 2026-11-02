import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMcp, parseCommandLine, validMcpName, validMcpUrl } from "../../src/ui/mcpInput.ts";

test("a command line becomes arguments without a shell: quotes group, a backslash is just a character", () => {
  assert.deepEqual(parseCommandLine("npx -y @modelcontextprotocol/server-everything"), ["npx", "-y", "@modelcontextprotocol/server-everything"]);
  assert.deepEqual(parseCommandLine('node "C:\\Program Files\\srv\\index.js" --flag=\'a b\''), ["node", "C:\\Program Files\\srv\\index.js", "--flag=a b"]);
  assert.deepEqual(parseCommandLine("   "), []);
  assert.deepEqual(parseCommandLine('cmd "" x'), ["cmd", "", "x"]);
  // nothing that looks like shell syntax is interpreted
  assert.deepEqual(parseCommandLine("a && b | c; $(d)"), ["a", "&&", "b", "|", "c;", "$(d)"]);
});

test("a server name is a narrow identifier, because it becomes a URL path and a permission pattern", () => {
  for (const ok of ["docs", "my-server_2", "A".repeat(40)]) assert.equal(validMcpName(ok), true, ok);
  for (const bad of ["", "a b", "a/b", "a.b", "../x", "x".repeat(41), "a*", undefined, 5]) assert.equal(validMcpName(bad), false, String(bad));
});

test("an address is https, or http for this computer only, and carries no credentials", () => {
  for (const ok of ["https://example.com/mcp", "http://localhost:3000/mcp", "http://127.0.0.1/mcp", "http://[::1]:8080/x"]) assert.equal(validMcpUrl(ok), true, ok);
  for (const bad of ["http://example.com/mcp", "ftp://example.com", "https://user:pw@example.com/", "https://", "not a url", "file:///etc/passwd", "javascript:alert(1)", "", 3]) assert.equal(validMcpUrl(bad), false, String(bad));
});

test("what will run is shown in full before it is confirmed", () => {
  assert.equal(describeMcp({ type: "local", command: ["node", "C:\\a b\\x.js", "--n", "1"] }), 'node "C:\\\\a b\\\\x.js" --n 1');
  assert.equal(describeMcp({ type: "local", command: ["node", "x.js", "a b"] }, true), 'Program: node\nArguments: x.js "a b"');
  assert.equal(describeMcp({ type: "local", command: ["srv"] }, true), "Program: srv\nArguments: (none)");
  assert.equal(describeMcp({ type: "remote", url: "https://example.com/mcp" }, true), "Address: https://example.com/mcp");
});
