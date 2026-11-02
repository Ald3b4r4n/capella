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
- **Preview** button: open a dev server a tool printed, an address you type, or an HTML file of the folder, which Capella serves read-only on 127.0.0.1 (no dotfiles, nothing outside the folder, only this computer) while the chat is open.
- **Effort** chip for models that have reasoning-effort options, a **Web** chip (follow the mode, always allow, or off for this chat) and a button that reads the model list again; the list also refreshes by itself when opencode says the catalog or your account changed, and a new or vanished model is said in words.
- **`/` palette:** type `/` in the message box for Capella's own `/new` and `/compact` and the commands and skills your opencode lists (arrows, Enter or Tab to pick). A command runs on the chat; on 2.x a skill rides on the message that invokes it, and on 1.x skills are listed as commands. Text such as a path (`/usr/bin ...`) is still an ordinary message.
- **Messages while the agent works (2.x):** Enter queues the message (it waits in a tray above the box and joins the same turn when the agent is done with its current work); Ctrl+Enter, or **Send now** on a queued one, hands it over at the agent's next step. A queued message can be removed. opencode 1.x has no queue: Capella says so and waits for the turn.
- **Task list:** when the agent keeps a task list (its todo tool), the progress shows above the box, `Tasks 1/3 · the current item`, and is rebuilt when you reopen a chat.
- **Pictures in answers:** `![alt](path)` shows the picture when it is a PNG, JPEG, GIF or WebP (by its real bytes, up to 5 MB) inside the open folder. A web address is never fetched; it stays a link.
- The view follows the answer while it streams, stops only when you scroll up yourself, and a jump button brings you back; a finished answer has one **Copy answer** button.
- opencode is started per chat window on a random local port with a password only Capella knows.

## Not built yet

Zen balance (the API exposes only budgets), undo of changes, voice recording on macOS/Linux. See `docs/PROTOCOL-NOTES.md` for what was measured on the real server.

## Not verified

- With opencode 1.x: attachments, diffs and the preview button, and any version other than 1.19.5.
- Voice with a real microphone, and the Windows speech engine, inside Capella (the recorder and transcriber were checked with fakes and with synthesized speech).
- Messages queued while a turn runs, on opencode 1.x (it has no queue; Capella does not send them). The task list was checked with a scripted tool call, not with a model that calls the todo tool by itself.
- Adding extra folders to a chat and the skills/MCP/plugin managers of Antares are not built yet (adding a folder grants the agent access outside the project, so it needs its own design and confirmation).
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
