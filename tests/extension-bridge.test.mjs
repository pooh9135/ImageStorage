import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import { bridgeError, createExtensionBridge, createLineDecoder, ensureBridgeConfiguration, safeSource, imageIdentityKeys } from "../desktop/extension-bridge.cjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const token = "a".repeat(64);
const thumbnail = "https://i.pinimg.com/236x/01/23/45/0123456789abcdef0123456789abcdef.jpg";
const originalImage = "https://i.pinimg.com/originals/01/23/45/0123456789abcdef0123456789abcdef.png";
function pipeName() { return `imagestorage-connector-${randomBytes(16).toString("hex")}`; }
function pipePath(name) { return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(root, "work", `${name}.sock`); }
async function fixture(t, onImport = async () => ({ count: 1 }), boards = [{ id: "a", name: "default" }, { id: "b", name: "保存先 日本語" }], onRemove) {
  const name = pipeName();
  const bridge = createExtensionBridge({ pipePath: pipePath(name), token, onImport, onRemove });
  await bridge.start();
  t.after(() => bridge.close());
  bridge.updateState({ ready: true, generation: 1, activeId: "a", boards });
  return { bridge, name, state: bridge.snapshot() };
}
async function socketClient(t, name) {
  const socket = net.connect(pipePath(name));
  await once(socket, "connect");
  const pending = new Map(), events = [];
  socket.on("data", createLineDecoder((message) => { if (message.event) events.push(message); else { pending.get(message.id)?.(message); pending.delete(message.id); } }, (error) => { throw error; }));
  t.after(() => socket.destroy());
  return {
    events,
    request(message, authorization = token) {
      const id = randomUUID();
      const result = new Promise((resolve) => pending.set(id, resolve));
      socket.write(`${JSON.stringify({ ...message, id, token: authorization })}\n`);
      return result;
    },
  };
}

test("pipe decoding handles split UTF-8, multiple messages, invalid JSON, and message size limits", () => {
  const messages = [], errors = [];
  const decode = createLineDecoder((message) => messages.push(message), (error) => errors.push(error.code), 100);
  const bytes = Buffer.from('{"name":"保存先"}\n{"ready":true}\n');
  for (const byte of bytes) decode(Buffer.from([byte]));
  assert.deepEqual(messages, [{ name: "保存先" }, { ready: true }]);
  decode(Buffer.from("not-json\n"));
  assert.deepEqual(errors, ["invalid_message"]);
  const large = [];
  createLineDecoder(() => assert.fail(), (error) => large.push(error.code), 4)(Buffer.from("12345"));
  assert.deepEqual(large, ["too_large"]);
});

test("connector URL validation rejects local files, credentials, scripts, and browser-owned blob URLs", () => {
  for (const url of ["file:///C:/private.png", "C:\\private.png", "javascript:alert(1)", "blob:https://example.test/id", "https://user:password@example.test/a.png"]) assert.throws(() => safeSource(url, true));
  assert.equal(safeSource("https://example.test/a.png"), "https://example.test/a.png");
  assert.equal(safeSource("data:image/png;base64,aGVsbG8=", true), "data:image/png;base64,aGVsbG8=");
  assert.throws(() => safeSource("data:text/html;base64,aGVsbG8=", true));
});

test("only the main app frame can publish destinations or complete an import", async () => {
  const text = await fs.readFile(path.join(root, "desktop/main.cjs"), "utf8");
  const source = ts.createSourceFile("main.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const guard = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "isMainRenderer");
  const handlers = new Map(), replies = [], updates = [], frame = {}, contents = { mainFrame: frame };
  const active = new Map([["request", { boardId: "allowed", isCurrent: () => true, resolve: (value) => replies.push(value), reject: () => assert.fail(), timer: 0 }]]);
  const context = vm.createContext({ mainWindow: { isDestroyed: () => false, webContents: contents }, extensionBridge: { updateState: (value) => updates.push(value) }, extensionImports: active, restoringBackup: false, validProjectSnapshot: () => true, queueRecoverySnapshot: async () => ({ saved: true }), clearTimeout() {}, ipcMain: { on: (channel, listener) => handlers.set(channel, listener) } });
  vm.runInContext(guard.getText(source), context);
  for (const node of source.statements) {
    if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "ipcMain.on" && ["extension:state", "extension:complete"].includes(node.expression.arguments[0]?.text)) vm.runInContext(node.getText(source), context);
  }
  for (const event of [{ sender: {}, senderFrame: frame }, { sender: contents, senderFrame: {} }]) {
    handlers.get("extension:state")(event, { boards: [{ id: "private" }] });
    handlers.get("extension:complete")(event, { requestId: "request", count: 1 });
  }
  assert.equal(updates.length, 0); assert.equal(replies.length, 0); assert.equal(active.size, 1);
  const sender = { sender: contents, senderFrame: frame };
  handlers.get("extension:state")(sender, { boards: [{ id: "allowed" }] });
  await handlers.get("extension:complete")(sender, { requestId: "request", count: 1, snapshot: { boards: [{ id: "allowed" }] } });
  assert.equal(updates.length, 1); assert.equal(replies[0].count, 1); assert.equal(active.size, 0);
});

