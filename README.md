<p align="center"><img src="media/capella.png" alt="Capella" width="96"></p>

# Capella

An editor interface for [opencode](https://opencode.ai), with its **Zen** (pay as you go) and **Go** (subscription) models, for VS Code and VS Code–based editors such as Antigravity. Capella talks to your locally installed `opencode` through its own server API, so opencode keeps doing the login, the model calls and the permission checks.

> **Status: release candidate (0.1.0).** Checked in real VS Code and Antigravity IDE windows against a real opencode 2.2.5, and (chat, approvals, modes, models, History) against 1.19.5. What was *not* exercised is listed under "Not verified" below.

## What works

- Chat with streaming text, collapsible reasoning and a step-by-step timeline of tool calls.
- Four permission modes built from opencode agents and rules: **Plan** (default, read-only), **Review each change**, **Accept edits** and **Bypass** (asks for confirmation). Capella never answers an approval by itself: Allow once, Always allow or Reject is always your click.
- Model picker grouped as Zen, Go and other providers, with free models marked. A model is always selected explicitly before the first message.
- OpenCode Go usage (5-hour, weekly, monthly) in the chat header and the status bar, with threshold alerts, read from the running opencode (`/api/experimental/usage/limits`). Nothing is requested from the Console directly.
- Stored chats of the folder (continue or fork), web search/fetch cards, and an "Open preview" button for dev servers.
- Compatibility with the opencode that is really running: Capella reads its OpenAPI description, checks the routes it needs against the ones it was last tested with, switches off only what is missing, and shows `Capella: Compatibility diagnostics` (a report with no keys, paths or chat content). It tells you when a newer opencode is out; it never updates anything itself.
- Attachments: paste or drop images, attach files of the open folder, the current file or the selection (the + button). Images only as PNG/JPEG/GIF/WebP up to 5 MB, text files up to 1 MB, nothing from outside the open folder, at most 10 per message; the extension checks the bytes, not the file name.
- File edits: each edit card shows its diff, `Changes (n)` lists every file the chat changed against how it was before the chat, and Open diff uses the editor's own diff view. Capella computes these itself (opencode's diff endpoint returned nothing in testing). Only edits made by opencode's edit and write tools are seen; changes made by shell commands are not.
- Voice dictation (Windows): the microphone button records in the extension host, transcribes on your computer with faster-whisper (or Windows speech), and puts the text in the message box for you to review; nothing is sent by itself. If Antares already set up local voice, Capella offers to reuse it instead of downloading ~450 MB again. See `docs/VOICE.md`.
- opencode 1.x and 2.x, through one backend interface. The generation is detected when the server starts (2.x answers `/api/info`, 1.x `/global/health`). On 1.x there is no usage meter, and a rejection cannot carry a note. See `docs/PROTOCOL-NOTES.md`.
- opencode is started per chat window on a random local port with a password only Capella knows.

## Not built yet

Zen balance (the API exposes only budgets), undo of changes, voice recording on macOS/Linux. See `docs/PROTOCOL-NOTES.md` for what was measured on the real server.

## Not verified

- With opencode 1.x: attachments, diffs and the preview button, and any version other than 1.19.5.
- Voice with a real microphone, and the Windows speech engine, inside Capella (the recorder and transcriber were checked with fakes and with synthesized speech).
- The voice setup wizard (it runs `pip` and downloads a model) and the "reuse Antares" dialog were not clicked through.
- A real free-model usage cap: opencode exposes no remaining quota for free models, so Capella keeps its own count and only recognises a cap when the provider refuses a call.
- macOS and Linux (only Windows was available).

## Safety

- Capella needs a **trusted folder**: it runs opencode, an agent that can read files and run commands there. In Restricted Mode it stays off.
- The settings that decide which program starts (`capella.opencodePath`, `capella.voice.home`, `capella.voice.pythonPath`) are machine-scoped: a folder you open cannot set them.
- Nothing is sent anywhere by Capella itself. opencode talks to your model providers. The only request Capella makes is, if `capella.updates.check` is on (the default), asking the npm registry for the latest opencode version number, at most every 12 hours.
- Attachments and diffs only ever read files inside the open folder, and the text of a model's tool arguments is never trusted as a path outside it.

## Develop

```bash
npm install
npm run build
npm test
node scripts/preview.ts   # the chat page in a browser, with a scripted fake host
```

MIT licensed.
