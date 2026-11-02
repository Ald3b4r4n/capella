/**
 * Which files the agent changed in this chat, and how. opencode's own diff endpoint and revert did nothing in the
 * probes, so Capella records the text of a file when an edit's arguments are complete (before the tool runs), reads it
 * again when the tool succeeds, and diffs the two (src/ui/diff.ts).
 *
 * Safety: the path comes from the model, so it is only followed inside the open folder(s) (links and short names
 * resolved), only for text files up to 1 MB. Nothing outside is ever read or shown. Edits made by a shell command
 * (sed, a script, git) do not pass through an edit tool and are NOT seen here; the page says so.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { ChatEvent } from "../opencode/events.ts";
import { insideRoots, looksLikeText, MAX_TEXT_BYTES } from "./attachments.ts";
import { changeOf, reversePatch, type FileChange } from "./diff.ts";

export interface ToolChange {
  callId: string;
  /** The file's id in this chat's change list. */
  id: string;
  rel: string;
  status: FileChange["status"];
  additions: number;
  deletions: number;
  /** The first lines of the change (`@@` headers and `+`/`-`/space lines). */
  lines: string[];
  more: boolean;
}

export interface ChangeRow {
  id: string;
  rel: string;
  status: FileChange["status"];
  additions: number;
  deletions: number;
  edits: number;
  /** The file differs from what the last edit wrote: someone (or something) changed it afterwards. */
  changedSince: boolean;
}

interface FileRecord {
  id: string;
  abs: string;
  rel: string;
  /** The text before the chat's first edit of this file; null when the file did not exist. */
  original: string | null;
  lastAfter: string | null;
  edits: number;
}

const SHOWN_LINES = 80;
const PATH_KEYS = ["path", "filePath", "file_path", "file"];

/** The file an edit-like tool call targets, from its arguments. Undefined for anything else (a read, a search...). */
export function targetOf(name: string, input: unknown): string | undefined {
  if (!/edit|write|patch/i.test(name) || typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of PATH_KEYS) if (typeof record[key] === "string" && record[key] !== "") return record[key] as string;
  return undefined;
}

type Snapshot = { ok: true; text: string | null } | { ok: false };

export class ChangeTracker {
  private readonly roots: string[];
  private readonly names = new Map<string, string>();
  private readonly pending = new Map<string, { abs: string; before: string | null; startedAt: number }>();
  private readonly startedAt = new Map<string, number>();
  private readonly files = new Map<string, FileRecord>();
  private seq = 0;

  constructor(roots: readonly string[]) {
    this.roots = [...roots];
  }

  get count(): number {
    return this.files.size;
  }

  private key(abs: string): string {
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }

  /** Inside the open folder(s); a file that does not exist yet counts when its nearest existing folder does. */
  private async allowed(abs: string): Promise<boolean> {
    if (await insideRoots(abs, this.roots)) return true;
    let here = abs;
    for (let i = 0; i < 64; i++) {
      try {
        await stat(here);
        break;
      } catch {
        const parent = dirname(here);
        if (parent === here) return false;
        here = parent;
      }
    }
    // Only a missing file may use this: an existing one outside the roots was refused above.
    try {
      await stat(abs);
      return false;
    } catch {
      return insideRoots(here, this.roots);
    }
  }

  private async snapshot(abs: string): Promise<Snapshot> {
    if (!(await this.allowed(abs))) return { ok: false };
    try {
      const info = await stat(abs);
      if (!info.isFile() || info.size > MAX_TEXT_BYTES) return { ok: false };
      const buf = await readFile(abs);
      return looksLikeText(buf) ? { ok: true, text: buf.toString("utf8") } : { ok: false };
    } catch {
      return { ok: true, text: null };
    }
  }

  private async relOf(abs: string): Promise<string> {
    const base = this.roots[0] ? await realpath(this.roots[0]).catch(() => this.roots[0]!) : "";
    const real = await realpath(abs).catch(() => abs);
    const rel = relative(base, real);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : abs;
  }

