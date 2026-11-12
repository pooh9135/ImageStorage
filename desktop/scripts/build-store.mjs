import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyStoreManifest, resolveStoreSettings, storeLanguages, verifyStoreManifest } from "./store-packaging.mjs";

const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);
const logos = { "StoreLogo.png": [50, 50], "Square44x44Logo.png": [44, 44], "Square150x150Logo.png": [150, 150], "Wide310x150Logo.png": [310, 150], "Square310x310Logo.png": [310, 310] };

function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: projectDirectory, env: process.env, shell: false, windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} failed (exit ${code}).`)));
  });
}

async function findMakeAppx() {
  const sdkRoot = path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Windows Kits", "10", "bin");
  const versions = (await readdir(sdkRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory() && /^10\.0\.\d+\.\d+$/.test(entry.name) && Number(entry.name.split(".")[2]) >= 17763).map((entry) => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const candidates = versions.map((version) => path.join(sdkRoot, version, "x64", "makeappx.exe"));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed SDK. */ }
  }
  throw new Error("An installed Windows SDK (10.0.17763.0 or newer) with x64 MakeAppx.exe is required to create and validate the Store package.");
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function collectFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Unexpected link in unpacked Store package.");
    if (entry.isDirectory()) result.push(...await collectFiles(file));
    else result.push(file);
  }
  return result;
}

async function packStorePackage(artifact, outputDirectory, resourceDirectory, settings, packageJson, sdk) {
  const inputDirectory = path.join(outputDirectory, "package-input");
  await mkdir(inputDirectory, { recursive: true });
  const escapeXml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]);
  const values = {
    identityName: settings.identityName, publisher: settings.publisher, version: settings.version, arch: "x64",
    displayName: "ImageStorage", publisherDisplayName: "ImageStorage", description: escapeXml(packageJson.description || "ImageStorage"),
    applicationId: "ImageStorage", executable: "app\\ImageStorage.exe", backgroundColor: "#24262d",
    resourceLanguages: storeLanguages.map((language) => `<Resource Language="${language}"/>`).join("\n"),
    minVersion: "10.0.17763.0", maxVersionTested: "10.0.26100.0", logo: "assets\\StoreLogo.png",
    square150x150Logo: "assets\\Square150x150Logo.png", square44x44Logo: "assets\\Square44x44Logo.png",
    lockScreen: "", defaultTile: '<uap:DefaultTile Wide310x150Logo="assets\\Wide310x150Logo.png" Square310x310Logo="assets\\Square310x310Logo.png"/>', splashScreen: "", extensions: "",
  };
  const template = await readFile(require.resolve("app-builder-lib/templates/appx/appxmanifest.xml"), "utf8");
  const manifest = template.replace(/\$\{(\w+)\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Unsupported Store manifest template field: ${key}`);
    return values[key];
  });
  const manifestPath = path.join(inputDirectory, "AppxManifest.xml");
  await writeFile(manifestPath, applyStoreManifest(manifest, settings));
  const appDirectory = path.join(outputDirectory, "win-unpacked");
  const mappings = (await collectFiles(appDirectory)).map((file) => [file, `app\\${path.relative(appDirectory, file)}`]);
  for (const name of Object.keys(logos)) mappings.push([path.join(resourceDirectory, "appx", name), `assets\\${name}`]);
  mappings.push([manifestPath, "AppxManifest.xml"]);
  if (mappings.some((mapping) => mapping.some((file) => /["\r\n]/.test(file)))) throw new Error("Unsupported character in Store package mapping path.");
  const mappingPath = path.join(inputDirectory, "mapping.txt");
  await writeFile(mappingPath, `[Files]\r\n${mappings.map(([source, destination]) => `"${source}" "${destination}"`).join("\r\n")}`);
  // Use the installed SDK for both operations. The builder's AppX target uses an older cached MakeAppx.
  await run(sdk, ["pack", "/o", "/f", mappingPath, "/p", artifact]);
}

async function checkX64(file) {
  const handle = await open(file, "r");
  try {
    const dos = Buffer.alloc(64);
    await handle.read(dos, 0, dos.length, 0);
    if (dos.toString("ascii", 0, 2) !== "MZ") throw new Error(`Invalid native binary: ${path.basename(file)}`);
    const pe = Buffer.alloc(6);
    await handle.read(pe, 0, pe.length, dos.readUInt32LE(60));
    if (pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) throw new Error(`Expected x64 native binary: ${path.basename(file)}`);
  } finally { await handle.close(); }
}

async function validatePackage(artifact, outputDirectory, resourceDirectory, settings, sdk) {
  const validationDirectory = await mkdtemp(path.join(outputDirectory, "validation-"));
  await run(sdk, ["unpack", "/p", artifact, "/d", validationDirectory]);
  const manifest = verifyStoreManifest(await readFile(path.join(validationDirectory, "AppxManifest.xml"), "utf8"), settings);
  const files = await collectFiles(validationDirectory);
  if (files.some((file) => path.basename(file).toLowerCase() === "appxsignature.p7x")) throw new Error("Store submission package was unexpectedly signed.");
  // MakeAppx validates package structure, but omits [Content_Types].xml when unpacking.
  for (const required of ["AppxBlockMap.xml", "app/ImageStorage.exe", "app/resources/app.asar"]) await access(path.join(validationDirectory, required));
  const nativeFiles = files.filter((file) => /\.(exe|dll|node)$/i.test(file));
  for (const file of nativeFiles) await checkX64(file);
  if (!nativeFiles.some((file) => /sharp-win32-x64\.node$/i.test(file)) || !nativeFiles.some((file) => /libvips[^\\/]*\.dll$/i.test(file))) throw new Error("Packaged Sharp native dependencies are missing.");
  const asar = require("@electron/asar");
  const asarFile = path.join(validationDirectory, "app", "resources", "app.asar");
  const rendererFiles = await collectFiles(path.join(projectDirectory, "desktop-dist"));
  const currentEntries = ["desktop/main.cjs", "desktop/preload.cjs", ...rendererFiles.map((file) => path.relative(projectDirectory, file).split(path.sep).join("/"))];
  for (const entry of currentEntries) {
    if (!asar.extractFile(asarFile, path.normalize(entry)).equals(await readFile(path.join(projectDirectory, entry)))) throw new Error(`Packaged ${entry} differs from the current build.`);
  }
  for (const name of Object.keys(logos)) {
    if (await sha256(path.join(validationDirectory, "assets", name)) !== await sha256(path.join(resourceDirectory, "appx", name))) throw new Error(`Store logo mismatch: ${name}`);
  }
  return {
    state: "validated", mode: settings.preview ? "preview" : "release", storeSubmissionReady: !settings.preview,
    signed: false, locallyInstallable: false, installedOrLaunched: false, userDataMigrationTested: false,
    limitation: settings.preview
      ? "Preparation sample identity only: do not submit or distribute. Not locally installable as a trusted package. A Partner Center identity, Store certification and Microsoft signing are still required."
      : "Unsigned Store submission package. Identity ownership and certification have not been checked with Microsoft. Normal installation requires Store certification and Microsoft signing.",
    migrationNote: "Packaged AppData behavior and existing ImageStorage/museboard profile migration remain unverified. Back up portable .imagestorage projects before moving to the Store version.",
    manifest, artifact, bytes: (await stat(artifact)).size, sha256: await sha256(artifact),
    validation: { makeAppx: sdk, unpackedAt: validationDirectory, manifest: true, currentAppSources: true, brandedLogos: true, sharpDependencies: true, nativeFiles: nativeFiles.map((file) => path.relative(validationDirectory, file)) },
    checkedAt: new Date().toISOString(),
  };
}

async function main() {
  // Identity validation happens before icons, renderer or package output is changed.
  const settings = resolveStoreSettings(process.argv.slice(2));
  if (process.platform !== "win32") throw new Error("Store MSIX builds require Windows.");
  const sdk = await findMakeAppx();
  const packageJson = JSON.parse(await readFile(path.join(projectDirectory, "package.json"), "utf8"));
  const win = packageJson.build.win || {};
  const signingOptions = { ...win, ...win.signtoolOptions };
  if (win.azureSignOptions || ["certificateFile", "certificatePassword", "certificateSha1", "certificateSubjectName", "sign"].some((key) => signingOptions[key]) || packageJson.build.cscLink) {
    throw new Error("Store submission builds are unsigned. Remove signing-specific package.json build options or keep them in the separate signed-EXE build script.");
  }
  const outputDirectory = path.join(projectDirectory, settings.preview ? "work/store-preview" : "release-imagestorage-store");
  const resourceDirectory = path.join(projectDirectory, "work", "store-resources");
  // This process creates an unsigned Store submission. Never discover or use signing credentials.
  for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) delete process.env[name];
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "store-package-validation.json"), JSON.stringify({ state: "building", mode: settings.preview ? "preview" : "release", storeSubmissionReady: false, signed: false, installedOrLaunched: false }, null, 2));
  await run(process.execPath, [path.join(projectDirectory, "desktop/scripts/create-icon.mjs")]);
  await run(process.execPath, [path.join(projectDirectory, "browser-extension/build.mjs")]);
  await run(process.execPath, [path.join(projectDirectory, "node_modules/vite/bin/vite.js"), "build", "--config", "vite.desktop.config.ts"]);
  await mkdir(path.join(resourceDirectory, "appx"), { recursive: true });
  const { default: sharp } = await import("sharp");
  for (const [name, [width, height]] of Object.entries(logos)) {
    await sharp(path.join(projectDirectory, "desktop/assets/icon.png")).resize(width, height, { fit: "contain", background: { r: 36, g: 38, b: 45, alpha: 1 } }).png().toFile(path.join(resourceDirectory, "appx", name));
  }
  const artifactName = `ImageStorage-${packageJson.version}-${settings.preview ? "StorePreview" : "Store"}.msix`;
  const { build, Platform, Arch } = await import("electron-builder");
  await build({
    projectDir: projectDirectory, targets: Platform.WINDOWS.createTarget(["dir"], Arch.x64), publish: "never",
    config: {
      ...packageJson.build, forceCodeSigning: false,
      directories: { ...packageJson.build.directories, output: outputDirectory, buildResources: resourceDirectory },
      win: { icon: "desktop/assets/icon.ico", target: [{ target: "dir", arch: ["x64"] }], forceCodeSigning: false, signAndEditExecutable: true, signtoolOptions: {} },
    },
  });
  await packStorePackage(path.join(outputDirectory, artifactName), outputDirectory, resourceDirectory, settings, packageJson, sdk);
  const report = await validatePackage(path.join(outputDirectory, artifactName), outputDirectory, resourceDirectory, settings, sdk);
  await writeFile(path.join(outputDirectory, "store-package-validation.json"), JSON.stringify(report, null, 2));
  console.log(settings.preview ? "Store preview validated. SAMPLE IDENTITY: not for submission, distribution or installation." : "Unsigned Store submission package validated locally. Microsoft certification and signing are still required.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
  // Match electron-builder's CLI: its cleanup must not turn a failed build into exit code 0.
  process.on("exit", () => { process.exitCode = 1; });
});
