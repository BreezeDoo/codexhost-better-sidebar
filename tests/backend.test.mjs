import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { activate } from "../backend/src/index.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bs-backend-"));
const workspace = path.join(temp, "workspace");
const dataDir = path.join(temp, "data");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(dataDir, { recursive: true });

execFileSync("git", ["init", "-q"], { cwd: workspace });
execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
await fs.writeFile(path.join(workspace, "README.md"), "# Hello\n\nfirst line\nsecond line\n", "utf8");
await fs.mkdir(path.join(workspace, "src"), { recursive: true });
await fs.writeFile(path.join(workspace, "src", "app.js"), "export const value = 1;\n", "utf8");
execFileSync("git", ["add", "."], { cwd: workspace });
execFileSync("git", ["commit", "-qm", "init"], { cwd: workspace });

const handlers = new Map();
const settings = {};
const ctx = {
  dataDir,
  extensionDir: path.resolve("."),
  readSettings: async () => settings,
  writeSettings: async (next) => Object.assign(settings, next),
  handle: (method, handler) => handlers.set(method, handler),
};
await activate(ctx);
const call = (method, params = {}) => handlers.get(method)(params);

await fs.writeFile(path.join(workspace, "README.md"), "# Hello\n\nfirst line changed\nsecond line\nthird\n", "utf8");
await fs.writeFile(path.join(workspace, "src", "new.js"), "export const next = 2;\n", "utf8");
await fs.mkdir(path.join(workspace, "node_modules", "x"), { recursive: true });
await fs.writeFile(path.join(workspace, "node_modules", "x", "index.js"), "ignored\n", "utf8");

const listing = await call("fs.list", { root: workspace });
assert.ok(listing.entries.some((entry) => entry.name === "README.md"));
assert.ok(!listing.entries.some((entry) => entry.name === "node_modules"));

const nested = await call("fs.list", { root: workspace, dir: "src" });
assert.deepEqual(nested.entries.map((entry) => entry.name), ["app.js", "new.js"]);

const read = await call("fs.read", { root: workspace, path: "README.md" });
assert.equal(read.kind, "text");
assert.equal(read.eol, "\n");
assert.match(read.content, /first line changed/u);

const saved = await call("fs.write", {
  root: workspace,
  path: "README.md",
  content: read.content + "fourth\n",
  baseMtime: read.mtimeMs,
  eol: read.eol,
});
assert.equal(saved.ok, true);

const conflict = await call("fs.write", {
  root: workspace,
  path: "README.md",
  content: "stale\n",
  baseMtime: read.mtimeMs,
});
assert.equal(conflict.conflict, true);

const status = await call("git.status", { root: workspace });
assert.equal(status.repo, true);
assert.equal(status.changes.find((change) => change.path === "README.md")?.code, " M");
assert.equal(status.changes.find((change) => change.path === "src/new.js")?.code, "??");
assert.ok(!status.changes.some((change) => change.path.startsWith("node_modules")));

// Staged states must match `git status --short`, not treat workdir===stage as a change.
await fs.writeFile(path.join(workspace, "staged.txt"), "one" + String.fromCharCode(10), "utf8");
execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
let stagedStatus = await call("git.status", { root: workspace });
assert.deepEqual(
  stagedStatus.changes.find((change) => change.path === "staged.txt"),
  { path: "staged.txt", code: "A ", staged: true, unstaged: false, untracked: false },
);
await fs.writeFile(path.join(workspace, "staged.txt"), "two-longer" + String.fromCharCode(10), "utf8");
await new Promise((resolve) => setTimeout(resolve, 1600));
stagedStatus = await call("git.status", { root: workspace });
assert.equal(stagedStatus.changes.find((change) => change.path === "staged.txt")?.code, "AM");
execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
execFileSync("git", ["commit", "-qm", "staged"], { cwd: workspace });
await fs.writeFile(path.join(workspace, "staged.txt"), "three" + String.fromCharCode(10), "utf8");
execFileSync("git", ["add", "staged.txt"], { cwd: workspace });
stagedStatus = await call("git.status", { root: workspace });
assert.deepEqual(
  stagedStatus.changes.find((change) => change.path === "staged.txt"),
  { path: "staged.txt", code: "M ", staged: true, unstaged: false, untracked: false },
);
await fs.writeFile(path.join(workspace, "staged.txt"), "four-longer" + String.fromCharCode(10), "utf8");
await new Promise((resolve) => setTimeout(resolve, 1600));
stagedStatus = await call("git.status", { root: workspace });
assert.equal(stagedStatus.changes.find((change) => change.path === "staged.txt")?.code, "MM");
execFileSync("git", ["rm", "-q", "src/app.js"], { cwd: workspace });
stagedStatus = await call("git.status", { root: workspace });
assert.deepEqual(
  stagedStatus.changes.find((change) => change.path === "src/app.js"),
  { path: "src/app.js", code: "D ", staged: true, unstaged: false, untracked: false },
);

const diff = await call("git.diff", { root: workspace, path: "README.md" });
assert.ok(diff.patch.includes("+first line changed"));
assert.ok(diff.patch.includes("+fourth"));
assert.ok(diff.additions >= 2);

const added = await call("git.diff", { root: workspace, path: "src/new.js" });
assert.equal(added.additions, 1);
assert.equal(added.deletions, 0);

const search = await call("fs.search", { root: workspace, query: "read" });
assert.ok(search.results.some((result) => result.path === "README.md"));

const traversal = await call("fs.read", { root: workspace, path: "../escape.txt" }).then(
  () => null,
  (error) => error,
);
assert.ok(traversal instanceof Error);

const upperForbidden = await call("fs.read", { root: workspace, path: ".GIT/config" }).then(
  () => null,
  (error) => error,
);
assert.ok(upperForbidden instanceof Error, "case-insensitive .git access must be rejected");
const forbiddenListing = await call("fs.list", { root: workspace });
assert.ok(!forbiddenListing.entries.some((entry) => entry.name.toLowerCase() === ".git"));

const bigPath = path.join(workspace, "big.txt");
await fs.writeFile(bigPath, "x".repeat(1.5 * 1024 * 1024 + 1024), "utf8");
const bigRead = await call("fs.read", { root: workspace, path: "big.txt" });
assert.equal(bigRead.truncated, true);
const bigSave = await call("fs.write", {
  root: workspace,
  path: "big.txt",
  content: bigRead.content,
  baseMtime: bigRead.mtimeMs,
}).then(() => null, (error) => error);
assert.ok(bigSave instanceof Error, "saving a truncated large file must be rejected");

const remembered = await call("workspace.remember", { root: workspace });
assert.ok(remembered.recentRoots.some((item) => item.root === workspace));

let linkCreated = false;
try {
  await fs.symlink(temp, path.join(workspace, "escape-link"), "junction");
  linkCreated = true;
} catch {}
if (linkCreated) {
  const escaped = await call("fs.list", { root: workspace, dir: "escape-link" }).then(
    () => null,
    (error) => error,
  );
  assert.ok(escaped instanceof Error, "symlink outside the workspace must be rejected");
}

console.log("backend tests passed");
await fs.rm(temp, { recursive: true, force: true });