async function completionFixture(save) {
  const text = await fs.readFile(path.join(root, "desktop/main.cjs"), "utf8");
  const source = ts.createSourceFile("main.cjs", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const handlers = new Map(), replies = [], failures = [], writes = [];
  const pending = { boardId: "target", isCurrent: () => true, resolve: value => replies.push(value), reject: error => failures.push(error), timer: 0 };
  const active = new Map([["request", pending]]);
  const context = vm.createContext({
    isMainRenderer: () => true, extensionImports: active, restoringBackup: false,
    validProjectSnapshot: snapshot => Array.isArray(snapshot?.boards), bridgeError,
    queueRecoverySnapshot: snapshot => { writes.push(snapshot); return save(snapshot); },
    clearTimeout() {}, ipcMain: { on: (channel, listener) => handlers.set(channel, listener) },
  });
  const handler = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "ipcMain.on" && node.expression.arguments[0]?.text === "extension:complete");
  vm.runInContext(handler.getText(source), context);
  return { complete: handlers.get("extension:complete"), replies, failures, writes, active, pending };
}

test("extension success waits for durable storage and duplicate completion cannot write or reply twice", async () => {
  let finish;
  const fixture = await completionFixture(() => new Promise(resolve => { finish = resolve; }));
  const payload = { requestId: "request", count: 1, snapshot: { boards: [{ id: "target" }] } };
  const saving = fixture.complete({}, payload);
  assert.equal(fixture.writes.length, 1); assert.equal(fixture.replies.length, 0); assert.equal(fixture.active.size, 1);
  await fixture.complete({}, payload);
  assert.equal(fixture.writes.length, 1); assert.equal(fixture.replies.length, 0);
  finish({ saved: true }); await saving;
  assert.equal(fixture.replies.length, 1); assert.equal(fixture.failures.length, 0); assert.equal(fixture.active.size, 0);
});

test("a disk failure never reports a successful save or permits automatic duplicate creation", async () => {
  for (const save of [async () => ({ saved: false, error: "disk full" }), async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); }]) {
    const fixture = await completionFixture(save);
    await fixture.complete({}, { requestId: "request", count: 1, snapshot: { boards: [{ id: "target" }] } });
    assert.equal(fixture.replies.length, 0); assert.equal(fixture.failures.length, 1);
    assert.equal(fixture.failures[0].code, "unknown_result"); assert.equal(fixture.active.size, 0);
  }
});

test("removal acknowledges only a durable snapshot without the requested items", async () => {
  let finish;
  const f = await completionFixture(() => new Promise(resolve => { finish = resolve; }));
  Object.assign(f.pending, { removing: true, itemIds: ["one", "two"] });
  const work = f.complete({}, { requestId: "request", count: 2, snapshot: { boards: [{ id: "target", items: [{ id: "keep" }] }] } });
  assert.equal(f.replies.length, 0); finish({ saved: true }); await work;
  assert.equal(f.replies[0].count, 2);
  const noChange = await completionFixture(async () => ({ saved: true }));
  Object.assign(noChange.pending, { removing: true, itemIds: [] });
  await noChange.complete({}, { requestId: "request", count: 0, snapshot: { boards: [{ id: "target", items: [] }] } });
  assert.equal(noChange.writes.length, 1); assert.equal(noChange.replies[0].count, 0);
  for (const items of [[{ id: "one" }], [{ id: "two" }]]) {
    const invalid = await completionFixture(async () => assert.fail("Incomplete removal must not be saved"));
    Object.assign(invalid.pending, { removing: true, itemIds: ["one", "two"] });
    await invalid.complete({}, { requestId: "request", count: 2, snapshot: { boards: [{ id: "target", items }] } });
    assert.equal(invalid.failures[0].code, "unknown_result");
  }
  const failed = await completionFixture(async () => ({ saved: false }));
  Object.assign(failed.pending, { removing: true, itemIds: ["one"] });
  await failed.complete({}, { requestId: "request", count: 1, snapshot: { boards: [{ id: "target", items: [] }] } });
  assert.equal(failed.replies.length, 0); assert.equal(failed.failures[0].code, "unknown_result");
});

