import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { browserChannel, browserCommand, imagePathsIn, LOCAL_ORIGINS, PLAYWRIGHT_MCP_VERSION } from "../../src/ui/browserPreset.ts";

test("the browser is the installed Edge, else Chrome; none is downloaded", () => {
  const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };
  const only = (...paths: string[]) => (p: string) => paths.includes(p);
  assert.equal(browserChannel("win32", only("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), env), "msedge");
  assert.equal(browserChannel("win32", only("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), env), "chrome");
  assert.equal(browserChannel("win32", only("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"), env), "chrome");
  assert.equal(browserChannel("win32", only(), env), undefined);
  assert.equal(browserChannel("darwin", only("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")), "chrome");
  assert.equal(browserChannel("linux", only("/usr/bin/google-chrome")), "chrome");
  assert.equal(browserChannel("linux", only()), undefined);
});

test("the command is node, the pinned package's CLI, a throwaway profile, headless, and localhost only unless the user chose the web", () => {
  const local = browserCommand("C:\\x\\cli.js", "msedge", "local", "C:\\out");
  assert.deepEqual(local, ["node", "C:\\x\\cli.js", "--browser", "msedge", "--isolated", "--headless", "--block-service-workers", "--allowed-origins", LOCAL_ORIGINS, "--output-dir", "C:\\out"]);
  const web = browserCommand("/x/cli.js", "chrome", "web", "/out");
  assert.equal(web.includes("--allowed-origins"), false);
  for (const list of [local, web]) {
    assert.equal(list.includes("--allow-unrestricted-file-access"), false, "file: pages stay blocked");
    assert.equal(list.includes("--no-sandbox"), false);
    assert.ok(list.includes("--isolated"));
  }
  assert.equal(LOCAL_ORIGINS.includes("example.com"), false);
  assert.match(PLAYWRIGHT_MCP_VERSION, /^\d+\.\d+\.\d+$/);
});

// the folder Capella gave the server, and the project the server works from
const out = resolve("C:\\Users\\Me Too\\store\\browser-output");
const project = resolve("C:\\work\\proj");
const known = (...paths: string[]) => (p: string) => paths.map((x) => x.toLowerCase()).includes(p.toLowerCase());

test("a picture named by an absolute path inside the folder Capella gave the server is found; any other is not", () => {
  const plain = `### Result\n- [Screenshot of viewport](${out}\\page-1.png)\nPage URL: http://127.0.0.1:5000/`;
  assert.deepEqual(imagePathsIn(plain, out, project, known(`${out}\\page-1.png`)), [`${out}\\page-1.png`]);
  // the same path inside a JSON string (backslashes doubled), and the drive letter in the other case
  const json = JSON.stringify({ shot: `[Screenshot](${out}\\after.jpeg)`, other: "C:\\Windows\\win.png" });
  assert.deepEqual(imagePathsIn(json, out.replace("C:", "c:"), project, known(`${out}\\after.jpeg`)), [`${out}\\after.jpeg`]);
  // elsewhere, a sibling folder with the same prefix, a traversal, a file that is not a picture, a URL
  const sibling = "C:\\Windows\\win.png and C:\\Users\\Me Too\\store\\browser-output-evil\\x.png";
  // (the stand-in for "the file exists" is true only for the files the text names, as on a real disk)
  assert.deepEqual(imagePathsIn(sibling, out, project, known("C:\\Windows\\win.png", "C:\\Users\\Me Too\\store\\browser-output-evil\\x.png")), []);
  assert.deepEqual(imagePathsIn(`${out}\\..\\secret.png`, out, project, known(resolve(out, "..\\secret.png"))), []);
  assert.deepEqual(imagePathsIn(`${out}\\notes.txt ${out}\\x.png.txt`, out, project, known(`${out}\\notes.txt`, `${out}\\x.png.txt`, `${out}\\x.png`)), []);
  assert.deepEqual(imagePathsIn("http://127.0.0.1:1/a.png", out, project, () => true), []);
  // a file that is not there is not offered
  assert.deepEqual(imagePathsIn(`${out}\\gone.png`, out, project, () => false), []);
  // several, deduplicated, and capped
  const many = Array.from({ length: 9 }, (_, i) => `${out}\\s${i % 6}.png`).join(" ");
  assert.equal(imagePathsIn(many, out, project, () => true).length, 4);
  assert.deepEqual(imagePathsIn(`${out}\\a.png ${out}\\a.png`, out, project, () => true), [`${out}\\a.png`]);
});

test("a picture named relative to the project the server works from is resolved there, and kept only inside the project or the folder Capella gave it", () => {
  // how the real server names what it saved (measured): `..\out\page-….png` for its own, `./name.png` for a name the model chose
  const own = "### Result\n- [Screenshot of viewport](..\\out\\page-2026.png)";
  const projectOut = resolve(project, "..\\out");
  assert.deepEqual(imagePathsIn(own, projectOut, project, known(resolve(projectOut, "page-2026.png"))), [resolve(projectOut, "page-2026.png")]);
  assert.deepEqual(imagePathsIn("- [Screenshot of full page](./capella-before.png)", out, project, known(resolve(project, "capella-before.png"))), [resolve(project, "capella-before.png")]);
  assert.deepEqual(imagePathsIn(JSON.stringify({ shot: "- [Screenshot](./after.png)" }), out, project, known(resolve(project, "after.png"))), [resolve(project, "after.png")]);
  // outside both: a traversal out of the project into a folder that is neither, an absolute path, a URL, a file that is not a picture
  assert.deepEqual(imagePathsIn("(../../secret.png) (C:\\Windows\\win.png) (https://example.com/a.png) (./notes.txt) (./yml.png.txt)", out, project, () => true), []);
  // and a name that is not there
  assert.deepEqual(imagePathsIn("(./ghost.png)", out, project, () => false), []);
});
