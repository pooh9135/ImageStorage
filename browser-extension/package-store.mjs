// Packages dist/chromium and dist/zen as store uploads (run build.mjs first).
// Chrome Web Store and Edge Add-ons assign their own extension ID and reject the
// developer "key" field, so it is removed from the Chromium store manifest.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const base = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(base, "dist");
const out = path.join(dist, "store");
await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

async function stage(browser, edit) {
  const source = path.join(dist, browser);
  const staged = path.join(out, `.${browser}`);
  await fs.cp(source, staged, { recursive: true });
  const manifestPath = path.join(staged, "manifest.json");
  const manifest = edit(JSON.parse(await fs.readFile(manifestPath, "utf8")));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { staged, version: manifest.version };
}

function zip(directory, file) {
  const entries = spawnSync("cmd", ["/c", "dir", "/b"], { cwd: directory, encoding: "utf8" }).stdout.split(/\r?\n/).filter(Boolean);
  const result = spawnSync(path.join(process.env.WINDIR || "C:\\Windows", "System32", "tar.exe"), ["-a", "-c", "-f", file, ...entries], { cwd: directory, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`zip failed: ${result.stderr}`);
}

const chromium = await stage("chromium", ({ key, ...manifest }) => manifest);
zip(chromium.staged, path.join(out, `ImageStorage-Connector-${chromium.version}-Chrome-Edge.zip`));
const zen = await stage("zen", (manifest) => manifest);
zip(zen.staged, path.join(out, `ImageStorage-Connector-${zen.version}-Firefox.zip`));
for (const browser of ["chromium", "zen"]) await fs.rm(path.join(out, `.${browser}`), { recursive: true, force: true });
console.log(`Store packages written to ${out}`);
