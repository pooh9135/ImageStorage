import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export class SigningConfigurationError extends Error {}
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;

function normalizeThumbprint(value) {
  if (!/^[a-f\d]{40}$/i.test(value.trim())) {
    throw new SigningConfigurationError("The certificate SHA1 selector must contain exactly 40 hexadecimal characters.");
  }
  return value.trim().toUpperCase();
}

export function resolveSigningConfiguration(build = {}, env = {}, platform = process.platform) {
  if (platform !== "win32") throw new SigningConfigurationError("Signed ImageStorage releases must be built on Windows.");
  const win = build.win || {};
  const options = { ...(win.signtoolOptions || {}) };
  if (win.azureSignOptions) throw new SigningConfigurationError("Azure/Artifact Signing requires a separately configured and validated release workflow.");
  if (options.sign) throw new SigningConfigurationError("A custom signing hook is already configured. Remove it before using this verified release workflow.");
  if (nonempty(options.certificatePassword)) throw new SigningConfigurationError("Keep signing passwords out of package.json. Use WIN_CSC_KEY_PASSWORD or CSC_KEY_PASSWORD.");
  if (env.ELECTRON_BUILDER_OFFLINE === "true") throw new SigningConfigurationError("Signed releases require an online timestamp service; ELECTRON_BUILDER_OFFLINE must not be enabled.");
  const winLink = nonempty(env.WIN_CSC_LINK);
  const genericLink = nonempty(env.CSC_LINK);
  if (winLink && genericLink && env.WIN_CSC_LINK !== env.CSC_LINK) throw new SigningConfigurationError("Conflicting WIN_CSC_LINK and CSC_LINK inputs. Configure one signing identity.");
  const envThumbprint = nonempty(env.IMAGESTORAGE_CERTIFICATE_SHA1) ? normalizeThumbprint(env.IMAGESTORAGE_CERTIFICATE_SHA1) : null;
  if (nonempty(options.certificateSha1)) options.certificateSha1 = normalizeThumbprint(options.certificateSha1);
  const configuredStore = nonempty(options.certificateSha1) || nonempty(options.certificateSubjectName);
  const sources = [winLink || genericLink, nonempty(options.certificateFile), Boolean(envThumbprint), configuredStore].filter(Boolean).length;
  if (sources === 0) throw new SigningConfigurationError([
    "A trusted Windows code-signing certificate is required before creating a release.",
    "Set WIN_CSC_LINK (or CSC_LINK) for a PFX, or IMAGESTORAGE_CERTIFICATE_SHA1 for an explicitly selected certificate in the Windows store.",
    "Use WIN_CSC_KEY_PASSWORD for a protected PFX. Test/self-signed certificates are not accepted.",
    "No installer was built. Use the separate unsigned development build only for development.",
  ].join("\n"));
  if (sources !== 1) throw new SigningConfigurationError("Multiple signing credential sources are configured. Select one PFX or one Windows-store certificate.");
  if (envThumbprint) options.certificateSha1 = envThumbprint;
  return { signtoolOptions: options };
}

// Fixed code; file names are JSON data, never interpolated into PowerShell.
const verificationCommand = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $manifest = Get-Content -Raw -LiteralPath $env:IMAGESTORAGE_SIGNATURE_MANIFEST | ConvertFrom-Json
  $results = @()
  foreach ($file in $manifest.paths) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop
    $signer = $signature.SignerCertificate
    $selfSigned = $null -ne $signer -and $signer.Subject -eq $signer.Issuer
    $codeSigning = $false
    if ($null -ne $signer) {
      $codeSigning = @($signer.EnhancedKeyUsageList | Where-Object { [string]$_.ObjectId -eq '1.3.6.1.5.5.7.3.3' }).Count -gt 0
    }
    $results += [pscustomobject]@{
      path = (Resolve-Path -LiteralPath $file).ProviderPath
      status = [string]$signature.Status
      timestamped = $null -ne $signature.TimeStamperCertificate
      selfSigned = $selfSigned
      codeSigning = $codeSigning
      signerThumbprint = $(if ($null -ne $signer) { $signer.Thumbprint } else { $null })
      sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash
    }
  }
  $json = ConvertTo-Json -InputObject @($results) -Depth 4
  Set-Content -LiteralPath $env:IMAGESTORAGE_SIGNATURE_RESULT -Value $json -Encoding UTF8
} catch {
  Write-Error 'Windows signature inspection failed.'
  exit 1
}
`;

export function assertVerifiedSignatures(records, paths) {
  if (!Array.isArray(records) || records.length !== paths.length) throw new Error("Incomplete Windows signature report.");
  const expected = new Set(paths.map((file) => path.resolve(file).toLowerCase()));
  for (const record of records) {
    const key = typeof record.path === "string" ? path.resolve(record.path).toLowerCase() : "";
    if (!expected.delete(key) || record.status !== "Valid" || record.timestamped !== true || record.selfSigned !== false || record.codeSigning !== true || !/^[a-f\d]{64}$/i.test(record.sha256 || "") || !/^[a-f\d]{40}$/i.test(record.signerThumbprint || "")) {
      throw new Error("A release file has no valid, timestamped, trusted code-signing signature.");
    }
  }
  if (expected.size) throw new Error("Incomplete Windows signature report.");
  return records;
}

export async function verifyWindowsSignatures(paths) {
  if (process.platform !== "win32") throw new Error("Windows signature verification requires Windows.");
  const absolutePaths = paths.map((file) => path.resolve(file));
  if (!absolutePaths.length || new Set(absolutePaths.map((file) => file.toLowerCase())).size !== absolutePaths.length) throw new Error("Expected distinct release files to verify.");
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "imagestorage-signatures-"));
  const manifestPath = path.join(temporaryDirectory, "manifest.json");
  const resultPath = path.join(temporaryDirectory, "result.json");
  try {
    await writeFile(manifestPath, JSON.stringify({ paths: absolutePaths }));
    const verificationEnv = { ...process.env, IMAGESTORAGE_SIGNATURE_MANIFEST: manifestPath, IMAGESTORAGE_SIGNATURE_RESULT: resultPath };
    // Windows PowerShell 5 must discover its own modules, not inherit pwsh 7's
    // incompatible module paths through the Node build process.
    for (const key of Object.keys(verificationEnv)) {
      if (key.toLowerCase() === "psmodulepath") delete verificationEnv[key];
    }
    await new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", verificationCommand], {
        shell: false, windowsHide: true, stdio: "ignore",
        env: verificationEnv,
      });
      child.once("error", () => reject(new Error("Windows signature verification could not start.")));
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Windows signature inspection failed.")));
    });
    const resultText = (await readFile(resultPath, "utf8")).replace(/^\uFEFF/, "");
    return assertVerifiedSignatures(JSON.parse(resultText), absolutePaths);
  } finally {
    // Remove only the two exact files and empty directory created above.
    await rm(manifestPath, { force: true });
    await rm(resultPath, { force: true });
    await rmdir(temporaryDirectory);
  }
}

export function createVerifiedSigner(verify) {
  return async (configuration, packager) => {
    if (!configuration.cscInfo || configuration.hash !== "sha256") throw new Error("A real SHA256 signing identity is required.");
    const manager = await packager.signingManager.value;
    if (typeof manager.doSign !== "function") throw new Error("Unsupported Windows signing manager.");
    await manager.doSign(configuration, packager);
    await verify([configuration.path]);
  };
}
