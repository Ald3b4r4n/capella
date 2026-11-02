// A minimal MCP server over stdio for tests (newline-delimited JSON-RPC): one tool, `echo`. It reads nothing and writes
// nothing outside its own stdout, so it is safe to start from a test or a probe. Run as: node mini-mcp.mjs
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

// For tests only: when asked, record what the environment held at start, so that a test can see that a variable arrived.
if (process.env.CAPELLA_TEST_DUMP_FILE) writeFileSync(process.env.CAPELLA_TEST_DUMP_FILE, JSON.stringify({ value: process.env.CAPELLA_TEST_VALUE ?? null, cwd: process.cwd() }));

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") reply(message.id, { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini-mcp", version: "1.0.0" } });
  else if (message.method === "tools/list") reply(message.id, { tools: [{ name: "echo", description: "Returns its text argument.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
  else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: "echo: " + (message.params?.arguments?.text ?? "") }] });
  else if (message.id !== undefined && !message.method?.startsWith("notifications/")) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } }) + "\n");
});
rl.on("close", () => process.exit(0));
