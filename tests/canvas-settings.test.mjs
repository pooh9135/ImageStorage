import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/canvas-settings.ts", import.meta.url), "utf8");
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DEFAULT_CANVAS_SETTINGS, normalizeCanvasSettings, applyCanvasSettings } =
  await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const defaults = {
  gridVisible: false, snapEnabled: false, gridSize: 40,
  backgroundColor: "#171717", backgroundFit: "cover",
  backgroundImageSrc: undefined, backgroundImageThumbnailSrc: undefined, backgroundImageAssetId: undefined,
};

test("fresh, missing legacy and malformed canvas settings use complete defaults", () => {
  assert.deepEqual(DEFAULT_CANVAS_SETTINGS, defaults);
  for (const value of [undefined, null, false, 7, "{}", [], {}, { id: "legacy-board", items: [] }]) {
    const normalized = normalizeCanvasSettings(value);
    assert.deepEqual(normalized, defaults);
    assert.notEqual(normalized, DEFAULT_CANVAS_SETTINGS);
    for (const key of ["backgroundImageSrc", "backgroundImageThumbnailSrc", "backgroundImageAssetId"]) {
      assert.ok(Object.hasOwn(normalized, key), `Missing explicit clear for ${key}`);
    }
  }
});

test("legacy board fields normalize without carrying unrelated board data", () => {
  assert.deepEqual(normalizeCanvasSettings({
    id: "legacy", items: [{ id: "image" }], viewport: { scale: 2 }, headerImageSrc: "header.png",
    gridVisible: true, snapEnabled: false, gridSize: 55.5, backgroundColor: " #A0B1C2 ", backgroundFit: "contain",
    backgroundImageSrc: " file:///background.png ", backgroundImageThumbnailSrc: " thumb.png ", backgroundImageAssetId: " asset-1 ",
  }), {
    gridVisible: true, snapEnabled: false, gridSize: 55.5, backgroundColor: "#a0b1c2", backgroundFit: "contain",
    backgroundImageSrc: "file:///background.png", backgroundImageThumbnailSrc: "thumb.png", backgroundImageAssetId: "asset-1",
  });
});

test("grid and snap accept booleans without coercing saved strings or numbers", () => {
  for (const value of ["true", "false", 0, 1, null, [], {}]) {
    const normalized = normalizeCanvasSettings({ gridVisible: value, snapEnabled: value });
    assert.equal(normalized.gridVisible, false);
    assert.equal(normalized.snapEnabled, false);
  }
  assert.equal(normalizeCanvasSettings({ gridVisible: true }).gridVisible, true);
  assert.equal(normalizeCanvasSettings({ snapEnabled: true }).snapEnabled, true);
});

test("grid size clamps finite numbers and rejects nonnumeric or nonfinite values", () => {
  for (const [value, expected] of [[-20, 10], [0, 10], [10, 10], [30.5, 30.5], [120, 120], [500, 120]]) {
    assert.equal(normalizeCanvasSettings({ gridSize: value }).gridSize, expected);
  }
  for (const value of [NaN, Infinity, -Infinity, "50", null, false, {}, []]) {
    assert.equal(normalizeCanvasSettings({ gridSize: value }).gridSize, 40);
  }
});

test("background color and fitting keep only supported values", () => {
  for (const value of ["#fff", "#11223344", "red", "rgb(1,2,3)", "#zzzzzz", "", 123, null]) {
    assert.equal(normalizeCanvasSettings({ backgroundColor: value }).backgroundColor, "#171717");
  }
  assert.equal(normalizeCanvasSettings({ backgroundColor: "#ABCDEF" }).backgroundColor, "#abcdef");
  for (const backgroundFit of ["cover", "contain", "tile"]) {
    assert.equal(normalizeCanvasSettings({ backgroundFit }).backgroundFit, backgroundFit);
  }
  for (const backgroundFit of ["stretch", "COVER", "", null, 1]) {
    assert.equal(normalizeCanvasSettings({ backgroundFit }).backgroundFit, "cover");
  }
});

test("empty and nonstring image references become explicit clears", () => {
  for (const value of ["", " \t\n", null, false, 7, {}, []]) {
    const normalized = normalizeCanvasSettings({ backgroundImageSrc: value, backgroundImageThumbnailSrc: value, backgroundImageAssetId: value });
    assert.equal(normalized.backgroundImageSrc, undefined);
    assert.equal(normalized.backgroundImageThumbnailSrc, undefined);
    assert.equal(normalized.backgroundImageAssetId, undefined);
  }
});

test("mirroring shared settings is immutable and preserves each board's content", () => {
  const boards = ["a", "b"].map((id, index) => Object.freeze({
    id, name: `Board ${id}`, items: Object.freeze([{ id: `image-${id}`, src: `${id}.png` }]),
    viewport: Object.freeze({ x: index * 20, y: 30, scale: 1.5 }), groupName: `group-${id}`,
    headerImageSrc: `header-${id}.png`, headerImageAssetId: `header-asset-${id}`,
    gridVisible: false, backgroundColor: "#ffffff",
  }));
  Object.freeze(boards);
  const canvas = Object.freeze({ ...defaults, gridVisible: true, snapEnabled: true, gridSize: 80, backgroundColor: "#123456", backgroundImageSrc: "shared.png" });
  const mirrored = applyCanvasSettings(boards, canvas);
  assert.notEqual(mirrored, boards);
  mirrored.forEach((board, index) => {
    assert.notEqual(board, boards[index]);
    assert.deepEqual(normalizeCanvasSettings(board), canvas);
    for (const key of ["id", "name", "items", "viewport", "groupName", "headerImageSrc", "headerImageAssetId"]) {
      assert.equal(board[key], boards[index][key], `Changed board-owned ${key}`);
    }
    assert.equal(boards[index].backgroundColor, "#ffffff");
    assert.equal(boards[index].gridVisible, false);
  });
  assert.deepEqual(applyCanvasSettings([], canvas), []);
});

test("clearing a shared background removes stale board image fields without clearing header artwork", () => {
  const board = { id: "a", headerImageSrc: "header.png", backgroundImageSrc: "old.png", backgroundImageThumbnailSrc: "old-thumb.png", backgroundImageAssetId: "old-asset" };
  const [cleared] = applyCanvasSettings([board], DEFAULT_CANVAS_SETTINGS);
  for (const key of ["backgroundImageSrc", "backgroundImageThumbnailSrc", "backgroundImageAssetId"]) {
    assert.ok(Object.hasOwn(cleared, key));
    assert.equal(cleared[key], undefined);
    assert.ok(board[key]);
  }
  assert.equal(cleared.headerImageSrc, "header.png");
});

test("unexpected canvas properties cannot overwrite board identity or contents", () => {
  const board = { id: "original", items: [{ id: "keep" }], viewport: { x: 12, y: 8, scale: 2 }, groupName: "kept" };
  const [mirrored] = applyCanvasSettings([board], { ...defaults, id: "wrong", items: [], viewport: {}, groupName: "wrong" });
  assert.equal(mirrored.id, board.id);
  assert.equal(mirrored.items, board.items);
  assert.equal(mirrored.viewport, board.viewport);
  assert.equal(mirrored.groupName, board.groupName);
});
