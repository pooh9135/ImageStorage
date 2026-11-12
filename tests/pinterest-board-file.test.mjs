import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import ts from "typescript";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parsePinterestBoardFile, MAX_BYTES } = require("../desktop/pinterest-board-file.cjs");
const javascript = ts.transpileModule(await fs.readFile(new URL("../app/pinterest-board-import.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { preparePinterestBoardImport, pinterestBoardItems } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
const pin = index => ({ pinUrl: `https://www.pinterest.com/pin/${index + 1}/`, imageUrl: `https://i.pinimg.com/236x/aa/bb/cc/${String(index).repeat(32)}.png`, title: `資料 ${index + 1}`, width: 100, height: 200 });
const file = pins => ({ format: "imagestorage-pinterest-board", version: 1, board: { name: "イラスト資料", url: "https://www.pinterest.com/user/reference/" }, pins, capture: { mode: "manual-scroll", complete: false } });
const image = index => ({ name: `image-${index}.png`, src: `file:///test/original-${index}.png`, thumbnailSrc: `file:///test/thumb-${index}.webp`, assetId: `asset-${index}`, width: 100 + index, height: 200 + index });

test("board files preserve Unicode names and original image and Pin URLs", () => {
  const data = parsePinterestBoardFile("\uFEFF" + JSON.stringify(file([pin(0), pin(1)])));
  assert.equal(data.board.name, "イラスト資料"); assert.equal(data.pins.length, 2); assert.deepEqual(data.pins[1], pin(1));
});
test("duplicate thumbnail and original variants are removed before downloading", () => {
  const original = pin(0), variant = { ...original, pinUrl: pin(1).pinUrl, imageUrl: original.imageUrl.replace("236x", "originals").replace(".png", ".jpg") };
  const data = parsePinterestBoardFile(JSON.stringify(file([original, variant])));
  assert.equal(data.pins.length, 1); assert.equal(data.duplicates, 1);
});
test("version 2 preserves separate Pins sharing one image and downloads the shared URL once", async () => {
  const first = pin(0), second = { ...first, pinUrl: pin(1).pinUrl };
  const data = parsePinterestBoardFile(JSON.stringify({ ...file([first, second, first]), version: 2 }));
  assert.equal(data.pins.length, 2); assert.equal(data.duplicates, 1);
  let calls = 0;
  const result = await preparePinterestBoardImport(data.pins, async () => { calls++; return { canceled: false, images: [image(0)], errors: [] }; }, () => false, () => {});
  assert.equal(calls, 1); assert.equal(result.images.length, 2); assert.notEqual(result.images[0].pin.pinUrl, result.images[1].pin.pinUrl);
});
test("invalid, empty, oversized and unsupported board files are rejected", () => {
  for (const invalid of ["not JSON", JSON.stringify({ ...file([pin(0)]), version: 3 }), JSON.stringify({ ...file([pin(0)]), format: "museboard" }), JSON.stringify(file([])), " ".repeat(MAX_BYTES + 1), JSON.stringify(file(Array.from({ length: 5001 }, () => pin(0))))]) assert.throws(() => parsePinterestBoardFile(invalid));
});
test("board files cannot fetch local files, arbitrary hosts, credentials or executable links", () => {
  for (const url of ["file:///C:/private.png", "http://i.pinimg.com/a.png", "https://127.0.0.1/a.png", "https://i.pinimg.com.evil.test/a.png", "https://user:secret@i.pinimg.com/a.png", "data:image/png;base64,AAAA", "javascript:alert(1)"]) assert.throws(() => parsePinterestBoardFile(JSON.stringify(file([{ ...pin(0), imageUrl: url }]))));
  for (const url of ["https://evil.test/pin/1/", "https://www.pinterest.com.evil.test/pin/1/", "https://www.pinterest.com/user/board/", "javascript:alert(1)"]) assert.throws(() => parsePinterestBoardFile(JSON.stringify(file([{ ...pin(0), pinUrl: url }]))));
});
test("sequential preparation preserves resources and reports per-image progress", async () => {
  const calls = [], progress = [];
  const result = await preparePinterestBoardImport([pin(0), pin(1)], async url => { calls.push(url); return { canceled: false, images: [image(calls.length)], errors: [] }; }, () => false, (done, total) => progress.push([done, total]));
  assert.equal(result.cancelled, false); assert.equal(result.images.length, 2); assert.deepEqual(calls, [pin(0).imageUrl, pin(1).imageUrl]); assert.deepEqual(progress, [[1, 2], [2, 2]]);
  assert.equal(result.images[0].image.originalImageUrl, pin(0).imageUrl); assert.equal(result.images[0].image.src, image(1).src);
});
test("cancelling during a download stops without returning a committable result", async () => {
  let cancelled = false, calls = 0;
  const result = await preparePinterestBoardImport([pin(0), pin(1)], async () => { calls++; cancelled = true; return { canceled: false, images: [image(0)], errors: [] }; }, () => cancelled, () => assert.fail());
  assert.equal(result.cancelled, true); assert.equal(result.images.length, 0); assert.equal(calls, 1);
});
test("partial failures retain successes and support retrying failed images alone", async () => {
  const result = await preparePinterestBoardImport([pin(0), pin(1)], async url => url === pin(0).imageUrl ? { canceled: false, images: [], errors: [{ message: "Missing image" }] } : { canceled: false, images: [image(1)], errors: [] }, () => false, () => {});
  assert.equal(result.images.length, 1); assert.equal(result.errors.length, 1); assert.equal(result.errors[0].pin.pinUrl, pin(0).pinUrl);
  const retries = [];
  const retry = await preparePinterestBoardImport(result.errors.map(entry => entry.pin), async url => { retries.push(url); return { canceled: false, images: [image(0)], errors: [] }; }, () => false, () => {});
  assert.deepEqual(retries, [pin(0).imageUrl]); assert.equal(retry.images.length, 1);
});
test("new-list layout preserves aspect ratios and source bytes without overlapping images", () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({ pin: pin(index), image: { ...image(index), width: index % 2 ? 1600 : 500, height: index % 2 ? 700 : 1900 } }));
  let id = 0; const items = pinterestBoardItems(entries, () => `item-${++id}`);
  for (const [index, item] of items.entries()) { assert.equal(item.src, entries[index].image.src); assert.equal(item.originalImageUrl, entries[index].pin.imageUrl); assert.equal(item.sourceUrl, entries[index].pin.pinUrl); assert(Math.abs(item.w / item.h - entries[index].image.width / entries[index].image.height) < 1e-10); }
  for (let left = 0; left < items.length; left++) for (let right = left + 1; right < items.length; right++) { const a = items[left], b = items[right]; assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y); }
});
