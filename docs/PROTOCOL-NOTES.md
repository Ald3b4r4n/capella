# opencode protocol notes (as observed)

Measured against **opencode 2.2.5** on Windows with `scripts/probe-*.ts`. Everything here was seen on a real server unless marked *unverified*. The public docs at opencode.ai/docs/server and /sdk describe the older 1.x API (`/session`, `/event`); 2.x serves `/api/*` and answers the old paths with the web app's HTML.

## Starting and authenticating

- `opencode serve --port 0 --hostname 127.0.0.1` picks a free port and prints one line: `server listening on http://127.0.0.1:PORT`.
- With `OPENCODE_SERVER_PASSWORD` set (and optionally `OPENCODE_SERVER_USERNAME`, default `opencode`) the server prints **no** password line and requires HTTP Basic: `401` without it, `200` with it. Without the variable the server generates a password and prints `server password …`. Capella always sets its own, so nothing secret is parsed from output.
- The npm shim `opencode.cmd` launches `node_modules\@opencode\cli\bin\opencode.exe`. Killing the shim leaves the real server running, so Capella resolves the shim to the executable (`src/opencode/locate.ts`).
- `GET /api/info` → `{version, pid, hostname, urls[], paths, capabilities}`.
- The OpenAPI document is at **`/openapi.json`** (not `/doc`, which is the web app).
- Requests are resolved against a *location* (a folder). It is passed as the query parameter `location[directory]=<absolute path>` (a deepObject); `POST /api/session` also takes `location` in its body. A fresh session reports `location.directory` in 8.3 short-name form on Windows.

## Events

- `GET /api/event` is an SSE stream. The SSE `event:` field is always `message`; the real type is in the JSON `data`: `{id, created, type, location?, data, durable?: {aggregateID, seq, version}}`.
- First frame: `server.connected`. Idle chatter: `project.updated`, `models-dev.refreshed`, `config.updated`, `integration.updated`, `provider.updated`, `model.updated`, `agent.updated`, `command.updated`, `skill.updated`, `websearch.updated`, `reference.updated`, `plugin.updated`, `mcp.status.changed`, `mcp.resources.changed`.
- The stream is volatile (the API says so): a slow consumer fails it and events sent while disconnected are not replayed. After a reconnect the chat re-reads `GET /api/session/{id}/message`.
- One real turn (prompt → `read` tool → answer) produced, in order:
  `session.inbox.enqueued`, `session.execution.started`, `session.inbox.delivered`, then per step `session.step.started` (carries `agent`, `model{id,providerID}`, `assistantMessageID`), `session.reasoning.started|delta|ended` (`ordinal`, `delta`/`text`), `session.tool.input.started` (`id`, `name`), `session.tool.input.ended` (`text`: the raw JSON arguments), `session.tool.called` (`input`, `executed`), `session.tool.success` (`content[]` of `{type:"text",text}`), `session.step.streamed`, `session.step.ended` (`finish`: `tool-calls` or `stop`, `tokens{input,output,reasoning,cache{read,write}}`), `session.text.started|delta|ended`, and finally `session.execution.succeeded`.
- Still to observe (*unverified*): tool failure, permission asked/replied, interruption, `session.execution.failed`, forms, compaction, todo changes.

## Sessions and messages

- `POST /api/session {title?, location?, …}` → `{data: {id: "ses_…", projectID, cost, tokens, time, title, location, …}}`.
- `POST /api/session/{id}/prompt {text, files?, agents?, skills?, delivery?, resume?}` → `{data: {id: "msg_…", type:"user", payload:{text}, delivery:"steer"}}`; the turn then runs on its own.
- `POST /api/session/{id}/model` takes `{model: {id, providerID, variant?}}`. **A session with no model selected runs on the user's default model** (here a metered Vercel gateway model), so a client must select the model and check the call succeeded before prompting.
- `POST /api/session/{id}/agent {agent}`; `POST /api/session/{id}/interrupt`.
- `GET /api/session/{id}/message` → `{data: [...]}` newest first; entries have `type`: `user`, `assistant` (with `content[]` of `reasoning`/`text`/`tool` parts), `idle` (with `outcome`).
- `GET /api/agent` → `build` (mode `primary`) and others; each carries `permissions: [{action, resource, effect: allow|ask|deny}]` rules.

## Models and usage

- `GET /api/model` → `{location, data: [Model.Info]}` (776 entries with a configured account, 462 without). Providers seen: `opencode` (Zen, 84), `opencode-go` (38), `openrouter`, `vercel`, `inception`, `muse`. Zen's free models end in `-free`.
- **Secret exposure:** `Model.Info.settings` contains the provider's `apiKey` and `baseURL` in clear text (seen on `/api/model/default`). Capella maps models through a whitelist and never forwards, logs or stores `settings`. `scripts/probe-turn.ts` prints identifiers only.
- `GET /api/experimental/usage/limits` → `{location, data: null | {workspace{id,name,usageURL}, go{rolling,weekly,monthly:{percent,limited,resetsAt}}, budgets[]}}`. `data` is `null` when the location is not signed in to the OpenCode Console (seen with a throwaway home); with the real account it returned the three Go windows (`resetsAt` in ms since the epoch).

## Safety notes from the probes

- `probe-events.ts` runs on a throwaway `HOME`/`XDG_*` and makes no model call.
- `probe-turn.ts` needs the real credentials. Its first run selected the model with a wrong body, the call failed silently, and the turn ran on the user's default Vercel model instead of the free Zen model asked for (about 17k input tokens). The probe now aborts when the selection fails.

