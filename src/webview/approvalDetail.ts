/**
 * What an approval card says about the thing it asks to allow. opencode's request names a permission (`shell`, `edit`,
 * `browser_browser_navigate`) and a resource that is often only `*`, so the card could not say WHAT would happen. The tool
 * call the request belongs to carries that (its input), and this turns it into a few readable lines: the command, the file,
 * the address, or, for an MCP tool called through opencode's code tool, the call itself with its arguments. Pure text in,
 * text out (the page puts it in with textContent, never as markup), so it is unit-tested.
 */

export interface ApprovalDetail {
  /** One sentence: what is being asked. */
  headline?: string;
  /** The specifics, one per line: arguments, command, file. */
  lines: string[];
  /** A longer text worth showing in full on demand (the code of a call). */
  code?: string;
}

const MAX_LINE = 240;
const MAX_CALLS = 6;

const clip = (text: string, max = MAX_LINE): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const one = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v) ?? String(v));
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The calls `tools.<server>.<tool>(<arguments>)` in a piece of code, with their arguments cut at the matching bracket. */
export function mcpCallsIn(code: string): Array<{ server: string; tool: string; args: string }> {
  const out: Array<{ server: string; tool: string; args: string }> = [];
  const re = /\btools\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\(/g;
  for (let m = re.exec(code); m && out.length < MAX_CALLS; m = re.exec(code)) {
    let depth = 1;
    let i = m.index + m[0].length;
    let quote: string | undefined;
    for (; i < code.length && depth > 0 && i - m.index < 2000; i++) {
      const ch = code[i]!;
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = undefined;
      } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    out.push({ server: m[1]!, tool: m[2]!, args: code.slice(m.index + m[0].length, depth === 0 ? i - 1 : i).replace(/\s+/g, " ").trim() });
  }
  return out;
}

/**
 * `action` is the permission asked, `tool` the name of the tool call it belongs to (when known) and `input` that call's
 * arguments. Nothing is returned for a request whose call is unknown: the card then keeps what opencode sent.
 */
export function describeApproval(action: string, tool: string | undefined, input: unknown): ApprovalDetail | undefined {
  if (!isRecord(input)) return undefined;
  const code = typeof input.code === "string" ? input.code : undefined;
  if (code !== undefined) {
    const calls = mcpCallsIn(code);
    if (calls.length > 0) {
      const asked = calls.find((c) => action.endsWith(`${c.tool}`) || action === `${c.server}_${c.tool}`) ?? calls[0]!;
      return {
        headline: `Calls the "${asked.tool}" tool of the "${asked.server}" server`,
        lines: calls.map((c) => clip(`${c.server}.${c.tool}(${c.args})`)),
        code: code.length > 12 ? clip(code, 4000) : undefined,
      };
    }
    return { headline: "Runs code through opencode", lines: [], code: clip(code, 4000) };
  }
  const first = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof input[k] === "string" && input[k] !== "") return input[k] as string;
    return undefined;
  };
  if (/^(shell|bash)$/.test(action) || /^(bash|shell)$/i.test(tool ?? "")) {
    const command = first("command", "cmd");
    return command ? { headline: "Runs this command", lines: [clip(command, 600)] } : undefined;
  }
  if (action === "edit" || /^(edit|write|patch|apply_patch)$/i.test(tool ?? "")) {
    const file = first("path", "filePath", "file_path", "file");
    const content = first("content", "newString", "new_string", "patch");
    return file ? { headline: /write/i.test(tool ?? "") ? "Writes this file" : "Changes this file", lines: [file, ...(content ? [`${content.split("\n").length} line${content.split("\n").length === 1 ? "" : "s"} of new text`] : [])] } : undefined;
  }
  if (action === "webfetch" || action === "websearch") {
    const target = first("url", "query");
    return target ? { headline: action === "webfetch" ? "Fetches this page" : "Searches the web for", lines: [clip(target)] } : undefined;
  }
  // anything else: its arguments as `name: value`, long texts shortened
  const lines = Object.entries(input).flatMap(([k, v]): string[] => (v === undefined || v === null || v === "" ? [] : [clip(`${k}: ${typeof v === "string" && v.length > 160 ? `${v.slice(0, 159)}… (${v.length} characters)` : one(v)}`)])).slice(0, 8);
  return lines.length > 0 ? { lines } : undefined;
}
