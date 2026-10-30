import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdown } from "../web/markdown.js";

describe("renderMarkdown (U13)", () => {
  it("returns empty for falsy", () => {
    assert.equal(renderMarkdown(""), "");
    assert.equal(renderMarkdown(null as never), "");
    assert.equal(renderMarkdown(undefined as never), "");
  });

  it("escapes HTML / XSS in paragraphs", () => {
    const html = renderMarkdown(`<script>alert(1)</script> & "x"`);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&amp;/);
    assert.match(html, /&quot;x&quot;/);
  });

  it("renders headings, lists, hr, code fence", () => {
    const src = [
      "# Title",
      "",
      "- a",
      "- b",
      "",
      "1. one",
      "2. two",
      "",
      "---",
      "",
      "```js",
      "const x = 1 < 2",
      "```",
      "",
      "plain **bold** and *em* and `code`",
    ].join("\n");
    const html = renderMarkdown(src);
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<ul>[\s\S]*<li>a<\/li>/);
    assert.match(html, /<ol>[\s\S]*<li>one<\/li>/);
    assert.match(html, /<hr \/>/);
    assert.match(html, /<pre class="md-code"><code class="lang-js">/);
    assert.match(html, /const x = 1 &lt; 2/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>em<\/em>/);
    assert.match(html, /<code>code<\/code>/);
  });

  it("renders tables and safe links/images", () => {
    const src = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "![alt](/uploads/abc.png)",
      "![remote](https://example.com/x.png)",
      "[link](https://example.com)",
      "![bad](javascript:alert(1))",
    ].join("\n");
    const html = renderMarkdown(src);
    assert.match(html, /<table class="md-table">/);
    assert.match(html, /<th>A<\/th>/);
    assert.match(html, /<td>1<\/td>/);
    assert.match(html, /<img class="md-img" src="\/uploads\/abc\.png"/);
    assert.match(html, /src="https:\/\/example\.com\/x\.png"/);
    assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noopener">link<\/a>/);
    // javascript: images must not become <img>
    assert.doesNotMatch(html, /src="javascript:/);
  });
});
