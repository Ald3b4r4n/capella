/**
 * A small, safe markdown renderer for assistant text: fenced and inline code, headings, bold, italic, links, bullet and
 * numbered lists, paragraphs. Everything is HTML-escaped first, so model output can never inject markup; links are
 * kept only for http(s) and are rendered as `<a data-href>` (the extension opens them after confirmation, the page
 * never navigates). Pure, so it is unit-tested without a browser.
 */

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function inline(raw: string): string {
  // Code spans first so their contents are not touched by the other rules.
  const spans: string[] = [];
  let text = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_m, code: string) => {
    spans.push(`<code>${code}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  text = text
    // A picture: only one on disk is shown (the extension reads it, inside the open folder); a web address stays a plain link.
    .replace(/!\[([^\]\n]*)\]\(([^\s)]+)\)/g, (_m, alt: string, src: string) =>
      /^https?:\/\//.test(src) ? `<a data-href="${src}" title="${src}">${alt || src}</a>` : `<span class="answer-img" data-src="${src}" title="${alt}">${alt || src}</span>`,
    )
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => `<a data-href="${url}" title="${url}">${label}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)] ?? "");
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | undefined;
  let i = 0;
  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join("<br>")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = undefined;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      i++;
      // An unterminated fence (a reply still streaming) renders what has arrived so far.
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push(`<pre data-lang="${escapeHtml(fence[1] ?? "")}"><code>${escapeHtml(body.join("\n"))}</code><button class="copy" type="button">Copy</button></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (line.trim() === "") {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
    i++;
  }
  flushParagraph();
  flushList();
  return out.join("");
}
