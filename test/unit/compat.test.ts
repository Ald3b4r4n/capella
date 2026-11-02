import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { assess, compareVersions, featureFlags, fingerprintOf, generationOf, routesOf, usedRoutes, type Tested } from "../../src/opencode/compat.ts";
import { buildReport } from "../../src/opencode/diagnostics.ts";
import { OpencodeSession } from "../../src/opencode/session.ts";
import tested from "../../src/opencode/tested.json" with { type: "json" };
import { decideNotices, packageFor, parseLatest, registryUrl } from "../../src/opencode/updates.ts";

const TESTED: Tested = { version: "2.2.5", usedRoutes: usedRoutes(), fingerprint: fingerprintOf(usedRoutes()) };

/** An OpenAPI `paths` object with exactly these `METHOD path` routes. */
function spec(routes: string[]): unknown {
  const paths: Record<string, Record<string, object>> = {};
  for (const route of routes) {
    const [method, path] = route.split(" ");
    (paths[path!] ??= {})[method!.toLowerCase()] = {};
  }
  return { openapi: "3.1.0", paths };
}

test("routes are read from OpenAPI, and garbage gives none", () => {
  assert.deepEqual(routesOf(spec(["POST /api/session", "GET /api/session"])), ["GET /api/session", "POST /api/session"]);
  assert.deepEqual(routesOf({ paths: { "/x": { parameters: [], get: {} } } }), ["GET /x"], "non-method keys are not routes");
  for (const bad of [undefined, null, "x", { paths: null }, { paths: { "/x": 5 } }]) assert.deepEqual(routesOf(bad), []);
  assert.equal(generationOf(["GET /api/info", "GET /api/session"]), "v2");
  assert.equal(generationOf(["GET /session", "GET /event", "GET /api/session"]), "v1", "1.19.5 also serves a partial /api/session preview: it is still 1.x");
  assert.equal(generationOf(["GET /health"]), "unknown");
});

test("versions compare numerically, not as text", () => {
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  assert.equal(compareVersions("2.2.5", "2.2.5"), 0);
  assert.equal(compareVersions("1.19.5", "2.0.0"), -1);
  assert.equal(compareVersions("0.0.0-dev-5", "2.2.5"), -1);
  assert.equal(compareVersions("nope", "2.2.5"), undefined);
});

test("the tested snapshot on disk is what Capella uses today", () => {
  assert.deepEqual(tested.usedRoutes, usedRoutes(), "src/opencode/tested.json is stale: run node scripts/contract-check.ts --update");
});

test("the tested version is OK; a newer one with the same routes is 'newer', not an error", () => {
  const same = spec(usedRoutes());
  assert.equal(assess(same, "2.2.5", TESTED).status, "ok");
  const newer = assess(same, "2.9.0", TESTED);
  assert.equal(newer.status, "newer");
  assert.match(newer.summary, /newer than 2\.2\.5/);
  assert.equal(newer.usedFingerprint, TESTED.fingerprint);
});

test("a missing essential route is 'broken' and names what stops working", () => {
  const without = usedRoutes().filter((r) => r !== "POST /api/session/{sessionID}/permission/{requestID}/reply");
  const result = assess(spec(without), "2.5.0", TESTED);
  assert.equal(result.status, "broken");
  assert.match(result.summary, /Approvals/);
  assert.deepEqual(result.removedSinceTested, ["POST /api/session/{sessionID}/permission/{requestID}/reply"]);
  assert.notEqual(result.usedFingerprint, TESTED.fingerprint);
});

test("a missing optional route only switches that part off", () => {
  const without = usedRoutes().filter((r) => r !== "GET /api/experimental/usage/limits");
  const result = assess(spec(without), "2.5.0", TESTED);
  assert.equal(result.status, "degraded");
  assert.deepEqual(featureFlags(result), { usage: false, history: true, defaultModel: true });
});

