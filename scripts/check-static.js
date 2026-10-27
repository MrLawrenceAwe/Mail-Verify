import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceTextModule } from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
const extensionRoot = join(root, "extension");
const dependencies = new Map();
const manifest = JSON.parse(
  readFileSync(join(extensionRoot, "manifest.json"), "utf8"),
);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function requireFile(path, owner) {
  try {
    if (statSync(path).isFile()) return;
  } catch {
    // Include the referring file so moves and renames are easy to repair.
  }
  fail(`${owner}: missing file ${relative(root, path)}`);
}

function addDependency(owner, path) {
  if (!dependencies.has(owner)) dependencies.set(owner, new Set());
  dependencies.get(owner).add(path);
  requireFile(path, relative(root, owner));
}

function localReference(owner, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return;
  const path = specifier.startsWith("/")
    ? fileURLToPath(new URL(`.${specifier}`, pathToFileURL(root)))
    : fileURLToPath(new URL(specifier, pathToFileURL(owner)));
  addDependency(owner, path);
}

function checkModule(source, path, label = relative(root, path)) {
  try {
    // Parse and inspect imports without linking or evaluating application code.
    const module = new SourceTextModule(source, { identifier: label });
    for (const specifier of module.dependencySpecifiers)
      localReference(path, specifier);
  } catch (error) {
    fail(`${label}: ${error.message}`);
  }
}

function htmlReference(owner, specifier) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(specifier)) return;
  localReference(
    owner,
    specifier.startsWith(".") || specifier.startsWith("/")
      ? specifier
      : `./${specifier}`,
  );
}

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (entry.name.endsWith(".js"))
      checkModule(readFileSync(path, "utf8"), path);
    else if (entry.name.endsWith(".html")) {
      const source = readFileSync(path, "utf8");
      const scripts = source.matchAll(
        /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
      );
      for (const match of scripts) {
        const src = match[1].match(/\bsrc=["']([^"']+)["']/i)?.[1];
        if (src) htmlReference(path, src);
        else if (/\btype=["']module["']/i.test(match[1]))
          checkModule(match[2], path, `${relative(root, path)} (inline module)`);
      }
      for (const match of source.matchAll(/<link\b([^>]*)>/gi)) {
        if (!/\brel=["']stylesheet["']/i.test(match[1])) continue;
        const href = match[1].match(/\bhref=["']([^"']+)["']/i)?.[1];
        if (href) htmlReference(path, href);
      }
    }
  }
}

for (const directory of ["extension", "tests", "docs", "scripts"])
  inspect(join(root, directory));

const contentScripts = manifest.content_scripts || [];
const resources = new Set(
  (manifest.web_accessible_resources || []).flatMap((entry) => entry.resources),
);
const entries = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...Object.values(manifest.icons || {}),
  ...(typeof manifest.action?.default_icon === "string"
    ? [manifest.action.default_icon]
    : Object.values(manifest.action?.default_icon || {})),
  ...contentScripts.flatMap((entry) => [...(entry.js || []), ...(entry.css || [])]),
  ...resources,
].filter(Boolean);
for (const entry of entries)
  requireFile(join(extensionRoot, entry), "extension/manifest.json");

// Content scripts load their module entry points through literal getURL calls.
// Only these entry points and their imports need web-accessible declarations.
const inlineEntries = [];
for (const entry of contentScripts.flatMap((entry) => entry.js || [])) {
  const path = join(extensionRoot, entry);
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    continue; // Already reported as a missing manifest entry.
  }
  const imports = source.matchAll(
    /import\(\s*chrome\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)\s*\)/g,
  );
  for (const match of imports) {
    const target = join(extensionRoot, match[1]);
    addDependency(path, target);
    inlineEntries.push(target);
  }
}
const visited = new Set();
while (inlineEntries.length) {
  const path = inlineEntries.pop();
  if (visited.has(path)) continue;
  visited.add(path);
  const name = relative(extensionRoot, path);
  if (!resources.has(name))
    fail(`${name}: missing web-accessible resource declaration`);
  inlineEntries.push(...(dependencies.get(path) || []));
}