test("unsaving removes matching entries only in the chosen list and retries never delete a subsequent re-save", async (t) => {
  let removals = 0, imports = 0;
  const pin = "https://www.pinterest.com/pin/999/";
  const boards = [{ id: "a", imageSources: [{ id: "other-list", imageUrl: originalImage }] }, { id: "b", imageSources: [{ id: "one", imageUrl: thumbnail, sourceUrl: pin }, { id: "two", sourceUrl: originalImage }, { id: "keep", imageUrl: "https://example.test/other.png", sourceUrl: pin }] }];
  const publish = () => bridge.updateState({ ready: true, generation: 1, activeId: "a", boards });
  const { bridge, name, state } = await fixture(t, async () => { imports++; boards[1].imageSources.push({ id: "new", imageUrl: originalImage }); publish(); return { count: 1 }; }, boards, async (request, isCurrent) => {
    assert.equal(isCurrent(), true); removals++;
    assert.deepEqual(request.targets.map(target => target.id), removals === 1 ? ["one", "two"] : []);
    boards[1].imageSources = boards[1].imageSources.filter(item => !request.targets.some(target => target.id === item.id));
    publish(); return { count: request.targets.length, removed: true, boardId: request.boardId };
  });
  const client = await socketClient(t, name);
  assert.equal(state.capabilities.removeImage, true);
  const request = { action: "import", operation: "remove", boardId: "b", imageUrl: originalImage, sourceUrl: pin, session: state.session, importId: randomUUID() };
  const [first, retry] = await Promise.all([client.request(request), client.request(request)]);
  assert.equal(first.result.removed, true); assert.equal(retry.result.count, 2); assert.equal(removals, 1); assert.equal(imports, 0);
  assert.deepEqual(boards[1].imageSources.map(item => item.id), ["keep"]);
  assert.deepEqual((await client.request({ action: "list", lookup: { imageUrl: thumbnail } })).state.boards.map(board => board.containsImage), [true, false]);
  assert.equal((await client.request({ ...request, importId: randomUUID() })).result.count, 0);
  await client.request({ ...request, operation: "save", importId: randomUUID() });
  assert.equal(imports, 1);
  await client.request(request);
  assert.equal(removals, 2); assert(boards[1].imageSources.some(item => item.id === "new"));
  assert.equal((await client.request({ ...request, operation: "save" })).error.code, "duplicate_id");
  bridge.updateState({ ready: true, generation: 2, activeId: "a", boards });
  assert.equal((await client.request({ ...request, importId: randomUUID() })).error.code, "stale_list");
});

test("unsaving waits for an in-flight save and never falls back to importing on unsupported apps", async (t) => {
  let finish, began;
  const wait = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { began = resolve; });
  const boards = [{ id: "b", imageSources: [] }], events = [];
  const { bridge, name, state } = await fixture(t, async () => {
    events.push("save"); began(); await wait;
    boards[0].imageSources.push({ id: "new", imageUrl: originalImage });
    bridge.updateState({ ready: true, generation: 1, activeId: "", boards }); return { count: 1 };
  }, boards, async request => { events.push("remove"); assert.equal(request.targets[0].id, "new"); return { count: 1, removed: true }; });
  const client = await socketClient(t, name);
  const request = { action: "import", session: state.session, boardId: "b", imageUrl: thumbnail };
  const saving = client.request({ ...request, importId: randomUUID() }); await started;
  const removing = client.request({ ...request, importId: randomUUID(), operation: "remove" });
  await new Promise(resolve => setTimeout(resolve, 15)); assert.deepEqual(events, ["save"]);
  finish(); await saving; assert.equal((await removing).result.removed, true); assert.deepEqual(events, ["save", "remove"]);
  const old = await fixture(t, () => assert.fail("Remove must never import"));
  const oldClient = await socketClient(t, old.name);
  const oldRequest = { ...request, session: old.state.session, importId: randomUUID(), operation: "remove" };
  assert.equal((await oldClient.request(oldRequest)).error.code, "update_required");
  assert.equal((await client.request({ ...request, importId: randomUUID(), operation: "toggle" })).error.code, "invalid_message");
});

