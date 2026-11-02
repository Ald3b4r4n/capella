import { context, build } from "esbuild";

const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "dist/extension.cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info",
};

// The chat page runs in the webview: a browser bundle, no Node, no vscode module.
const webview = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outfile: "dist/chat.js",
  sourcemap: false,
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  for (const options of [extension, webview]) await (await context(options)).watch();
} else {
  await Promise.all([build(extension), build(webview)]);
}
