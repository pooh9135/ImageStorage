import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createConnector } from "../browser-extension/src/background.js";
import { pinterestBoardContextScript } from "../browser-extension/src/pinterest-board-context.js";

function event() {
  const listeners = [];
  return { addListener(callback) { listeners.push(callback); }, emit(...args) { for (const callback of listeners) callback(...args); }, listeners };
}
function fixture(t, options = {}) {
  const calls = [], menus = new Map(), values = {}, windows = [], scripts = [], popups = [];
  let state = { ready: true, session: randomUUID(), revision: 1, activeId: "a", capabilities: { createBoard: true }, boards: [{ id: "a", name: "現在のリスト", groupName: "" }, { id: "b", name: "保存先", groupName: "資料" }] };
  let route = options.route;
  const nativePort = { onMessage: event(), onDisconnect: event(), disconnect() {}, postMessage(message) {
    calls.push(message);
    void Promise.resolve().then(async () => {
      let response;
      if (route) response = await route(message, state);
      if (!response) {
        if (message.action === "list") {
          const offset = message.offset || 0;
          response = { ok: true, state: { ...state, total: state.boards.length, boards: state.boards.slice(offset, offset + 250), nextOffset: offset + 250 < state.boards.length ? offset + 250 : null } };
        } else response = { ok: true, result: { count: 1, boardId: message.newBoardName ? `board-${message.importId}` : message.boardId } };
      }
      nativePort.onMessage.emit({ ...response, id: message.id });
    });
  } };
  const api = {
    runtime: { id: "connector-id", getURL: (suffix) => `chrome-extension://connector-id/${suffix}`, connectNative(name) { assert.equal(name, "com.imagestorage.connector"); return nativePort; }, onMessage: event(), onInstalled: event(), onStartup: event(), ...(options.firefox ? { getBrowserInfo: async () => ({ name: "Firefox" }) } : {}) },
    contextMenus: { onClicked: event(), onShown: options.firefox ? event() : undefined, async refresh() {}, async removeAll() { menus.clear(); }, create(item, callback) { menus.set(item.id, item); callback?.(); return item.id; }, update(id, properties, callback) { Object.assign(menus.get(id) || {}, properties); callback?.(); } },
    storage: { session: { async get(key) { return structuredClone(key === null ? { ...values } : { [key]: values[key] }); }, async set(data) { Object.assign(values, structuredClone(data)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {}, async openPopup() { popups.push(true); } },
    windows: { async create(details) { windows.push(details); return { id: windows.length }; } },
    alarms: { onAlarm: event(), async create() {} },
    tabs: { async query() { return [{ id: 22, url: image.pageUrl }]; }, async sendMessage() { return ""; }, onActivated: event(), onRemoved: event(), onUpdated: event() },
    scripting: { async executeScript(details) { scripts.push(details); if (["showInlinePicker", "showBatchPicker", "showPinterestBoardExporter"].includes(details.func.name)) { if (options.restricted) throw new Error("Cannot access this page"); return [{ result: { shown: true } }]; } if (details.func.name === "collectPageImages") { if (options.restricted) throw new Error("Cannot access this page"); return [{ result: { images: options.batchImages || [{ imageUrl: image.srcUrl, sourceUrl: image.linkUrl, width: 300, height: 400 }] } }]; } if (details.func.name === "resolveLinkedImage") { if (options.resolveError) throw new Error("Cannot access this frame"); return [{ result: options.linkResult ?? null }]; } return [{ result: "data:image/png;base64,b3JpZ2luYWwtYnl0ZXM=" }]; } },
  };
  const connector = createConnector(api);
  t.after(() => connector.stop());
  return { connector, api, calls, menus, windows, scripts, values, nativePort, popups, state: () => state, setState(next) { state = { ...state, ...next }; }, setRoute(next) { route = next; } };
}
const image = { srcUrl: "https://i.pinimg.com/236x/01/02/03/related.jpg", pageUrl: "https://www.pinterest.com/pin/100/", linkUrl: "https://www.pinterest.com/pin/200/", frameId: 4 };

async function openInline(f, menuItemId = "imagestorage-pick") {
  f.connector.start();
  await f.connector.refreshState();
  await f.connector.clicked({ ...image, menuItemId }, { id: 22 });
  return f.scripts.find((entry) => entry.func.name === "showInlinePicker").args[0];
}
function inline(f, config, action, payload = {}, sender = {}) {
  return new Promise((resolve) => {
    const accepted = f.api.runtime.onMessage.listeners[0]({ action: `inline:${action}`, id: config.id, token: config.token, ...payload }, { id: "connector-id", url: image.pageUrl, tab: { id: 22 }, frameId: 0, documentId: "page-one", ...sender }, resolve);
    if (!accepted) resolve({ ok: false, ignored: true });
  });
}

function selectImage(f, imageUrl = image.srcUrl, sourceUrl = image.linkUrl) {
  return new Promise(resolve => f.api.runtime.onMessage.listeners[0]({ action: "context:image", imageUrl, sourceUrl }, { id: "connector-id", url: image.pageUrl, tab: { id: 22 }, frameId: 4, documentId: "page-one" }, resolve));
}

for (const firefox of [false, true]) test(`${firefox ? "Zen" : "Chrome/Edge"} opens board export without launching ImageStorage`, async t => {
  const f = fixture(t, { firefox }); f.api.tabs.query = async () => [{ id: 22, url: "https://www.pinterest.com/user/reference/" }];
  f.api.tabs.sendMessage = async () => "https://www.pinterest.com/user/reference/";
  f.connector.start(); await f.connector.refreshState();
  assert(f.menus.has("imagestorage-export-board"));
  assert.equal((await f.connector.pageMessage({ action: "board:open" })).ok, true);
  const script = f.scripts.find(entry => entry.func.name === "showPinterestBoardExporter");
  assert.deepEqual(script.target, { tabId: 22, frameIds: [0] }); assert.equal(script.args[0].boardUrl, "https://www.pinterest.com/user/reference/");
  assert(f.calls.every(call => call.action === "list" && !call.launch)); assert.equal(f.windows.length, 0);
});

for (const firefox of [false, true]) test(`${firefox ? "Zen/Firefox" : "Chrome/Edge"} shows export only on a confirmed board as the active page changes`, async t => {
  const f = fixture(t, { firefox });
  const boardUrl = "https://www.pinterest.com/user/reference/";
  let context = "";
  f.api.tabs.sendMessage = async (tabId, message, target) => {
    assert.equal(tabId, 22); assert.equal(message.action, "board:context"); assert.deepEqual(target, { frameId: 0 });
    return context;
  };
  f.connector.start(); await f.connector.refreshState();
  const menu = () => f.menus.get("imagestorage-export-board");
  assert.equal(menu().visible, false);
  assert.equal((await f.connector.pageMessage({ action: "board:available" })).available, false);

  context = `${boardUrl}?tracking=test`;
  const change = () => f.api.runtime.onMessage.emit({ action: "context:board-changed" }, { id: "connector-id", frameId: 0, tab: { id: 22, active: true } });
  change(); await new Promise(setImmediate);
  assert.equal(menu().visible, true);
  assert.deepEqual(menu().documentUrlPatterns, [boardUrl, `${boardUrl}?*`, boardUrl.slice(0, -1), `${boardUrl.slice(0, -1)}?*`]);
  assert.equal((await f.connector.pageMessage({ action: "board:available" })).available, true);
  await f.connector.clicked({ menuItemId: menu().id, pageUrl: `${boardUrl}?tracking=test` }, { id: 22 });
  assert.equal(f.scripts.at(-1)?.args[0].boardUrl, boardUrl);

  context = "https://www.pinterest.com/pin/100/";
  change(); await new Promise(setImmediate);
  assert.equal(menu().visible, false);
  assert.equal((await f.connector.pageMessage({ action: "board:available" })).available, false);
  await assert.rejects(f.connector.pageMessage({ action: "board:open" }), { code: "unsupported_page" });
});

test("the content script recognizes the board view after navigation without treating a lookalike Pinterest URL as a board", () => {
  const navigation = new EventTarget(), window = new EventTarget(), messages = [];
  const runtime = { id: "connector-id", onMessage: event(), async sendMessage(message) { messages.push(message.action); } };
  const board = "https://www.pinterest.com/user/reference/";
  const location = new URL("https://www.pinterest.com/user/following/");
  let hasFeed = false;
  const feed = { closest: () => null };
  const document = { querySelector(selector) { return hasFeed && selector.includes('data-test-id="board-feed"') ? feed : null; } };
  class MutationObserver { observe() {} disconnect() {} }
  window.top = window; window.navigation = navigation;
  runInNewContext(pinterestBoardContextScript(), { URL, window, location, document, MutationObserver, setTimeout: () => 1, clearTimeout() {}, chrome: { runtime } });
  const context = () => {
    let result;
    runtime.onMessage.emit({ action: "board:context" }, { id: runtime.id }, value => { result = value; });
    return result;
  };
  assert.equal(context(), "");
  assert.deepEqual(messages, []);

  location.href = `${board}?tracking=test`; hasFeed = true;
  navigation.dispatchEvent(new Event("currententrychange"));
  assert.equal(context(), board);
  assert.deepEqual(messages, ["context:board-changed"]);

  location.href = "https://www.pinterest.com/user/following/";
  navigation.dispatchEvent(new Event("currententrychange"));
  assert.equal(context(), "", "A stale board feed does not confirm another route");
  assert.deepEqual(messages, ["context:board-changed", "context:board-changed"]);

  location.href = "https://www.pinterest.com/pin/12345/";
  navigation.dispatchEvent(new Event("currententrychange"));
  assert.equal(context(), "", "A remaining feed element does not make the pin a board");
  assert.deepEqual(messages, ["context:board-changed", "context:board-changed"]);
});

test("non-Pinterest pages and forged web-page messages cannot open privileged export commands", async t => {
  const f = fixture(t); f.api.tabs.sendMessage = async () => "https://www.pinterest.com.evil.test/user/board/";
  await assert.rejects(f.connector.pageMessage({ action: "board:open" }), { code: "unsupported_page" });
  f.connector.start();
  const listener = f.api.runtime.onMessage.listeners[0];
  assert.equal(listener({ action: "board:open" }, { id: "connector-id", url: "https://untrusted.test" }, () => assert.fail()), false);
  assert.equal(f.scripts.length, 0);
});

function batch(f, config, action, payload = {}, sender = {}) {
  return new Promise(resolve => {
    const accepted = f.api.runtime.onMessage.listeners[0]({ action: `batch:${action}`, id: config.id, token: config.token, ...payload }, { id: "connector-id", url: image.pageUrl, tab: { id: 22 }, frameId: 0, documentId: "batch-page", ...sender }, resolve);
    if (!accepted) resolve({ ok: false, ignored: true });
  });
}

for (const firefox of [false, true]) test(`${firefox ? "Zen" : "Chrome/Edge"} opens batch selection in the page and sends only selected images to the inactive list`, async t => {
  const images = [1, 2, 3].map(i => ({ imageUrl: `https://example.test/${i}.png`, sourceUrl: `https://www.pinterest.com/pin/${i}/`, width: 400, height: 500 }));
  const f = fixture(t, { firefox, batchImages: images });
  f.connector.start(); await f.connector.refreshState();
  assert(f.menus.has("imagestorage-batch"));
  await f.connector.clicked({ ...image, menuItemId: "imagestorage-batch" }, { id: 22 });
  const script = f.scripts.find(entry => entry.func.name === "showBatchPicker"), config = script.args[0];
  assert.deepEqual(script.target, { tabId: 22, frameIds: [0] });
  assert.deepEqual(f.scripts.find(entry => entry.func.name === "collectPageImages").target, { tabId: 22, frameIds: [4] });
  assert(f.calls.every(call => call.action === "list" && call.launch === false));
  const status = await batch(f, config, "status");
  assert.equal(status.batch.images.length, 3); assert.equal(status.batch.token, undefined);
  const chosen = [status.batch.images[0].id, status.batch.images[2].id];
  assert.equal((await batch(f, config, "start", { selected: chosen, boardId: "b", session: f.state().session })).ok, true);
  for (let i = 0; i < 100 && (await batch(f, config, "status")).batch.running; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.filter(call => call.action === "import").map(call => call.imageUrl), [images[0].imageUrl, images[2].imageUrl]);
  assert(f.calls.filter(call => call.action === "import").every(call => call.boardId === "b" && call.originalImageUrl === call.imageUrl));
  assert.equal(f.state().activeId, "a"); assert.equal(f.windows.length, 0); assert.equal(f.popups.length, 0);
});

test("batch control rejects another page or a forged token before importing", async t => {
  const f = fixture(t); f.connector.start(); await f.connector.refreshState();
  assert.equal((await f.connector.pageMessage({ action: "batch:open" })).ok, true);
  const config = f.scripts.find(entry => entry.func.name === "showBatchPicker").args[0];
  assert.equal((await batch(f, { ...config, token: randomUUID() }, "status")).ok, false);
  assert.equal((await batch(f, config, "status", {}, { tab: { id: 99 } })).ok, false);
  assert.equal((await batch(f, config, "status")).ok, true);
  assert.equal((await batch(f, config, "status", {}, { documentId: "navigated" })).ok, false);
  assert.equal(f.calls.filter(call => call.action === "import").length, 0);
});

test("restricted pages cannot start batch imports or open extra windows", async t => {
  const f = fixture(t, { restricted: true });
  await assert.rejects(f.connector.pageMessage({ action: "batch:open" }), { code: "unsupported_page" });
  assert.equal(f.calls.length, 0); assert.equal(f.windows.length, 0);
});

for (const firefox of [false, true]) test(`${firefox ? "Zen" : "Chrome/Edge"} restores the native checkbox after a rejected removal`, async (t) => {
  const f = fixture(t, { firefox });
  f.setState({ capabilities: { createBoard: true, savedStatus: true, removeImage: true } });
  f.setRoute((request, state) => request.lookup
    ? { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: board.id === "b" })), nextOffset: null } }
    : request.operation === "remove" ? { ok: false, error: { code: "stale_image", message: "Image changed" } } : undefined);
  f.connector.start(); await f.connector.refreshState(); await selectImage(f);
  const id = `board|${f.state().session}|b`;
  // Browsers toggle checkbox menu items before dispatching onClicked.
  f.menus.get(id).checked = false;
  await f.connector.clicked({ ...image, menuItemId: id, wasChecked: true, checked: false }, { id: 22 });
  await f.connector.refreshState(); await selectImage(f);
  assert.equal(f.menus.get(id).checked, true, "Rejected removals must remain visibly saved");
  assert.match(f.menus.get(id).title, /保存済み/);
});

