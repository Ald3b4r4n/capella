/**
 * Worktrees: copies of the project's git repository (a separate folder, a detached HEAD at the current commit: opencode 2.2.5
 * makes no branch) that opencode (2.x) creates and removes. A chat
 * run inside one edits that copy and leaves the user's own files alone. Pure helpers (names, the listing, the removal error),
 * so they are unit-tested without a server.
 */
import { basename } from "node:path";

export interface WorktreeRow {
  directory: string;
  /** `project` is the user's own folder; `worktree` is a copy opencode made. */
  kind: "project" | "worktree";
  name: string;
  /** Only a worktree opencode made itself (it names the strategy it used) can be removed from here. */
  removable: boolean;
}

/** Letters, digits, dot, dash and underscore; it becomes a folder and a branch name, so nothing else is let through. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

export function validWorktreeName(name: string): boolean {
  return NAME.test(name) && !name.endsWith(".") && !name.includes("..") && !name.endsWith(".lock");
}

/** Why a name is not acceptable, as text for the input box; undefined when it is. */
export function worktreeNameProblem(name: string): string | undefined {
  if (name === "") return "Give the worktree a name.";
  if (!validWorktreeName(name)) return "Use letters, digits, dots, dashes and underscores (up to 40, starting with a letter or digit).";
  return undefined;
}

export const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === b.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();

/**
 * opencode lists the project itself (no `strategy`) and each worktree it made (`strategy: "git"`). Anything that is not an
 * absolute-looking path is dropped; the project's own folder is always `project`, whatever the listing says about it.
 */
export function mapWorktrees(raw: unknown, projectRoot: string): WorktreeRow[] {
  const rows: WorktreeRow[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (typeof item !== "object" || item === null) continue;
    const directory = (item as { directory?: unknown }).directory;
    if (typeof directory !== "string" || directory.length === 0 || directory.length > 1024 || !/^(?:[A-Za-z]:[\\/]|\/)/.test(directory)) continue;
    if (seen.has(directory.toLowerCase())) continue;
    seen.add(directory.toLowerCase());
    const isProject = samePath(directory, projectRoot);
    const strategy = (item as { strategy?: unknown }).strategy;
    rows.push({ directory, kind: isProject ? "project" : "worktree", name: isProject ? basename(projectRoot) : basename(directory), removable: !isProject && typeof strategy === "string" && strategy !== "" });
  }
  // The project first, then the worktrees by name.
  if (!rows.some((r) => r.kind === "project")) rows.unshift({ directory: projectRoot, kind: "project", name: basename(projectRoot), removable: false });
  return rows.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "project" ? -1 : 1));
}

/** What a failed removal says: the server's message, and whether it asks for `force` (changes that are not committed). */
export function removalFailure(body: string): { message: string; forceRequired: boolean } {
  try {
    const parsed = JSON.parse(body) as { data?: { message?: unknown; forceRequired?: unknown }; message?: unknown };
    const message = typeof parsed.data?.message === "string" ? parsed.data.message : typeof parsed.message === "string" ? parsed.message : body;
    return { message: message.slice(0, 400), forceRequired: parsed.data?.forceRequired === true };
  } catch {
    return { message: body.slice(0, 400), forceRequired: false };
  }
}

/** The id opencode gives a git project is its first commit. Used only when the server does not list the folder yet. */
export function projectIdFromRoots(output: string): string | undefined {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines.length === 1 && /^[0-9a-f]{40}$/.test(lines[0]!) ? lines[0] : undefined;
}
