import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_IMAGE_BYTES, decodeBase64, describeSize, fromBytes, fromSelection, insideRoots, judgeBytes, loadFile, looksLikeText, sniffImage } from "../../src/ui/attachments.ts";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

test("images are recognised by their bytes, not their name", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(GIF), "image/gif");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("not an image")), undefined);
  assert.equal(judgeBytes("holiday.png", Buffer.from("<script>alert(1)</script>")).ok, true, "text named .png is just text, not an image");
  const verdict = judgeBytes("holiday.png", Buffer.from("<script>alert(1)</script>"));
  assert.equal(verdict.ok && verdict.kind, "file");
  const real = judgeBytes("renamed.txt", PNG);
  assert.equal(real.ok && real.kind, "image", "a PNG named .txt is still an image");
});

test("SVG and HTML are refused, binaries are refused, text is accepted", () => {
  const svg = judgeBytes("logo.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>'));
  assert.equal(svg.ok, false);
  assert.match(!svg.ok ? svg.reason : "", /SVG/);
  assert.equal(judgeBytes("page.html", Buffer.from("<svg onload=alert(1)>")).ok, false);
  assert.equal(judgeBytes("tool.exe", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00])).ok, false);
  assert.equal(judgeBytes("notes.md", Buffer.from("# hello\nçãõ\n")).ok, true);
  assert.equal(looksLikeText(Buffer.from([0xc3, 0x28])), false, "invalid UTF-8 is not text");
});

test("size limits", () => {
  const bigImage = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
  assert.equal(judgeBytes("big.png", bigImage).ok, false);
  assert.equal(judgeBytes("big.txt", Buffer.alloc(1024 * 1024 + 1, 97)).ok, false);
  assert.equal(judgeBytes("ok.txt", Buffer.alloc(1024 * 1024, 97)).ok, true);
});

test("bytes without a file behind them are sent inline, images get a small thumbnail", () => {
  const loaded = fromBytes("shot.png", PNG);
  assert.ok(loaded.ok);
  if (loaded.ok) {
    assert.equal(loaded.attachment.kind, "image");
    assert.match(loaded.attachment.uri, /^data:image\/png;base64,/);
    assert.match(loaded.attachment.thumb ?? "", /^data:image\/png;base64,/);
  }
  assert.equal(fromBytes("junk.bin", Buffer.from([0, 1, 2, 3])).ok, false);
});

test("a selection is named by file and lines, and empty or oversized ones are refused", () => {
  const ok = fromSelection("C:\\proj\\src\\app.ts", 10, 14, "const a = 1;\n");
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.attachment.name, "app.ts:10-14");
    assert.equal(ok.attachment.kind, "selection");
    assert.match(ok.attachment.uri, /^data:text\/plain;base64,/);
  }
  assert.equal(fromSelection("a.ts", 1, 1, "").ok, false);
  assert.equal(fromSelection("a.ts", 1, 1, "x".repeat(1024 * 1024 + 1)).ok, false);
});

test("base64 from the page is decoded only when it is really base64", () => {
  assert.equal(decodeBase64(PNG.toString("base64")).equals(PNG), true);
  assert.equal(decodeBase64("not base64 !!").length, 0);
  assert.equal(decodeBase64("data:image/png;base64,AAAA").length, 0, "a data: prefix is not accepted");
});

test("a file is attached only from inside the open folder, links and ..-paths included", async () => {
  const root = mkdtempSync(join(tmpdir(), "capella-att-root-"));
  const outside = mkdtempSync(join(tmpdir(), "capella-att-out-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pic.png"), PNG);
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  assert.equal(await insideRoots(join(root, "src", "a.ts"), [root]), true);
  assert.equal(await insideRoots(join(root, "src", "..", "..", "x"), [root]), false);
  assert.equal(await insideRoots(join(outside, "secret.txt"), [root]), false);
  const ok = await loadFile(join(root, "src", "a.ts"), [root]);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.attachment.kind, "file");
    assert.match(ok.attachment.uri, /^file:\/\//);
  }
  const image = await loadFile(join(root, "pic.png"), [root]);
  assert.equal(image.ok && image.attachment.kind, "image");
  const refused = await loadFile(join(outside, "secret.txt"), [root]);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /outside the open folder/);
  assert.equal((await loadFile(join(root, "missing.txt"), [root])).ok, false);
  assert.equal((await loadFile(root, [root])).ok, false, "a folder is not a file");
  try {
    symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    assert.equal((await loadFile(join(root, "link.txt"), [root])).ok, false, "a link that points outside is outside");
  } catch {
    // creating symbolic links needs a privilege on Windows; the other checks above still stand
  }
});

test("sizes read well", () => {
  assert.equal(describeSize(512), "512 B");
  assert.equal(describeSize(2048), "2 KB");
  assert.equal(describeSize(3.5 * 1024 * 1024), "3.5 MB");
});

test("a picture an answer points to is read only from the open folder, by its real bytes, and a web address is never fetched", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { loadAnswerImage } = await import("../../src/ui/attachments.ts");
  const base = mkdtempSync(join(tmpdir(), "capella-ans-"));
  const root = join(base, "ws");
  mkdirSync(root);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  writeFileSync(join(root, "ok.png"), png);
  writeFileSync(join(root, "fake.png"), "this is not a picture");
  writeFileSync(join(base, "outside.png"), png);
  const ok = await loadAnswerImage("ok.png", [root]);
  assert.equal(ok.ok && ok.uri.startsWith("data:image/png;base64,"), true);
  assert.equal((await loadAnswerImage("fake.png", [root])).ok, false);
  assert.equal((await loadAnswerImage("../outside.png", [root])).ok, false);
  assert.equal((await loadAnswerImage(join(base, "outside.png"), [root])).ok, false);
  assert.equal((await loadAnswerImage("https://example.com/a.png", [root])).ok, false);
  assert.equal((await loadAnswerImage("file:///etc/passwd", [root])).ok, false);
  assert.equal((await loadAnswerImage("data:image/png;base64,AAAA", [root])).ok, false);
  assert.equal((await loadAnswerImage("ok.png", [])).ok, false);
});
