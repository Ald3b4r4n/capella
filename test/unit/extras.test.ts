import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { OpencodeSession } from "../../src/opencode/session.ts";
import { npmPage, pluginTarget, validPluginSpec } from "../../src/ui/pluginSpec.ts";
import { copySkill, inspectSkillFolder, parseSkillMd, removeSkillDir, skillsDir, validSkillName } from "../../src/ui/skillInstall.ts";

const made: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "capella-extras-"));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("a plugin to add is an npm package name, with an optional version or tag, and nothing else", () => {
  for (const ok of ["opencode-x", "@scope/name", "@scope/name@1.2.3", "name@latest", "a.b_c~d", "name@1.0.0-beta.1+build"]) assert.equal(validPluginSpec(ok), true, ok);
  for (const bad of ["", "Name", "https://x.test/p.tgz", "git+ssh://git@x/y.git", "github:user/repo", "../local", "C:\\x\\y", "/abs/path", "name; rm -rf x", "name --flag", "@scope", "name@", "a b", "x".repeat(215), 5, undefined]) assert.equal(validPluginSpec(bad), false, String(bad));
  assert.equal(pluginTarget("@scope/name@1.2.3"), "@scope/name");
  assert.equal(pluginTarget("@scope/name"), "@scope/name");
  assert.equal(pluginTarget("name@latest"), "name");
  assert.equal(npmPage("@scope/name@2"), "https://www.npmjs.com/package/@scope/name");
});

test("the front matter of a SKILL.md: plain, quoted and folded values", () => {
  assert.deepEqual(parseSkillMd("---\nname: my-skill\ndescription: Does a thing.\n---\nBody\n"), { name: "my-skill", description: "Does a thing.", body: "Body\n" });
  assert.equal(parseSkillMd('---\nname: "my-skill"\ndescription: \'Quoted: yes\'\n---\nx').description, "Quoted: yes");
  assert.equal(parseSkillMd("---\nname: s\ndescription: >\n  first line\n  second line\n---\nx").description, "first line second line");
  assert.equal(parseSkillMd("---\r\nname: s\r\ndescription: d\r\n---\r\nx").name, "s");
  assert.deepEqual(parseSkillMd("no front matter"), { body: "no front matter" });
});

test("a skill name is lowercase letters, digits and single hyphens", () => {
  for (const ok of ["a", "my-skill", "skill2", "a1-b2-c3"]) assert.equal(validSkillName(ok), true, ok);
  for (const bad of ["", "My-Skill", "-a", "a-", "a--b", "a b", "a/b", "..", "a.b", "x".repeat(65), 3]) assert.equal(validSkillName(bad), false, String(bad));
});

const skillFolder = (root: string, extra: (dir: string) => void = () => undefined, md = "---\nname: pdf-tools\ndescription: Work with PDF files.\n---\nUse the helper.\n") => {
  const dir = join(root, "src-skill");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), md);
  writeFileSync(join(dir, "reference.md"), "# ref\n");
  writeFileSync(join(dir, "scripts", "run.py"), "print('hi')\n");
  extra(dir);
  return dir;
};

test("a folder is inspected as a skill: what it is, its size, and what looks like a program", async () => {
  const dir = skillFolder(temp());
  const result = await inspectSkillFolder(dir);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([result.skill.name, result.skill.description, result.skill.files.map((f) => f.rel).sort(), result.skill.scripts], ["pdf-tools", "Work with PDF files.", ["SKILL.md", "reference.md", "scripts/run.py"], ["scripts/run.py"]]);
});

