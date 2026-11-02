import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where local voice (faster-whisper and its model) lives: one folder per user, shared by every editor
 * that runs Capella, so a fork does not download the model again. `CAPELLA_VOICE_HOME` overrides it
 * (tests, or a user who wants the files elsewhere).
 */
export function voiceHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (env.CAPELLA_VOICE_HOME) return env.CAPELLA_VOICE_HOME;
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Capella", "voice");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Capella", "voice");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "capella", "voice");
}

export const venvDir = (home: string): string => join(home, "venv");
export const modelCacheDir = (home: string): string => join(home, "models");

/** The Python inside the private virtual environment. */
export function venvPython(home: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? join(venvDir(home), "Scripts", "python.exe") : join(venvDir(home), "bin", "python");
}

/**
 * Where the Antares extension keeps its own local voice, if this machine has it. Antares and Capella use the same
 * private Python environment and Whisper model, so a user who already set it up can reuse it instead of downloading
 * about 450 MB again. Capella never writes there on its own: it only offers to point at it (see setupVoice).
 */
export function antaresVoiceHome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Antares", "voice");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Antares", "voice");
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "antares", "voice");
}
