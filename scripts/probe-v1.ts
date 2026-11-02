// Probe: the 1.x API of opencode (installed in a scratch folder, never on the PATH): announce line, auth, OpenAPI routes,
// and the first events. Throwaway home with no credentials, no model call.
// Usage: node scripts/probe-v1.ts <path-to-opencode-1.x-executable>
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/probe-v1.ts <opencode-1.x executable>");
const home = mkdtempSync(join(tmpdir(), "capella-v1-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-v1-project-"));
writeFileSync(join(project, "hello.txt"), "hello\n");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

const server = new OpencodeServer({ binary, cwd: project, env });
try {
  const endpoint = await server.start();
  console.log("started:", endpoint.baseUrl);
  const client = new OpencodeClient(endpoint, project);
  const text = async (path: string) => {
    const r = await fetch(endpoint.baseUrl + path, { headers: { authorization: "Basic " + Buffer.from(`${endpoint.username}:${endpoint.password}`).toString("base64") } });
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  };
  for (const path of ["/global/health", "/doc", "/openapi.json", "/api/info"]) {
    const r = await text(path);
    console.log(`GET ${path} -> ${r.status} ${r.type} ${r.body.slice(0, 120).replace(/\s+/g, " ")}`);
    if (path === "/doc" && r.type?.includes("json")) {
      if (process.env.V1_DOC_OUT) writeFileSync(process.env.V1_DOC_OUT, r.body);
      const doc = JSON.parse(r.body) as { info?: { version?: string }; paths: Record<string, Record<string, unknown>> };
      console.log("doc version:", doc.info?.version);
      for (const [p, v] of Object.entries(doc.paths)) console.log("  ", Object.keys(v).filter((k) => /^(get|post|put|patch|delete)$/.test(k)).join(",").toUpperCase(), p);
    }
  }
  const seen: string[] = [];
  const stream = new EventStream(client, "/event", { onMessage: (m) => seen.push(m.data.slice(0, 200)) });
  stream.start();
  await new Promise((r) => setTimeout(r, 1500));
  const created = await client.post<Record<string, unknown>>("/session", { title: "probe" }).catch((e) => String(e));
  console.log("POST /session ->", JSON.stringify(created).slice(0, 500));
  await new Promise((r) => setTimeout(r, 1500));
  stream.stop();
  console.log("events:", seen.slice(0, 8));
  console.log("GET /config/providers ->", JSON.stringify(await client.get("/config/providers").catch((e) => String(e))).slice(0, 300));
  console.log("GET /agent ->", JSON.stringify(await client.get("/agent").catch((e) => String(e))).slice(0, 400));
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
