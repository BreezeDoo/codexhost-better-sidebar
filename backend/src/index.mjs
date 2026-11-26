import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import git from "isomorphic-git";
import { structuredPatch } from "diff";

const MAX_TEXT_BYTES = 1.5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_SEARCH_ENTRIES = 20000;
const MAX_UNTRACKED_ENTRIES = 4000;
const MAX_UNTRACKED_DEPTH = 3;
const MAX_CHANGES = 4000;
const MAX_TRACKED_FILES = 5000;
const GIT_STATUS_CACHE_MS = 1500;
const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".pnpm-store",
  "target",
  "dist",
  "build",
  "coverage",
  ".idea",
  ".gradle",
]);
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
  [".svg", "image/svg+xml"],
  [".avif", "image/avif"],
]);

const stateCache = new Map();
const gitStatusCache = new Map();
const searchTokens = new Map();

function stateFile(ctx) {
  return path.join(ctx.dataDir, "state.json");
}

async function readState(ctx) {
  const file = stateFile(ctx);
  if (stateCache.has(file)) return stateCache.get(file);
  let value = { recentRoots: [] };
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.recentRoots)) {
      value = {
        recentRoots: parsed.recentRoots
          .filter((item) => item && typeof item.root === "string")
          .slice(0, 12),
      };
    }
  } catch {}
  stateCache.set(file, value);
  return value;
}