test("the 1.x API and an unreadable description are told apart from a broken 2.x", () => {
  assert.equal(assess(spec(["GET /session", "GET /event"]), "1.19.5", TESTED).status, "broken", "1.x is recognised, and what is missing is named");
  assert.equal(assess(spec(["GET /health"]), "9.0.0", TESTED).status, "unsupported", "an API of neither generation");
  const unknown = assess(undefined, "2.2.5", TESTED);
  assert.equal(unknown.status, "unknown");
  assert.deepEqual(featureFlags(unknown), { usage: true, history: true, defaultModel: true }, "when it cannot be checked nothing is switched off");
});

test("update notices are said once, and only the version number is ever requested", () => {
  assert.equal(packageFor("2.2.5"), "@opencode/cli");
  assert.equal(packageFor("1.19.5"), "opencode-ai");
  assert.equal(registryUrl("@opencode/cli"), "https://registry.npmjs.org/@opencode%2fcli/latest");
  assert.equal(parseLatest({ name: "x", version: "2.3.0" }), "2.3.0");
  assert.equal(parseLatest({ version: "latest" }), undefined);
  assert.equal(parseLatest(null), undefined);
  const first = decideNotices("2.2.5", "2.3.0", "2.2.5", new Set());
  assert.deepEqual(first.map((n) => n.kind), ["update-available"]);
  assert.equal(first[0]?.command, "npm install -g @opencode/cli");
  assert.deepEqual(decideNotices("2.2.5", "2.3.0", "2.2.5", new Set(["update:2.3.0"])), []);
  const newer = decideNotices("2.4.0", "2.4.0", "2.2.5", new Set());
  assert.deepEqual(newer.map((n) => n.kind), ["newer-than-tested"]);
  assert.deepEqual(decideNotices("2.2.5", undefined, "2.2.5", new Set()), [], "no network answer, nothing to say");
});

test("the report holds no secret, no path and no chat content", () => {
  const report = buildReport({
    capellaVersion: "0.0.1",
    editor: { name: "Visual Studio Code", version: "1.143.1" },
    platform: "win32",
    opencode: { version: "2.2.5", executable: "C:\\Users\\Someone Private\\AppData\\opencode.exe", foundBy: "search" },
    compat: assess(spec(usedRoutes().filter((r) => r !== "GET /api/experimental/usage/limits")), "2.2.5", TESTED),
    unknownEvents: new Map([["session.new.thing", 3]]),
    updates: { enabled: true, latest: "2.3.0", checkedAtMs: 1_000_000, package: "@opencode/cli" },
    now: 1_000_000 + 5 * 60_000,
  });
  assert.equal(report.includes("Someone Private"), false);
  assert.equal(report.includes("C:\\"), false);
  assert.match(report, /executable `opencode\.exe`/);
  assert.match(report, /Working, with parts switched off/);
  assert.match(report, /`session\.new\.thing` × 3/);
  assert.match(report, /checked 5 min ago/);
  assert.match(report, /no API keys, passwords, folder paths or chat content/);
});

// ---- against the fake server: the session reads the contract from /openapi.json -------------------------------------

const fixture = new URL("../fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sessions: OpencodeSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.dispose()));
  delete process.env.FAKE_OPENAPI;
  delete process.env.FAKE_DROP_ROUTES;
});
async function started(): Promise<OpencodeSession> {
  const s = new OpencodeSession({ binary: process.execPath, binaryArgs: [fixture], workspaceRoot: process.cwd() });
  sessions.push(s);
  await s.start();
  return s;
}

test("a session assesses the server it started", async () => {
  const ok = await started();
  assert.equal(ok.compat?.status, "newer", "the fake reports 9.9.9-fake, newer than tested");
  process.env.FAKE_DROP_ROUTES = "GET /api/event";
  assert.equal((await started()).compat?.status, "broken");
  delete process.env.FAKE_DROP_ROUTES;
  process.env.FAKE_OPENAPI = "v1";
  assert.equal((await started()).compat?.status, "unsupported", "a description with neither generation's routes");
});