test("a folder that cannot be a skill is refused, with the reason", async () => {
  const root = temp();
  assert.match((await inspectSkillFolder(join(root, "missing"))).ok === false ? "no" : "yes", /no/);
  const none = join(root, "none");
  mkdirSync(none);
  const noMd = await inspectSkillFolder(none);
  assert.deepEqual([noMd.ok, !noMd.ok && /no SKILL\.md/.test(noMd.reason)], [false, true]);
  const noFront = await inspectSkillFolder(skillFolder(temp(), () => undefined, "just text"));
  assert.deepEqual([noFront.ok, !noFront.ok && /front matter/.test(noFront.reason)], [false, true]);
  const badName = await inspectSkillFolder(skillFolder(temp(), () => undefined, "---\nname: ../evil\ndescription: x\n---\n"));
  assert.deepEqual([badName.ok, !badName.ok && /must be lowercase/.test(badName.reason)], [false, true]);
  const withGit = await inspectSkillFolder(skillFolder(temp(), (d) => mkdirSync(join(d, ".git"))));
  assert.deepEqual([withGit.ok, !withGit.ok && /\.git/.test(withGit.reason)], [false, true]);
  const many = await inspectSkillFolder(skillFolder(temp(), (d) => { for (let i = 0; i < 201; i++) writeFileSync(join(d, `f${i}.txt`), "x"); }));
  assert.deepEqual([many.ok, !many.ok && /more than 200 files/.test(many.reason)], [false, true]);
  const big = await inspectSkillFolder(skillFolder(temp(), (d) => writeFileSync(join(d, "big.bin"), Buffer.alloc(5 * 1024 * 1024 + 1))));
  assert.deepEqual([big.ok, !big.ok && /larger than 5 MB/.test(big.reason)], [false, true]);
  // a link is refused (creating one needs a privilege on Windows: skip when it cannot be made)
  const target = temp();
  const linked = skillFolder(temp(), (d) => {
    try {
      symlinkSync(target, join(d, "link"), "junction");
    } catch {
      /* cannot make a link here */
    }
  });
  if (existsSync(join(linked, "link"))) {
    const result = await inspectSkillFolder(linked);
    assert.deepEqual([result.ok, !result.ok && /is a link/.test(result.reason)], [false, true]);
  }
});

test("a skill is copied into its folder, never over another, and only what Capella installed is removed", async () => {
  const root = temp();
  const source = skillFolder(root);
  const inspected = await inspectSkillFolder(source);
  assert.ok(inspected.ok);
  if (!inspected.ok) return;
  const parent = skillsDir("project", join(root, "project"));
  const dir = await copySkill(source, parent, inspected.skill);
  assert.equal(dir, join(parent, "pdf-tools"));
  assert.equal(readFileSync(join(dir, "scripts", "run.py"), "utf8"), "print('hi')\n");
  await assert.rejects(copySkill(source, parent, inspected.skill), /already/);
  // removal: only a direct child of a skills folder that Capella installs into, with a SKILL.md
  await assert.rejects(removeSkillDir(dir, [join(root, "elsewhere")]), /not in a skills folder/);
  await assert.rejects(removeSkillDir(parent, [parent]), /not in a skills folder/);
  const stray = join(parent, "stray");
  mkdirSync(stray);
  await assert.rejects(removeSkillDir(stray, [parent]), /no SKILL\.md/);
  await removeSkillDir(dir, [parent]);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(parent), true);
});

test("the folders skills go to: the project's .opencode/skills, and opencode's own configuration folder", () => {
  assert.equal(skillsDir("project", "/work/p"), join("/work/p", ".opencode", "skills"));
  assert.equal(skillsDir("user", "/work/p", { XDG_CONFIG_HOME: "/cfg" }, "/home/me"), join("/cfg", "opencode", "skills"));
  assert.equal(skillsDir("user", "/work/p", {}, "/home/me"), join("/home/me", ".config", "opencode", "skills"));
});

test("2.x: plugins are checked for updates and updated through the server's own routes", async () => {
  const fixture = new URL("../fixtures/fake-opencode.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const session = new OpencodeSession({ binary: process.execPath, binaryArgs: [fixture], workspaceRoot: process.cwd() });
  try {
    await session.start();
    assert.equal((await session.plugins()).find((p) => p.name === "my-plugin")?.outdated, undefined);
    const checked = await session.pluginsCheck();
    assert.deepEqual(checked.map((p) => [p.name, p.outdated]), [["my-plugin", true]]);
    assert.equal((await session.plugins()).find((p) => p.name === "my-plugin")?.outdated, true);
    await session.pluginsUpdate(["my-plugin"]);
    assert.equal((await session.plugins()).find((p) => p.name === "my-plugin")?.outdated, undefined);
  } finally {
    await session.dispose();
  }
});
