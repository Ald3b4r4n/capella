/**
 * Page preview: when a dev server the agent started prints a local address, Capella offers to open it in the editor's
 * Simple Browser. Pure parsing here; the opening itself is in the chat panel.
 */

/** Hosts that are this machine. Anything else is never opened with one click. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi;

/** Returns the URL when it is http(s) on this machine, else undefined. Userinfo and odd ports are refused. */
export function localPreviewUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (!LOCAL_HOSTS.has(url.hostname.startsWith("[") ? url.hostname : url.hostname)) return undefined;
  if (url.port !== "" && (Number(url.port) < 1 || Number(url.port) > 65535)) return undefined;
  return url.toString();
}

/** The first local address in a text (a tool's input or output), or undefined. */
export function findLocalUrl(text: string): string | undefined {
  for (const match of text.matchAll(URL_PATTERN)) {
    const ok = localPreviewUrl(match[0].replace(/[.,;:]+$/, ""));
    if (ok) return ok;
  }
  return undefined;
}
