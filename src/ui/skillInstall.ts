/**
 * Installing a skill from a folder: checking it, copying it, and removing what was installed. A skill is a folder with a
 * `SKILL.md` (a front matter with `name` and `description`, then instructions) and, perhaps, helper files. opencode reads
 * the skills it finds in `<project>/.opencode/skills/<name>/` and in `<config>/opencode/skills/<name>/` (measured on 2.2.5: a
 * skill added while it runs shows up within seconds), so installing is copying a folder there. The instructions of a skill
 * are given to the model, so a folder is inspected and described before anything is copied, and a link, a huge folder or a
 * name that could point elsewhere is refused. Nothing here is executed.
 */
import { lstat, mkdir, readdir, readFile, rm, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_MD_BYTES = 256 * 1024;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const validSkillName = (name: unknown): name is string => typeof name === "string" && NAME.test(name) && !name.endsWith("-") && !name.includes("--");

/** The front matter of a SKILL.md: `name` and `description` (a plain value, quoted, or a folded `>` / literal `|` block). */
export function parseSkillMd(text: string): { name?: string; description?: string; body: string } {
  const normal = text.replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normal);
  if (!match) return { body: normal };
  const lines = match[1]!.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) block.push(lines[++i]!.trim());
      value = block.join(value.startsWith(">") ? " " : "\n");
    } else if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) value = value.slice(1, -1);
    out[kv[1]!.toLowerCase()] = value;
  }
  return { name: out.name, description: out.description, body: match[2]! };
}

export interface SkillFolder {
  name: string;
  description: string;
  files: Array<{ rel: string; size: number }>;
  bytes: number;
  /** Files that look like programs or scripts, which the agent could be asked to run (each run still asks first). */
  scripts: string[];
}

const SCRIPT = /\.(sh|bash|zsh|ps1|psm1|bat|cmd|py|rb|pl|js|mjs|cjs|ts|exe|dll|com|vbs|jar)$/i;

/** Reads a folder as a skill: what it is, how big, and what looks like a program. A reason string when it cannot be one. */
export async function inspectSkillFolder(folder: string): Promise<{ ok: true; skill: SkillFolder } | { ok: false; reason: string }> {
  const root = resolve(folder);
  const files: Array<{ rel: string; size: number }> = [];
  let bytes = 0;
  const walk = async (dir: string): Promise<string | undefined> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const info = await lstat(full);
      if (info.isSymbolicLink()) return `${relative(root, full)} is a link; a skill folder must hold plain files.`;
      if (info.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") return `${relative(root, full)}: a skill folder should not carry ${entry.name}.`;
        const problem = await walk(full);
        if (problem) return problem;
      } else if (info.isFile()) {
        files.push({ rel: relative(root, full).split(sep).join("/"), size: info.size });
        bytes += info.size;
        if (files.length > MAX_SKILL_FILES) return `It holds more than ${MAX_SKILL_FILES} files.`;
        if (bytes > MAX_SKILL_BYTES) return `It is larger than ${MAX_SKILL_BYTES / 1024 / 1024} MB.`;
      } else return `${relative(root, full)} is not a plain file.`;
    }
    return undefined;
  };
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return { ok: false, reason: "That is not a plain folder." };
    const skillMd = join(root, "SKILL.md");
    const md = await lstat(skillMd).catch(() => undefined);
    if (!md || !md.isFile()) return { ok: false, reason: "There is no SKILL.md in that folder." };
    if (md.size > MAX_SKILL_MD_BYTES) return { ok: false, reason: `SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KB.` };
    const problem = await walk(root);
    if (problem) return { ok: false, reason: problem };
    const parsed = parseSkillMd(await readFile(skillMd, "utf8"));
    if (!parsed.name || !parsed.description) return { ok: false, reason: "SKILL.md needs a front matter with a name and a description." };
    if (!validSkillName(parsed.name)) return { ok: false, reason: `The skill name "${parsed.name}" must be lowercase letters, digits and single hyphens (up to 64 characters).` };
    return { ok: true, skill: { name: parsed.name, description: parsed.description, files, bytes, scripts: files.filter((f) => SCRIPT.test(f.rel)).map((f) => f.rel) } };
  } catch (error) {
    return { ok: false, reason: `The folder could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type SkillScope = "project" | "user";

/** The folder skills of a scope go into. The user's is under the configuration folder opencode uses (XDG_CONFIG_HOME, else ~/.config). */
export function skillsDir(scope: SkillScope, workspaceRoot: string, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  if (scope === "project") return join(workspaceRoot, ".opencode", "skills");
  return join(env["XDG_CONFIG_HOME"] || join(home, ".config"), "opencode", "skills");
}

/** Copies the files of an inspected skill into `<parent>/<name>`. Never overwrites: the caller removes an older copy first. */
export async function copySkill(source: string, parent: string, skill: SkillFolder): Promise<string> {
  const target = join(parent, skill.name);
  if (!resolve(target).startsWith(resolve(parent) + sep)) throw new Error("The skill name leads outside the skills folder.");
  if (await lstat(target).then(() => true, () => false)) throw new Error(`There is a "${skill.name}" in ${parent} already.`);
  try {
    for (const file of skill.files) {
      const to = join(target, ...file.rel.split("/"));
      if (!resolve(to).startsWith(resolve(target) + sep)) throw new Error("A file of the skill leads outside its folder.");
      await mkdir(join(to, ".."), { recursive: true });
      await copyFile(join(source, ...file.rel.split("/")), to);
    }
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}

/** Deletes a skill folder Capella installed. Only a direct child of a skills folder, and only with a SKILL.md in it. */
export async function removeSkillDir(dir: string, allowedParents: string[]): Promise<void> {
  const target = resolve(dir);
  const parent = resolve(target, "..");
  if (!allowedParents.some((p) => resolve(p).toLowerCase() === parent.toLowerCase())) throw new Error("That folder is not in a skills folder Capella installs into.");
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("That is not a plain folder.");
  if (!(await lstat(join(target, "SKILL.md")).then((i) => i.isFile(), () => false))) throw new Error("There is no SKILL.md in that folder; it is not removed.");
  await rm(target, { recursive: true, force: true });
}
