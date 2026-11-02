/**
 * What may be attached to a message, and the checks that decide it. opencode's prompt takes `files: [{uri, name}]`
 * (observed on 2.2.5: a `file://` URI is read by the server, a `data:` URI travels inline). Everything an attachment
 * is allowed to be is decided HERE, in the extension, never by the page:
 *  - images only as PNG, JPEG, GIF or WebP (SVG can carry script), up to 5 MB, and the bytes must really be that type;
 *  - other files only if they are text (valid UTF-8, no NUL bytes), up to 1 MB;
 *  - a file from disk only when it sits inside the open folder(s), after resolving symbolic links and short names;
 *  - at most 10 attachments per message.
 * Pure functions plus one filesystem reader; no vscode import, so it is tested without an editor.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TEXT_BYTES = 1024 * 1024;
/** A thumbnail is only sent to the page for small images. */
export const MAX_THUMB_BYTES = 256 * 1024;

export type AttachmentKind = "image" | "file" | "selection";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mime: string;
  bytes: number;
  /** What goes to opencode: a `file://` URI for a file on disk, or a `data:` URI for pasted/selected content. */
  uri: string;
  /** A small `data:` image for the chip, only for images up to MAX_THUMB_BYTES. */
  thumb?: string;
}

export type Verdict = { ok: true; kind: "image" | "file"; mime: string } | { ok: false; reason: string };

/** The image type the bytes really are, or undefined. The file's name or declared type is never trusted. */
export function sniffImage(buf: Uint8Array): string | undefined {
  const at = (offset: number, bytes: number[]) => bytes.every((b, i) => buf[offset + i] === b);
  if (buf.length >= 8 && at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (buf.length >= 3 && at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (buf.length >= 6 && (at(0, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(0, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "image/gif";
  if (buf.length >= 12 && at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return "image/webp";
  return undefined;
}

export function looksLikeText(buf: Uint8Array): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

const SVG = /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i;

export function judgeBytes(name: string, buf: Uint8Array): Verdict {
  const image = sniffImage(buf);
  if (image) return buf.length <= MAX_IMAGE_BYTES ? { ok: true, kind: "image", mime: image } : { ok: false, reason: `${name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
  if (/\.(svgz?|html?|xhtml)$/i.test(name) && SVG.test(new TextDecoder().decode(buf.subarray(0, 512)))) return { ok: false, reason: `${name} is an SVG image: SVG can carry script, so only PNG, JPEG, GIF and WebP images are attached.` };
  if (buf.length > MAX_TEXT_BYTES) return { ok: false, reason: `${name} is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MB.` };
  if (!looksLikeText(buf)) return { ok: false, reason: `${name} is not a text file or a PNG, JPEG, GIF or WebP image, so it is not attached.` };
  return { ok: true, kind: "file", mime: "text/plain" };
}

/** True when `path` is inside one of `roots`, comparing real paths (links and short names resolved) without case on Windows. */
export async function insideRoots(path: string, roots: readonly string[]): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return false;
  }
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue;
    }
    const rel = relative(fold(realRoot), fold(real));
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return true;
  }
  return false;
}

/**
 * An image an answer points to (`![alt](path)`), as a `data:` URI for the page. Only a picture on disk inside the open
 * folder(s): the bytes must really be PNG, JPEG, GIF or WebP (a name is never trusted) and at most MAX_IMAGE_BYTES. A web
 * address is never fetched: that would let an answer make the editor contact a server of the model's choosing.
 */
export async function loadAnswerImage(src: string, roots: readonly string[]): Promise<{ ok: true; uri: string } | { ok: false; reason: string }> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return { ok: false, reason: "Only pictures from the open folder are shown." };
  const root = roots[0];
  if (!root) return { ok: false, reason: "No folder is open." };
  const absolute = resolve(root, src);
  const shown = basename(absolute);
  try {
    await stat(absolute);
  } catch {
    return { ok: false, reason: `${shown} was not found.` };
  }
  if (!(await insideRoots(absolute, roots))) return { ok: false, reason: `${shown} is outside the open folder.` };
  const loaded = await loadFile(absolute, roots);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  if (loaded.attachment.kind !== "image") return { ok: false, reason: `${loaded.attachment.name} is not a picture Capella can show.` };
  try {
    return { ok: true, uri: dataUri(loaded.attachment.mime, await readFile(absolute)) };
  } catch {
    return { ok: false, reason: `${loaded.attachment.name} could not be read.` };
  }
}

export function dataUri(mime: string, buf: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

export function thumbFor(mime: string, buf: Uint8Array): string | undefined {
  return mime.startsWith("image/") && buf.length <= MAX_THUMB_BYTES ? dataUri(mime, buf) : undefined;
}

let counter = 0;
export const newId = (): string => `att_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export type Loaded = { ok: true; attachment: Attachment } | { ok: false; reason: string };

/** A file on disk, inside the open folder(s). Read and judged here; opencode later reads the same path by its URI. */
export async function loadFile(path: string, roots: readonly string[]): Promise<Loaded> {
  const name = basename(path);
  const absolute = resolve(path);
  if (!(await insideRoots(absolute, roots))) return { ok: false, reason: `${name} is outside the open folder, so it is not attached. Open its folder in the editor first.` };
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { ok: false, reason: `${name} is not a file.` };
    size = info.size;
  } catch {
    return { ok: false, reason: `${name} could not be read.` };
  }
  // A cheap size check before reading a large file into memory.
  if (size > MAX_IMAGE_BYTES) return { ok: false, reason: `${name} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
  let buf: Buffer;
  try {
    buf = await readFile(absolute);
  } catch {
    return { ok: false, reason: `${name} could not be read.` };
  }
  const verdict = judgeBytes(name, buf);
  if (!verdict.ok) return verdict;
  return { ok: true, attachment: { id: newId(), name, kind: verdict.kind, mime: verdict.mime, bytes: buf.length, uri: pathToFileURL(absolute).href, thumb: thumbFor(verdict.mime, buf) } };
}

/** Bytes that arrived without a file behind them (a pasted or dropped image, a dropped text file). Sent inline. */
export function fromBytes(name: string, buf: Uint8Array): Loaded {
  const verdict = judgeBytes(name, buf);
  if (!verdict.ok) return verdict;
  return { ok: true, attachment: { id: newId(), name, kind: verdict.kind, mime: verdict.mime, bytes: buf.length, uri: dataUri(verdict.mime, buf), thumb: thumbFor(verdict.mime, buf) } };
}

/** A piece of the open editor's text. Sent inline, named by file and lines. */
export function fromSelection(file: string, firstLine: number, lastLine: number, text: string): Loaded {
  const buf = new TextEncoder().encode(text);
  const name = `${basename(file)}:${firstLine}-${lastLine}`;
  if (buf.length === 0) return { ok: false, reason: "Nothing is selected." };
  if (buf.length > MAX_TEXT_BYTES) return { ok: false, reason: "The selection is larger than 1 MB." };
  return { ok: true, attachment: { id: newId(), name, kind: "selection", mime: "text/plain", bytes: buf.length, uri: dataUri("text/plain", buf) } };
}

/** `data:` for a clipboard image arriving as base64 from the page. Invalid base64 gives an empty buffer, which is then refused. */
export function decodeBase64(value: string): Buffer {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) ? Buffer.from(value, "base64") : Buffer.alloc(0);
}

export function describeSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
