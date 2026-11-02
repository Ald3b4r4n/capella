/**
 * The text of "Capella: Compatibility diagnostics". Built to be pasted into a bug report, so it carries no secret and
 * nothing personal: no API key, no server password, no user name or folder path (the opencode executable is shown by
 * file name only), and no content of any chat.
 */
import type { Compatibility } from "./compat.ts";

export interface DiagnosticsInput {
  capellaVersion: string;
  editor: { name: string; version: string };
  platform: string;
  /** Why opencode could not be started, when it could not. */
  startError?: string;
  opencode?: { version?: string; executable?: string; foundBy?: "setting" | "search" };
  compat?: Compatibility;
  /** Frames the event mapper did not recognise, by type: a sign the API moved. */
  unknownEvents: ReadonlyMap<string, number>;
  updates: { enabled: boolean; latest?: string; checkedAtMs?: number; package?: string };
  now: number;
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

const STATUS_TEXT: Record<Compatibility["status"], string> = {
  ok: "OK",
  newer: "OK, newer than tested",
  degraded: "Working, with parts switched off",
  broken: "Not compatible",
  unsupported: "Unsupported API generation",
  unknown: "Could not be checked",
};

export function buildReport(input: DiagnosticsInput): string {
  const lines: string[] = ["# Capella compatibility diagnostics", ""];
  lines.push(`- Capella ${input.capellaVersion} in ${input.editor.name} ${input.editor.version} (${input.platform})`);
  if (input.opencode) lines.push(`- opencode ${input.opencode.version ?? "version unknown"}${input.opencode.executable ? `, executable \`${basename(input.opencode.executable)}\`` : ""}${input.opencode.foundBy ? ` (${input.opencode.foundBy === "setting" ? "from the capella.opencodePath setting" : "found on this machine"})` : ""}`);
  if (input.startError) lines.push(`- opencode could not be started: ${input.startError}`);
  lines.push("");
  const compat = input.compat;
  if (compat) {
    lines.push(`## Verdict: ${STATUS_TEXT[compat.status]}`, "", compat.summary, "");
    lines.push(`- API generation: ${compat.generation}`);
    lines.push(`- Last tested with opencode ${compat.testedVersion}`);
    lines.push(`- Fingerprint of the routes Capella uses: ${compat.usedFingerprint} (tested: ${compat.testedFingerprint})`);
    lines.push("", "## What Capella needs", "", "| | Feature | Needed for |", "|---|---|---|");
    for (const c of compat.capabilities) lines.push(`| ${c.present ? "✔" : c.essential ? "✘" : "–"} | ${c.label} | ${c.essential ? "the chat itself" : "an optional part"} |`);
    const missing = compat.capabilities.flatMap((c) => c.missing);
    if (missing.length > 0) lines.push("", "Routes missing from this opencode:", ...missing.map((m) => `- \`${m}\``));
    if (compat.removedSinceTested.length > 0) lines.push("", `Routes Capella used at ${compat.testedVersion} that are gone:`, ...compat.removedSinceTested.map((m) => `- \`${m}\``));
  } else if (!input.startError) {
    lines.push("## Verdict: not checked yet", "", "Open the Capella chat once so opencode is started, then run this again.");
  }
  lines.push("", "## Events", "");
  if (input.unknownEvents.size === 0) lines.push("No unrecognised event types were seen in this session.");
  else {
    lines.push("Event types the chat did not recognise (counted, not an error; many of them can mean the API moved):");
    for (const [type, count] of [...input.unknownEvents].sort((a, b) => b[1] - a[1]).slice(0, 25)) lines.push(`- \`${type}\` × ${count}`);
  }
  lines.push("", "## Updates", "");
  if (!input.updates.enabled) lines.push("The periodic check for new opencode versions is switched off (capella.updates.check).");
  else if (input.updates.latest) lines.push(`Latest published \`${input.updates.package ?? "opencode"}\`: ${input.updates.latest}${input.updates.checkedAtMs ? `, checked ${Math.max(0, Math.round((input.now - input.updates.checkedAtMs) / 60000))} min ago` : ""}.`);
  else lines.push("No version check has completed yet (it needs network access and only asks npm for a version number).");
  lines.push("", "_This report contains no API keys, passwords, folder paths or chat content._", "");
  return lines.join("\n");
}
