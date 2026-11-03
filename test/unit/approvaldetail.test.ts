import assert from "node:assert/strict";
import { test } from "node:test";
import { describeApproval, mcpCallsIn } from "../../src/webview/approvalDetail.ts";

test("the calls of MCP tools are read out of the code opencode runs, with their arguments", () => {
  const code = 'const nav = await tools.browser.browser_navigate({ url: "http://127.0.0.1:5000/" });\nconst shot = await tools.browser.browser_take_screenshot({ filename: "a (1).png", fullPage: true });\nreturn { nav, shot };';
  assert.deepEqual(mcpCallsIn(code), [
    { server: "browser", tool: "browser_navigate", args: '{ url: "http://127.0.0.1:5000/" }' },
    { server: "browser", tool: "browser_take_screenshot", args: '{ filename: "a (1).png", fullPage: true }' },
  ]);
  assert.deepEqual(mcpCallsIn("return 1 + 1;"), []);
  // a bracket inside a string does not end the arguments, and a call that never closes is cut, not looped on
  assert.equal(mcpCallsIn('await tools.s.t({ q: ")))" })')[0]!.args, '{ q: ")))" }');
  assert.ok(mcpCallsIn("await tools.s.t({ q: 'x'" + " ".repeat(5000))[0]!.args.length < 2100);
  assert.equal(mcpCallsIn(Array.from({ length: 12 }, (_, i) => `tools.s.t${i}(1);`).join("\n")).length, 6);
});

test("an approval for an MCP tool says which tool of which server and with what, instead of a bare star", () => {
  const input = { code: 'const r = await tools.capellaprobe.echo({ text: "PINEAPPLE" });\nreturn r;' };
  const detail = describeApproval("capellaprobe_echo", "execute", input)!;
  assert.equal(detail.headline, 'Calls the "echo" tool of the "capellaprobe" server');
  assert.deepEqual(detail.lines, ['capellaprobe.echo({ text: "PINEAPPLE" })']);
  assert.match(detail.code ?? "", /PINEAPPLE/);
  // several calls in one piece of code: the one asked about gives the headline, all are listed
  const many = describeApproval("browser_browser_click", "execute", { code: 'await tools.browser.browser_navigate({ url: "http://x.test/" });\nawait tools.browser.browser_click({ target: "e3" });' })!;
  assert.equal(many.headline, 'Calls the "browser_click" tool of the "browser" server');
  assert.equal(many.lines.length, 2);
  // code with no MCP call in it is said to be code
  assert.equal(describeApproval("anything", "execute", { code: "return 1" })!.headline, "Runs code through opencode");
});

test("a shell command, an edit and a web fetch are stated plainly", () => {
  assert.deepEqual(describeApproval("shell", "bash", { command: "npm test" }), { headline: "Runs this command", lines: ["npm test"] });
  assert.deepEqual(describeApproval("edit", "edit", { filePath: "src/a.ts", newString: "x\ny" }), { headline: "Changes this file", lines: ["src/a.ts", "2 lines of new text"] });
  assert.equal(describeApproval("edit", "write", { path: "notes.md", content: "# Notes" })!.headline, "Writes this file");
  assert.deepEqual(describeApproval("webfetch", "webfetch", { url: "https://example.com/a" }), { headline: "Fetches this page", lines: ["https://example.com/a"] });
  assert.equal(describeApproval("websearch", "websearch", { query: "capella" })!.headline, "Searches the web for");
});

test("anything else shows its arguments as name: value, long texts shortened, and nothing is made up when the call is unknown", () => {
  const detail = describeApproval("custom", "thing", { path: "/x", note: "n".repeat(500), empty: "", missing: null, n: 3 })!;
  assert.equal(detail.headline, undefined);
  assert.deepEqual(detail.lines.map((l) => l.split(":")[0]), ["path", "note", "n"]);
  assert.match(detail.lines[1]!, /\(500 characters\)/);
  assert.equal(describeApproval("shell", "bash", undefined), undefined);
  assert.equal(describeApproval("shell", "bash", "text"), undefined);
  assert.equal(describeApproval("shell", "bash", {}), undefined);
});
