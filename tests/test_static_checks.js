import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mail-verify-static-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const folder of ["extension", "tests", "docs", "scripts"])
    mkdirSync(join(root, folder));
  cpSync(
    new URL("../scripts/check-static.js", import.meta.url),
    join(root, "scripts/check-static.js"),
  );
  const write = (path, text) => writeFileSync(join(root, path), text);
  write("package.json", '{"type":"module"}');
  const manifest = {
    manifest_version: 3,
    background: { service_worker: "background.js", type: "module" },
    action: { default_popup: "popup.html" },
    content_scripts: [{ matches: ["https://*/*"], js: ["content-entry.js"] }],
    web_accessible_resources: [{
      matches: ["https://*/*"],
      resources: ["inline.js", "shared.js"],
    }],
  };
  const saveManifest = () =>
    write("extension/manifest.json", JSON.stringify(manifest));
  saveManifest();
  write("extension/background.js", "export const background = true;");
  write("extension/popup.html", '<script type="module" src="popup.js"></script>');
  write("extension/popup.js", "export const popup = true;");
  write(
    "extension/content-entry.js",
    'import(chrome.runtime.getURL("inline.js"));',
  );
  write("extension/inline.js", 'export { value } from "./shared.js";');
  write("extension/shared.js", "export const value = true;");
  return {
    write,
    manifest,
    saveManifest,
    run: () => spawnSync(
      process.execPath,
      ["--experimental-vm-modules", join(root, "scripts/check-static.js")],
      { encoding: "utf8" },
    ),
  };
}

test("static checks accept valid references without executing modules", (t) => {
  const { write, run } = fixture(t);
  write(
    "extension/shared.js",
    'throw new Error("must not execute"); export const value = true;',
  );
  const result = run();
  assert.equal(result.status, 0, result.stderr);
});

test("static checks reject syntax errors in files and inline preview modules", (t) => {
  const { write, run } = fixture(t);
  write("extension/popup.js", "export const = ;");
  write("docs/preview.html", '<script type="module">export const = ;</script>');
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extension\/popup\.js/);
  assert.match(result.stderr, /docs\/preview\.html \(inline module\)/);
});

test("static checks reject missing manifest entry points and resources", (t) => {
  const { manifest, saveManifest, run } = fixture(t);
  manifest.background.service_worker = "missing-background.js";
  manifest.web_accessible_resources[0].resources.push("missing-resource.js");
  saveManifest();
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-background\.js/);
  assert.match(result.stderr, /missing-resource\.js/);
});

test("static checks reject missing import and re-export targets", (t) => {
  const { write, run } = fixture(t);
  write("extension/popup.js", `
    import "./missing-import.js";
    export * from "./missing-export.js";
  `);
  const result = run();
  assert.notEqual(result.status, 0);
  for (const name of ["import", "export"])
    assert.match(result.stderr, new RegExp(`missing-${name}\\.js`));
});

test("static checks reject missing Chrome module entry points", (t) => {
  const { write, run } = fixture(t);
  write(
    "extension/content-entry.js",
    'import(chrome.runtime.getURL("missing-inline.js"));',
  );
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-inline\.js/);
});

test("static checks reject inline dependencies omitted from web-accessible resources", (t) => {
  const { manifest, saveManifest, run } = fixture(t);
  manifest.web_accessible_resources[0].resources = ["inline.js"];
  saveManifest();
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shared\.js.*web.accessible/i);
});

test("static checks resolve external and inline preview modules relative to their HTML", (t) => {
  const { write, run } = fixture(t);
  write("docs/preview.html", `<script type="module" src="./missing-entry.js"></script>
    <script type="module">import "/extension/missing-preview.js";</script>`);
  const result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing-entry\.js/);
  assert.match(result.stderr, /missing-preview\.js/);
});