test("an incomplete or wrong-destination snapshot cannot overwrite the saved project", async () => {
  for (const snapshot of [undefined, { boards: [{ id: "other" }] }]) {
    const fixture = await completionFixture(async () => assert.fail("Unexpected storage write"));
    await fixture.complete({}, { requestId: "request", count: 1, snapshot });
    assert.equal(fixture.writes.length, 0); assert.equal(fixture.replies.length, 0);
    assert.equal(fixture.failures[0].code, "unknown_result");
  }
});

test("configuration retains its connection identity across app upgrades and records structured launch arguments", async () => {
  const directory = await fs.mkdtemp(path.join(root, "work", "extension-config-test-"));
  const first = await ensureBridgeConfiguration(directory, { appPath: "C:\\ImageStorage.exe", appArgs: [] });
  const second = await ensureBridgeConfiguration(directory, { appPath: "C:\\New Version\\ImageStorage.exe", appArgs: ["C:\\Project Path"] });
  assert.deepEqual(second, first);
  assert.match(second.token, /^[a-f0-9]{64}$/);
  const application = JSON.parse(await fs.readFile(path.join(directory, "application.json"), "utf8"));
  assert.equal(application.appPath, "C:\\New Version\\ImageStorage.exe");
  assert.deepEqual(application.appArgs, ["C:\\Project Path"]);
});

test("list messages require authorization, paginate every list, and broadcast only metadata", async (t) => {
  const boards = Array.from({ length: 620 }, (_, index) => ({ id: `board-${index}`, name: `資料 ${index}`, groupName: "Art", items: [{ src: "file:///private.png" }] }));
  const { bridge, name } = await fixture(t, undefined, boards);
  const bad = await socketClient(t, name);
  const rejected = await bad.request({ action: "list" }, "b".repeat(64));
  assert.equal(rejected.error.code, "unauthorized");
  assert.equal("state" in rejected, false);
  const client = await socketClient(t, name);
  const first = await client.request({ action: "list" });
  assert.equal(first.state.boards.length, 128);
  assert.equal(first.state.total, 620);
  let last = first;
  const all = [...first.state.boards];
  while (last.state.nextOffset !== null) { last = await client.request({ action: "list", offset: last.state.nextOffset }); all.push(...last.state.boards); }
  assert.equal(all.length, 620);
  assert.equal(last.state.boards.at(-1).id, "board-619");
  assert.equal(JSON.stringify(first).includes("private.png"), false);
  bridge.updateState({ ready: true, generation: 1, activeId: "board-1", boards });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(client.events.at(-1).event, "state");
  assert.equal("boards" in client.events.at(-1).state, false);
});

test("saved identity matches Pinterest sizes and regional pins without merging unrelated images on the same page", () => {
  assert.deepEqual(imageIdentityKeys({ imageUrl: thumbnail }), imageIdentityKeys({ sourceUrl: originalImage + "?download=true" }));
  assert.deepEqual(imageIdentityKeys({ sourceUrl: "https://jp.pinterest.com/pin/123/?tracking=x" }), imageIdentityKeys({ sourceUrl: "https://www.pinterest.com/pin/123/" }));
  assert.deepEqual(imageIdentityKeys({ sourceUrl: "https://example.test/gallery" }), []);
  assert.deepEqual(imageIdentityKeys({ imageUrl: "file:///private/image.png", sourceUrl: "https://example.test/gallery" }), []);
  assert.deepEqual(imageIdentityKeys(null), []);
  assert.notDeepEqual(imageIdentityKeys({ imageUrl: "https://example.test/image?id=1" }), imageIdentityKeys({ imageUrl: "https://example.test/image?id=2" }));
  assert.deepEqual(imageIdentityKeys({ imageUrl: "https://example.test/image.png#crop" }), ["url:https://example.test/image.png"]);
  assert(!imageIdentityKeys({ sourceUrl: "https://pinterest.com.evil.test/pin/123/" }).some(key => key.startsWith("pin:")));
});

