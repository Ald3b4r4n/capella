/**
 * When the agent reads a picture with its `read` tool, the card can show the picture. This tells which tool calls those are:
 * a call of the `read` tool whose file is a PNG, JPEG, GIF or WebP by its name. Only the name decides whether to LOOK; what
 * is shown is decided by the host's own checks (inside the open folder, really a picture, small enough). Pure, so it is
 * unit-tested.
 */
const PICTURE = /\.(?:png|jpe?g|gif|webp)$/i;

export function readImagePath(toolName: string | undefined, input: unknown): string | undefined {
  if (!toolName || !/^read(?:_file)?$/i.test(toolName)) return undefined;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "filePath", "file_path", "file"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && value.length < 1024 && PICTURE.test(value)) return value;
  }
  return undefined;
}
