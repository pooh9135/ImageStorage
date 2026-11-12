import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { resolveLinkedImage } from "./src/linked-image.js";
import { pinterestBoardContextScript } from "./src/pinterest-board-context.js";

const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(base);
const identity = JSON.parse(await fs.readFile(path.join(base, "identity.json"), "utf8"));
const expectedId = createHash("sha256").update(Buffer.from(identity.chromiumKey, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + parseInt(character, 16)));
if (expectedId !== identity.chromiumId || !/^[a-p]{32}$/.test(expectedId)) throw new Error("Invalid extension identity");
const dist = path.join(base, "dist");
await fs.mkdir(dist, { recursive: true });
const icons = { 16: "icons/icon16.png", 32: "icons/icon32.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const common = {
  manifest_version: 3, name: "ImageStorage Connector", version: "0.4.4",
  description: "画像を右クリックして、ImageStorageの保存先リストを選んで送信します。",
  permissions: ["contextMenus", "nativeMessaging", "storage", "alarms", "activeTab", "scripting"],
  content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["linked-image-content.js", "context-position.js", "pinterest-board-context-content.js"], run_at: "document_start", all_frames: true, match_about_blank: true }],
  icons, action: { default_title: "ImageStorageに画像を送る", default_popup: "chooser.html", default_icon: icons },
};
for (const browser of ["chromium", "zen"]) {
  const output = path.join(dist, browser);
  await fs.mkdir(output, { recursive: true });
  for (const file of await fs.readdir(path.join(base, "src"))) await fs.copyFile(path.join(base, "src", file), path.join(output, file));
  await fs.writeFile(path.join(output, "linked-image-content.js"), `globalThis.__imageStorageResolveLinkedImage = ${resolveLinkedImage.toString()};\n`);
  await fs.writeFile(path.join(output, "pinterest-board-context-content.js"), pinterestBoardContextScript());
  await fs.mkdir(path.join(output, "icons"), { recursive: true });
  for (const [size, file] of Object.entries(icons)) await sharp(path.join(root, "desktop/assets/icon.png")).resize(Number(size), Number(size)).png().toFile(path.join(output, file));
  const specific = browser === "chromium" ? {
    key: identity.chromiumKey, minimum_chrome_version: "128", background: { service_worker: "background.js", type: "module" },
  } : {
    background: { scripts: ["background.js"], type: "module" },
    browser_specific_settings: { gecko: { id: identity.firefoxId, strict_min_version: "140.0", data_collection_permissions: { required: ["websiteContent", "browsingActivity"] } } },
  };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ ...common, ...specific }, null, 2));
}
if (process.platform !== "win32" && !process.argv.includes("--test")) throw new Error("The Windows native host must be compiled on Windows");
if (process.platform === "win32") {
  const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  await fs.access(compiler);
  const generated = path.join(root, "work/browser-extension-build");
  await fs.mkdir(generated, { recursive: true });
  const identitySource = path.join(generated, "HostIdentity.cs");
  await fs.writeFile(identitySource, `internal static class HostIdentity { public const string ChromiumId = ${JSON.stringify(identity.chromiumId)}; public const string FirefoxId = ${JSON.stringify(identity.firefoxId)}; }\n`);
  await fs.mkdir(path.join(dist, "native-host"), { recursive: true });
  for (const [source, output, target, references] of [
    ["NativeHost.cs", "native-host/ImageStorage.NativeHost.exe", "exe", ["System.Web.Extensions.dll"]],
    ["SetupConnector.cs", "SetupConnector.exe", "winexe", ["System.Web.Extensions.dll", "System.Windows.Forms.dll", "System.Drawing.dll"]],
  ]) {
    const result = spawnSync(compiler, ["/nologo", "/optimize+", "/platform:anycpu", `/target:${target}`, `/out:${path.join(dist, output)}`, ...references.map((reference) => `/reference:${reference}`), identitySource, path.join(base, "native", source)], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0) throw new Error(`Native connector compilation failed:\n${result.stdout}\n${result.stderr}`);
  }
}
for (const file of ["使い方.txt", "Zen署名申請.txt"]) await fs.copyFile(path.join(base, file), path.join(dist, file));
await fs.writeFile(path.join(dist, "extension-identity.json"), JSON.stringify({ hostName: identity.hostName, chromiumId: identity.chromiumId, firefoxId: identity.firefoxId, version: common.version }, null, 2));
console.log(`Built Chrome/Edge and Zen extensions, native host, and connector setup in ${dist}`);
