import { readFileSync, statSync } from "node:fs";

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  durationMs: number;
}

const MAX_READ_BYTES = 64 * 1024 * 1024;

/** Reads the header of a PCM WAV held in memory. Returns undefined when it is not a PCM WAV. */
export function parseWavHeader(buf: Buffer): WavInfo | undefined {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bits: number; tag: number } | undefined;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 8 + 16 <= buf.length) {
      fmt = { tag: buf.readUInt16LE(offset + 8), channels: buf.readUInt16LE(offset + 10), sampleRate: buf.readUInt32LE(offset + 12), bits: buf.readUInt16LE(offset + 22) };
    } else if (id === "data") {
      if (!fmt || fmt.tag !== 1 || fmt.channels < 1 || fmt.sampleRate < 1 || fmt.bits < 8) return undefined;
      const available = Math.max(0, buf.length - (offset + 8));
      // A recorder that was cut off can leave a data size that is 0 or larger than the file: trust the real length.
      const dataBytes = size === 0 || size > available ? available : size;
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataBytes, durationMs: Math.round((dataBytes / bytesPerSecond) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

/** Describes a WAV file on disk. Recordings are short, so the file is read whole (capped at 64 MB). */
export function readWavInfo(path: string): WavInfo | undefined {
  if (statSync(path).size > MAX_READ_BYTES) return undefined;
  return parseWavHeader(readFileSync(path));
}

/** A silent mono 16-bit PCM WAV of the given length (used by tests and the fake recorder). */
export function silentWav(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