test("a delayed status response cannot resurrect a cancelled picker", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  f.setState({ capabilities: { createBoard: true, savedStatus: true } });
  let release, began;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  f.setRoute(async (request, state) => {
    if (!request.lookup) return;
    began(); await wait;
    return { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: false })), nextOffset: null } };
  });
  const status = inline(f, config, "status"); await started;
  await inline(f, config, "cancel"); release(); await status;
  assert.equal((await f.connector.pageMessage({ action: "pending", id: config.id })).image, null);
  assert.equal((await inline(f, config, "send", { boardId: "b", session: f.state().session })).ok, false);
  assert.equal(f.calls.filter(call => call.action === "import").length, 0);
});

test("a delayed status response preserves an uncertain save for worker restarts", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  f.setState({ capabilities: { createBoard: true, savedStatus: true } });
  let release, began;
  const wait = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  f.setRoute(async (request, state) => {
    if (request.action === "import") return { ok: false, error: { code: "unknown_result", message: "Result unknown" } };
    if (!request.lookup) return;
    began(); await wait;
    return { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: false })), nextOffset: null } };
  });
  const status = inline(f, config, "status"); await started;
  assert.equal((await inline(f, config, "send", { boardId: "b", session: f.state().session })).code, "unknown_result");
  release(); await status;
  assert.deepEqual(f.values[`pending:${config.id}`].uncertain, [JSON.stringify([f.state().session, "b"])]);
});