test("membership finds previously saved sources in each list, updates after removal, and never exposes source data", async (t) => {
  let imports = 0;
  const boards = [
    { id: "a", name: "Old download", imageSources: [{ imageUrl: "file:///private/cached.png", sourceUrl: originalImage }] },
    { id: "b", name: "Old extension save", imageSources: [{ sourceUrl: "https://www.pinterest.com/pin/123/" }] },
    { id: "c", name: "Other image on this page", imageSources: [{ sourceUrl: "https://example.test/gallery", imageUrl: "https://example.test/other.png" }] },
  ];
  const { bridge, name, state } = await fixture(t, async () => { imports++; return { count: 1 }; }, boards);
  const client = await socketClient(t, name);
  const lookup = { imageUrl: thumbnail, sourceUrl: "https://jp.pinterest.com/pin/123/?x=1" };
  const first = await client.request({ action: "list", lookup });
  assert.equal(first.state.capabilities.savedStatus, true);
  assert.deepEqual(first.state.boards.map(board => board.containsImage), [true, true, false]);
  assert(!/cached\.png|pinimg|pinterest|imageSources/.test(JSON.stringify(first)), "Only membership booleans should leave the app");
  const plain = await client.request({ action: "list" });
  assert(plain.state.boards.every(board => !("containsImage" in board) && !("imageSources" in board)));
  const skipped = await client.request({ action: "import", boardId: "a", session: state.session, importId: randomUUID(), ...lookup });
  assert.equal(skipped.result.alreadySaved, true); assert.equal(skipped.result.count, 0); assert.equal(imports, 0);
  boards[0].imageSources = [];
  bridge.updateState({ ready: true, generation: 1, activeId: "a", boards });
  const removed = await client.request({ action: "list", lookup });
  assert.equal(removed.state.session, first.state.session);
  assert(removed.state.revision > first.state.revision);
  assert.deepEqual(removed.state.boards.map(board => board.containsImage), [false, true, false]);
  assert.equal((await client.request({ action: "import", boardId: "a", session: state.session, importId: randomUUID(), ...lookup })).ok, true);
  assert.equal(imports, 1);
});

test("membership works beyond the first page and browser fallback retains original image identity", async (t) => {
  let received;
  const boards = Array.from({ length: 130 }, (_, index) => ({ id: `list-${index}`, imageSources: index === 129 ? [{ imageUrl: originalImage }] : [] }));
  const { name, state } = await fixture(t, async request => { received = request; return { count: 1 }; }, boards);
  const client = await socketClient(t, name);
  const first = await client.request({ action: "list", lookup: { imageUrl: thumbnail } });
  assert(first.state.boards.every(board => board.containsImage === false));
  const second = await client.request({ action: "list", offset: first.state.nextOffset, lookup: { imageUrl: thumbnail } });
  assert.deepEqual(second.state.boards.map(board => board.containsImage), [false, true]);
  const request = { action: "import", boardId: "list-0", session: state.session, importId: randomUUID(), imageUrl: "data:image/png;base64,YWJj", originalImageUrl: thumbnail, sourceUrl: "https://example.test/gallery" };
  assert.equal((await client.request(request)).ok, true);
  assert.equal(received.originalImageUrl, thumbnail);
  assert.equal((await client.request({ ...request, boardId: "list-129" })).error.code, "duplicate_id", "Membership must not bypass import-ID validation");
});

