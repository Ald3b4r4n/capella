# Changelog

## 0.1.8 (2026-11-02)

- **Fix:** "Could not start opencode: GET /api/model: HTTP 503 … Location plugins did not finish activating". A server that has just started answers 503 `ServiceUnavailableError` while its plugins and MCP servers come up (seen on a machine with many of them); the chat gave up at the first answer. A request that gets that answer is now repeated after a short wait, for up to a minute, and after 6 seconds the chat says opencode is still starting its plugins instead of looking stuck. Any other error is still an error at once.

- **The message box is easier to see:** it now sits on a surface one step off the page, with a visible edge (taken from the theme's own text colour, so it holds on dark and light themes), a light line above it and a soft shadow; the inner second gold rectangle that appeared when typing is gone and the whole box lights up instead; the chips (mode, model, web, effort) have a clear border, a tint and readable text, and the brand colours are mixed with the text colour so that they stay readable on a light theme.

## 0.1.7 (2026-11-02)

- **The browser:** Tools → **Add the browser (Playwright)…** adds Microsoft's Playwright MCP so that the agent can open a page, click, type and take screenshots, which show under its tool card in the chat. A question says it is third-party code, asks which pages it may open (only this computer, or any website) and shows what will run; Capella installs `@playwright/mcp` 0.0.83 (pinned, install scripts off) into its own storage, and starts it headless in a throwaway profile on the installed Edge or Chrome (nothing is downloaded). Every action asks first. Checked in both editors with a real model: install, connection, approvals, a click on a local page, the screenshots, and an outside site refused.
- The pictures a tool result names are shown only when the file exists inside the open project or Capella's own folder and its bytes are a real picture.
- e2e: `E2E_BROWSER=1` (a throwaway opencode, with the Go key typed into the Accounts box and never printed).

## 0.1.6 (2026-11-02)

- **MCP manager, complete:** servers added in Capella can be given environment variables or headers (values typed masked and kept only in the editor's secret storage, never shown again), **Edit**ed (command, address, working folder, variables, headers) and **Test**ed; a server that needs a login gets a **Sign in** button. The confirmation lists names, never values; a missing secret stops a server from starting half-configured. What was stored by 0.1.4 is read as before.
- The MCP code moved out of the chat panel into `src/ui/mcpManager.ts` (the editor's boxes and questions) and `src/ui/mcpStore.ts` (what is stored and how it becomes opencode's configuration; pure and unit-tested).
- Checked against the real 2.2.5 and 1.19.5: environment, working folder, replacement and headers (`scripts/check-mcp.ts`, with HTTP and stdio fixtures); in both editors, in a throwaway home (`E2E_TOOLS=1`), through the real boxes, with the secret read back from the keychain in a new chat.
- Fix: the Tools panel is emptied when a new chat starts, so it never shows another chat's servers.

## 0.1.5 (2026-11-02)

- **Accounts** (Tools, first section): connect Zen, Go or any other provider with an API key (masked box, stored by opencode; Capella keeps nothing and scrubs the key from any error) or, on 2.x, with a browser sign-in that opencode runs (the address and the code are shown and the site is named before anything opens); several keys per provider with **Use**; **Sign out** asks first. The model list and the usage meter are read again after a change.
- The credential route of opencode carries the secrets themselves; Capella reads only the ids and the active flag from it. `scripts/check-accounts.ts` checks the flow against a real opencode with a dummy key in a throwaway home; `E2E_ACCOUNTS=1` does the same in an editor, never in your own opencode.

## 0.1.4 (2026-11-02)

- **Tools panel:** the MCP servers, skills and plugins of your opencode. MCP servers can be turned off and on, and added with **Add an MCP server…** (name, then a command or an https address; a question shows exactly what will run). Servers added in Capella are kept per project and registered again in each chat (opencode forgets them on restart) and can be removed. Skills open their file; plugins are listed.
- **Fix (safety):** the tools of MCP servers ran with no approval in every mode, Plan included (measured on 2.2.5). They are now asked about in every mode but Bypass, on 2.x and 1.x, and a server added later is covered at once.
- The e2e answers the editor's own dialogs and input boxes (`window.dialogStyle: custom`): the Add folder, web-access and Add MCP questions are exercised for real, with Cancel and accept. `scripts/check-mcp.ts` checks the MCP approval flow against a real opencode. The test hook for the MCP question was removed.
- The README now says plainly where the task list works (1.x) and where it cannot (2.2.5 has no todo tool).

## 0.1.3 (2026-11-02)

- **Add a folder** (+ menu): lets the agent use a folder outside the project in this chat only, after a question that says what it allows. It shows as a removable chip, applies at once to the live session on 2.x and 1.x, and does not carry over to another chat. A drive root, your home folder and the folder above it are refused.
- **Fix (safety):** the permission modes did not cover folders outside the project: opencode read a file there without asking (measured on 2.2.5). Every mode but Bypass now asks (`external_directory`), and the approval card says "Let the agent use a folder outside the project?".
- `scripts/check-folders.ts` checks the above against a real opencode (asked, allowed after adding, asked again after removing); `CAPELLA_DEV_ADD_FOLDER` lets a development host used by the e2e name the folder.

## 0.1.2 (2026-11-02)

The rest of what Antares learned in 0.1.4–0.2.1 and fits opencode:

- **`/` palette:** Capella's `/new` and `/compact` plus the server's commands and skills, with search; `/name args` runs a command, a skill rides on the message (2.x), and 1.x lists its skills among the commands.
- **Queue and steer (2.x):** send while the agent works; the message waits in a tray, can be removed or hurried (**Send now**, Ctrl+Enter) and joins the conversation when the agent takes it.
- **Task list** above the box from the agent's todo tool, rebuilt on replay.
- **Pictures in answers** (`![alt](path)`) from the open folder, judged by their real bytes; web pictures are never loaded.
- New optional capabilities in the compatibility report (queue, commands); the tested snapshots were refreshed for 2.2.5 and 1.19.5.
- e2e: DeepSeek V4.1 Flash (Go) is used for the vision step; `E2E_SKIP_QUEUE=1` skips the queue step.

## 0.1.1 (2026-11-02)

From what Antares learned since 0.1.4:

- **Preview of static pages:** the Preview button serves an HTML file of the folder read-only on 127.0.0.1 and opens it in the editor's browser (hardened: GET/HEAD only, own host name only, never outside the folder, never dotfiles).
- **The chat follows the answer properly:** it stops following only when you scroll up yourself (not when content shrinks for a moment), resumes when you scroll down to the end, and has a jump-to-latest button; smooth scrolling was removed because it never caught up with a streaming answer. A finished answer has one Copy answer button.
- **Model list:** read again on request (button) and when opencode announces a catalog, provider or account change; the last good list is kept when a read fails (an empty list counts as a failure), and new or vanished models are reported.
- **Effort** (the model's own variants) and **web access** (follow the mode, allow, off) controls.
- **Fix:** the + menu (and any menu opened by a button other than Mode or Model) closed itself the moment it opened.
- **Fix:** a file a tool created could still be missed in Changes when it appeared between two of the checks that decide whether it is inside the open folder; it is now judged as the existing file it has become.
- **Fix:** the side panel showed a literal `\n\n` between its last two links.
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