test("concurrent saves to different lists persist both confirmations", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  const results = await Promise.all(["a", "b"].map(boardId => inline(f, config, "send", { boardId, session: f.state().session })));
  assert(results.every(result => result.ok));
  assert.deepEqual(new Set(f.values[`pending:${config.id}`].saved), new Set(["a", "b"].map(id => JSON.stringify([f.state().session, id]))));
});

test("an uncertain native removal cannot be retried from its fallback panel", async (t) => {
  const f = fixture(t);
  f.setState({ capabilities: { createBoard: true, savedStatus: true, removeImage: true } });
  f.setRoute((request, state) => request.lookup
    ? { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: board.id === "b" })), nextOffset: null } }
    : request.operation === "remove" ? { ok: false, error: { code: "unknown_result", message: "Result unknown" } } : undefined);
  f.connector.start(); await f.connector.refreshState(); await selectImage(f);
  await f.connector.clicked({ ...image, menuItemId: `board|${f.state().session}|b`, wasChecked: true, checked: false }, { id: 22 });
  const config = f.scripts.find(script => script.func.name === "showInlinePicker").args[0];
  assert.equal((await inline(f, config, "status")).uncertain.length, 1);
  const payload = { boardId: "b", session: f.state().session };
  assert.equal((await inline(f, config, "remove", payload)).code, "unknown_result");
  assert.equal((await inline(f, config, "send", payload)).code, "unknown_result");
  assert.equal(f.calls.filter(call => call.action === "import").length, 1);
});

test("a confirmed removal stays unchecked when storing its confirmation fails", async (t) => {
  const f = fixture(t), config = await openInline(f);
  f.setState({ capabilities: { createBoard: true, removeImage: true } });
  await inline(f, config, "status");
  const payload = { boardId: "b", session: f.state().session };
  await inline(f, config, "send", payload);
  f.api.storage.session.set = async () => { throw new Error("Storage unavailable"); };
  assert.equal((await inline(f, config, "remove", payload)).ok, true);
  assert.deepEqual((await inline(f, config, "status")).saved, []);
});