async function writeState(ctx, value) {
  const file = stateFile(ctx);
  await fs.mkdir(ctx.dataDir, { recursive: true });
  const temp = `${file}.${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(temp, file);
  stateCache.delete(file);
}

function normalizeRelative(input) {
  const text = String(input ?? "").replace(/\\/gu, "/");
  if (text.startsWith("/") || /^[A-Za-z]:/u.test(text)) {
    throw new Error("路径必须是工作区内的相对路径");
  }
  const normalized = path.posix.normalize(text);
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error("路径越出工作区");
  }
  return normalized === "." ? "" : normalized;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveWorkspace(rootInput) {
  if (typeof rootInput !== "string" || !rootInput.trim()) {
    throw new Error("还没有选择工作区");
  }
  const absolute = path.resolve(rootInput.trim());
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch {
    throw new Error(`工作区不存在：${absolute}`);
  }
  if (!stat.isDirectory()) throw new Error(`不是目录：${absolute}`);
  return await fs.realpath(absolute);
}

async function assertInsideReal(root, absolute) {
  let stat = null;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (stat?.isSymbolicLink()) throw new Error("不跟随符号链接");
  let probe = absolute;
  const suffix = [];
  let real = null;
  while (!real) {
    try {
      real = await fs.realpath(probe);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(probe);
      if (parent === probe || !isInside(root, parent)) break;
      suffix.unshift(path.basename(probe));
      probe = parent;
    }
  }
  if (!real) throw new Error("路径越出工作区");
  const target = suffix.length ? path.join(real, ...suffix) : real;
  if (!isInside(root, target)) throw new Error("路径越出工作区");
  const realRel = path.relative(root, target).replace(/\\/gu, "/");
  if (isForbidden(realRel)) throw new Error("该路径不可访问");
}

async function resolvePath(root, relative) {
  const rel = normalizeRelative(relative);
  const absolute = rel ? path.join(root, ...rel.split("/")) : root;
  if (!isInside(root, absolute)) throw new Error("路径越出工作区");
  await assertInsideReal(root, absolute);
  return { rel, absolute };
}

const FORBIDDEN_SEGMENTS = new Set([".git", "node_modules"]);

function isForbiddenSegment(name) {
  return FORBIDDEN_SEGMENTS.has(String(name).toLowerCase());
}

function isForbidden(rel) {
  return rel.split("/").some(isForbiddenSegment);
}

async function looksBinary(buffer) {
  const length = Math.min(buffer.length, 8192);
  for (let i = 0; i < length; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function guessImage(rel) {
  return IMAGE_TYPES.get(path.extname(rel).toLowerCase()) ?? null;
}

function sortEntries(a, b) {
  if (a.type !== b.type) {
    if (a.type === "dir") return -1;
    if (b.type === "dir") return 1;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
}

const STATUS_TABLE = new Map([
  ["003", { code: "AD", staged: true, unstaged: true, untracked: false }],
  ["020", { code: "??", staged: false, unstaged: false, untracked: true }],
  ["022", { code: "A ", staged: true, unstaged: false, untracked: false }],
  ["023", { code: "AM", staged: true, unstaged: true, untracked: false }],
  ["100", { code: "D ", staged: true, unstaged: false, untracked: false }],
  ["101", { code: " D", staged: false, unstaged: true, untracked: false }],
  ["103", { code: "MD", staged: true, unstaged: true, untracked: false }],
  // `git status --short` shows `D ` plus `??` for these two; one row
  // cannot carry both, so keep the staged deletion.
  ["110", { code: "D ", staged: true, unstaged: false, untracked: false }],
  ["113", { code: "MM", staged: true, unstaged: true, untracked: false }],
  ["120", { code: "D ", staged: true, unstaged: false, untracked: false }],
  ["121", { code: " M", staged: false, unstaged: true, untracked: false }],
  ["122", { code: "M ", staged: true, unstaged: false, untracked: false }],
  ["123", { code: "MM", staged: true, unstaged: true, untracked: false }],
]);

function statusOf(head, workdir, stage) {
  return STATUS_TABLE.get(`${head}${workdir}${stage}`) ?? null;
}

async function gitRepo(root) {
  try {
    const repoRoot = await git.findRoot({ fs, filepath: root });
    return repoRoot;
  } catch {
    return null;
  }
}

async function readHeadText(root, repoRoot, relativeToRepo) {
  try {
    const oid = await git.resolveRef({ fs, dir: repoRoot, ref: "HEAD" });
    const blob = await git.readBlob({ fs, dir: repoRoot, oid, filepath: relativeToRepo });
    return new TextDecoder().decode(blob.blob);
  } catch {
    return null;
  }
}

async function buildThreadIndex() {
  const cached = buildThreadIndex.cache;
  if (cached && Date.now() - cached.at < 120000) return cached.entries;
  const homes = new Set([process.env.CODEX_HOME, path.join(os.homedir(), ".codex")].filter(Boolean));
  const entries = [];
  for (const home of homes) {
    for (const sub of ["sessions", "archived_sessions"]) {
      const base = path.join(home, sub);
      let exists = false;
      try {
        exists = (await fs.stat(base)).isDirectory();
      } catch {}
      if (!exists) continue;
      const queue = [{ dir: base, depth: 0 }];
      while (queue.length) {
        const { dir, depth } = queue.shift();
        let children;
        try {
          children = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const child of children) {
          const absolute = path.join(dir, child.name);
          if (child.isDirectory() && depth < 5) {
            queue.push({ dir: absolute, depth: depth + 1 });
            continue;
          }
          if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
          const match = child.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu);
          if (!match) continue;
          let stat;
          try {
            stat = await fs.stat(absolute);
          } catch {
            continue;
          }
          entries.push({ threadId: match[1], file: absolute, mtimeMs: stat.mtimeMs, source: sub });
        }
      }
    }
  }
  buildThreadIndex.cache = { at: Date.now(), entries };
  return entries;
}

async function readSessionMeta(file) {
  let handle;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString("utf8");
    const firstLine = head.split("\n", 1)[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta") return null;
    const payload = parsed.payload ?? {};
    return {
      threadId: payload.id ?? payload.session_id ?? null,
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
      roots: Array.isArray(payload.runtime_workspace_roots)
        ? payload.runtime_workspace_roots.filter((item) => typeof item === "string")
        : [],
      title: typeof payload.title === "string" ? payload.title : null,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function resolveThreadWorkspace(threadId) {
  if (typeof threadId !== "string" || !threadId.trim()) return null;
  const wanted = threadId.trim().toLowerCase();
  const entries = await buildThreadIndex();
  const entry = entries.find((item) => item.threadId.toLowerCase() === wanted);
  if (!entry) return null;
  const meta = await readSessionMeta(entry.file);
  const root = meta?.roots?.[0] ?? meta?.cwd ?? null;
  return {
    threadId: entry.threadId,
    root,
    cwd: meta?.cwd ?? null,
    roots: meta?.roots ?? [],
    title: meta?.title ?? null,
    source: entry.source,
    updatedAt: entry.mtimeMs,
  };
}

async function recentThreads(limit = 12) {
  const entries = await buildThreadIndex();
  const sorted = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, Math.min(limit, 30)));
  const output = [];
  for (const entry of sorted) {
    const meta = await readSessionMeta(entry.file);
    const root = meta?.roots?.[0] ?? meta?.cwd ?? null;
    if (!root) continue;
    output.push({
      threadId: entry.threadId,
      root,
      title: meta?.title ?? null,
      updatedAt: entry.mtimeMs,
      source: entry.source,
    });
  }
  return output;
}

async function listDirectory(params) {
  const root = await resolveWorkspace(params.root);
  const { rel, absolute } = await resolvePath(root, params.dir ?? "");
  if (isForbidden(rel)) throw new Error("该目录不可访问");
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory()) throw new Error("不是目录");
  const names = await fs.readdir(absolute, { withFileTypes: true });
  const showIgnored = Boolean(params.showIgnored);
  const entries = [];
  for (const dirent of names) {
    const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
    const childAbs = path.join(absolute, dirent.name);
    let type = "file";
    if (dirent.isDirectory()) type = "dir";
    else if (dirent.isSymbolicLink()) type = "link";
    let childStat;
    try {
      childStat = await fs.stat(childAbs);
      if (childStat.isDirectory()) type = type === "link" ? "link" : "dir";
    } catch {}
    let size = 0;
    let mtimeMs = 0;
    if (childStat && !childStat.isDirectory()) {
      size = childStat.size;
      mtimeMs = childStat.mtimeMs;
    }
    if (isForbiddenSegment(dirent.name)) continue;
    const ignored = type === "dir" && IGNORED_DIRS.has(dirent.name);
    if (ignored && !showIgnored) continue;
    entries.push({ name: dirent.name, path: childRel, type, size, mtimeMs, ignored });
  }
  entries.sort(sortEntries);
  return {
    root,
    dir: rel,
    entries: entries.slice(0, 1500),
    truncated: entries.length > 1500,
  };
}

async function readFile(params) {
  const root = await resolveWorkspace(params.root);
  const { rel, absolute } = await resolvePath(root, params.path);
  if (isForbidden(rel)) throw new Error("该文件不可访问");
  const stat = await fs.stat(absolute);
  if (!stat.isFile()) throw new Error("不是文件");
  if (stat.size > 8 * 1024 * 1024) {
    return { kind: "tooLarge", size: stat.size, mtimeMs: stat.mtimeMs, path: rel };
  }
  const buffer = await fs.readFile(absolute);
  const imageMime = guessImage(rel);
  if (imageMime && stat.size <= MAX_IMAGE_BYTES) {
    return {
      kind: "image",
      path: rel,
      mime: imageMime,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      dataUrl: `data:${imageMime};base64,${buffer.toString("base64")}`,
    };
  }
  if (await looksBinary(buffer)) {
    return { kind: "binary", path: rel, size: stat.size, mtimeMs: stat.mtimeMs };
  }
  let content = buffer.toString("utf8");
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  content = content.replace(/^\uFEFF/u, "");
  const truncated = stat.size > MAX_TEXT_BYTES;
  if (truncated) content = buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8");
  return {
    kind: "text",
    path: rel,
    content,
    truncated,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    eol,
  };
}

async function writeFile(params) {
  const root = await resolveWorkspace(params.root);
  const { rel, absolute } = await resolvePath(root, params.path);
  if (!rel) throw new Error("拒绝写入工作区根目录");
  if (isForbidden(rel)) throw new Error("该路径不可写入");
  if (typeof params.content !== "string") throw new Error("缺少文件内容");
  if (Buffer.byteLength(params.content, "utf8") > MAX_TEXT_BYTES) throw new Error("文件超过 1.5 MiB，无法保存");
  let stat = null;
  try {
    stat = await fs.stat(absolute);
  } catch {}
  if (stat && !stat.isFile()) throw new Error("目标不是普通文件");
  if (stat && stat.size > MAX_TEXT_BYTES) throw new Error("文件大于 1.5 MiB，拒绝覆盖；请用其他编辑器处理");
  if (stat && !params.force && typeof params.baseMtime === "number") {
    if (Math.abs(stat.mtimeMs - params.baseMtime) > 2) {
      return { conflict: true, mtimeMs: stat.mtimeMs, size: stat.size };
    }
  }
  let data = params.content;
  if (params.eol === "\r\n" && !data.includes("\r\n")) data = data.replace(/\n/gu, "\r\n");
  if (params.eol === "\n" && data.includes("\r\n")) data = data.replace(/\r\n/gu, "\n");
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const temp = path.join(
    path.dirname(absolute),
    `.bs-save-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  try {
    await fs.writeFile(temp, data, "utf8");
    if (stat) await fs.chmod(temp, stat.mode).catch(() => {});
    await fs.rename(temp, absolute);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
  gitStatusCache.clear();
  const next = await fs.stat(absolute);
  return { ok: true, path: rel, size: next.size, mtimeMs: next.mtimeMs };
}

async function searchFiles(params) {
  const root = await resolveWorkspace(params.root);
  const query = String(params.query ?? "").trim().toLowerCase();
  if (query.length < 1) return { results: [], truncated: false };
  const token = (searchTokens.get(root) ?? 0) + 1;
  searchTokens.set(root, token);
  const showIgnored = Boolean(params.showIgnored);
  const results = [];
  const queue = [{ dir: root, rel: "" }];
  let visited = 0;
  let truncated = false;
  const deadline = Date.now() + 3000;
  while (queue.length) {
    if (searchTokens.get(root) !== token) return { results: [], truncated: true, cancelled: true };
    if (Date.now() > deadline || visited > MAX_SEARCH_ENTRIES) {
      truncated = true;
      break;
    }
    const { dir, rel } = queue.shift();
    let children;
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      if (searchTokens.get(root) !== token) return { results: [], truncated: true, cancelled: true };
      visited += 1;
      if (visited > MAX_SEARCH_ENTRIES) break;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (isForbiddenSegment(child.name)) continue;
        if (!showIgnored && IGNORED_DIRS.has(child.name)) continue;
        queue.push({ dir: path.join(dir, child.name), rel: childRel });
        continue;
      }
      if (child.name.toLowerCase().includes(query)) {
        results.push({ path: childRel, type: "file" });
        if (results.length >= 80) {
          truncated = true;
          break;
        }
      }
    }
    if (results.length >= 80) break;
  }
  results.sort((a, b) => {
    const aBase = a.path.split("/").pop().toLowerCase();
    const bBase = b.path.split("/").pop().toLowerCase();
    const aStarts = aBase.startsWith(query) ? 0 : 1;
    const bStarts = bBase.startsWith(query) ? 0 : 1;
    return aStarts - bStarts || a.path.length - b.path.length || a.path.localeCompare(b.path);
  });
  return { results, truncated };
}

