function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function safeUrl(raw) {
  const value = String(raw).trim();
  if (/^https?:\/\//iu.test(value) || /^mailto:/iu.test(value)) return { href: value, external: true };
  if (value.startsWith("#")) return { href: value, external: false, hash: true };
  return { relative: value };
}

function inline(value) {
  let text = escapeHtml(value);
  const tokens = [];
  text = text.replace(/`([^`\n]+)`/gu, (_, code) => {
    const index = tokens.push(`<code>${code}</code>`) - 1;
    return `\u0001${index}\u0002`;
  });
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_, alt, url) => {
    const safe = safeUrl(url);
    if (safe.external) return `<a href="${escapeHtml(safe.href)}" target="_blank" rel="noreferrer">[图片: ${alt || "链接"}]</a>`;
    return `<span class="bs-md-image">[图片: ${escapeHtml(alt || url)}]</span>`;
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu, (_, label, url) => {
    const safe = safeUrl(url);
    if (safe.relative) {
      return `<a href="#" data-bs-rel-link="${escapeHtml(safe.relative)}">${label}</a>`;
    }
    if (safe.hash) return `<a href="${escapeHtml(safe.href)}">${label}</a>`;
    return `<a href="${escapeHtml(safe.href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>");
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, "$1<em>$2</em>");
  text = text.replace(/~~([^~\n]+)~~/gu, "<del>$1</del>");
  text = text.replace(/\u0001(\d+)\u0002/gu, (_, index) => tokens[Number(index)] ?? "");
  return text;
}

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isTableDivider(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(line);
}

export function renderMarkdown(source) {
  const lines = String(source ?? "").replace(/\r\n/gu, "\n").split("\n");
  const headings = [];
  const html = [];
  let index = 0;
  let headingId = 0;
  let inCode = false;
  let codeLines = [];
  let codeLang = "";
  let list = null;
  let paragraph = [];
  let quote = [];
  let table = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (!quote.length) return;
    html.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
    quote = [];
  };
  const flushTable = () => {
    if (!table) return;
    const head = table.header.map((cell) => `<th>${inline(cell)}</th>`).join("");
    const body = table.rows
      .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
      .join("");
    html.push(`<div class="bs-md-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
    table = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  while (index < lines.length) {
    const line = lines[index];

    if (inCode) {
      if (/^\s*```/u.test(line)) {
        const lang = codeLang ? ` data-lang="${escapeHtml(codeLang)}"` : "";
        html.push(`<pre class="bs-code"${lang}><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCode = false;
        codeLines = [];
        codeLang = "";
      } else {
        codeLines.push(line);
      }
      index += 1;
      continue;
    }

    const fence = line.match(/^\s*```\s*([\w#+.-]*)\s*$/u);
    if (fence) {
      flushAll();
      inCode = true;
      codeLang = fence[1] || "";
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushAll();
      index += 1;
      continue;
    }

    if (line.startsWith("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushAll();
      table = { header: splitRow(line), rows: [] };
      index += 2;
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        table.rows.push(splitRow(lines[index]));
        index += 1;
      }
      flushTable();
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      const text = heading[2].trim();
      const id = `md-h-${headingId++}`;
      headings.push({ level, text, id });
      html.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s\S]*$/u.test(line) && line.replace(/[\s\-*_]/gu, "") === "") {
      flushAll();
      html.push("<hr>");
      index += 1;
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      flushList();
      flushTable();
      quote.push(line.replace(/^\s*>\s?/u, ""));
      index += 1;
      continue;
    }
    flushQuote();

    const bullet = line.match(/^\s*([-*+])\s+(.*)$/u);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/u);
    if (bullet || ordered) {
      flushParagraph();
      flushTable();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      let content = bullet ? bullet[2] : ordered[2];
      const task = content.match(/^\[([ xX])\]\s+(.*)$/u);
      if (task) {
        const checked = task[1].toLowerCase() === "x";
        content = `<input type="checkbox" disabled${checked ? " checked" : ""}> ${inline(task[2])}`;
      } else {
        content = inline(content);
      }
      list.items.push(content);
      index += 1;
      continue;
    }

    flushParagraph();
    paragraph.push(line.trim());
    index += 1;
  }

  if (inCode) {
    html.push(`<pre class="bs-code"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  flushAll();

  return { html: html.join("\n"), headings };
}
