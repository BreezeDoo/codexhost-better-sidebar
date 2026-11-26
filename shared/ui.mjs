const ICONS = {
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm6.5-1.5L22 22",
  file: "M14 3v5h5M6 3h9l5 5v13H6V3Z",
  folder: "M3 7h7l2 2h9v10H3V7Z",
  folderOpen: "M3 7h7l2 2h9l-2 10H3V7Z",
  chevron: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  git: "M6 3v12a3 3 0 0 0 3 3h9M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm12 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5a8 8 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2.2-1.3L15 3H9l-.3 2.4A8 8 0 0 0 6.5 6.7l-2.4-1-2 3.4 2 1.6A8 8 0 0 0 4 12c0 .4 0 .9.1 1.3l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2.2 1.3L9 21h6l.3-2.4a8 8 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z",
  save: "M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  edit: "M4 20h4L20 8l-4-4L4 16v4Zm10-14 4 4",
  image: "M3 5h18v14H3V5Zm3 10 3.5-4 3 3.5L15 11l3 4M8 9h.01",
  back: "M15 18l-6-6 6-6",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  alert: "M12 3 2 21h20L12 3Zm0 6v6m0 3h.01",
  check: "M4 12l5 5L20 6",
  copy: "M9 9h11v11H9V9ZM4 15V4h11",
  dot: "M12 12h.01",
  sidebar: "M3 4h18v16H3V4Zm10 0v16",
  outline: "M4 6h4M4 12h7M4 18h10M15 6h5M15 12h5",
};

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset") {
      Object.assign(node.dataset, value);
    } else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function icon(name, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] ?? ICONS.dot);
  svg.append(path);
  return svg;
}

export function iconMarkup(name, size = 14) {
  const path = ICONS[name] ?? ICONS.dot;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
}

export function basename(rel) {
  const text = String(rel);
  const parts = text.split(/[\\/]+/u).filter(Boolean);
  return parts[parts.length - 1] || text;
}

export function dirname(rel) {
  const text = String(rel);
  const separator = text.includes("\\") ? "\\" : "/";
  const parts = text.split(/[\\/]+/u).filter(Boolean);
  parts.pop();
  if (!parts.length) return text.startsWith("/") ? "/" : "";
  const joined = parts.join(separator);
  if (separator === "/" && text.startsWith("/")) return `/${joined}`;
  return joined;
}

export function joinRel(base, rel) {
  const parts = [...(base ? base.split("/") : []), ...String(rel).split("/")];
  const output = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!output.length) return null;
      output.pop();
    } else output.push(part);
  }
  return output.join("/");
}

export function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function relativeTime(value) {
  const time = Number(value) || 0;
  if (!time) return "";
  const seconds = Math.max(0, (Date.now() - time) / 1000);
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)} 天前`;
  return new Date(time).toLocaleDateString("zh-CN");
}

export function fileKind(rel) {
  const name = basename(rel).toLowerCase();
  if (name === "dockerfile" || name === "makefile") return "code";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".avif"].includes(ext)) return "image";
  if ([".md", ".markdown", ".mdx"].includes(ext)) return "markdown";
  if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".env"].includes(ext)) return "data";
  return "text";
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.cancel = () => clearTimeout(timer);
  return wrapped;
}

export function toast(text, kind = "info") {
  const node = document.querySelector(".bs-toast");
  if (node) node.remove();
  const element = el("div", { class: `bs-toast bs-toast--${kind}`, role: "status" }, text);
  document.body.append(element);
  setTimeout(() => element.remove(), 3200);
}
