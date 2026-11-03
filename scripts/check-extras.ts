// Check of plugins and skills against a REAL opencode, in a throwaway home (the config folder, data and cache are all inside it):
//  - skills (2.x and 1.x): a folder is installed into the project's `.opencode/skills`, opencode lists it within seconds, and
//    removing the folder takes it away;
//  - plugins (2.x): `opencode plugin add` puts an official, harmless package (`@opencode-ai/plugin`, a types package that is not a
//    plugin, so it loads as "failed" with opencode's reason) into the throwaway configuration, the running server lists it,
//    a check for updates answers, and `opencode plugin remove` takes it out again.
// The CLI starts a background service for the home it is given: those started here are stopped at the end.
//
// Usage: node scripts/check-extras.ts <opencode executable>
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeSession } from "../src/opencode/session.ts";
import { copySkill, inspectSkillFolder, removeSkillDir, skillsDir } from "../src/ui/skillInstall.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: node scripts/check-extras.ts <opencode executable>");
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "capella-extras-check-")));
const home = join(base, "home");
const project = join(base, "project");
mkdirSync(project);
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "c"), XDG_DATA_HOME: join(home, "d"), XDG_STATE_HOME: join(home, "s"), XDG_CACHE_HOME: join(home, "k") };
for (const name of Object.keys(env)) if (/(_API_KEY|_TOKEN|_SECRET)$/i.test(name)) delete env[name];
const startedAt = Date.now();

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` - ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(read: () => Promise<T | undefined>, ms: number): Promise<T | undefined> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await wait(1500);
  }
  return undefined;
};
const cli = (args: string[]): Promise<{ code: number | null; output: string }> =>
  new Promise((resolve) => {
    const child = spawn(binary, args, { env, windowsHide: true });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += String(c)));
    child.stderr.on("data", (c: Buffer) => (output += String(c)));
    const timer = setTimeout(() => child.kill(), 240_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

const session = new OpencodeSession({ binary, workspaceRoot: project, env });
try {
  await session.start();
  console.log(`opencode ${session.version} (${session.generation})`);

  // ---- skills -------------------------------------------------------------------------------------------------
  const source = join(base, "src", "check-skill");
  mkdirSync(join(source, "scripts"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "---\nname: check-skill\ndescription: Installed by the Capella check.\n---\nSay CHECK.\n");
  writeFileSync(join(source, "scripts", "x.py"), "print(1)\n");
  const inspected = await inspectSkillFolder(source);
  check("the folder is read as a skill", inspected.ok && inspected.skill.name === "check-skill" && inspected.skill.scripts.length === 1, inspected.ok ? inspected.skill.files.map((f) => f.rel) : inspected.reason);
  if (!inspected.ok) throw new Error("no skill");
  const parent = skillsDir("project", project);
  const dir = await copySkill(source, parent, inspected.skill);
  // 2.x watches its skill folders; 1.x reads them when it starts, so a fresh server is asked there
  const read = async (): Promise<Awaited<ReturnType<OpencodeSession["skills"]>>> => {
    if (session.generation === "v2") return session.skills();
    const fresh = new OpencodeSession({ binary, workspaceRoot: project, env });
    try {
      await fresh.start();
      return await fresh.skills();
    } finally {
      await fresh.dispose();
    }
  };
  const listed = await until(async () => ((await read()).find((s) => s.name === "check-skill") ? true : undefined), 60000);
  check(session.generation === "v2" ? "opencode lists the installed skill within a minute" : "a server started afterwards lists the installed skill (1.x reads its folders at start)", listed === true);
  check("with the path of the installed copy", (await read()).find((s) => s.name === "check-skill")?.path?.toLowerCase().startsWith(dir.toLowerCase()) === true);
  await removeSkillDir(dir, [parent]);
  const gone = await until(async () => (!(await read()).some((s) => s.name === "check-skill") ? true : undefined), 60000);
  check("and stops listing it once the folder is removed", gone === true);

  // ---- plugins (2.x) -------------------------------------------------------------------------------------------
  if (session.generation === "v2") {
    const config = join(home, "c", "opencode", "opencode.json");
    const added = await cli(["plugin", "add", "@opencode-ai/plugin"]);
    check("opencode plugin add installs the package", added.code === 0, added.output.trim().slice(-160));
    check("and puts it in the global configuration", existsSync(config) && readFileSync(config, "utf8").includes("@opencode-ai/plugin"));
    // a server started after the change loads it
    const second = new OpencodeSession({ binary, workspaceRoot: project, env });
    try {
      await second.start();
      const plugin = await until(async () => (await second.plugins()).find((p) => p.name === "@opencode-ai/plugin"), 90000);
      check("a server started afterwards lists it as a package plugin", plugin?.kind === "package", plugin);
      check("with the reason when it cannot load (it is a types package, not a plugin)", plugin?.state === "failed" && /export a default definition/.test(plugin.error ?? ""), plugin?.error);
      const checked = await second.pluginsCheck();
      check("a check for updates answers and still lists it", checked.some((p) => p.name === "@opencode-ai/plugin"));
    } finally {
      await second.dispose();
    }
    const removed = await cli(["plugin", "remove", "@opencode-ai/plugin"]);
    check("opencode plugin remove takes it out", removed.code === 0 && !readFileSync(config, "utf8").includes("@opencode-ai/plugin"), removed.output.trim().slice(-160));
  }
} finally {
  await session.dispose();
  // the CLI starts a background service for the home it is given: stop the ones that this check started
  execFileSync(process.execPath, [join(import.meta.dirname, "stop-services.mjs"), String(startedAt - 2000)], { stdio: "ignore" });
  await wait(1500);
  rmSync(base, { recursive: true, force: true });
}
console.log(failed === 0 ? "ALL CHECKS PASSED" : `${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
