// Previewing a page: a read-only static server bound to 127.0.0.1 for a folder, and finding the local URLs an agent prints.
// The server is the risky part (a path that escapes the folder, a dotfile, another site talking to it), so those are tested hard.
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractLocalUrls, isPreviewableUrl, startPreviewServer } from "../../src/ui/staticServer.ts";

function get(url: string, opts: { method?: string; headers?: Record<string, string>; path?: string } = {}): Promise<{ status: number; body: string; type?: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: opts.path ?? u.pathname + u.search, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, type: res.headers["content-type"], headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function site() {
  const outer = mkdtempSync(join(tmpdir(), "capella-prev-"));
  const root = join(outer, "site");
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<h1>home</h1>");
  writeFileSync(join(root, "about.html"), "<h1>about</h1>");
  writeFileSync(join(root, "assets", "app.css"), "body{color:red}");
  writeFileSync(join(root, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(root, ".env"), "SECRET=1");
  writeFileSync(join(root, ".git", "config"), "x");
  writeFileSync(join(outer, "outside.txt"), "outside the site folder");
  return { outer, root, done: () => rmSync(outer, { recursive: true, force: true }) };
}

test("the server serves files with the right types, index.html for a folder, and binds to 127.0.0.1 only", async () => {
  const s = site();
  const server = await startPreviewServer(s.root);
  try {
    assert.match(server.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const home = await get(server.baseUrl);
    assert.equal(home.status, 200);
    assert.equal(home.body, "<h1>home</h1>");
    assert.match(home.type ?? "", /text\/html/);
    assert.match((await get(server.baseUrl + "assets/app.css")).type ?? "", /text\/css/);
    assert.match((await get(server.baseUrl + "assets/app.js")).type ?? "", /javascript/);
    assert.equal((await get(server.baseUrl + "about.html")).body, "<h1>about</h1>");
    assert.equal((await get(server.baseUrl + "assets/")).status, 404, "no directory listing");
    assert.equal((await get(server.baseUrl + "nope.html")).status, 404);
  } finally {
    await server.close();
    s.done();
  }
});

test("a path cannot leave the folder, in any spelling", async () => {
  const s = site();
  const server = await startPreviewServer(s.root);
  try {
    for (const path of ["/../outside.txt", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/assets/../../outside.txt", "/..\\outside.txt", "/%2e%2e%5coutside.txt", "//outside.txt", "/assets/%00.css"]) {
      const r = await get(server.baseUrl, { path });
      assert.notEqual(r.body, "outside the site folder", path);
      assert.ok(r.status === 400 || r.status === 403 || r.status === 404, `${path} -> ${r.status}`);
    }
  } finally {
    await server.close();
    s.done();
  }
});

test("dotfiles and version-control folders are never served", async () => {
  const s = site();
  const server = await startPreviewServer(s.root);
  try {
    assert.equal((await get(server.baseUrl + ".env")).status, 404);
    assert.equal((await get(server.baseUrl + ".git/config")).status, 404);
  } finally {
    await server.close();
    s.done();
  }
});

test("a link inside the folder that points outside it is not followed", async () => {
  const s = site();
  try {
    symlinkSync(join(s.outer, "outside.txt"), join(s.root, "link.txt"));
  } catch {
    s.done();
    return; // creating a symlink needs a privilege some Windows setups do not give: nothing to test there
  }
  const server = await startPreviewServer(s.root);
  try {
    const r = await get(server.baseUrl + "link.txt");
    assert.notEqual(r.body, "outside the site folder");
    assert.ok(r.status === 403 || r.status === 404);
  } finally {
    await server.close();
    s.done();
  }
});

test("only GET and HEAD are answered, and only for this server's own host name (no DNS rebinding)", async () => {
  const s = site();
  const server = await startPreviewServer(s.root);
  try {
    assert.equal((await get(server.baseUrl, { method: "POST" })).status, 405);
    assert.equal((await get(server.baseUrl, { method: "PUT" })).status, 405);
    assert.equal((await get(server.baseUrl, { method: "HEAD" })).status, 200);
    assert.equal((await get(server.baseUrl, { headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await get(server.baseUrl, { headers: { Host: `localhost:${new URL(server.baseUrl).port}` } })).status, 200);
  } finally {
    await server.close();
    s.done();
  }
});

test("responses carry no-store and nosniff, and the server stops when closed", async () => {
  const s = site();
  const server = await startPreviewServer(s.root);
  const r = await get(server.baseUrl);
  assert.match(String(r.headers["cache-control"]), /no-store/);
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  await server.close();
  await assert.rejects(get(server.baseUrl));
  s.done();
});

test("extractLocalUrls finds the dev-server addresses an agent prints, once each, in order", () => {
  const text = "  VITE v5  ready in 300 ms\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.0.5:5173/\nlistening on http://127.0.0.1:3000/app?x=1 and again http://localhost:5173/ and [::1] http://[::1]:8080";
  assert.deepEqual(extractLocalUrls(text), ["http://localhost:5173/", "http://127.0.0.1:3000/app?x=1", "http://[::1]:8080"]);
  assert.deepEqual(extractLocalUrls("nothing here, see https://example.com and http://10.0.0.2:80"), []);
});

test("isPreviewableUrl accepts http(s) only", () => {
  assert.equal(isPreviewableUrl("http://localhost:3000/"), true);
  assert.equal(isPreviewableUrl("https://example.com/page"), true);
  for (const bad of ["file:///C:/x.html", "javascript:alert(1)", "data:text/html,x", "vscode://x", "ftp://x", "", "localhost:3000"]) assert.equal(isPreviewableUrl(bad), false, bad);
});
