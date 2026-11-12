import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyStoreManifest, resolveStoreSettings, storeLanguages, verifyStoreManifest } from "../desktop/scripts/store-packaging.mjs";

const realEnv = {
  IMAGESTORAGE_STORE_IDENTITY_NAME: "12345.ExampleApp",
  IMAGESTORAGE_STORE_PUBLISHER: "CN=12345678-1234-5678-9abc-123456789abc",
  IMAGESTORAGE_STORE_PUBLISHER_DISPLAY_NAME: "制作 & Design",
  IMAGESTORAGE_STORE_DISPLAY_NAME: "Reference <Image> \"Board\"",
};

test("release requires all four Store values before doing any build work", () => {
  assert.throws(() => resolveStoreSettings([], {}), /Store release preflight failed/);
  for (const name of Object.keys(realEnv)) {
    const partial = { ...realEnv };
    delete partial[name];
    assert.throws(() => resolveStoreSettings(["--release"], partial), new RegExp(name));
  }
});

test("preview is unmistakable and cannot be accidentally used as release identity", () => {
  const preview = resolveStoreSettings(["--preview"], {});
  assert.equal(preview.identityName, "ImageStorage.StorePreview");
  assert.equal(preview.preview, true);
  assert.throws(() => resolveStoreSettings([], { ...realEnv, IMAGESTORAGE_STORE_IDENTITY_NAME: preview.identityName, IMAGESTORAGE_STORE_PUBLISHER: preview.publisher }), /Preview\/sample/);
  assert.throws(() => resolveStoreSettings(["--preview", "--release"], {}), /Use --preview or --release/);
  assert.throws(() => resolveStoreSettings(["--publsh"], {}), /Use --preview or --release/);
});

test("Store versions prohibit major zero and Store-reserved nonzero revision", () => {
  for (const version of ["0.15.0.0", "1.0.0.1", "65536.0.0.0", "1.65536.0.0", "1.0.65536.0", "1.0.0", "01.0.0.0", "1.0.0.0\n"]) {
    assert.throws(() => resolveStoreSettings(["--preview"], { IMAGESTORAGE_STORE_VERSION: version }), /IMAGESTORAGE_STORE_VERSION/);
  }
  assert.equal(resolveStoreSettings(["--preview"], {}).version, "1.0.0.0");
  assert.equal(resolveStoreSettings(["--preview"], { IMAGESTORAGE_STORE_VERSION: "65535.65535.65535.0" }).version, "65535.65535.65535.0");
});

test("invalid identities and sideload test publishers fail closed", () => {
  for (const identity of ["ab", "a".repeat(51), "bad_name", "CON", "con.anything", "bad..name"]) {
    assert.throws(() => resolveStoreSettings([], { ...realEnv, IMAGESTORAGE_STORE_IDENTITY_NAME: identity }), /identity name/);
  }
  assert.throws(() => resolveStoreSettings([], { ...realEnv, IMAGESTORAGE_STORE_PUBLISHER: `${realEnv.IMAGESTORAGE_STORE_PUBLISHER}, OID.2.25.311729368913984317654407730594956997722=1` }), /Store publisher/);
});

test("Store manifest hook escapes exact names and changes only package metadata", async () => {
  const settings = resolveStoreSettings([], { ...realEnv, IMAGESTORAGE_STORE_IDENTITY_NAME: "12345.ImageStorage", IMAGESTORAGE_STORE_VERSION: "1.15.0.0" });
  const source = await readFile(new URL("../node_modules/app-builder-lib/templates/appx/appxmanifest.xml", import.meta.url), "utf8");
  const values = {
    identityName: settings.identityName, publisher: settings.publisher, version: "0.15.0.0", arch: "x64",
    displayName: "ImageStorage", publisherDisplayName: "ImageStorage", description: "Desktop canvas",
    applicationId: "ImageStorage", executable: "app\\ImageStorage.exe", backgroundColor: "#24262d",
    resourceLanguages: storeLanguages.map((language) => `<Resource Language="${language}"/>`).join("\n"),
    minVersion: "10.0.17763.0", maxVersionTested: "10.0.26100.0", logo: "assets\\StoreLogo.png", square150x150Logo: "assets\\Square150x150Logo.png", square44x44Logo: "assets\\Square44x44Logo.png",
    lockScreen: "", defaultTile: "", splashScreen: "", extensions: "",
  };
  const template = source.replace(/\$\{(\w+)\}/g, (_, key) => values[key]);
  const updated = applyStoreManifest(template, settings);
  assert.match(updated, /制作 &amp; Design/);
  assert.match(updated, /Version="1\.15\.0\.0"/);
  assert.equal(verifyStoreManifest(updated, settings).version, "1.15.0.0");
  assert.match(template, /Version="0\.15\.0\.0"/);
  assert.throws(() => verifyStoreManifest(updated.replace("Windows.FullTrustApplication", "invalid"), settings), /does not launch/);
  assert.throws(() => verifyStoreManifest(updated.replace("1.15.0.0", "1.15.0.1"), settings), /Version does not match/);
  assert.throws(() => verifyStoreManifest(updated.replace("</DisplayName>", "</DisplayName trailing>"), settings), /not valid package XML/);
  assert.throws(() => applyStoreManifest(updated.replace("<Properties>", "<Properties><?XML invalid?>"), settings), /processing instruction target/i);
  assert.throws(() => verifyStoreManifest(`<!DOCTYPE Package>${updated}`, settings), /Unexpected declarations/);
});
