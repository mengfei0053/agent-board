/** Minimal markdown → safe HTML (headings, lists, code, tables, emphasis). */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function inlineFormat(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  // Images first (so ![alt](url) is not eaten by the link rule).
  // Allow https? and same-origin /uploads/… paths.
  s = s.replace(
    /!\[([^\]]*)\]\(((?:https?:\/\/[^)\s]+|\/uploads\/[A-Za-z0-9._-]+))\)/g,
    '<img class="md-img" src="$2" alt="$1" loading="lazy" />',
  );
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

export function renderMarkdown(src) {
  if (!src) return "";
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;
  let inTable = false;

  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push("</tbody></table>"); inTable = false; }
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      closeLists(); closeTable();
      const lang = fence[1] || "";
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      out.push(`<pre class="md-code"><code class="lang-${escapeHtml(lang)}">${escapeHtml(buf.join("\n"))}</code></pre>`);
      i++;
      continue;
    }

    // table
    if (/^\s*\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*[-:| ]+\|\s*$/.test(lines[i + 1])) {
      closeLists();
      const split = (l) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const heads = split(line);
      i += 2;
      if (!inTable) {
        out.push("<table class=\"md-table\"><thead><tr>");
        for (const h of heads) out.push(`<th>${inlineFormat(h)}</th>`);
        out.push("</tr></thead><tbody>");
        inTable = true;
      }
      while (i < lines.length && /^\s*\|.+\|\s*$/.test(lines[i])) {
        const cells = split(lines[i]);
        out.push("<tr>");
        for (const c of cells) out.push(`<td>${inlineFormat(c)}</td>`);
        out.push("</tr>");
        i++;
      }
      closeTable();
      continue;
    }

    // headings
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h) {
      closeLists(); closeTable();
      const n = h[1].length;
      out.push(`<h${n}>${inlineFormat(h[2])}</h${n}>`);
      i++;
      continue;
    }

    // hr
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeLists(); closeTable();
      out.push("<hr />");
      i++;
      continue;
    }

    // ul
    const ul = line.match(/^\s*[-*+]\s+(.+)$/);
    if (ul) {
      closeTable();
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${inlineFormat(ul[1])}</li>`);
      i++;
      continue;
    }

    // ol
    const ol = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      closeTable();
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${inlineFormat(ol[1])}</li>`);
      i++;
      continue;
    }

    // blank
    if (!line.trim()) {
      closeLists(); closeTable();
      i++;
      continue;
    }

    closeLists(); closeTable();
    out.push(`<p>${inlineFormat(line)}</p>`);
    i++;
  }
  closeLists(); closeTable();
  return out.join("\n");
}
