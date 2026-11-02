import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../../src/webview/markdown.ts";

test("model output can never inject markup", () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> and <script>x</script> "quoted"');
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes("&#60;img"));
});

test("only http(s) links survive, and they carry data-href instead of href", () => {
  const ok = renderMarkdown("[docs](https://opencode.ai/docs)");
  assert.ok(ok.includes('data-href="https://opencode.ai/docs"'));
  assert.equal(ok.includes(' href='), false);
  const bad = renderMarkdown("[x](javascript:alert(1)) [y](file:///c:/secret)");
  assert.equal(bad.includes("data-href"), false);
});

test("a quote inside a link target cannot break out of the attribute", () => {
  const html = renderMarkdown('[a](https://x.test/"onmouseover="alert(1))');
  assert.equal(html.includes('"onmouseover'), false);
});

test("fenced code is escaped, keeps its language and carries a copy button", () => {
  const html = renderMarkdown("```ts\nconst a = '<b>';\n```");
  assert.ok(html.includes('data-lang="ts"'));
  assert.ok(html.includes("const a = &#39;&#60;b&#62;&#39;;"));
  assert.ok(html.includes('class="copy"'));
});

test("an unterminated fence (still streaming) renders what has arrived", () => {
  const html = renderMarkdown("```js\nlet x = 1");
  assert.ok(html.includes("let x = 1"));
  assert.ok(html.includes("</pre>"));
});

test("inline code is not touched by bold or italic rules", () => {
  const html = renderMarkdown("use `**not bold**` and **bold** and *it*");
  assert.ok(html.includes("<code>**not bold**</code>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>it</em>"));
});

test("headings, lists and paragraphs", () => {
  const html = renderMarkdown("# Title\n\n- a\n- b\n\n1. one\n2. two\n\nlast line");
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<ul><li>a</li><li>b</li></ul>"));
  assert.ok(html.includes("<ol><li>one</li><li>two</li></ol>"));
  assert.ok(html.includes("<p>last line</p>"));
});
