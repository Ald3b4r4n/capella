const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export interface ChatHtmlOptions {
  /** Content-Security-Policy source for styles/images (webview.cspSource, or 'self' in the preview). */
  cspSource: string;
  nonce: string;
  /** Maps a file under media/ to the URL the page should load. */
  mediaUri: (file: string) => string;
  /** Preview only: inline script that must run before chat.js (e.g. a fake acquireVsCodeApi). */
  preScript?: string;
}

/** The chat page. Pure (no vscode import) so the preview server renders the exact same markup. */
export function chatHtml(options: ChatHtmlOptions): string {
  const { cspSource, nonce, mediaUri, preScript } = options;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${escapeHtml(mediaUri("chat.css"))}">
<title>Capella</title></head><body>
<header class="top">
  <div class="brand"><img src="${escapeHtml(mediaUri("capella.svg"))}" alt="" width="20" height="20"><span>Capella</span><span id="version" class="faint"></span></div>
  <div class="top-right">
    <span id="usage" class="usage" hidden></span>
    <button id="changesBtn" class="ghost" hidden title="Files this chat changed">Changes</button>
    <button id="historyBtn" class="ghost" title="Continue or fork a stored chat of this folder">History</button>
    <button id="newChat" class="ghost" title="Start a new chat">New chat</button>
  </div>
</header>
<section id="history" class="overlay" hidden aria-label="Stored chats">
  <div class="overlay-head">
    <strong>Chats</strong>
    <input id="historySearch" type="search" placeholder="Filter by title…" aria-label="Filter chats">
    <button id="historyClose" class="ghost" aria-label="Close">Close</button>
  </div>
  <div id="historyList" class="overlay-body"></div>
</section>
<section id="changes" class="overlay" hidden aria-label="Changed files">
  <div class="overlay-head">
    <strong>Changes in this chat</strong>
    <span class="spacer"></span>
    <button id="changesClose" class="ghost" aria-label="Close">Close</button>
  </div>
  <div id="changesList" class="overlay-body"></div>
  <p class="faint pad small">Only edits made with opencode's edit and write tools are listed. Changes made by a shell command are not.</p>
</section>
<main id="timeline" aria-live="polite">
  <section class="welcome" id="welcome">
    <img src="${escapeHtml(mediaUri("capella.svg"))}" alt="" width="56" height="56">
    <h1>What are we building?</h1>
    <p>Capella talks to your local <b>opencode</b>, with Zen and Go models. Plan mode is on: it reads, it does not change anything.</p>
  </section>
</main>
<div id="notice" class="notice" role="status" hidden></div>
<div id="voiceStatus" class="notice voice" role="status" hidden></div>
<footer class="composer">
  <div class="box">
    <div id="chips" class="chips" hidden aria-label="Attachments"></div>
    <textarea id="input" rows="1" placeholder="Ask opencode…  (Enter sends, Shift+Enter adds a line; paste or drop images)" aria-label="Message"></textarea>
    <div class="row">
      <button id="plusBtn" class="chip plus" title="Attach files, the current file or a selection" aria-label="Attach">+</button>
      <button id="modeBtn" class="chip" title="Permission mode (Shift+Tab cycles)"></button>
      <button id="modelBtn" class="chip" title="Model"></button>
      <button id="micBtn" class="chip mic" title="Dictate: speak, click again to stop (Esc cancels). Recorded and transcribed on your computer." aria-label="Dictate" aria-pressed="false">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="currentColor"/><path d="M3 8a5 5 0 0 0 10 0M8 13v2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </button>
      <span class="spacer"></span>
      <button id="send" class="send" title="Send" aria-label="Send">&#8593;</button>
      <button id="stop" class="send stop" title="Stop" aria-label="Stop" hidden>&#9632;</button>
    </div>
  </div>
</footer>
<div id="menu" class="menu" hidden></div>
${preScript ? `<script nonce="${nonce}">${preScript}</script>` : ""}
<script nonce="${nonce}" src="${escapeHtml(mediaUri("chat.js"))}"></script>
</body></html>`;
}
