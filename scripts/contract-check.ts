// Contract check: starts the installed opencode in a throwaway home (no credentials, no model call), reads its OpenAPI
// document and compares it with what Capella was last tested against. Run it after every opencode release.
//
//   node scripts/contract-check.ts            compare and report (exit 1 when Capella would break or degrade)
//   node scripts/contract-check.ts --update   record this opencode as the tested one (after the e2e passes)
//
// To check a release that is not installed, install it into a scratch folder and pass its executable:
//   node scripts/contract-check.ts --binary <path-to-opencode.exe>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeClient } from "../src/opencode/client.ts";
import { assess, fingerprintOf, generationOf, routesOf, usedRoutes, type Tested } from "../src/opencode/compat.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const args = process.argv.slice(2);
const update = args.includes("--update");
const binaryArg = args[args.indexOf("--binary") + 1];
const binary = args.includes("--binary") && binaryArg ? binaryArg : locateOpencode();
if (!binary) throw new Error("opencode not found");

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
// tested.json is the 2.x snapshot, tested.v1.json the 1.x one: the generation the running server answers as decides which.
const testedFileFor = (generation: string): string => join(root, "src", "opencode", generation === "v1" ? "tested.v1.json" : "tested.json");
const snapshotDir = join(root, "test", "contract");

const home = mkdtempSync(join(tmpdir(), "capella-contract-home-"));
const project = mkdtempSync(join(tmpdir(), "capella-contract-project-"));
// A contract check makes no model call: keep the real credentials out of the environment (see probe-failure.ts).
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];

const server = new OpencodeServer({ binary, cwd: project, env });
let failed = false;
try {
  const endpoint = await server.start();
  const client = new OpencodeClient(endpoint, project);
  // 2.x answers /api/info and describes itself at /openapi.json; 1.x answers /global/health and describes itself at /doc.
  const v2 = await client.get<{ version?: string }>("/api/info").catch(() => undefined);
  const info = v2?.version ? v2 : await client.get<{ version?: string }>("/global/health");
  const openapi = await client.get<unknown>(v2?.version ? "/openapi.json" : "/doc");
  const version = info.version;
  const routes = routesOf(openapi);
  const generation = generationOf(routes);
  const testedFile = testedFileFor(generation);
  const used = usedRoutes(generation).filter((route) => routes.includes(route));
  console.log(`opencode ${version} (${generation}): ${routes.length} routes, Capella uses ${usedRoutes(generation).length} (${used.length} present)`);

  if (update) {
    if (!version) throw new Error("the server did not report a version");
    const tested: Tested = { version, usedRoutes: used, fingerprint: fingerprintOf(used) };
    writeFileSync(testedFile, JSON.stringify(tested, null, 2) + "\n");
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(join(snapshotDir, `routes-${version}${generation === "v1" ? "-v1" : ""}.json`), JSON.stringify(routes, null, 2) + "\n");
    console.log(`recorded ${version} as tested (${used.length} routes, fingerprint ${tested.fingerprint})`);
  } else {
    const tested = JSON.parse(readFileSync(testedFile, "utf8")) as Tested;
    const result = assess(openapi, version, tested);
    console.log(`status: ${result.status.toUpperCase()}: ${result.summary}`);
    for (const c of result.capabilities) console.log(`  ${c.present ? "ok     " : c.essential ? "MISSING" : "absent "} ${c.label}${c.missing.length ? `  (${c.missing.join(", ")})` : ""}`);
    if (result.removedSinceTested.length > 0) console.log(`routes Capella used at ${tested.version} that are gone:\n  ${result.removedSinceTested.join("\n  ")}`);
    // What else changed in the API, so a human can judge whether new features are worth adopting.
    try {
      const previous = JSON.parse(readFileSync(join(snapshotDir, `routes-${tested.version}${generation === "v1" ? "-v1" : ""}.json`), "utf8")) as string[];
      const added = routes.filter((route) => !previous.includes(route));
      const removed = previous.filter((route) => !routes.includes(route));
      console.log(`API change since ${tested.version}: ${added.length} routes added, ${removed.length} removed`);
      for (const route of added.slice(0, 15)) console.log(`  + ${route}`);
      for (const route of removed.slice(0, 15)) console.log(`  - ${route}`);
    } catch {
      console.log(`(no stored route list for ${tested.version}; run with --update on that version to keep one)`);
    }
    failed = result.status === "broken" || result.status === "unsupported" || result.status === "unknown" || result.removedSinceTested.length > 0;
  }
} finally {
  await server.stop();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