  /** Feed every chat event, in order. Returns what a finished edit changed, to show on its card. */
  /** `at` is when the event came off the stream: the queue may run it later, and the creation-time check needs the real moment. */
  async handle(event: ChatEvent, at: number = Date.now()): Promise<ToolChange | undefined> {
    switch (event.type) {
      case "tool-started":
        this.names.set(event.callId, event.name);
        this.startedAt.set(event.callId, at);
        return undefined;
      case "tool-input": {
        const target = targetOf(this.names.get(event.callId) ?? "", event.input);
        if (!target || !this.roots[0]) return undefined;
        const abs = resolve(this.roots[0], target);
        const before = await this.snapshot(abs);
        if (before.ok) this.pending.set(event.callId, { abs, before: before.text, startedAt: this.startedAt.get(event.callId) ?? Date.now() });
        return undefined;
      }
      case "tool-failed":
        this.pending.delete(event.callId);
        return undefined;
      case "tool-result": {
        const wanted = this.pending.get(event.callId);
        if (!wanted) return undefined;
        this.pending.delete(event.callId);
        const after = await this.snapshot(wanted.abs);
        if (!after.ok) return undefined;
        const before = await this.beforeOf(wanted, after.text, event.files);
        // A file rewritten by `write` whose earlier text cannot be recovered is not listed: a diff would be a guess.
        if (before === "unknown") return undefined;
        wanted.before = before;
        const change = changeOf(wanted.before, after.text);
        if (!change || (change.additions === 0 && change.deletions === 0 && change.status === "modified")) return undefined;
        const key = this.key(wanted.abs);
        let record = this.files.get(key);
        if (!record) {
          record = { id: `chg_${++this.seq}`, abs: wanted.abs, rel: await this.relOf(wanted.abs), original: wanted.before, lastAfter: after.text, edits: 0 };
          this.files.set(key, record);
        }
        record.edits++;
        record.lastAfter = after.text;
        return { callId: event.callId, id: record.id, rel: record.rel, status: change.status, additions: change.additions, deletions: change.deletions, lines: change.lines.slice(0, SHOWN_LINES), more: change.lines.length > SHOWN_LINES };
      }
      default:
        return undefined;
    }
  }

  /**
   * The text the file had before this call. The snapshot taken when the arguments were complete is only trusted when it
   * differs from the result: opencode can run the tool within a millisecond of announcing it, and a snapshot that equals
   * the result may have been taken after the write. Then, in order: the patch opencode's edit tool reports (applied
   * backwards), or the file's creation time (a file born during this call did not exist before). Otherwise unknown.
   */
  private async beforeOf(wanted: { abs: string; before: string | null; startedAt: number }, after: string | null, files: Array<{ file: string; patch: string }> | undefined): Promise<string | null | "unknown"> {
    if (wanted.before !== after) return wanted.before;
    if (after !== null && files) {
      for (const f of files) {
        const reversed = reversePatch(after, f.patch);
        if (reversed !== undefined && reversed !== after) return reversed;
      }
    }
    if (after !== null) {
      try {
        const info = await stat(wanted.abs);
        if (info.birthtimeMs >= wanted.startedAt - 5) return null;
      } catch {
        // fall through
      }
    }
    return wanted.before === after && after === null ? null : "unknown";
  }

  /** Every file edited in this chat, compared with how it is on disk right now. Files back to their original are left out. */
  async rows(): Promise<ChangeRow[]> {
    const out: ChangeRow[] = [];
    for (const record of this.files.values()) {
      const now = await this.snapshot(record.abs);
      const current = now.ok ? now.text : record.lastAfter;
      if (current === record.original) continue;
      const change = changeOf(record.original, current);
      if (!change) continue;
      out.push({ id: record.id, rel: record.rel, status: change.status, additions: change.additions, deletions: change.deletions, edits: record.edits, changedSince: now.ok && current !== record.lastAfter });
    }
    return out.sort((a, b) => a.rel.localeCompare(b.rel));
  }

  /** What `rel` looked like before this chat touched it, and where it is; undefined for an unknown id. */
  original(id: string): { abs: string; rel: string; text: string | null } | undefined {
    for (const record of this.files.values()) if (record.id === id) return { abs: record.abs, rel: record.rel, text: record.original };
    return undefined;
  }
}
