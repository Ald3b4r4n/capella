// Probe: how a prompt takes attachments (`files: [{uri, name?}]`), with free models only and nothing ever approved.
//   A. a text file by file:// URI, to a text model
//   B. a small red PNG as a data: URI and as a file:// URI, to a vision model
//   C. the same PNG to a text-only model (what a refusal looks like)
// Real opencode home (needs your credentials), throwaway project. Usage: node scripts/probe-attach.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { EventStream, OpencodeClient } from "../src/opencode/client.ts";
import { locateOpencode } from "../src/opencode/locate.ts";
import { OpencodeServer } from "../src/opencode/server.ts";

const TEXT_MODEL = "opencode/glm-5.3-flash-free";
const VISION_MODEL = "opencode/nemotron-3.5-super-vl-free";

function redPng(size = 64): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [220, 20, 20]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const binary = locateOpencode();
if (!binary) throw new Error("opencode not found");
const project = mkdtempSync(join(tmpdir(), "capella-probe-attach-"));
writeFileSync(join(project, "hello.txt"), "The secret word is PERSIMMON.\n");
const png = redPng();
writeFileSync(join(project, "red.png"), png);

const server = new OpencodeServer({ binary, cwd: project });
try {
  const client = new OpencodeClient(await server.start(), project);
  const run = async (label: string, model: string, text: string, files: Array<Record<string, unknown>>) => {
    console.log(`\n==== ${label}  [${model}]`);
    const [providerID, ...rest] = model.split("/");
    const created = await client.post<{ data: { id: string } }>("/api/session", { title: `probe ${label}`, agent: "plan", permissions: [{ action: "shell", resource: "*", effect: "deny" }, { action: "edit", resource: "*", effect: "deny" }] });
    const id = created.data.id;
    await client.post(`/api/session/${id}/model`, { model: { id: rest.join("/"), providerID } });
    let done = false;
    let answer = "";
    const stream = new EventStream(client, "/api/event", {
      onMessage: (m) => {
        let frame: { type?: string; data?: Record<string, unknown> } = {};
        try {
          frame = JSON.parse(m.data);
        } catch {
          return;
        }
        if (frame.data?.sessionID !== id) return;
        if (frame.type === "session.text.delta") answer += String(frame.data.delta ?? "");
        if (/session\.(tool\.called|execution\.failed)/.test(frame.type ?? "")) console.log("EVENT", frame.type, JSON.stringify(frame.data).slice(0, 400));
        if (/execution\.(succeeded|failed|interrupted)/.test(frame.type ?? "")) done = true;
      },
    });
    stream.start();
    await new Promise((r) => setTimeout(r, 700));
    try {
      const sent = await client.post<{ data?: unknown }>(`/api/session/${id}/prompt`, { text, files });
      console.log("prompt accepted:", JSON.stringify(sent).slice(0, 300));
    } catch (error) {
      console.log("prompt REFUSED:", String(error).slice(0, 400));
      stream.stop();
      return;
    }
    const until = Date.now() + 90000;
    while (!done && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    const messages = await client.get<{ data: Array<Record<string, unknown>> }>(`/api/session/${id}/message`);
    const user = messages.data.find((m) => m.type === "user");
    console.log("stored user message:", JSON.stringify(user).slice(0, 500));
    console.log("ANSWER:", answer.slice(0, 300));
    stream.stop();
    await client.request("DELETE", `/api/session/${id}`).catch(() => undefined);
  };
  await run("A text file", TEXT_MODEL, "What is the secret word in the attached file? One short sentence.", [{ uri: pathToFileURL(join(project, "hello.txt")).href, name: "hello.txt" }]);
  await run("B1 image data uri", VISION_MODEL, "What colour is the attached image? One word.", [{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "red.png" }]);
  await run("B2 image file uri", VISION_MODEL, "What colour is the attached image? One word.", [{ uri: pathToFileURL(join(project, "red.png")).href, name: "red.png" }]);
  await run("C image to a text-only model", TEXT_MODEL, "What colour is the attached image? One word.", [{ uri: `data:image/png;base64,${png.toString("base64")}`, name: "red.png" }]);
} finally {
  await server.stop();
  rmSync(project, { recursive: true, force: true });
}
