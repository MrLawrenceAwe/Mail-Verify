import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8"));

function check(source, label) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: source,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    console.error(`${label}:\n${result.stderr}`);
    process.exitCode = 1;
  }
}

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (entry.name.endsWith(".js"))
      check(readFileSync(path, "utf8"), relative(root, path));
    else if (entry.name.endsWith(".html")) {
      const source = readFileSync(path, "utf8");
      const modules = source.matchAll(
        /<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi,
      );
      for (const match of modules)
        check(match[1], `${relative(root, path)} (inline module)`);
    }
  }
}

for (const directory of ["extension", "tests", "docs", "scripts"])
  inspect(join(root, directory));