for (const firefox of [false, true]) test(`${firefox ? "Zen" : "Chrome/Edge"} shows pre-existing membership in the native submenu without recreating it or launching the app`, async (t) => {
  const f = fixture(t, { firefox });
  f.setState({ capabilities: { createBoard: true, savedStatus: true } });
  f.setRoute((request, state) => request.lookup ? { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: board.id === "b" })), nextOffset: null } } : undefined);
  f.connector.start(); await f.connector.refreshState();
  await selectImage(f);
  const root = f.menus.get("imagestorage-send"), saved = f.menus.get(`board|${f.state().session}|b`), empty = f.menus.get(`board|${f.state().session}|a`);
  assert.equal(saved.type, "checkbox"); assert.equal(saved.checked, true); assert.equal(saved.enabled, false); assert.match(saved.title, /保存済み/);
  assert.equal(empty.checked, false); assert.equal(empty.enabled, true);
  const before = f.calls.length;
  await selectImage(f);
  assert.equal(f.calls.length, before, "Right-click should retain the hover result without flicker or another round trip");
  assert.equal(f.menus.get("imagestorage-send"), root);
  assert(f.calls.every(call => call.launch === false && call.action === "list"));
  assert.equal(f.windows.length, 0); assert.equal(f.scripts.length, 0);
});

for (const firefox of [false, true]) test(`${firefox ? "Zen" : "Chrome/Edge"} unchecks saved images by removing only the chosen destination`, async (t) => {
  const f = fixture(t, { firefox }); let present = true;
  f.setState({ capabilities: { createBoard: true, savedStatus: true, removeImage: true } });
  f.setRoute((request, state) => {
    if (request.lookup) return { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: present && board.id === "b" })), nextOffset: null } };
    if (request.operation === "remove") { present = false; f.setState({ revision: 2 }); return { ok: true, result: { removed: true, count: 1, boardId: "b" } }; }
  });
  f.connector.start(); await f.connector.refreshState(); await selectImage(f);
  const id = `board|${f.state().session}|b`;
  assert.equal(f.menus.get(id).enabled, true); assert.match(f.menus.get(id).title, /解除/);
  await f.connector.clicked({ ...image, menuItemId: id, wasChecked: true, checked: false }, { id: 22 });
  const mutations = f.calls.filter(call => call.action === "import");
  assert.equal(mutations.length, 1); assert.equal(mutations[0].operation, "remove");
  assert.equal(mutations[0].boardId, "b"); assert.equal(mutations[0].imageUrl, image.srcUrl);
  assert.equal(f.scripts.length, 0); assert.equal(f.windows.length, 0); assert(f.calls.every(call => call.launch === false));
  await f.connector.refreshState(); await selectImage(f);
  assert.equal(f.menus.get(id).checked, false);
  await f.connector.clicked({ ...image, menuItemId: id, wasChecked: false, checked: true }, { id: 22 });
  assert.equal(f.calls.filter(call => call.action === "import").at(-1).operation, undefined, "Unchecked entries must save rather than blindly toggle server state");
});

test("removal in the inline and toolbar picker can be followed by re-saving without cached success blocking it", async (t) => {
  const f = fixture(t), config = await openInline(f);
  f.setState({ capabilities: { createBoard: true, removeImage: true } }); await f.connector.refreshState();
  const payload = { boardId: "b", session: f.state().session };
  await inline(f, config, "send", payload);
  assert.equal((await inline(f, config, "status")).saved.length, 1);
  await Promise.all([inline(f, config, "remove", payload), inline(f, config, "remove", payload)]);
  assert.equal(f.calls.filter(call => call.operation === "remove").length, 1);
  assert.deepEqual((await inline(f, config, "status")).saved, []);
  assert.deepEqual((await inline(f, config, "status")).uncertain, []);
  await f.connector.pageMessage({ action: "send", id: config.id, ...payload });
  assert.equal(f.calls.filter(call => call.action === "import" && !call.operation).length, 2);
  await f.connector.pageMessage({ action: "remove", id: config.id, ...payload });
  assert.equal(f.calls.filter(call => call.operation === "remove").length, 2);
});

test("old applications and uncertain removals never turn an unsave into a download or repeated mutation", async (t) => {
  const f = fixture(t), config = await openInline(f);
  const payload = { boardId: "b", session: f.state().session };
  assert.equal((await inline(f, config, "remove", payload)).code, "update_required");
  assert.equal(f.calls.filter(call => call.action === "import").length, 0);
  f.setState({ capabilities: { createBoard: true, removeImage: true } }); await f.connector.refreshState();
  f.setRoute(request => request.operation === "remove" ? { ok: false, error: { code: "unknown_result", message: "解除結果を確認してください" } } : undefined);
  assert.equal((await inline(f, config, "remove", payload)).code, "unknown_result");
  assert.equal((await inline(f, config, "remove", payload)).code, "unknown_result");
  assert.equal((await inline(f, config, "send", payload)).code, "unknown_result");
  assert.equal(f.calls.filter(call => call.action === "import").length, 1);
  assert(f.scripts.every(script => script.func.name === "showInlinePicker"));
});

test("slow membership for the previous image cannot mark the newly hovered image", async (t) => {
  const f = fixture(t); let release, started;
  const wait = new Promise(resolve => { release = resolve; }), began = new Promise(resolve => { started = resolve; });
  f.setState({ capabilities: { createBoard: true, savedStatus: true } });
  f.setRoute(async (request, state) => {
    if (!request.lookup) return;
    const previous = request.lookup.imageUrl.endsWith("first.png");
    if (previous) { started(); await wait; }
    return { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: board.id === (previous ? "a" : "b") })), nextOffset: null } };
  });
  f.connector.start(); await f.connector.refreshState();
  const first = selectImage(f, "https://example.test/first.png"); await began;
  await selectImage(f, "https://example.test/second.png"); release(); await first;
  assert.equal(f.menus.get(`board|${f.state().session}|a`).checked, false);
  assert.equal(f.menus.get(`board|${f.state().session}|b`).checked, true);
  await selectImage(f, "", "");
  assert([...f.menus.values()].filter(menu => menu.id.startsWith("board|")).every(menu => !menu.checked));
});

