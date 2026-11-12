import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");
const foundation = "http://schemas.microsoft.com/appx/manifest/foundation/windows10";
const visual = "http://schemas.microsoft.com/appx/manifest/uap/windows10";
const restricted = "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities";
export const storeLanguages = ["ja-JP", "en-US", "zh-CN", "ko-KR"];
const samplePublisher = "CN=00000000-0000-0000-0000-000000000000";

export function resolveStoreSettings(args, env = process.env) {
  if (args.some((arg) => !["--preview", "--release"].includes(arg)) || new Set(args).size !== args.length || args.length > 1) {
    throw new Error("Use --preview or --release (default). Store identity is supplied through IMAGESTORAGE_STORE_* environment variables.");
  }
  const preview = args.includes("--preview");
  const version = env.IMAGESTORAGE_STORE_VERSION || "1.0.0.0";
  if (!/^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.0$/.test(version) || version.split(".").some((part) => Number(part) > 65535)) {
    throw new Error("IMAGESTORAGE_STORE_VERSION must be Major.Minor.Build.0; Major must be 1-65535 and Minor/Build 0-65535.");
  }
  const settings = preview ? {
    identityName: "ImageStorage.StorePreview",
    publisher: samplePublisher,
    publisherDisplayName: "ImageStorage preview",
    displayName: "ImageStorage preview",
  } : {
    identityName: env.IMAGESTORAGE_STORE_IDENTITY_NAME,
    publisher: env.IMAGESTORAGE_STORE_PUBLISHER,
    publisherDisplayName: env.IMAGESTORAGE_STORE_PUBLISHER_DISPLAY_NAME,
    displayName: env.IMAGESTORAGE_STORE_DISPLAY_NAME,
  };
  const names = { identityName: "IDENTITY_NAME", publisher: "PUBLISHER", publisherDisplayName: "PUBLISHER_DISPLAY_NAME", displayName: "DISPLAY_NAME" };
  const missing = Object.keys(names).filter((key) => typeof settings[key] !== "string" || !settings[key].trim());
  if (missing.length) {
    throw new Error(`Store release preflight failed. Supply the exact Partner Center identity and reserved display name: ${missing.map((key) => `IMAGESTORAGE_STORE_${names[key]}`).join(", ")}. Use --preview only for a package preparation check.`);
  }
  const reservedName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)|(?:^|\.)xn--/i;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,48}[A-Za-z0-9-]$/.test(settings.identityName) || reservedName.test(settings.identityName) || settings.identityName.includes("..")) {
    throw new Error("Store identity name must be the valid 3-50 character Package/Identity/Name from Partner Center.");
  }
  if (!/^CN=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(settings.publisher)) {
    throw new Error("Store publisher must be the exact CN=<GUID> Package/Identity/Publisher from Partner Center, not a certificate path or an unsigned-test identity.");
  }
  if (!preview && (settings.publisher.toUpperCase() === samplePublisher || settings.identityName.toLowerCase() === "imagestorage.storepreview")) {
    throw new Error("Preview/sample identity cannot be used for a Store release. Reserve an app in Partner Center first.");
  }
  for (const key of ["publisherDisplayName", "displayName"]) {
    if (settings[key].length > 256 || settings[key] !== settings[key].trim() || /[\u0000-\u001f\u007f]/.test(settings[key])) {
      throw new Error(`Invalid ${names[key]}; use the exact non-empty Partner Center value (up to 256 characters).`);
    }
  }
  return { ...settings, version, preview };
}

function parseManifest(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unexpected declarations in Store manifest.");
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: (e) => errors.push(e), error: (e) => errors.push(e), fatalError: (e) => errors.push(e) } }).parseFromString(xml, "application/xml");
  if (errors.length || doc.documentElement?.namespaceURI !== foundation || doc.documentElement.localName !== "Package") {
    throw new Error("Store manifest is not valid package XML.");
  }
  return doc;
}

function one(doc, namespace, name) {
  const elements = doc.getElementsByTagNameNS(namespace, name);
  if (elements.length !== 1) throw new Error(`Expected exactly one ${name} in Store manifest.`);
  return elements[0];
}

export function applyStoreManifest(xml, settings) {
  const doc = parseManifest(xml);
  const identity = one(doc, foundation, "Identity");
  identity.setAttribute("Name", settings.identityName);
  identity.setAttribute("Publisher", settings.publisher);
  identity.setAttribute("Version", settings.version);
  one(doc, foundation, "DisplayName").textContent = settings.displayName;
  one(doc, foundation, "PublisherDisplayName").textContent = settings.publisherDisplayName;
  one(doc, visual, "VisualElements").setAttribute("DisplayName", settings.displayName);
  // xmldom 0.8 represents the XML declaration as a processing instruction.
  // Serialize the package element strictly, then write a known UTF-8 declaration.
  const result = '<?xml version="1.0" encoding="utf-8"?>\n' + new XMLSerializer().serializeToString(doc.documentElement, false, undefined, { requireWellFormed: true });
  verifyStoreManifest(result, settings);
  return result;
}

export function verifyStoreManifest(xml, settings) {
  const doc = parseManifest(xml);
  const identity = one(doc, foundation, "Identity");
  for (const [attribute, expected] of Object.entries({ Name: settings.identityName, Publisher: settings.publisher, Version: settings.version, ProcessorArchitecture: "x64" })) {
    if (identity.getAttribute(attribute) !== expected) throw new Error(`Store manifest ${attribute} does not match the requested build.`);
  }
  if (one(doc, foundation, "DisplayName").textContent !== settings.displayName || one(doc, foundation, "PublisherDisplayName").textContent !== settings.publisherDisplayName || one(doc, visual, "VisualElements").getAttribute("DisplayName") !== settings.displayName) {
    throw new Error("Store manifest display names do not match the requested build.");
  }
  const application = one(doc, foundation, "Application");
  if (application.getAttribute("Id") !== "ImageStorage" || application.getAttribute("Executable") !== "app\\ImageStorage.exe" || application.getAttribute("EntryPoint") !== "Windows.FullTrustApplication") {
    throw new Error("Store manifest does not launch the ImageStorage desktop executable.");
  }
  if (one(doc, restricted, "Capability").getAttribute("Name") !== "runFullTrust") throw new Error("Missing desktop FullTrust capability.");
  const languages = Array.from(doc.getElementsByTagNameNS(foundation, "Resource"), (element) => element.getAttribute("Language"));
  if (JSON.stringify(languages) !== JSON.stringify(storeLanguages)) throw new Error("Store manifest languages do not match the application.");
  const family = one(doc, foundation, "TargetDeviceFamily");
  if (family.getAttribute("Name") !== "Windows.Desktop" || family.getAttribute("MinVersion") !== "10.0.17763.0") throw new Error("Unexpected Store platform requirement.");
  return { identityName: settings.identityName, publisher: settings.publisher, version: settings.version, architecture: "x64", languages };
}
