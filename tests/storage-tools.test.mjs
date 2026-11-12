import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import sharp from "sharp";
import { createStorageTools, hasTransientSources } from "../desktop/storage-tools.cjs";

const mainText = await fs.readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const main = ts.createSourceFile("main.cjs", mainText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const validator = main.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "validProjectSnapshot");
const validation = vm.createContext({});
vm.runInContext(validator.getText(main), validation);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const image = (id, src, caption = "image") => ({ id, type: "image", src, caption, x: 15, y: -27, w: 40, h: 70, z: 1 });
const project = (items = []) => ({ format: "museboard", version: 2, savedAt: "2026-11-05T00:00:00.000Z", activeId: "a", boards: [
  { id: "a", name: "一覧", viewport: { x: 22, y: 9, scale: 1.7 }, items },
] });

async function fixture(t) {
  const root = fileURLToPath(new URL("../work/storage-tests/", import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "case-"));
  assert.equal(path.dirname(directory), root.replace(/[\\/]$/, ""));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const recoveryDirectory = path.join(directory, "recovery");
  const automatic = path.join(recoveryDirectory, "autosave.json");
  const original = path.join(directory, "original.png");
  const bytes = await sharp({ create: { width: 7, height: 11, channels: 4, background: "#49819e" } }).png().toBuffer();
  await fs.writeFile(original, bytes);
  const writeJsonAtomically = async (file, contents) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + ".tmp";
    await fs.writeFile(temporary, contents);
    await fs.rename(temporary, file);
  };
  const tools = createStorageTools({ recoveryDirectory, recoverySnapshotPaths: () => [automatic],
    validProjectSnapshot: validation.validProjectSnapshot, writeJsonAtomically,
    localProjectSourcePath: (source) => source.startsWith("file:") ? fileURLToPath(source) : null,
    readImageSource: async (source) => {
      if (source.startsWith("data:")) return Buffer.from(source.split(",")[1], "base64");
      throw new Error("Unavailable source");
    },
    sha256File: async (file) => hash(await fs.readFile(file)), sharp, maxImageBytes: 120 * 1024 * 1024,
  });
  return { directory, recoveryDirectory, automatic, original, bytes, tools, writeJsonAtomically };
}

test("backup catalog preserves a checkpoint, exact geometry and content after rotating autosave", async (t) => {
  const state = await fixture(t);
  const data = project([image("i", pathToFileURL(state.original).href)]);
  await state.tools.createBackup(data);
  await state.writeJsonAtomically(state.automatic, JSON.stringify(project()));
  const list = await state.tools.listBackups();
  assert.equal(list.backups.length, 2);
  const manual = list.backups.find((entry) => entry.kind === "manual");
  assert.equal(manual.boards, 1); assert.equal(manual.images, 1);
  const restored = await state.tools.readBackup(manual);
  assert.deepEqual(restored.boards, data.boards);
  assert.equal(restored.activeId, data.activeId);
  assert.equal(restored.backupReason, undefined);
});

test("rotated or path-forged backup tokens cannot restore different data", async (t) => {
  const state = await fixture(t);
  await state.writeJsonAtomically(state.automatic, JSON.stringify(project()));
  const token = (await state.tools.listBackups()).backups[0];
  const next = project(); next.boards[0].name = "newer data";
  await state.writeJsonAtomically(state.automatic, JSON.stringify(next));
  await assert.rejects(state.tools.readBackup(token), /Backup changed/);
  await assert.rejects(state.tools.readBackup({ ...token, id: "../original.png" }), /not found/);
  await assert.rejects(state.tools.readBackup({ ...token, digest: "wrong" }), /Invalid/);
});

test("unreadable snapshots are reported and transient image references cannot become backups", async (t) => {
  const state = await fixture(t);
  await state.writeJsonAtomically(state.automatic, "{broken");
  assert.equal((await state.tools.listBackups()).errors.length, 1);
  const data = project([image("i", "blob:only-this-session")]);
  await assert.rejects(state.tools.createBackup(data), /incomplete/);
  data.boards[0].items = [];
  data.boards[0].headerImageSrc = "blob:header";
  assert.equal(hasTransientSources(data), true);
  await assert.rejects(state.tools.createBackup(data), /incomplete/);
});

test("restoring a backup with a missing original is rejected before replacing current data", async (t) => {
  const state = await fixture(t);
  await state.tools.createBackup(project([image("i", pathToFileURL(state.original).href)]));
  const entry = (await state.tools.listBackups()).backups[0];
  await fs.unlink(state.original);
  await assert.rejects(state.tools.readBackup(entry), /image is missing/);
});

test("duplicate scan compares original bytes across lists and reports missing images", async (t) => {
  const state = await fixture(t);
  const copy = path.join(state.directory, "different-name.png");
  await fs.writeFile(copy, state.bytes);
  const other = await sharp(state.bytes).jpeg().toBuffer();
  const data = project([image("i1", pathToFileURL(state.original).href), image("i2", pathToFileURL(copy).href),
    image("i3", `data:image/jpeg;base64,${other.toString("base64")}`), image("missing", "https://unavailable.test/image")]);
  data.boards.push({ ...data.boards[0], id: "b", name: "second", items: [image("i4", pathToFileURL(state.original).href)] });
  const before = structuredClone(data);
  const result = await state.tools.findDuplicates(data);
  assert.equal(result.scanned, 4);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].items.length, 3);
  assert.equal(result.groups[0].hash, hash(state.bytes));
  assert.equal(result.errors.length, 1);
  assert.deepEqual(data, before, "detection must not delete, merge or change images");
});

test("list export preserves original bytes, exports every occurrence and never overwrites names", async (t) => {
  const state = await fixture(t);
  const output = path.join(state.directory, "output"); await fs.mkdir(output);
  const existing = path.join(output, "image.png"); await fs.writeFile(existing, "keep this file");
  const src = pathToFileURL(state.original).href;
  const data = project([image("1", src), image("2", src), image("3", src, "../NUL"),
    { id: "note", type: "note", text: "not an image", x: 0, y: 0, w: 100, h: 100, z: 3 },
    image("4", "https://unavailable.test/image", "missing")]);
  data.boards.push({ ...data.boards[0], id: "not-selected", items: [image("5", src)] });
  const before = structuredClone(data);
  const result = await state.tools.exportImages(data, "a", output);
  assert.equal(result.exported, 3); assert.equal(result.errors.length, 1);
  assert.deepEqual(result.files.slice(0, 2), ["image (2).png", "image (3).png"]);
  for (const filename of result.files) {
    assert.equal(path.dirname(path.resolve(output, filename)), output);
    assert.deepEqual(await fs.readFile(path.join(output, filename)), state.bytes);
  }
  assert.equal(await fs.readFile(existing, "utf8"), "keep this file");
  assert.deepEqual(await fs.readFile(state.original), state.bytes);
  assert.deepEqual(data, before);
  await assert.rejects(state.tools.exportImages(data, "removed-list", output), /not found/);
});

test("export uses the actual image format, not an incorrect caption extension", async (t) => {
  const state = await fixture(t);
  const data = project([image("i", pathToFileURL(state.original).href, "photo.jpeg")]);
  const result = await state.tools.exportImages(data, "a", state.directory);
  assert.deepEqual(result.files, ["photo.png"]);
  assert.deepEqual(await fs.readFile(path.join(state.directory, "photo.png")), state.bytes);
});
