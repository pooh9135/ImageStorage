import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/note-settings.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DEFAULT_NOTE_SETTINGS, normalizeNoteSettings, applyNoteSettings } =
  await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const defaults = { noteFont: 'Inter, "Noto Sans JP", "Segoe UI", sans-serif', noteFontSize: 12 };

test("missing, legacy and malformed note settings use the existing defaults", () => {
  assert.deepEqual(DEFAULT_NOTE_SETTINGS, defaults);
  for (const value of [undefined, null, false, 10, "{}", [], {}, { language: "ja" }]) {
    const normalized = normalizeNoteSettings(value);
    assert.deepEqual(normalized, defaults);
    assert.notEqual(normalized, DEFAULT_NOTE_SETTINGS);
  }
});

test("font normalization accepts trimmed custom font stacks and rejects empty or nonstring fonts", () => {
  assert.deepEqual(normalizeNoteSettings({ noteFont: '  "BIZ UDPGothic", sans-serif  ', noteFontSize: 16, noteColor: "#ffffff" }), {
    noteFont: '"BIZ UDPGothic", sans-serif', noteFontSize: 16,
  });
  for (const noteFont of ["", " \t\n", null, 10, true, {}, []]) {
    assert.equal(normalizeNoteSettings({ noteFont }).noteFont, defaults.noteFont);
  }
});

test("font size clamps finite numbers to 9 through 28 without coercing malformed values", () => {
  for (const [noteFontSize, expected] of [[-1, 9], [0, 9], [9, 9], [14.5, 14.5], [28, 28], [100, 28]]) {
    assert.equal(normalizeNoteSettings({ noteFontSize }).noteFontSize, expected);
  }
  for (const noteFontSize of [NaN, Infinity, -Infinity, "20", null, false, {}, []]) {
    assert.equal(normalizeNoteSettings({ noteFontSize }).noteFontSize, 12);
  }
});

test("shared fonts replace all legacy note overrides without changing text, colors or geometry", () => {
  const notes = [
    { id: "a", type: "note", text: "日本語\nReference", color: "#f4d98b", x: 20, y: 45, w: 280, h: 160, rotation: -5, z: 3, fontFamily: "Georgia", fontSize: 24 },
    { id: "b", type: "note", text: "Second note", color: "#aabbcc", x: -30, y: 0, w: 100, h: 80, rotation: 0, z: 2 },
  ].map(Object.freeze);
  const board = Object.freeze({ id: "board-a", name: "Reference", groupName: "Art", items: Object.freeze(notes),
    viewport: Object.freeze({ x: 100, y: 40, scale: 0.7 }), headerImageSrc: "file:header", headerImageAssetId: "header-asset",
    frames: Object.freeze([{ id: "frame", itemIds: ["a", "b"] }]), backgroundColor: "#171717" });
  const boards = Object.freeze([board]);
  const settings = Object.freeze({ noteFont: '"Yu Gothic UI", sans-serif', noteFontSize: 18 });
  const mirrored = applyNoteSettings(boards, settings);
  assert.notEqual(mirrored, boards);
  assert.notEqual(mirrored[0], board);
  assert.notEqual(mirrored[0].items, board.items);
  mirrored[0].items.forEach((item, index) => {
    assert.notEqual(item, notes[index]);
    assert.deepEqual(item, { ...notes[index], fontFamily: settings.noteFont, fontSize: settings.noteFontSize });
  });
  for (const key of ["id", "name", "groupName", "viewport", "headerImageSrc", "headerImageAssetId", "frames", "backgroundColor"]) {
    assert.equal(mirrored[0][key], board[key], `Changed board-owned ${key}`);
  }
  assert.equal(notes[0].fontFamily, "Georgia");
  assert.equal(notes[0].fontSize, 24);
  assert.equal(notes[1].fontFamily, undefined);
});

test("image items and image-only boards keep their exact references and media data", () => {
  const image = Object.freeze({ id: "image", type: "image", src: "file:image", thumbnailSrc: "file:thumb", assetId: "asset",
    x: 8, y: 9, w: 300, h: 200, fontFamily: "image-metadata", fontSize: 99, analysis: { strokes: [{ color: "#ff0000" }] } });
  const imageOnly = Object.freeze({ id: "images", items: Object.freeze([image]) });
  const mixed = { id: "mixed", items: [image, { id: "note", type: "note", text: "Keep" }] };
  const mirrored = applyNoteSettings([imageOnly, mixed], defaults);
  assert.equal(mirrored[0], imageOnly);
  assert.equal(mirrored[0].items, imageOnly.items);
  assert.equal(mirrored[1].items[0], image);
  assert.equal(mirrored[1].items[0].analysis, image.analysis);
  assert.equal(mirrored[1].items[0].fontSize, 99);
  assert.equal(mirrored[1].items[1].fontFamily, defaults.noteFont);
});

test("already synchronized notes and empty boards are reused, including the original array", () => {
  const note = Object.freeze({ id: "note", type: "note", fontFamily: defaults.noteFont, fontSize: 12 });
  const boards = Object.freeze([
    Object.freeze({ id: "ready", items: Object.freeze([note]) }),
    Object.freeze({ id: "empty", items: Object.freeze([]) }),
  ]);
  assert.equal(applyNoteSettings(boards, defaults), boards);
  const empty = [];
  assert.equal(applyNoteSettings(empty, defaults), empty);
  const mixed = [{ id: "mixed", items: [note, { type: "note", fontFamily: "Georgia", fontSize: 19 }] }];
  const mirrored = applyNoteSettings(mixed, defaults);
  assert.equal(mirrored[0].items[0], note);
  assert.notEqual(mirrored[0].items[1], mixed[0].items[1]);
  assert.equal(applyNoteSettings(mirrored, defaults), mirrored, "Applying the same settings again must be a no-op");
});

test("extra settings fields cannot overwrite note identity, colors, text or size", () => {
  const note = { id: "keep", type: "note", text: "Original", color: "#f4d98b", w: 140, h: 80 };
  const [board] = applyNoteSettings([{ id: "board", items: [note] }], {
    ...defaults, id: "wrong", type: "image", text: "wrong", color: "#000000", w: 1, h: 1,
  });
  assert.deepEqual(board.items[0], { ...note, fontFamily: defaults.noteFont, fontSize: 12 });
});