## Permissions and modes (observed on 2.2.5)

- The default `build` agent is `allow * *`; only reads of `*.env` / `*.env.*` ask. So opencode's out-of-the-box behaviour runs edits and shell commands without asking. `plan` is `deny edit` (except its own plan folder) and still allows shell. Subagents: `general`, `explore`.
- Rule shape: `{action, resource, effect: allow|deny|ask}`. Actions seen: `read`, `edit`, `shell`, `grep`, `glob`, `webfetch`, `websearch`, `question`, `subagent`, `external_directory`, `browser`, `skill`.
- `POST /api/session` accepts `agent` and `permissions` (a ruleset). **Verified:** `ask shell` on `build` raised `permission.asked` for the command; rejecting it failed the tool and wrote nothing. With `deny edit` + `deny shell` on `plan` the model never attempted either tool (denied tools are not offered). **Verified:** `PATCH /api/session/{id} {permissions}` *replaces* the ruleset (an empty list clears it) and `POST /api/session/{id}/agent {agent}` switches the agent on a live session.
- `permission.asked` → `{id: "per_…", sessionID, action, resources[], save[], source: {type: "tool", messageID, id}}`. `save` holds the patterns an `always` reply remembers (`["*"]` for a `.env` read, `["echo *"]` for a shell command). `GET /api/permission/request` lists pending requests (the same objects). `POST /api/session/{id}/permission/{requestId}/reply {decision: once|always|reject, message?}` answers with an empty body; then `permission.replied` → `{sessionID, requestID, reply}`.
- A rejection with a message ends that tool with `session.tool.failed {id, error: {type: "permission.rejected", message}, executed: false}`, and the model carried on without the tool. A normal failure is the same event with `error.type: "tool.execution"` (e.g. "File not found").
- The event stream dropped once during a probe (`TypeError: terminated`), which the reconnect loop absorbed.
- Capella's modes (`src/opencode/modes.ts`): Plan = `plan` + deny edit/shell; Review = `build` + ask edit/shell/webfetch/websearch; Accept edits = `build` + ask shell/webfetch/websearch; Bypass = `build` with no extra rules (confirmation required, never in the Shift+Tab cycle). Edits under Accept edits go through without asking by design, as in opencode's own default.

## opencode 1.x (observed on 1.19.5, installed in a scratch folder with `npm install opencode-ai@1.19.5`)

npm publishes 1.x as `opencode-ai` and 2.x as `@opencode/cli`. Capella supports both through one `Backend` interface (`src/opencode/backend*.ts`); the generation is detected at start: 2.x answers JSON at `GET /api/info`, 1.x at `GET /global/health` (and answers the web app at `/api/info`).

- **Contract:** the OpenAPI description is at `/doc` (not `/openapi.json`, which is the web app). 1.19.5 also serves a partial `/api/*` preview (sessions, prompt, model, permissions, events) with no `/api/info`; Capella ignores it and uses the stable legacy routes: `GET/POST /session`, `GET/PATCH /session/{id}`, `POST /session/{id}/prompt_async`, `GET /session/{id}/message`, `POST /session/{id}/abort`, `POST /session/{id}/fork`, `GET /permission`, `POST /session/{id}/permissions/{permissionID} {response: once|always|reject}`, `GET /config/providers`, `GET /config`, `GET /event`.
- **Start:** `opencode serve --port 0` prints `opencode server listening on http://127.0.0.1:PORT`; `OPENCODE_SERVER_PASSWORD` gives the same Basic auth as 2.x.
- **Model and agent travel with each prompt** (`prompt_async {model: {providerID, modelID}, agent, parts: [{type: "text"}, {type: "file", mime, url, filename}]}`); there is no "set the session's model" call. `POST /session` also accepts `model`, `agent` and `permission`.
- **Rules** are `{permission, pattern, action}` and the shell is `bash`. **`PATCH /session/{id} {permission}` APPENDS to the session's rules; it does not replace them** (measured: Plan, then Accept edits, left the Plan `edit deny` in place, and an empty list changed nothing). The last matching rule wins, which was verified with a real turn (Plan then Review: the shell asks again). So `v1Rules()` writes each mode as a complete set (edit, bash, webfetch, websearch, with an explicit `allow` where the mode lets it through).
- **Events** are `{id, type, properties}`: `session.status {status: {type: "busy"}}` and `session.idle` bracket a turn; `message.updated {info: {id, role}}` says whose a message is (the user's own text also arrives as a `message.part.updated`); `message.part.updated {part}` with `type` `text`, `reasoning`, `tool` (`state.status` pending, running, completed, error; `callID`, `tool`, `state.input`, `state.output`), `step-start`, `step-finish {reason, tokens}`; `message.part.delta {messageID, partID, field: "text", delta}` for streaming. `permission.asked {id, sessionID, permission, patterns, always, tool: {messageID, callID}}`, `permission.replied {sessionID, requestID, reply}`. A rejection ends the tool with `state.status: "error"` and the text "The user rejected permission...". `session.error {error: {name, data: {message, statusCode}}}` is followed by `session.idle`.
- **Catalog:** `GET /config/providers` → `{providers: [{id, options, models: {key: {...}}}], default}`. `options` holds the provider's API key (a public key for opencode's own free models), so the mapper whitelists fields and never reads it. In a throwaway home with no credentials, opencode's free models answer anyway.
- **Not available on 1.x:** the usage endpoint (so no meter), a per-session model call, and a message with a rejection. Sessions started by a subagent carry `parentID` and are left out of History.