test("membership tracks deletion and paginated lists while legacy apps remain usable", async (t) => {
  const f = fixture(t); let saved = true;
  f.setState({ capabilities: { createBoard: true, savedStatus: true }, boards: Array.from({ length: 320 }, (_, i) => ({ id: `list-${i}`, name: `List ${i}` })) });
  f.setRoute((request, state) => request.lookup ? { ok: true, state: { ...state, boards: state.boards.slice(request.offset, request.offset + 128).map(board => ({ ...board, containsImage: saved && board.id === "list-319" })), nextOffset: request.offset + 128 < state.boards.length ? request.offset + 128 : null } } : undefined);
  f.connector.start(); await f.connector.refreshState(); await selectImage(f);
  const target = () => f.menus.get(`board|${f.state().session}|list-319`);
  assert.equal(target().checked, true);
  saved = false; f.setState({ revision: 2 }); await f.connector.refreshState(); await selectImage(f);
  assert.equal(target().checked, false); assert.equal(target().enabled, true);
  f.setState({ capabilities: { createBoard: true }, revision: 3 }); await f.connector.refreshState();
  const count = f.calls.length; await selectImage(f);
  assert.equal(f.calls.length, count); assert.equal(target().enabled, true);
});

test("the inline and toolbar fallback recognize old saves and allow saving again after app-side deletion", async (t) => {
  const f = fixture(t); let present = true;
  f.setState({ capabilities: { createBoard: true, savedStatus: true } });
  f.setRoute((request, state) => request.lookup ? { ok: true, state: { ...state, boards: state.boards.map(board => ({ ...board, containsImage: present && board.id === "b" })), nextOffset: null } } : undefined);
  const config = await openInline(f);
  assert.deepEqual((await inline(f, config, "status")).saved, [JSON.stringify([f.state().session, "b"])]);
  assert.equal((await f.connector.pageMessage({ action: "status", id: config.id })).state.boards[1].containsImage, true);
  await inline(f, config, "send", { boardId: "b", session: f.state().session });
  assert.equal(f.calls.filter(call => call.action === "import").length, 0);
  present = false; f.setState({ revision: 2 });
  assert.deepEqual((await inline(f, config, "status")).saved, []);
  await inline(f, config, "send", { boardId: "b", session: f.state().session });
  assert.equal(f.calls.filter(call => call.action === "import").length, 1);
  assert.equal(f.calls.find(call => call.action === "import").originalImageUrl, image.srcUrl);
});

test("the same-tab picker receives the clicked image and exposes all destinations without a new window", async (t) => {
  const f = fixture(t), config = await openInline(f);
  const injected = f.scripts[0];
  assert.deepEqual(injected.target, { tabId: 22, frameIds: [0] }, "Use the top frame to avoid clipping the picker inside small image frames");
  assert.equal(config.imageUrl, image.srcUrl);
  assert.equal(config.sourceUrl, image.linkUrl);
  assert.equal(f.windows.length, 0);
  assert.equal(f.popups.length, 0);
  const result = await inline(f, config, "status", { launch: true });
  assert.equal(result.ok, true);
  assert.equal(result.state.boards.length, 2);
  const saved = await inline(f, config, "send", { boardId: "b", session: result.state.session });
  assert.equal(saved.ok, true);
  assert.equal(f.calls.find((call) => call.action === "import").imageUrl, image.srcUrl);
  assert.equal(f.state().activeId, "a");
});

test("the picker marks confirmed saves and supports several destinations without duplicating repeated clicks", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  const payload = { boardId: "b", session: f.state().session };
  const result = await Promise.all([inline(f, config, "send", payload), inline(f, config, "send", payload)]);
  assert.equal(result.every((value) => value.ok), true);
  await inline(f, config, "send", payload);
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  await inline(f, config, "send", { ...payload, boardId: "a" });
  const status = await inline(f, config, "status");
  assert.deepEqual(new Set(status.saved), new Set([JSON.stringify([f.state().session, "a"]), JSON.stringify([f.state().session, "b"])]));
  assert.equal(f.calls.filter((call) => call.action === "import").length, 2);
  assert.equal(f.windows.length, 0);
});

test("content-script access is limited to the selected request, tab, frame and document", async (t) => {
  const f = fixture(t), config = await openInline(f);
  const payload = { boardId: "b", session: f.state().session };
  const before = f.calls.length;
  for (const [message, sender] of [
    [{ ...payload, token: randomUUID() }, {}],
    [{ ...payload, id: randomUUID() }, {}],
    [payload, { tab: { id: 99 } }],
    [payload, { frameId: 4 }],
    [payload, { id: "another-extension" }],
  ]) assert.equal((await inline(f, config, "send", message, sender)).ok, false);
  assert.equal(f.calls.length, before);
  assert.equal((await inline(f, config, "status")).ok, true);
  const now = f.calls.length;
  assert.equal((await inline(f, config, "send", payload, { documentId: "new-navigation" })).ok, false);
  assert.equal(f.calls.length, now);
  await inline(f, config, "cancel");
  assert.equal((await inline(f, config, "send", payload)).ok, false);
});

test("closing the picker prevents further sends but never repeats or cancels a committed import", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  await inline(f, config, "send", { boardId: "b", session: f.state().session });
  await inline(f, config, "cancel");
  assert.equal((await f.connector.pageMessage({ action: "pending", id: config.id })).image, null);
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
});

test("an uncertain send cannot be retried from the inline picker or toolbar popup", async (t) => {
  const f = fixture(t), config = await openInline(f);
  f.setRoute((request) => request.action === "import" ? { ok: false, error: { code: "unknown_result", message: "保存先で結果を確認してください" } } : undefined);
  const payload = { boardId: "b", session: f.state().session };
  assert.equal((await inline(f, config, "send", payload)).code, "unknown_result");
  assert.equal((await inline(f, config, "send", payload)).code, "unknown_result");
  await assert.rejects(f.connector.pageMessage({ action: "send", id: config.id, ...payload }), { code: "unknown_result" });
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.equal((await inline(f, config, "status")).uncertain.length, 1);
});

test("successful imports stay successful when persisting the checkmark fails", async (t) => {
  const f = fixture(t), config = await openInline(f);
  await inline(f, config, "status");
  f.api.storage.session.set = async () => { throw new Error("Quota"); };
  const payload = { boardId: "b", session: f.state().session };
  assert.equal((await inline(f, config, "send", payload)).ok, true);
  assert.equal((await inline(f, config, "send", payload)).ok, true);
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.equal((await inline(f, config, "status")).saved.length, 1);
});

test("restricted pages fall back to the existing toolbar popup, never a separate window", async (t) => {
  const f = fixture(t, { restricted: true }), config = await openInline(f);
  assert.equal(f.windows.length, 0);
  assert.equal(f.popups.length, 1);
  const pending = await f.connector.pageMessage({ action: "pending" });
  assert.equal(pending.image.id, config.id);
  assert.equal(pending.image.imageUrl, image.srcUrl);
});