test("a second save of the same image waits for the first durable commit instead of acknowledging transient membership", async (t) => {
  let finish, entered, imports = 0;
  const commit = new Promise(resolve => { finish = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { bridge, name, state } = await fixture(t, async () => {
    imports++;
    bridge.updateState({ ready: true, generation: 1, activeId: "a", boards: [{ id: "a" }, { id: "b", imageSources: [{ imageUrl: originalImage }] }] });
    entered(); await commit; return { count: 1, boardId: "b" };
  });
  const client = await socketClient(t, name);
  const request = { action: "import", boardId: "b", session: state.session, imageUrl: thumbnail };
  const first = client.request({ ...request, importId: randomUUID() }); await started;
  let acknowledged = false;
  const second = client.request({ ...request, importId: randomUUID() }).then(result => { acknowledged = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(acknowledged, false); assert.equal(imports, 1);
  finish(); assert.equal((await first).ok, true); assert.equal((await second).result.alreadySaved, true);
});

test("inactive-list imports retain their destination, deduplicate retries, and reject a changed project", async (t) => {
  const imports = [];
  const { bridge, name, state } = await fixture(t, async (request, isCurrent) => {
    assert.equal(isCurrent(), true); imports.push(request); return { count: 1 };
  });
  const client = await socketClient(t, name);
  const request = { action: "import", session: state.session, boardId: "b", imageUrl: "https://i.pinimg.com/236x/01/02/03/image.jpg", sourceUrl: "https://www.pinterest.com/pin/200/", importId: randomUUID() };
  const [one, retry] = await Promise.all([client.request(request), client.request(request)]);
  assert.equal(one.ok, true); assert.equal(retry.ok, true);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].boardId, "b");
  assert.equal(imports[0].sourceUrl, request.sourceUrl);
  assert.equal((await client.request({ ...request, boardId: "a" })).error.code, "duplicate_id");
  bridge.updateState({ ready: true, generation: 2, activeId: "a", boards: [{ id: "a", name: "New project" }, { id: "b", name: "Same ID, different project" }] });
  assert.equal((await client.request({ ...request, importId: randomUUID() })).error.code, "stale_list");
  assert.equal(imports.length, 1);
});

test("a deleted destination invalidates an in-flight download before it can commit", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { bridge, name, state } = await fixture(t, async (_request, isCurrent) => { started(); await wait; if (!isCurrent()) throw Object.assign(new Error("Changed destination"), { code: "stale_list" }); return { count: 1 }; });
  const client = await socketClient(t, name);
  const result = client.request({ action: "import", session: state.session, boardId: "b", imageUrl: "https://example.test/image.png", importId: randomUUID() });
  await ready;
  bridge.updateState({ ready: true, generation: 1, activeId: "a", boards: [{ id: "a", name: "default" }] });
  release();
  assert.equal((await result).error.code, "stale_list");
});

test("new-list imports commit once, survive the new list publication, and retain their retry identity", async (t) => {
  const received = [];
  const { bridge, name, state } = await fixture(t, async (request, isCurrent) => {
    received.push(request);
    assert.equal(isCurrent(), true);
    bridge.updateState({ ready: true, generation: 1, activeId: "a", boards: [{ id: "a", name: "default" }, { id: request.boardId, name: request.newBoardName }] });
    assert.equal(isCurrent(), true, "Publishing the created list must not invalidate its acknowledgement");
    return { count: 1, boardId: request.boardId };
  });
  assert.equal(state.capabilities.createBoard, true);
  const client = await socketClient(t, name);
  const request = { action: "import", session: state.session, importId: randomUUID(), newBoardName: "  新しい資料  ", imageUrl: "https://example.test/original.png" };
  const results = await Promise.all([client.request(request), client.request(request)]);
  for (const result of results) { assert.equal(result.ok, true); assert.equal(result.result.boardId, `board-${request.importId}`); }
  assert.equal(received.length, 1);
  assert.equal(received[0].newBoardName, "新しい資料");
  assert.equal((await client.request(request)).ok, true);
  assert.equal(received.length, 1);
  assert.equal((await client.request({ ...request, newBoardName: "違う名前" })).error.code, "duplicate_id");
});

test("invalid names, failed downloads, and changed projects cannot leave empty new lists", async (t) => {
  let downloads = 0, release, started;
  const downloading = new Promise((resolve) => { started = resolve; });
  const wait = new Promise((resolve) => { release = resolve; });
  const { bridge, name, state } = await fixture(t, async (request, isCurrent) => {
    downloads++;
    if (request.newBoardName === "失敗") throw Object.assign(new Error("Download failed"), { code: "download_failed" });
    started(); await wait;
    assert.equal(isCurrent(), false);
    throw Object.assign(new Error("Project changed"), { code: "stale_list" });
  });
  const client = await socketClient(t, name);
  const request = (newBoardName) => ({ action: "import", session: state.session, importId: randomUUID(), newBoardName, imageUrl: "https://example.test/image.png" });
  for (const invalid of ["", "  ", "x".repeat(121), "bad\u0000name", 7]) assert.equal((await client.request(request(invalid))).ok, false);
  assert.equal((await client.request({ ...request("valid"), boardId: "a" })).ok, false);
  assert.equal(downloads, 0);
  assert.equal((await client.request(request("失敗"))).error.code, "download_failed");
  assert.equal((await client.request({ action: "list" })).state.boards.length, 2);
  const pending = client.request(request("新しい資料")); await downloading;
  bridge.updateState({ ready: true, generation: 2, activeId: "other", boards: [{ id: "other", name: "別プロジェクト" }] });
  release();
  assert.equal((await pending).error.code, "stale_list");
  assert.deepEqual((await client.request({ action: "list" })).state.boards.map((board) => board.id), ["other"]);
});

async function nativeClient(t, directory, args) {
  const executable = path.join(root, "browser-extension/dist/native-host/ImageStorage.NativeHost.exe");
  const child = spawn(executable, args, { env: { ...process.env, IMAGESTORAGE_EXTENSION_CONFIG_DIR: directory }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map(); let buffer = Buffer.alloc(0);
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(); assert(length <= 950000);
      if (buffer.length < length + 4) break;
      const response = JSON.parse(buffer.subarray(4, length + 4).toString("utf8")); buffer = buffer.subarray(length + 4);
      if (response.id) { pending.get(response.id)?.(response); pending.delete(response.id); }
    }
  });
  t.after(async () => { child.stdin.end(); if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(() => { child.kill(); resolve(); }, 2000))]); });
  return {
    child,
    request(message, fragmented = false) {
      const id = randomUUID(), data = Buffer.from(JSON.stringify({ ...message, id }));
      const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
      const frame = Buffer.concat([header, data]);
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native host did not respond")), 10000);
        pending.set(id, (response) => { clearTimeout(timer); resolve(response); });
      });
      if (fragmented) { for (let offset = 0; offset < frame.length; offset += 3) child.stdin.write(frame.subarray(offset, offset + 3)); }
      else child.stdin.write(frame);
      return promise;
    },
  };
}

