import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createBatchJobs } from "../browser-extension/src/batch-jobs.js";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test("a native save starts the real app invisibly and persists new lists and image bytes before acknowledgement", { skip: process.platform !== "win32", timeout: 60000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(root, "work", "extension-background-ui-"));
  const bridgeDirectory = path.join(directory, "bridge"), profile = path.join(directory, "profile");
  await fs.mkdir(bridgeDirectory); await fs.mkdir(path.join(profile, "recovery"), { recursive: true });
  const autosave = path.join(profile, "recovery/autosave.json");
  const original = { format: "museboard", version: 2, savedAt: new Date().toISOString(), activeId: "a", boards: ["a", "b"].map(id => ({ id, name: `Existing ${id}`, viewport: { x: 0, y: 0, scale: 1 }, items: [], frames: [] })) };
  await fs.writeFile(autosave, JSON.stringify(original));
  await fs.writeFile(path.join(bridgeDirectory, "connection.json"), JSON.stringify({ pipeName: `imagestorage-connector-${randomBytes(16).toString("hex")}`, token: randomBytes(32).toString("hex") }));
  await fs.writeFile(path.join(bridgeDirectory, "application.json"), JSON.stringify({ appPath: require("electron"), appArgs: [path.join(root, "tests/helpers/extension-background-bootstrap.cjs")] }));
  const identity = JSON.parse(await fs.readFile(path.join(root, "browser-extension/identity.json"), "utf8"));
  const env = { ...process.env, IMAGESTORAGE_BACKGROUND_TEST_DIR: directory, IMAGESTORAGE_TEST_USER_DATA: profile, IMAGESTORAGE_EXTENSION_CONFIG_DIR: bridgeDirectory };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MUSEBOARD_DEV_SERVER_URL;
  const hosts = [];
  function nativeClient() {
    const child = spawn(path.join(root, "browser-extension/dist/native-host/ImageStorage.NativeHost.exe"), [`chrome-extension://${identity.chromiumId}/`], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    hosts.push(child);
    let buffer = Buffer.alloc(0); const pending = new Map();
    child.stdout.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32LE();
        if (buffer.length < 4 + length) break;
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")); buffer = buffer.subarray(4 + length);
        if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      }
    });
    return (data) => new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Native timeout")); }, 35000);
      pending.set(id, response => { clearTimeout(timer); resolve(response); });
      const payload = Buffer.from(JSON.stringify({ ...data, id })); const header = Buffer.alloc(4); header.writeUInt32LE(payload.length);
      child.stdin.write(Buffer.concat([header, payload]));
    });
  }
  t.after(async () => {
    await fs.writeFile(path.join(directory, "stop"), "stop");
    for (const host of hosts) host.stdin.end();
    await sleep(300);
    for (const host of hosts) if (host.exitCode === null) host.kill();
  });
  async function ready(send, launch) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await send({ action: "list", launch: launch && attempt === 0 });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      if (result.state.ready) return result.state;
      await sleep(100);
    }
    throw new Error("Renderer did not hydrate");
  }
  const send = nativeClient();
  assert.equal((await send({ action: "list", launch: false })).error.code, "not_running");
  assert.deepEqual(JSON.parse(await fs.readFile(autosave, "utf8")), original);
  const state = await ready(send, true);
  assert.equal(state.capabilities.createBoard, true);
  const bytes = await sharp({ create: { width: 17, height: 13, channels: 4, background: "#b42438" } }).png().toBuffer();
  const imageUrl = `data:image/png;base64,${bytes.toString("base64")}`;
  const originalImageUrl = "https://i.pinimg.com/236x/01/23/45/0123456789abcdef0123456789abcdef.jpg";
  const created = await send({ action: "import", launch: false, session: state.session, importId: randomUUID(), newBoardName: "バックグラウンド保存", imageUrl, originalImageUrl, sourceUrl: "https://www.pinterest.com/pin/987/" });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const saved = JSON.parse(await fs.readFile(autosave, "utf8"));
  const board = saved.boards.find(entry => entry.id === created.result.boardId);
  assert.equal(saved.boards.length, 3); assert.equal(saved.activeId, "a");
  assert.equal(board.name, "バックグラウンド保存"); assert.equal(board.items.length, 1);
  assert.equal(board.items[0].originalImageUrl, originalImageUrl);
  assert(bytes.equals(await fs.readFile(fileURLToPath(board.items[0].src))), "Original image bytes changed");
  const existing = await send({ action: "import", launch: false, session: state.session, importId: randomUUID(), boardId: "b", imageUrl, originalImageUrl });
  assert.equal(existing.ok, true, JSON.stringify(existing.error));
  assert.equal(JSON.parse(await fs.readFile(autosave, "utf8")).boards.find(entry => entry.id === "b").items.length, 1);
  const batchValues = {}, batchBytes = [bytes];
  for (const color of ["#345875", "#64794d"]) batchBytes.push(await sharp({ create: { width: 23, height: 19, channels: 4, background: color } }).png().toBuffer());
  const batchUrls = [originalImageUrl, ...["a", "b"].map(letter => `https://i.pinimg.com/236x/ab/cd/ef/${letter.repeat(32)}.png`)];
  let batchState = state;
  const batch = createBatchJobs({
    storage: { async get(key) { return structuredClone(key === null ? batchValues : { [key]: batchValues[key] }); }, async set(data) { Object.assign(batchValues, structuredClone(data)); }, async remove(keys) { for (const key of keys) delete batchValues[key]; } },
    snapshot: () => batchState, async refreshState() { batchState = (await send({ action: "list", launch: false })).state; },
    async sendImage(image, boardId, session) {
      const index = batchUrls.indexOf(image.imageUrl);
      const result = await send({ action: "import", launch: false, session, importId: randomUUID(), boardId, imageUrl: `data:image/png;base64,${batchBytes[index].toString("base64")}`, originalImageUrl: image.imageUrl, sourceUrl: image.sourceUrl });
      assert.equal(result.ok, true, JSON.stringify(result.error));
      // Every acknowledgement must correspond to a completed disk write.
      const current = JSON.parse(await fs.readFile(autosave, "utf8"));
      const item = current.boards.find(entry => entry.id === boardId).items.find(entry => entry.originalImageUrl === image.imageUrl);
      assert(item, "Acknowledged batch image missing from disk");
      assert(batchBytes[index].equals(await fs.readFile(fileURLToPath(item.src))), "Batch changed original bytes");
      return result.result;
    },
  });
  const batchRecord = await batch.create(22, 0, "https://www.pinterest.com/owner/board/");
  const collection = await batch.merge(batchRecord.id, { images: batchUrls.map((imageUrl, index) => ({ imageUrl, sourceUrl: `https://www.pinterest.com/pin/${1000 + index}/`, width: 23, height: 19 })) });
  await batch.start(batchRecord.id, collection.images.map(image => image.id), board.id, state.session); await batch.idle(batchRecord.id);
  assert.deepEqual((await batch.status(batchRecord.id)).images.map(image => image.status), ["existing", "saved", "saved"]);
  assert.equal(JSON.parse(await fs.readFile(autosave, "utf8")).activeId, "a");
  await fs.writeFile(path.join(directory, "stop"), "stop");
  const reportPath = path.join(directory, "runtime-result.json");
  for (let attempt = 0; attempt < 100 && !await fs.stat(reportPath).then(() => true, () => false); attempt++) await sleep(50);
  const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  assert.equal(report.error, null); assert.equal(report.backgroundLaunch, true);
  assert.equal(report.windows, 1); assert.equal(report.visibleWindows, 0); assert.deepEqual(report.showCalls, []);
  await sleep(300);
  await fs.unlink(path.join(directory, "stop"));
  const afterRestart = nativeClient(), restored = await ready(afterRestart, true);
  assert.equal(restored.boards.find(entry => entry.id === created.result.boardId).name, board.name);
  assert.equal(restored.boards.length, 3);
  const lookup = { imageUrl: originalImageUrl.replace("236x", "originals").replace(".jpg", ".png"), sourceUrl: "https://jp.pinterest.com/pin/987/" };
  const membership = await afterRestart({ action: "list", launch: false, lookup });
  assert.deepEqual(membership.state.boards.map(entry => entry.containsImage), [false, true, true]);
  const duplicate = await afterRestart({ action: "import", launch: false, session: restored.session, importId: randomUUID(), boardId: board.id, imageUrl, originalImageUrl });
  assert.equal(duplicate.result.alreadySaved, true);
  assert.equal(JSON.parse(await fs.readFile(autosave, "utf8")).boards.find(entry => entry.id === board.id).items.length, 3);
  assert.equal(restored.capabilities.removeImage, true);
  const removal = { action: "import", operation: "remove", launch: false, session: restored.session, importId: randomUUID(), boardId: board.id, ...lookup };
  const removed = await afterRestart(removal);
  assert.equal(removed.ok, true, JSON.stringify(removed.error)); assert.equal(removed.result.removed, true);
  const afterRemoval = JSON.parse(await fs.readFile(autosave, "utf8"));
  assert.equal(afterRemoval.boards.find(entry => entry.id === board.id).items.length, 2);
  assert.equal(afterRemoval.boards.find(entry => entry.id === "b").items.length, 1);
  assert(bytes.equals(await fs.readFile(fileURLToPath(board.items[0].src))), "Removing membership must not delete the source file");
  await afterRestart(removal);
  await fs.unlink(reportPath);
  await fs.writeFile(path.join(directory, "stop"), "stop");
  for (let attempt = 0; attempt < 100 && !await fs.stat(reportPath).then(() => true, () => false); attempt++) await sleep(50);
  assert.equal(JSON.parse(await fs.readFile(reportPath, "utf8")).visibleWindows, 0);
  await sleep(300); await fs.unlink(path.join(directory, "stop"));
  const afterRemovalRestart = nativeClient(); await ready(afterRemovalRestart, true);
  assert.deepEqual((await afterRemovalRestart({ action: "list", launch: false, lookup })).state.boards.map(entry => entry.containsImage), [false, true, false]);
  console.log(`Background save evidence: ${directory}`);
});
