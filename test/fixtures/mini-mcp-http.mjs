// A minimal MCP server over HTTP for tests (streamable HTTP, JSON answers): one tool, `echo`. It listens on 127.0.0.1 only and
// writes the Authorization header of what it receives to the file named by CAPELLA_TEST_DUMP_FILE, so that a test can see
// that a header arrived. Prints `listening http://127.0.0.1:PORT/mcp` when ready. Run as: node mini-mcp-http.mjs
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const dump = process.env.CAPELLA_TEST_DUMP_FILE;
const server = createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (dump) writeFileSync(dump, JSON.stringify({ authorization: req.headers.authorization ?? null, xKey: req.headers["x-api-key"] ?? null }));
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      const json = (result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize") json({ protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "mini-mcp-http", version: "1.0.0" } });
      else if (message.method === "tools/list") json({ tools: [{ name: "echo", description: "Returns its text argument.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] });
      else if (message.method === "tools/call") json({ content: [{ type: "text", text: "echo: " + (message.params?.arguments?.text ?? "") }] });
      else res.writeHead(202).end();
    });
  } else if (req.method === "DELETE") res.writeHead(200).end();
  else res.writeHead(405).end();
});
server.listen(0, "127.0.0.1", () => console.log(`listening http://127.0.0.1:${server.address().port}/mcp`));