for (const browser of ["Chrome/Edge", "Zen"]) test(`${browser} expands destinations beside the native menu and preserves the saved-list order`, async (t) => {
  const f = fixture(t, { firefox: browser === "Zen" });
  await f.connector.refreshState();
  const entries = [...f.menus.values()].filter((entry) => entry.id.startsWith("board|"));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].parentId, "imagestorage-send");
  assert.equal(entries[1].parentId, "imagestorage-send");
  assert.equal(entries[0].id, `board|${f.state().session}|a`);
  assert.match(entries[0].title, /現在のリスト/);
  assert.match(entries[1].title, /資料 \/ 保存先/);
  assert.match(f.menus.get("imagestorage-send").title, /保存/);
  assert([...f.menus.values()].every(entry => JSON.stringify(entry.contexts) === JSON.stringify(["image", "link"])), "The root, destinations and creation action must all be available on image links");
  const unchangedRoot = f.menus.get("imagestorage-send");
  await f.connector.refreshState();
  assert.equal(f.menus.get("imagestorage-send"), unchangedRoot, "Polling unchanged destinations must not dismiss the open native menu");
  f.setState({ revision: 2, activeId: "b", boards: [{ id: "b", name: "変更した名前", groupName: "" }, { id: "a", name: "以前のリスト", groupName: "" }] });
  await f.connector.refreshState();
  assert.equal(f.connector.snapshot().boards[0].name, "変更した名前");
  assert.equal(f.connector.snapshot().activeId, "b");
  assert.equal([...f.menus.keys()].find((key) => key.startsWith("board|")), `board|${f.state().session}|b`);
  assert.equal(f.calls.every((call) => call.launch === false), true, "Discovery must never launch ImageStorage");
});

test("right-clicking a related Pinterest image sends that image to the chosen inactive list", async (t) => {
  const f = fixture(t);
  await f.connector.refreshState();
  await f.connector.clicked({ ...image, menuItemId: `board|${f.state().session}|b` }, { id: 22 });
  const imports = f.calls.filter((call) => call.action === "import");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].boardId, "b");
  assert.equal(imports[0].imageUrl, image.srcUrl, "Never substitute the large image from the currently open Pin");
  assert.equal(imports[0].sourceUrl, image.linkUrl);
  assert.equal(f.state().activeId, "a");
  assert.equal(Object.keys(f.values).length, 0);
  assert.equal(f.windows.length, 0);
  assert.equal(f.scripts.length, 0, "Choosing a native destination must not open an in-page picker");
  assert.equal(f.popups.length, 0);
});

test("a Pinterest grid link resolves its own image in the clicked frame and saves directly to the selected list", async (t) => {
  const f = fixture(t, { linkResult: { imageUrl: image.srcUrl } });
  await f.connector.refreshState();
  await f.connector.clicked({ ...image, srcUrl: undefined, menuItemId: `board|${f.state().session}|b` }, { id: 22 });
  const resolver = f.scripts.find(entry => entry.func.name === "resolveLinkedImage");
  assert.deepEqual(resolver.target, { tabId: 22, frameIds: [4] });
  assert.deepEqual(resolver.args, [image.linkUrl]);
  const imports = f.calls.filter(call => call.action === "import");
  assert.equal(imports.length, 1); assert.equal(imports[0].boardId, "b");
  assert.equal(imports[0].imageUrl, image.srcUrl); assert.equal(imports[0].sourceUrl, image.linkUrl);
  assert.equal(f.scripts.length, 1); assert.equal(f.windows.length, 0); assert.equal(f.popups.length, 0);
});

test("a linked grid image can create a new list through the same movable inline form", async (t) => {
  const f = fixture(t, { linkResult: { imageUrl: image.srcUrl } });
  f.connector.start(); await f.connector.refreshState();
  await f.connector.clicked({ ...image, srcUrl: undefined, menuItemId: "imagestorage-create" }, { id: 22 });
  const config = f.scripts.find(entry => entry.func.name === "showInlinePicker").args[0];
  assert.equal(config.mode, "create"); assert.equal(config.imageUrl, image.srcUrl);
  assert.equal(f.calls.some(call => call.action === "import" || call.launch), false);
  const result = await inline(f, config, "create", { name: "ボードからの資料", session: f.state().session });
  assert.equal(result.ok, true);
  assert.equal(f.calls.filter(call => call.action === "import").length, 1);
  assert.equal(f.calls.find(call => call.action === "import").imageUrl, image.srcUrl);
  assert.equal(f.windows.length, 0);
});

test("missing, inaccessible or unsafe linked images never import an unrelated page image or create an empty list", async (t) => {
  for (const options of [{}, { resolveError: true }, { linkResult: { imageUrl: "javascript:alert(1)" } }, { linkResult: { imageUrl: "file:///C:/private.png" } }]) {
    const f = fixture(t, options); await f.connector.refreshState();
    await f.connector.clicked({ ...image, srcUrl: undefined, menuItemId: `board|${f.state().session}|b` }, { id: 22 });
    await f.connector.clicked({ ...image, srcUrl: undefined, menuItemId: "imagestorage-create" }, { id: 22 });
    assert.equal(f.calls.some(call => call.action === "import" || call.launch), false);
    assert.equal(f.scripts.some(entry => entry.func.name === "showInlinePicker"), false);
    assert.equal(Object.keys(f.values).length, 0);
  }
});

test("opening the native parent menu does not open a chooser or send an image", async (t) => {
  const f = fixture(t);
  await f.connector.refreshState();
  const before = f.calls.length;
  await f.connector.clicked({ ...image, menuItemId: "imagestorage-send" }, { id: 22 });
  assert.equal(f.calls.length, before);
  assert.equal(f.scripts.length, 0);
  assert.equal(f.windows.length, 0);
  assert.equal(f.popups.length, 0);
  assert.equal(Object.keys(f.values).length, 0);
});