for (const browser of ["chromium", "zen"]) test(`compiled ${browser} native host exchanges real messages with the app pipe`, { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
  const received = [];
  const { name, state } = await fixture(t, async (request) => { received.push(request); return { count: 1 }; });
  const directory = await fs.mkdtemp(path.join(root, "work", "native-host-test-"));
  await fs.writeFile(path.join(directory, "connection.json"), JSON.stringify({ pipeName: name, token }));
  const identity = JSON.parse(await fs.readFile(path.join(root, "browser-extension/identity.json"), "utf8"));
  const args = browser === "chromium" ? [`chrome-extension://${identity.chromiumId}/`, "--parent-window=0"] : [path.join(directory, "firefox-host.json"), identity.firefoxId];
  const client = await nativeClient(t, directory, args);
  const list = await client.request({ action: "list", launch: false }, true);
  assert.equal(list.ok, true, JSON.stringify(list));
  assert.equal(list.state.boards[1].name, "保存先 日本語");
  assert.equal(JSON.stringify(list).includes(token), false);
  const sent = await client.request({ action: "import", launch: false, session: state.session, boardId: "b", imageUrl: "data:image/png;base64,aGVsbG8=", sourceUrl: "https://example.test/参照", importId: randomUUID() }, true);
  assert.equal(sent.ok, true);
  assert.equal(received[0].boardId, "b");
  assert.equal(received[0].imageUrl, "data:image/png;base64,aGVsbG8=");
  const created = await client.request({ action: "import", launch: false, session: state.session, newBoardName: "新規作成", imageUrl: "data:image/png;base64,aGVsbG8=", importId: randomUUID() }, true);
  assert.equal(created.ok, true);
  assert.equal(received[1].newBoardName, "新規作成");
  assert.match(received[1].boardId, /^board-/);
});

