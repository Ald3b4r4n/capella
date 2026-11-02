/**
 * Line diffs, computed here. opencode's own `GET /api/session/{id}/diff` answered with an empty list in every probe
 * (also in a git repository) and its revert staged nothing, so Capella keeps the text of a file from just before each
 * edit and compares it with the text just after. Myers' O(ND) algorithm, so a large file with a small edit is cheap.
 * Pure: no filesystem, no editor.
 */

export type Op = { kind: "keep" | "add" | "del"; text: string };

/** Splits into lines the way an editor counts them: a final newline does not start an extra empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The edit script between two line lists. Gives up (undefined) when the two are too different to be worth showing. */
export function diffLines(a: string[], b: string[], maxEdits = 2000): Op[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    // Only the diagonals this round can read are kept (-d-1 .. d+1), so memory grows with D squared, not with the file.
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) return undefined;
  // Walk back through the saved frontiers to recover the script.
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const frontier = trace[d]!;
    const k = x - y;
    const at = (diagonal: number) => frontier[diagonal + d + 1]!;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > (down ? prevX : prevX + 1) && y > (down ? prevY + 1 : prevY)) {
      ops.push({ kind: "keep", text: a[x - 1]! });
      x--;
      y--;
    }
    if (down) {
      ops.push({ kind: "add", text: b[y - 1]! });
      y--;
    } else {
      ops.push({ kind: "del", text: a[x - 1]! });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "keep", text: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface Counts {
  additions: number;
  deletions: number;
}

export function countOps(ops: readonly Op[]): Counts {
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "add") additions++;
    else if (op.kind === "del") deletions++;
  }
  return { additions, deletions };
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each line prefixed by `+`, `-` or a space. */
  lines: string[];
}

/** Groups changes with `context` unchanged lines around them, merging hunks that touch. */
export function hunksOf(ops: readonly Op[], context = 3): Hunk[] {
  const changed: number[] = [];
  ops.forEach((op, i) => op.kind !== "keep" && changed.push(i));
  if (changed.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }
  // Line numbers before each op, so a hunk can say where it starts.
  const oldBefore: number[] = [];
  const newBefore: number[] = [];
  let o = 0;
  let nn = 0;
  for (const op of ops) {
    oldBefore.push(o);
    newBefore.push(nn);
    if (op.kind !== "add") o++;
    if (op.kind !== "del") nn++;
  }
  return ranges.map(([from, to]) => {
    const slice = ops.slice(from, to + 1);
    const oldLines = slice.filter((op) => op.kind !== "add").length;
    const newLines = slice.filter((op) => op.kind !== "del").length;
    return {
      oldStart: oldLines === 0 ? oldBefore[from]! : oldBefore[from]! + 1,
      oldLines,
      newStart: newLines === 0 ? newBefore[from]! : newBefore[from]! + 1,
      newLines,
      lines: slice.map((op) => (op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ") + op.text),
    };
  });
}

/** A unified diff, like `git diff` prints, for one file. `before` null means the file did not exist. */
export function unifiedPatch(path: string, before: string | null, after: string | null, context = 3): string | undefined {
  const ops = diffLines(splitLines(before ?? ""), splitLines(after ?? ""));
  if (!ops) return undefined;
  const hunks = hunksOf(ops, context);
  if (hunks.length === 0) return "";
  const head = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
  return [...head, ...hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines])].join("\n") + "\n";
}

export interface FileChange {
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** Lines of the changed regions, `+`/`-`/space prefixed, hunk headers as `@@` lines. */
  lines: string[];
}

/** What changed between two texts of one file. Undefined when they are too different to diff cheaply. */
export function changeOf(before: string | null, after: string | null, context = 3): FileChange | undefined {
  const ops = diffLines(splitLines(before ?? ""), splitLines(after ?? ""));
  if (!ops) return undefined;
  const { additions, deletions } = countOps(ops);
  const hunks = hunksOf(ops, context);
  return {
    status: before === null ? "added" : after === null ? "deleted" : "modified",
    additions,
    deletions,
    lines: hunks.flatMap((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]),
  };
}

/**
 * The text a file had BEFORE a unified patch, given the text it has after it. Works backwards: each hunk's new-side
 * lines (context and additions) must match the file where the hunk says, and are replaced by its old-side lines. Any
 * mismatch gives undefined, never a guess. Header lines before the first `@@` (such as `Index:`) are ignored.
 */
export function reversePatch(after: string, patch: string): string | undefined {
  const lines = splitLines(after);
  const out: string[] = [];
  let cursor = 0;
  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const patchLines = patch.split(/\r?\n/);
  let i = patchLines.findIndex((l) => hunkHead.test(l));
  if (i < 0) return undefined;
  while (i < patchLines.length) {
    const head = hunkHead.exec(patchLines[i]!);
    if (!head) {
      i++;
      continue;
    }
    const newLines = Number(head[4] ?? "1");
    const newStart = newLines === 0 ? Number(head[3]) : Number(head[3]) - 1;
    if (newStart < cursor || newStart > lines.length) return undefined;
    out.push(...lines.slice(cursor, newStart));
    cursor = newStart;
    i++;
    while (i < patchLines.length && !hunkHead.test(patchLines[i]!)) {
      const line = patchLines[i]!;
      i++;
      if (line.startsWith("\\")) continue;
      const mark = line[0];
      const text = line.slice(1);
      if (mark === " ") {
        if (lines[cursor] !== text) return undefined;
        out.push(text);
        cursor++;
      } else if (mark === "+") {
        if (lines[cursor] !== text) return undefined;
        cursor++;
      } else if (mark === "-") out.push(text);
      else if (line === "" && i >= patchLines.length) break;
      else return undefined;
    }
  }
  out.push(...lines.slice(cursor));
  return out.length === 0 ? "" : out.join("\n") + (after.endsWith("\n") ? "\n" : "");
}
