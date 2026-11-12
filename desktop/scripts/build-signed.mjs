import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  SigningConfigurationError,
  createVerifiedSigner,
  resolveSigningConfiguration,
  verifyWindowsSignatures,
} from "./windows-signing.mjs";

const projectDirectory = fileURLToPath(new URL("../../", import.meta.url));

function runNode(relativeEntry, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectDirectory, relativeEntry), ...args], {
      cwd: projectDirectory,
      env: process.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    child.once("error", () => reject(new Error("Build process could not start.")));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error("Build process did not complete."));
    });
  });
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectDirectory, "package.json"), "utf8"));
  // Fail before generating icons, renderer files, or release artifacts.
  const signing = resolveSigningConfiguration(packageJson.build, process.env, process.platform);
  const verifiedFiles = new Map();
  const verify = async (paths) => {
    const records = await verifyWindowsSignatures(paths);
    for (const record of records) verifiedFiles.set(path.resolve(record.path), record);
    return records;
  };
  const sign = createVerifiedSigner(verify);

  await runNode("desktop/scripts/create-icon.mjs");
  await runNode("browser-extension/build.mjs");
  await runNode("node_modules/vite/bin/vite.js", ["build", "--config", "vite.desktop.config.ts"]);
  const { build, Platform, Arch } = await import("electron-builder");
  await build({
    projectDir: projectDirectory,
    targets: Platform.WINDOWS.createTarget(["portable", "nsis"], Arch.x64),
    publish: "never",
    config: {
      ...packageJson.build,
      forceCodeSigning: true,
      win: {
        ...packageJson.build.win,
        forceCodeSigning: true,
        signAndEditExecutable: true,
        signExts: [...new Set([...(packageJson.build.win.signExts || []), ".dll", ".node"])],
        signtoolOptions: { ...signing.signtoolOptions, signingHashAlgorithms: ["sha256"], sign },
      },
    },
  });

  const outputDirectory = path.resolve(projectDirectory, packageJson.build.directories.output);
  const productName = packageJson.build.productName;
  const requiredPaths = [
    path.join(outputDirectory, "win-unpacked", `${productName}.exe`),
    path.join(outputDirectory, `${productName}-${packageJson.version}-Setup.exe`),
    path.join(outputDirectory, `${productName}-${packageJson.version}-Portable.exe`),
  ];
  await verify(requiredPaths);
  // NSIS removes this temporary file after embedding it. Its signature was
  // checked by our signing hook before NSIS was allowed to continue.
  if (![...verifiedFiles.keys()].some((file) => path.basename(file).startsWith("__uninstaller-nsis-") && file.endsWith(".exe"))) {
    throw new Error("The embedded uninstaller was not verified.");
  }
  await writeFile(path.join(outputDirectory, "signature-verification.json"), JSON.stringify({
    version: packageJson.version,
    verifiedAt: new Date().toISOString(),
    files: [...verifiedFiles.values()],
  }, null, 2));
  console.log("Verified Windows signatures: app, native modules, installer, portable launcher, and embedded uninstaller.");
}

main().catch((error) => {
  // Signing libraries can include certificate input or passwords in errors.
  // Only our credential-independent preflight messages are safe to print.
  console.error(error instanceof SigningConfigurationError
    ? error.message
    : "Signed release failed. No verified release was completed. Check the configured certificate, trust chain, timestamp service, and build tools.");
  process.exitCode = 1;
  // Match electron-builder's CLI even when cleanup changes the process exit code.
  process.on("exit", () => { process.exitCode = 1; });
});
