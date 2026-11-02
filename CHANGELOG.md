# Changelog

## 0.1.1 (unreleased)

From what Antares learned since 0.1.4:

- **Preview of static pages:** the Preview button serves an HTML file of the folder read-only on 127.0.0.1 and opens it in the editor's browser (hardened: GET/HEAD only, own host name only, never outside the folder, never dotfiles).
- **The chat follows the answer properly:** it stops following only when you scroll up yourself (not when content shrinks for a moment), resumes when you scroll down to the end, and has a jump-to-latest button; smooth scrolling was removed because it never caught up with a streaming answer. A finished answer has one Copy answer button.
- **Model list:** read again on request (button) and when opencode announces a catalog, provider or account change; the last good list is kept when a read fails (an empty list counts as a failure), and new or vanished models are reported.
- **Effort** (the model's own variants) and **web access** (follow the mode, allow, off) controls.
- **Fix:** the + menu (and any menu opened by a button other than Mode or Model) closed itself the moment it opened.
- **Fix (1.x):** when a model's free allowance ran out, opencode 1.x kept retrying quietly and the chat looked stuck; the turn now ends as a usage-limit failure and the retry is stopped.
- **Fix:** a file a tool created could also be missed in Changes when the model wrote its absolute path and the file was still being written (the path could not be resolved for an instant); a plain file directly in an allowed folder is now accepted, and a link is still refused.
- **Fix:** a file created by a tool within milliseconds of it starting could be missed in Changes (Windows file times tick about every 16 ms).
- Observed and documented: a real free-model usage cap (HTTP 429, `provider.free-limit`, per model, no reset time).

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
