import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { batchImageKey, createBatchJobs } from "../browser-extension/src/batch-jobs.js";

const page = "https://www.pinterest.com/owner/board/";
const candidates = Array.from({ length: 3 }, (_, i) => ({ imageUrl: `https://i.pinimg.com/236x/aa/bb/cc/${String(i).repeat(32)}.jpg`, sourceUrl: `https://www.pinterest.com/pin/${i + 1}/`, width: 300, height: 400, alt: `資料${i + 1}` }));
function fixture(route = async () => ({})) {
  const values = {}, sends = [], launches = [];
  let state = { ready: true, session: randomUUID(), activeId: "a", boards: [{ id: "a", name: "現在" }, { id: "b", name: "保存先" }] };
  const storage = { async get(key) { return structuredClone(key === null ? values : { [key]: values[key] }); }, async set(data) { Object.assign(values, structuredClone(data)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; } };
  const options = { storage, snapshot: () => state, async refreshState(launch) { launches.push(launch); }, async sendImage(image, boardId, session) { sends.push({ image, boardId, session }); return route(image, boardId, session); } };
  const jobs = createBatchJobs(options);
  return { jobs, storage, values, sends, launches, options, state: () => state, setState(next) { state = { ...state, ...next }; } };
}
async function prepare(f, images = candidates) {
  const record = await f.jobs.create(22, 4, page);
  await f.jobs.merge(record.id, { images });
  const batch = await f.jobs.status(record.id);
  return { ...record, images: batch.images };
}
const selected = record => record.images.map(image => image.id);
const pause = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("batch scanning deduplicates Pinterest variants, preserves exact URLs and never launches or saves", async () => {
  const f = fixture(), record = await prepare(f, [...candidates, { ...candidates[0], imageUrl: candidates[0].imageUrl.replace("236x", "originals").replace(".jpg", ".png") }, { imageUrl: "file:///C:/private.png", sourceUrl: page }, { imageUrl: "https://user:secret@example.test/image.jpg", sourceUrl: page }]);
  const status = await f.jobs.status(record.id);
  assert.equal(status.images.length, 3); assert.equal(status.images[0].imageUrl, candidates[0].imageUrl);
  assert.equal(status.token, undefined); assert.equal(status.documentId, undefined);
  assert.equal(batchImageKey(candidates[0].imageUrl), batchImageKey(candidates[0].imageUrl.replace("236x", "originals")));
  assert.equal(f.sends.length, 0); assert.deepEqual(f.launches, []);
});

test("batch selection is bound to its token, tab, top frame and document", async () => {
  const f = fixture(), record = await prepare(f);
  const message = { id: record.id, token: record.token }, sender = { tab: { id: 22 }, frameId: 0, documentId: "first", url: page };
  for (const [payload, source] of [[{ ...message, token: randomUUID() }, sender], [message, { ...sender, tab: { id: 23 } }], [message, { ...sender, frameId: 4 }], [message, { ...sender, url: "file:///private" }]]) await assert.rejects(f.jobs.authorize(payload, source), { code: "expired" });
  await f.jobs.authorize(message, sender);
  await assert.rejects(f.jobs.authorize(message, { ...sender, documentId: "navigated" }), { code: "expired" });
  assert.equal(f.sends.length, 0);
});

test("only checked images are saved sequentially to the chosen inactive list", async () => {
  let active = 0, maximum = 0;
  const f = fixture(async () => { maximum = Math.max(maximum, ++active); await new Promise(resolve => setImmediate(resolve)); active--; return {}; });
  const record = await prepare(f);
  await f.jobs.start(record.id, [record.images[0].id, record.images[2].id], "b", f.state().session); await f.jobs.idle(record.id);
  assert.equal(maximum, 1); assert.equal(f.sends.length, 2);
  assert.deepEqual(f.sends.map(entry => entry.image.imageUrl), [candidates[0].imageUrl, candidates[2].imageUrl]);
  assert(f.sends.every(entry => entry.boardId === "b" && entry.image.frameId === 4 && entry.image.tabId === 22));
  assert.equal(f.state().activeId, "a");
  assert.deepEqual((await f.jobs.status(record.id)).images.map(image => image.status), ["saved", "idle", "saved"]);
});

test("duplicate clicks and invalid selections cannot start additional imports", async () => {
  const waiting = pause(), started = pause();
  const f = fixture(async () => { started.resolve(); await waiting.promise; return {}; }), record = await prepare(f);
  await assert.rejects(f.jobs.start(record.id, [randomUUID()], "b", f.state().session), { code: "invalid_selection" });
  await assert.rejects(f.jobs.start(record.id, [record.images[0].id, record.images[0].id], "b", f.state().session), { code: "invalid_selection" });
  assert.deepEqual(f.launches, []);
  await f.jobs.start(record.id, [record.images[0].id], "b", f.state().session); await started.promise;
  await assert.rejects(f.jobs.start(record.id, selected(record), "b", f.state().session), { code: "busy" });
  assert.equal((await f.jobs.status(record.id)).running, true);
  waiting.resolve(); await f.jobs.idle(record.id); assert.equal(f.sends.length, 1);
});

test("stop lets the in-flight image finish, keeps queued images unsent, and permits resuming", async () => {
  const waiting = pause(), started = pause();
  const f = fixture(async () => { started.resolve(); await waiting.promise; return {}; }), record = await prepare(f);
  await f.jobs.start(record.id, selected(record), "b", f.state().session); await started.promise;
  await f.jobs.stop(record.id); waiting.resolve(); await f.jobs.idle(record.id);
  assert.deepEqual((await f.jobs.status(record.id)).images.map(image => image.status), ["saved", "cancelled", "cancelled"]);
  await f.jobs.start(record.id, record.images.slice(1).map(image => image.id), "b", f.state().session); await f.jobs.idle(record.id);
  assert.equal(f.sends.length, 3);
});

test("closing during app startup cancels a batch before its first import", async () => {
  const waiting = pause(), started = pause(), f = fixture(), record = await prepare(f);
  f.options.refreshState = async () => { started.resolve(); await waiting.promise; };
  const jobs = createBatchJobs(f.options);
  const start = jobs.start(record.id, selected(record), "b", f.state().session); await started.promise;
  await jobs.stop(record.id); waiting.resolve();
  await assert.rejects(start, { code: "cancelled" }); assert.equal(f.sends.length, 0);
});

test("a failed image does not block later images, and existing images are reported separately", async () => {
  const f = fixture(async image => { if (image.imageUrl === candidates[0].imageUrl) throw Object.assign(new Error("Download failed"), { code: "download_failed" }); return image.imageUrl === candidates[1].imageUrl ? { alreadySaved: true } : {}; }), record = await prepare(f);
  await f.jobs.start(record.id, selected(record), "b", f.state().session); await f.jobs.idle(record.id);
  assert.deepEqual((await f.jobs.status(record.id)).images.map(image => image.status), ["failed", "existing", "saved"]);
  await assert.rejects(f.jobs.start(record.id, [record.images[2].id], "b", f.state().session), { code: "invalid_selection" });
});

test("uncertain results stop the batch and remain blocked across worker restarts", async () => {
  const f = fixture(async () => { throw Object.assign(new Error("Disconnected"), { code: "unknown_result" }); }), record = await prepare(f);
  await f.jobs.start(record.id, selected(record), "b", f.state().session); await f.jobs.idle(record.id);
  const restarted = createBatchJobs(f.options);
  assert.deepEqual((await restarted.status(record.id)).images.map(image => image.status), ["unknown", "cancelled", "cancelled"]);
  await assert.rejects(restarted.start(record.id, [record.images[0].id], "b", f.state().session), { code: "invalid_selection" });
  assert.equal(f.sends.length, 1);
});

test("orphaned in-flight records recover without automatically replaying a save", async () => {
  const f = fixture(), record = await prepare(f);
  Object.assign(f.values[`batch:${record.id}`], { running: true, images: record.images.map((image, index) => ({ ...image, status: index === 0 ? "sending" : "queued" })) });
  const status = await createBatchJobs(f.options).status(record.id);
  assert.equal(status.running, false); assert.deepEqual(status.images.map(image => image.status), ["unknown", "cancelled", "cancelled"]);
  assert.equal(f.sends.length, 0);
});

test("project changes reject the destination and never silently switch to another list", async () => {
  const f = fixture(), record = await prepare(f), session = f.state().session;
  f.setState({ session: randomUUID() });
  await assert.rejects(f.jobs.start(record.id, selected(record), "b", session), { code: "stale_list" });
  assert.equal(f.sends.length, 0);
});

test("storage failures before sending cannot import an image without a durable pending record", async () => {
  const f = fixture(), record = await prepare(f);
  f.storage.set = async () => { throw new Error("Storage full"); };
  await assert.rejects(f.jobs.start(record.id, selected(record), "b", f.state().session), /Storage full/);
  assert.equal(f.sends.length, 0);
});

test("rescanning appends newly loaded images, retains saved results, and caps the collection", async () => {
  const f = fixture(), record = await prepare(f);
  await f.jobs.start(record.id, [record.images[0].id], "b", f.state().session); await f.jobs.idle(record.id);
  await f.jobs.merge(record.id, { images: [...candidates, ...Array.from({ length: 201 }, (_, index) => ({ imageUrl: `https://example.test/${index}.png`, sourceUrl: page }))] });
  const status = await f.jobs.status(record.id);
  assert.equal(status.images.length, 200); assert.equal(status.limited, true); assert.equal(status.images[0].status, "saved");
});

test("tab closure stops that tab's job while leaving other tabs untouched", async () => {
  const waiting = pause(), started = pause(), f = fixture(async () => { started.resolve(); await waiting.promise; return {}; }), record = await prepare(f);
  await f.jobs.start(record.id, selected(record), "b", f.state().session); await started.promise;
  await f.jobs.stopForTab(99); assert.equal((await f.jobs.status(record.id)).stopRequested, false);
  await f.jobs.stopForTab(22); waiting.resolve(); await f.jobs.idle(record.id);
  assert.equal(f.sends.length, 1);
});
