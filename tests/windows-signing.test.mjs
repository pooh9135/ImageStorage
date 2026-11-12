import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertVerifiedSignatures, createVerifiedSigner, resolveSigningConfiguration, verifyWindowsSignatures } from "../desktop/scripts/windows-signing.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const thumbprint = "A".repeat(40);

test("release preflight selects one identity without exposing credential values", () => {
  assert.throws(() => resolveSigningConfiguration({}, {}, "win32"), /certificate is required/);
  assert.throws(() => resolveSigningConfiguration({}, { WIN_CSC_LINK: "private-secret-one", IMAGESTORAGE_CERTIFICATE_SHA1: thumbprint }, "win32"), (error) => !error.message.includes("private-secret") && /Multiple/.test(error.message));
  assert.throws(() => resolveSigningConfiguration({}, { IMAGESTORAGE_CERTIFICATE_SHA1: "invalid-secret" }, "win32"), (error) => !error.message.includes("invalid-secret") && /40 hexadecimal/.test(error.message));
  assert.equal(resolveSigningConfiguration({}, { IMAGESTORAGE_CERTIFICATE_SHA1: thumbprint.toLowerCase() }, "win32").signtoolOptions.certificateSha1, thumbprint);
  assert.equal(resolveSigningConfiguration({ win: { signtoolOptions: { certificateSubjectName: "Publisher" } } }, {}, "win32").signtoolOptions.certificateSubjectName, "Publisher");
  assert.equal(resolveSigningConfiguration({ win: { signtoolOptions: { certificateFile: "signing.pfx" } } }, {}, "win32").signtoolOptions.certificateFile, "signing.pfx");
  assert.doesNotThrow(() => resolveSigningConfiguration({}, { WIN_CSC_LINK: "private-secret-one" }, "win32"));
});

test("signature gate rejects invalid identity, missing timestamp and incomplete reports", () => {
  const files = [path.join(root, "app.exe"), path.join(root, "setup.exe")];
  const valid = files.map((file) => ({ path: file, status: "Valid", timestamped: true, selfSigned: false, codeSigning: true, sha256: "A".repeat(64), signerThumbprint: thumbprint }));
  assert.doesNotThrow(() => assertVerifiedSignatures(valid, files));
  for (const invalid of [{ status: "NotSigned" }, { status: "HashMismatch" }, { timestamped: false }, { selfSigned: true }, { codeSigning: false }, { path: files[1] }]) {
    assert.throws(() => assertVerifiedSignatures([{ ...valid[0], ...invalid }, valid[1]], files));
  }
  assert.throws(() => assertVerifiedSignatures(valid.slice(0, 1), files));
});

test("NSIS signing gate awaits default signing and refuses unverified uninstaller", async () => {
  const events = [];
  const configuration = { path: "__uninstaller-nsis-imagestorage.exe", cscInfo: { thumbprint }, hash: "sha256" };
  const packager = { signingManager: { value: Promise.resolve({ doSign: async (actual) => { assert.equal(actual, configuration); events.push("signed"); } }) } };
  const sign = createVerifiedSigner(async (paths) => { assert.deepEqual(paths, [configuration.path]); events.push("verified"); throw new Error("untrusted signature"); });
  await assert.rejects(sign(configuration, packager), /untrusted signature/);
  assert.deepEqual(events, ["signed", "verified"]);
  await assert.rejects(sign({ ...configuration, cscInfo: null }, packager));
  assert.deepEqual(events, ["signed", "verified"]);
});

test("Windows release command without credentials stops before modifying build output", { skip: process.platform !== "win32" }, async () => {
  const output = path.join(root, "desktop-dist/index.html");
  const before = await stat(output).catch(() => null);
  const env = { ...process.env };
  for (const key of ["WIN_CSC_LINK", "CSC_LINK", "IMAGESTORAGE_CERTIFICATE_SHA1", "WIN_CSC_KEY_PASSWORD", "CSC_KEY_PASSWORD", "ELECTRON_BUILDER_OFFLINE"]) delete env[key];
  const result = spawnSync(process.execPath, [path.join(root, "desktop/scripts/build-signed.mjs")], { cwd: root, env, encoding: "utf8", shell: false, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /certificate is required/);
  assert.doesNotMatch(result.stderr, /EINVAL/);
  const after = await stat(output).catch(() => null);
  assert.equal(after?.mtimeMs, before?.mtimeMs);
});

test("Windows verifier rejects the existing unsigned release executable", { skip: process.platform !== "win32" }, async (context) => {
  const unsigned = path.join(root, "release-imagestorage-0.15.0/win-unpacked/ImageStorage.exe");
  if (!(await stat(unsigned).catch(() => null))) { context.skip("No local unsigned fixture"); return; }
  await assert.rejects(verifyWindowsSignatures([unsigned]), /no valid, timestamped, trusted code-signing signature/);
});

test("release failures remain nonzero when builder cleanup resets the exit code", { skip: process.platform !== "win32" }, () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:WIN_CSC_|CSC_|IMAGESTORAGE_STORE_)/.test(key) || key === "IMAGESTORAGE_CERTIFICATE_SHA1") delete env[key];
  }
  for (const script of ["build-signed.mjs", "build-store.mjs"]) {
    const entry = new URL(`../desktop/scripts/${script}`, import.meta.url).href;
    const source = `process.on("exit", () => { process.exitCode = 0; }); await import(${JSON.stringify(entry)});`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: root, env, encoding: "utf8", shell: false, windowsHide: true });
    assert.equal(result.status, 1, `${script}: ${result.stderr}`);
  }
});

test("Windows verifier accepts the OS's trusted timestamped PowerShell binary", { skip: process.platform !== "win32" }, async () => {
  const binary = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  const records = await verifyWindowsSignatures([binary]);
  assert.equal(records[0].status, "Valid");
  assert.equal(records[0].codeSigning, true);
});