async function gitStatus(params) {
  const root = await resolveWorkspace(params.root);
  const showIgnored = Boolean(params.showIgnored);
  const repoRoot = await gitRepo(root);
  if (!repoRoot) return { repo: false, root };
  let indexMtime = 0;
  try {
    indexMtime = (await fs.stat(path.join(repoRoot, ".git", "index"))).mtimeMs;
  } catch {}
  const cacheKey = `${root}::${showIgnored ? 1 : 0}::${indexMtime}`;
  const cached = gitStatusCache.get(cacheKey);
  if (cached && Date.now() - cached.at < GIT_STATUS_CACHE_MS) return cached.value;
  let branch = null;
  try {
    branch = await git.currentBranch({ fs, dir: repoRoot, fullname: false });
  } catch {}
  let head = null;
  try {
    const oid = await git.resolveRef({ fs, dir: repoRoot, ref: "HEAD" });
    head = oid.slice(0, 7);
  } catch {}
  const prefix = path.relative(repoRoot, root).replace(/\\/gu, "/");
  let tracked = [];
  try {
    const [headFiles, indexFiles] = await Promise.all([
      git.listFiles({ fs, dir: repoRoot, ref: "HEAD" }).catch(() => []),
      git.listFiles({ fs, dir: repoRoot }).catch(() => []),
    ]);
    tracked = [...new Set([...headFiles, ...indexFiles])];
  } catch {}
  if (prefix) tracked = tracked.filter((filepath) => filepath === prefix || filepath.startsWith(`${prefix}/`));
  const trackedTruncated = tracked.length > MAX_TRACKED_FILES;
  if (trackedTruncated) tracked = tracked.slice(0, MAX_TRACKED_FILES);
  const trackedSet = new Set(tracked.map((filepath) => (prefix ? filepath.slice(prefix.length + 1) : filepath)));
  const trackedDirs = new Set();
  for (const filepath of trackedSet) {
    const parts = filepath.split("/");
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      trackedDirs.add(current);
    }
  }
  let matrix = [];
  if (tracked.length) {
    try {
      matrix = await git.statusMatrix({ fs, dir: repoRoot, filepaths: tracked });
    } catch (error) {
      return { repo: true, root, repoRoot, branch, head, changes: [], error: error.message };
    }
  }
  const changes = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const [filepath, headState, workdir, stage] of matrix) {
    if (!filepath) continue;
    if (prefix && filepath !== prefix && !filepath.startsWith(`${prefix}/`)) continue;
    const status = statusOf(headState, workdir, stage);
    if (!status) continue;
    const relative = prefix ? filepath.slice(prefix.length + 1) : filepath;
    if (!relative) continue;
    const parts = relative.split("/");
    if (parts.some(isForbiddenSegment)) continue;
    if (!showIgnored && parts.some((part) => IGNORED_DIRS.has(part))) continue;
    if (status.staged) staged += 1;
    if (status.unstaged) unstaged += 1;
    if (status.untracked) untracked += 1;
    changes.push({ path: relative, ...status });
  }
  let truncated = trackedTruncated;
  let visited = 0;
  const queue = [{ dir: root, rel: "", depth: 0 }];
  outer: while (!trackedTruncated && queue.length) {
    const { dir, rel, depth } = queue.shift();
    let children = [];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      visited += 1;
      if (visited > MAX_UNTRACKED_ENTRIES || changes.length >= MAX_CHANGES) {
        truncated = true;
        break outer;
      }
      if (isForbiddenSegment(child.name)) continue;
      if (!showIgnored && IGNORED_DIRS.has(child.name)) continue;
      const childRel = rel ? `${rel}/${child.name}` : child.name;
      if (child.isDirectory()) {
        if (!trackedDirs.has(childRel)) {
          if (!trackedSet.has(childRel)) {
            changes.push({ path: `${childRel}/`, code: "??", staged: false, unstaged: false, untracked: true });
            untracked += 1;
          }
          continue;
        }
        if (depth >= MAX_UNTRACKED_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ dir: path.join(dir, child.name), rel: childRel, depth: depth + 1 });
        continue;
      }
      if (trackedSet.has(childRel)) continue;
      changes.push({ path: childRel, code: "??", staged: false, unstaged: false, untracked: true });
      untracked += 1;
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const value = {
    repo: true,
    root,
    repoRoot,
    branch: branch || (head ? `detached@${head}` : null),
    head,
    changes,
    counts: { total: changes.length, staged, unstaged, untracked },
    truncated,
  };
  gitStatusCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function gitDiff(params) {
  const root = await resolveWorkspace(params.root);
  const { rel, absolute } = await resolvePath(root, params.path);
  const repoRoot = await gitRepo(root);
  if (!repoRoot) throw new Error("不是 Git 仓库");
  const repoRel = path.relative(repoRoot, absolute).replace(/\\/gu, "/");
  let workBuffer = null;
  try {
    workBuffer = await fs.readFile(absolute);
  } catch {}
  let headBuffer = null;
  const headText = await readHeadText(root, repoRoot, repoRel);
  if (headText !== null) headBuffer = Buffer.from(headText, "utf8");
  const changed = workBuffer ?? headBuffer;
  if (!changed) return { path: rel, patch: "", additions: 0, deletions: 0, binary: false };
  if (changed.length > MAX_DIFF_BYTES) {
    return { path: rel, tooLarge: true, size: changed.length, patch: "", additions: 0, deletions: 0, binary: false };
  }
  if (await looksBinary(changed)) {
    return { path: rel, binary: true, patch: "", additions: 0, deletions: 0 };
  }
  const oldText = headBuffer ? new TextDecoder().decode(headBuffer).replace(/\r\n/gu, "\n") : "";
  const newText = workBuffer ? new TextDecoder().decode(workBuffer).replace(/\r\n/gu, "\n") : "";
  if (oldText === newText) {
    return { path: rel, patch: "", additions: 0, deletions: 0, binary: false };
  }
  const oldName = headBuffer ? `a/${repoRel}` : "/dev/null";
  const newName = workBuffer ? `b/${repoRel}` : "/dev/null";
  const result = structuredPatch(oldName, newName, oldText, newText, "", "", { context: 3 });
  const lines = [`--- ${oldName}`, `+++ ${newName}`];
  let additions = 0;
  let deletions = 0;
  for (const hunk of result.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      lines.push(line);
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { path: rel, patch: lines.join("\n"), additions, deletions, binary: false };
}

async function rememberWorkspace(ctx, rootInput) {
  const root = await resolveWorkspace(rootInput);
  const state = await readState(ctx);
  const recentRoots = [
    { root, at: Date.now() },
    ...state.recentRoots.filter((item) => item.root !== root),
  ].slice(0, 12);
  await writeState(ctx, { ...state, recentRoots });
  return { recentRoots };
}

export async function activate(ctx) {
  const handle = (name, fn) => ctx.handle(name, fn);
  handle("ping", async () => ({ ok: true, pid: process.pid }));
  handle("workspace.resolveThread", async (params) => {
    const result = await resolveThreadWorkspace(params?.threadId);
    if (result?.root) {
      await rememberWorkspace(ctx, result.root).catch(() => {});
    }
    return result ?? null;
  });
  handle("workspace.recentThreads", async (params) => {
    const limit = Number(params?.limit ?? 12);
    return { threads: await recentThreads(Number.isFinite(limit) ? limit : 12) };
  });
  handle("workspace.state", async () => ({ ...(await readState(ctx)) }));
  handle("workspace.remember", async (params) => rememberWorkspace(ctx, params?.root));
  handle("workspace.forget", async (params) => {
    const root = await resolveWorkspace(params?.root);
    const state = await readState(ctx);
    const recentRoots = state.recentRoots.filter((item) => item.root !== root);
    await writeState(ctx, { ...state, recentRoots });
    return { recentRoots };
  });
  handle("fs.list", async (params) => {
    const settings = await ctx.readSettings().catch(() => ({}));
    return listDirectory({
      ...params,
      showIgnored: params?.showIgnored ?? Boolean(settings?.showIgnored),
    });
  });
  handle("fs.read", readFile);
  handle("fs.write", writeFile);
  handle("fs.search", async (params) => {
    const settings = await ctx.readSettings().catch(() => ({}));
    return searchFiles({ ...params, showIgnored: params?.showIgnored ?? Boolean(settings?.showIgnored) });
  });
  handle("git.status", async (params) => {
    const settings = await ctx.readSettings().catch(() => ({}));
    return gitStatus({ ...params, showIgnored: params?.showIgnored ?? Boolean(settings?.showIgnored) });
  });
  handle("git.diff", gitDiff);
}
