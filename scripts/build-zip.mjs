import { createHash } from "node:crypto";
import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const id = manifest.id;
const version = manifest.version;
const errors = [];

const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
if (!ID_RE.test(id)) errors.push(`invalid id: ${id}`);
if (manifest.manifestVersion !== 2) errors.push("manifestVersion must be 2");
for (const field of ["name", "description", "details"]) {
  const value = manifest[field];
  if (typeof value === "string") continue;
  if (!value || typeof value.en !== "string" || typeof value["zh-CN"] !== "string") {
    errors.push(`${field} must have en and zh-CN`);
  }
}

const files = [];
async function add(rel) {
  const abs = path.join(root, rel);
  if (!existsSync(abs)) {
    errors.push(`missing file: ${rel}`);
    return;
  }
  const info = await stat(abs);
  if (!info.isFile()) {
    errors.push(`not a file: ${rel}`);
    return;
  }
  files.push(rel);
}

const entries = new Set();
for (const capability of ["page", "web", "backend"]) {
  const value = manifest[capability];
  if (!value) continue;
  if (!value.entry) errors.push(`${capability}.entry missing`);
  else entries.add(value.entry);
  if (value.style) entries.add(value.style);
  if (capability === "page" && value.entry && !value.entry.endsWith(".mjs")) errors.push("page.entry must be .mjs");
  if (capability === "web" && value.entry && !value.entry.endsWith(".mjs")) errors.push("web.entry must be .mjs");
}
if (manifest.page && manifest.web && manifest.page.entry === manifest.web.entry) errors.push("page and web entries must differ");
if (manifest.backend?.entry && [manifest.page?.entry, manifest.web?.entry].includes(manifest.backend.entry)) {
  errors.push("backend.entry must differ from frontend entries");
}

for (const rel of entries) await add(rel);
for (const rel of ["manifest.json", "README.md", "LICENSE"]) await add(rel);
for (const rel of manifest.screenshots ?? []) await add(rel);
if (manifest.icon) await add(manifest.icon);

for (const dir of ["shared", "assets"]) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) continue;
  const walk = async (current) => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      const rel = path.relative(root, next).split(path.sep).join("/");
      if (entry.isDirectory()) await walk(next);
      else if (!rel.startsWith("assets/") || !files.includes(rel)) files.push(rel);
    }
  };
  await walk(abs);
}

const unique = [...new Set(files)].sort();
const zipFiles = {};
for (const rel of unique) {
  const data = await readFile(path.join(root, rel));
  if (rel === manifest.icon && data.byteLength > 128 * 1024) errors.push(`icon too large: ${data.byteLength}`);
  if ((manifest.screenshots ?? []).includes(rel) && data.byteLength > 512 * 1024) errors.push(`screenshot too large: ${rel}`);
  if (/\.(mjs|js)$/.test(rel)) {
    const text = data.toString("utf8");
    if (/\bchild_process\b/.test(text)) errors.push(`child_process reference in ${rel}`);
    if (/\beval\s*\(/.test(text)) errors.push(`eval( in ${rel}`);
    if (/\bnew\s+Function\b/.test(text)) errors.push(`new Function in ${rel}`);
  }
  zipFiles[rel] = data;
}

const screenshotBytes = (manifest.screenshots ?? []).reduce((sum, rel) => {
  const entry = zipFiles[rel];
  return sum + (entry ? entry.byteLength : 0);
}, 0);
if ((manifest.screenshots ?? []).length > 4) errors.push("too many screenshots");
if (screenshotBytes > 2 * 1024 * 1024) errors.push("screenshots exceed 2 MiB");

if (errors.length) {
  for (const error of errors) console.error(`ERROR ${error}`);
  process.exit(1);
}

const zip = zipSync(zipFiles, { level: 9 });
if (zip.byteLength > 64 * 1024 * 1024) throw new Error(`zip too large: ${zip.byteLength}`);
const dist = path.join(root, "dist");
await mkdir(dist, { recursive: true });
const output = path.join(dist, `${id}-${version}.zip`);
await writeFile(output, zip);
const sha = createHash("sha256").update(zip).digest("hex");
console.log(`built ${path.relative(root, output)}`);
console.log(`files ${unique.length}, bytes ${zip.byteLength}, sha256 ${sha}`);