test("native background discovery never launches the app without a user action", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(root, "work", "native-discovery-test-"));
  const identity = JSON.parse(await fs.readFile(path.join(root, "browser-extension/identity.json"), "utf8"));
  const client = await nativeClient(t, directory, [`chrome-extension://${identity.chromiumId}/`]);
  const result = await client.request({ action: "list", launch: false });
  assert.equal(result.ok, false); assert.equal(result.error.code, "not_running");
  assert.deepEqual(await fs.readdir(directory), []);
});

test("native list pages fit browser message limits even with long names that need HTML escaping", { skip: process.platform !== "win32", timeout: 15000 }, async (t) => {
  const boards = Array.from({ length: 260 }, (_, index) => ({ id: String(index) + '"'.repeat(90), name: "<".repeat(512), groupName: "'".repeat(128) }));
  const { name } = await fixture(t, undefined, boards);
  const directory = await fs.mkdtemp(path.join(root, "work", "native-long-list-test-"));
  await fs.writeFile(path.join(directory, "connection.json"), JSON.stringify({ pipeName: name, token }));
  const identity = JSON.parse(await fs.readFile(path.join(root, "browser-extension/identity.json"), "utf8"));
  const client = await nativeClient(t, directory, [`chrome-extension://${identity.chromiumId}/`]);
  const response = await client.request({ action: "list", launch: false });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.equal(response.state.boards.length, 128);
  assert.equal(response.state.boards[0].name, boards[0].name);
  assert.equal(response.state.nextOffset, 128);
});

test("explicit native startup launches only the configured executable and quotes Windows arguments", { skip: process.platform !== "win32", timeout: 20000 }, async (t) => {
  const directory = await fs.mkdtemp(path.join(root, "work", "native-launch-test-"));
  const probeDirectory = path.join(directory, "with spaces"); await fs.mkdir(probeDirectory);
  const source = path.join(probeDirectory, "LaunchProbe.cs"), executable = path.join(probeDirectory, "LaunchProbe.exe"), argumentsFile = path.join(directory, "arguments.json");
  await fs.writeFile(source, 'using System; using System.IO; using System.Text; using System.Web.Script.Serialization; public static class LaunchProbe { public static void Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("IMAGESTORAGE_LAUNCH_PROBE"), new JavaScriptSerializer().Serialize(args), new UTF8Encoding(false)); } }');
  const compiler = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
  const compiled = spawnSync(compiler, ["/nologo", "/target:exe", "/reference:System.Web.Extensions.dll", `/out:${executable}`, source], { encoding: "utf8", windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
  const name = pipeName();
  const bridge = createExtensionBridge({ pipePath: pipePath(name), token, onImport: async () => ({ count: 1 }) });
  t.after(() => bridge.close());
  bridge.updateState({ ready: true, generation: 1, activeId: "a", boards: [{ id: "a", name: "Started" }] });
  await fs.writeFile(path.join(directory, "connection.json"), JSON.stringify({ pipeName: name, token }));
  const launchArguments = ["C:\\folder with spaces\\", 'a"quoted value', "日本語の 引数", "literal & text"];
  await fs.writeFile(path.join(directory, "application.json"), JSON.stringify({ appPath: executable, appArgs: launchArguments }));
  const previousProbe = process.env.IMAGESTORAGE_LAUNCH_PROBE;
  process.env.IMAGESTORAGE_LAUNCH_PROBE = argumentsFile;
  const identity = JSON.parse(await fs.readFile(path.join(root, "browser-extension/identity.json"), "utf8"));
  const client = await nativeClient(t, directory, [`chrome-extension://${identity.chromiumId}/`]);
  if (previousProbe === undefined) delete process.env.IMAGESTORAGE_LAUNCH_PROBE; else process.env.IMAGESTORAGE_LAUNCH_PROBE = previousProbe;
  const response = client.request({ action: "list", launch: true });
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await fs.stat(argumentsFile).then(() => true, () => false)) break; await new Promise((resolve) => setTimeout(resolve, 25)); }
  await bridge.start();
  assert.equal((await response).ok, true);
  const actual = JSON.parse(await fs.readFile(argumentsFile, "utf8"));
  assert.deepEqual(actual, [...launchArguments, "--imagestorage-extension"]);
});