test("empty and disconnected submenu states expose the appropriate next action", async (t) => {
  const f = fixture(t);
  f.setState({ boards: [], activeId: "" });
  await f.connector.refreshState();
  assert.equal(f.menus.get("imagestorage-empty").enabled, false);
  assert.match(f.menus.get("imagestorage-create").title, /新規リスト/);
  assert.equal([...f.menus.values()].some((entry) => /検索/.test(entry.title || "")), false);
  f.setState({ ready: false });
  await f.connector.refreshState();
  assert.equal(f.menus.has("imagestorage-empty"), false);
  assert.match(f.menus.get("imagestorage-connect").title, /起動/);
  assert.equal([...f.menus.keys()].some((key) => key.startsWith("board|")), false);
});

test("native destinations preserve IDs containing Japanese and separator characters", async (t) => {
  const f = fixture(t);
  const id = "資料|画像/参考 %";
  f.setState({ boards: [{ id, name: "指定した保存先" }], activeId: id });
  await f.connector.refreshState();
  const menuId = [...f.menus.keys()].find((key) => key.startsWith("board|"));
  await f.connector.clicked({ ...image, menuItemId: menuId }, { id: 22 });
  assert.equal(f.calls.find((call) => call.action === "import").boardId, id);
  assert.equal(f.scripts.length, 0);
});

test("all lists remain selectable through native continuation submenus without search", async (t) => {
  const f = fixture(t);
  f.setState({ boards: Array.from({ length: 620 }, (_, index) => ({ id: `list-${index}`, name: `資料${index}` })), activeId: "list-400" });
  await f.connector.refreshState();
  assert.equal(f.connector.snapshot().boards.length, 620);
  assert.equal([...f.menus.keys()].filter((key) => key.startsWith("board|")).length, 620);
  assert.equal(f.menus.has("imagestorage-pick"), false);
  assert.equal(f.menus.get(`board|${f.state().session}|list-619`).parentId, `page|${f.state().session}|600`);
  await f.connector.clicked({ ...image, menuItemId: `board|${f.state().session}|list-619` }, { id: 22 });
  assert.equal(f.windows.length, 0);
  assert.equal(f.scripts.length, 0);
  assert.equal(f.calls.find((call) => call.action === "import").boardId, "list-619");
});

test("a stale menu does not silently change the destination to the current project", async (t) => {
  const f = fixture(t);
  await f.connector.refreshState();
  const previousSession = f.state().session;
  f.setState({ session: randomUUID() });
  f.setRoute((request, state) => request.action === "import" && request.session !== state.session ? { ok: false, error: { code: "stale_list", message: "保存先を選び直してください" } } : undefined);
  await f.connector.clicked({ ...image, menuItemId: `board|${previousSession}|b` }, { id: 22 });
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.equal(f.windows.length, 0);
  const pending = Object.entries(f.values).find(([key]) => key.startsWith("pending:"))[1];
  assert.match(pending.error, /保存先を選び直して/);
  assert.equal(f.scripts[0].func.name, "showInlinePicker");
});

test("session-only image fallback requests original bytes in the clicked frame without canvas re-encoding", async (t) => {
  const f = fixture(t);
  let imports = 0;
  f.setRoute((request) => request.action === "import" && ++imports === 1 ? { ok: false, error: { code: "download_failed", message: "Browser session required" } } : undefined);
  await f.connector.refreshState();
  await f.connector.clicked({ ...image, menuItemId: `board|${f.state().session}|b` }, { id: 22 });
  assert.equal(f.scripts.length, 1);
  assert.deepEqual(f.scripts[0].target, { tabId: 22, frameIds: [4] });
  assert.equal(f.scripts[0].args[0], image.srcUrl);
  const sent = f.calls.filter((call) => call.action === "import");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].imageUrl, "data:image/png;base64,b3JpZ2luYWwtYnl0ZXM=");
  assert.notEqual(sent[0].importId, sent[1].importId);
  assert.equal(f.windows.length, 0);
});

test("an unknown import result never triggers a second automatic image import", async (t) => {
  const f = fixture(t);
  f.setRoute((request) => request.action === "import" ? { ok: false, error: { code: "unknown_result", message: "保存先で結果を確認してください" } } : undefined);
  await f.connector.refreshState();
  await f.connector.clicked({ ...image, menuItemId: `board|${f.state().session}|b` }, { id: 22 });
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.equal(f.scripts[0].func.name, "showInlinePicker");
  assert.equal(f.windows.length, 0);
});

test("extension pages can request lists but websites and other extensions cannot invoke native messaging", async (t) => {
  const f = fixture(t); f.connector.start();
  await f.connector.refreshState();
  const listener = f.api.runtime.onMessage.listeners[0];
  const baseline = f.calls.length;
  assert.equal(listener({ action: "status", launch: true }, { id: "connector-id", url: "https://untrusted.test" }, () => assert.fail()), false);
  assert.equal(listener({ action: "status", launch: true }, { id: "different-extension", url: f.api.runtime.getURL("chooser.html") }, () => assert.fail()), false);
  assert.equal(f.calls.length, baseline);
  const result = await new Promise((resolve) => {
    assert.equal(listener({ action: "status", launch: true }, { id: "connector-id", url: f.api.runtime.getURL("chooser.html") }, resolve), true);
  });
  assert.equal(result.state.ready, true);
  assert.equal(f.calls.every((call) => ["list", "import"].includes(call.action)), true);
});

test("shipping manifests keep the Chromium ID stable and use Zen-compatible background scripts", async () => {
  const identity = JSON.parse(await fs.readFile(new URL("../browser-extension/identity.json", import.meta.url), "utf8"));
  const chrome = JSON.parse(await fs.readFile(new URL("../browser-extension/dist/chromium/manifest.json", import.meta.url), "utf8"));
  const zen = JSON.parse(await fs.readFile(new URL("../browser-extension/dist/zen/manifest.json", import.meta.url), "utf8"));
  const calculated = createHash("sha256").update(Buffer.from(chrome.key, "base64")).digest("hex").slice(0, 32).replace(/[0-9a-f]/g, (character) => String.fromCharCode(97 + parseInt(character, 16)));
  assert.equal(calculated, identity.chromiumId);
  assert.deepEqual(chrome.background, { service_worker: "background.js", type: "module" });
  assert.deepEqual(zen.background, { scripts: ["background.js"], type: "module" });
  assert.equal(zen.browser_specific_settings.gecko.id, identity.firefoxId);
  assert.deepEqual(zen.browser_specific_settings.gecko.data_collection_permissions.required, ["websiteContent", "browsingActivity"]);
  for (const manifest of [chrome, zen]) {
    assert.equal(manifest.version, "0.4.4");
    assert.equal(manifest.host_permissions, undefined);
    assert.deepEqual(manifest.content_scripts, [{ matches: ["http://*/*", "https://*/*"], js: ["linked-image-content.js", "context-position.js", "pinterest-board-context-content.js"], run_at: "document_start", all_frames: true, match_about_blank: true }]);
    assert.equal(manifest.permissions.includes("cookies"), false);
    assert.equal(manifest.permissions.includes("history"), false);
  }
  for (const platform of ["chromium", "zen"]) {
    const source = await fs.readFile(new URL(`../browser-extension/dist/${platform}/background.js`, import.meta.url), "utf8");
    assert.match(source, /import \{ showInlinePicker \} from "\.\/inline-picker\.js"/);
    assert.doesNotMatch(source, /windows\.create/);
    await fs.access(new URL(`../browser-extension/dist/${platform}/inline-picker.js`, import.meta.url));
  }
});

