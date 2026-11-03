/**
 * Adding a plugin runs `opencode plugin add <package>`, which installs a package from npm and adds it to opencode's GLOBAL
 * configuration. Only an npm package name, with an optional version or tag, is accepted: no address, no path, no Git
 * specifier and nothing a shell could read, and the arguments go to the program as a list (no shell is used).
 * Pure, so it is unit-tested.
 */

/** `name`, `@scope/name`, each optionally followed by `@version` or `@tag`. */
export function validPluginSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0 || spec.length > 214) return false;
  return /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:@[A-Za-z0-9][A-Za-z0-9._+-]*)?$/.test(spec);
}

/** The package without its version or tag: what the list names it and what `plugin remove` takes. */
export function pluginTarget(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

export const npmPage = (spec: string): string => `https://www.npmjs.com/package/${pluginTarget(spec)}`;
