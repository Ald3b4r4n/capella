# Changelog

## 0.1.0 (unreleased)

First release candidate.

- Chat with streaming text, collapsible reasoning and a timeline of tool calls, for **opencode 2.x and 1.x** (the generation is detected at start).
- Four permission modes built from opencode agents and rules (Plan, Review each change, Accept edits, Bypass); approvals are always your click.
- Model picker grouped as Zen, Go and other providers; free models marked; a model is always selected explicitly before the first message.
- OpenCode Go usage (5-hour, weekly, monthly) in the chat header and the status bar, with threshold alerts (2.x).
- Stored chats of the folder: continue or fork.
- Web search and page fetch cards; "Open preview" for local dev servers.
- Attachments: paste or drop images, files of the open folder, the current file, the selection.
- File edits: a diff under each edit, a "Changes" list for the chat, Open diff in the editor's own diff view.
- Voice dictation on Windows (faster-whisper or Windows speech), reusing an existing Antares install when there is one.
- Compatibility diagnostics and an optional check for new opencode versions (only the version number is requested).

Known gaps: no undo of changes; voice recording only on Windows; edits made by shell commands are not listed in Changes; on 1.x there is no usage meter and a rejection cannot carry a note.