test("new-list creation prompts for a name before sending the clicked image exactly once", async (t) => {
  const f = fixture(t), config = await openInline(f, "imagestorage-create");
  assert.equal(config.mode, "create");
  assert.equal(f.calls.some((call) => call.action === "import"), false);
  const payload = { name: "  資料まとめ  ", session: f.state().session };
  const [first, duplicate] = await Promise.all([inline(f, config, "create", payload), inline(f, config, "create", payload)]);
  assert.equal(first.ok, true); assert.deepEqual(duplicate, first);
  assert.deepEqual(await inline(f, config, "create", { ...payload, name: "別の名前" }), first);
  const sent = f.calls.filter((call) => call.action === "import");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].newBoardName, "資料まとめ");
  assert.equal(sent[0].boardId, undefined);
  assert.equal(sent[0].imageUrl, image.srcUrl);
  assert.equal(first.boardId, `board-${sent[0].importId}`);
  assert.equal((await inline(f, config, "status")).createdBoard.name, "資料まとめ");
});

test("cancel and invalid names never create a list or import an image", async (t) => {
  const f = fixture(t), config = await openInline(f, "imagestorage-create");
  for (const name of ["", "  ", "a".repeat(121), "line\nbreak", "nul\0value"]) {
    const result = await inline(f, config, "create", { name, session: f.state().session });
    assert.equal(result.code, "invalid_name");
  }
  await inline(f, config, "cancel");
  assert.equal((await inline(f, config, "create", { name: "キャンセル済み", session: f.state().session })).ok, false);
  assert.equal(f.calls.some((call) => call.action === "import"), false);
});

test("offline creation starts the app only on submit and uses its newly loaded session", async (t) => {
  const f = fixture(t);
  f.setRoute((request) => request.action === "list" ? { ok: false, error: { code: "not_running", message: "Closed" } } : undefined);
  f.connector.start();
  await f.connector.refreshState().catch(() => {});
  await f.connector.clicked({ ...image, menuItemId: "imagestorage-create" }, { id: 22 });
  const config = f.scripts.find((entry) => entry.func.name === "showInlinePicker").args[0];
  await inline(f, config, "status");
  assert(f.calls.every((call) => call.launch === false), "Form opening launched the app");
  const newSession = randomUUID();
  f.setRoute((request) => {
    if (request.action === "list" && request.launch) { f.setState({ session: newSession }); return { ok: true, state: { ...f.state(), nextOffset: null } }; }
  });
  const results = await Promise.all([inline(f, config, "create", { name: "閉じていても保存" }), inline(f, config, "create", { name: "閉じていても保存" })]);
  assert(results.every((result) => result.ok));
  assert.equal(f.calls.filter((call) => call.launch).length, 1);
  const imports = f.calls.filter((call) => call.action === "import");
  assert.equal(imports.length, 1); assert.equal(imports[0].session, newSession); assert.equal(imports[0].launch, false);
});

test("old apps, wrong project sessions, and ordinary save requests cannot create a list", async (t) => {
  const f = fixture(t), config = await openInline(f, "imagestorage-create");
  assert.equal((await inline(f, config, "create", { name: "新規", session: randomUUID() })).code, "stale_list");
  f.setState({ capabilities: undefined }); await f.connector.refreshState();
  assert.equal((await inline(f, config, "create", { name: "新規", session: f.state().session })).code, "update_required");
  assert.equal(f.calls.some((call) => call.action === "import"), false);
  const regular = fixture(t), normal = await openInline(regular);
  assert.equal((await inline(regular, normal, "create", { name: "新規", session: regular.state().session })).code, "invalid_request");
});

test("an uncertain creation cannot be repeated from either menu form", async (t) => {
  const f = fixture(t), config = await openInline(f, "imagestorage-create");
  f.setRoute((request) => request.action === "import" ? { ok: false, error: { code: "unknown_result", message: "作成結果を確認してください" } } : undefined);
  const payload = { name: "新規", session: f.state().session };
  assert.equal((await inline(f, config, "create", payload)).code, "unknown_result");
  assert.equal((await inline(f, config, "create", payload)).code, "unknown_result");
  await assert.rejects(f.connector.pageMessage({ action: "create", id: config.id, ...payload }), { code: "unknown_result" });
  assert.equal(f.calls.filter((call) => call.action === "import").length, 1);
  assert.equal((await inline(f, config, "status")).creationUncertain, true);
});

test("creation uses browser image bytes only after a proven download failure", async (t) => {
  const f = fixture(t), config = await openInline(f, "imagestorage-create");
  let imports = 0;
  f.setRoute((request) => request.action === "import" && ++imports === 1 ? { ok: false, error: { code: "download_failed", message: "Use browser session" } } : undefined);
  const result = await inline(f, config, "create", { name: "画像付きリスト", session: f.state().session });
  assert.equal(result.ok, true);
  const sent = f.calls.filter((call) => call.action === "import");
  assert.equal(sent.length, 2);
  assert.equal(sent[1].newBoardName, "画像付きリスト");
  assert.equal(sent[1].imageUrl, "data:image/png;base64,b3JpZ2luYWwtYnl0ZXM=");
  assert.equal(sent[1].boardId, undefined);
  assert.notEqual(sent[0].importId, sent[1].importId);
});
