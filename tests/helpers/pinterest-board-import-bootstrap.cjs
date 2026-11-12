/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");
const sharp = require("sharp");
const assert = require("node:assert/strict");
const output = process.argv.find(value => value.startsWith("--board-file-test-dir="))?.slice("--board-file-test-dir=".length);
if (!output) throw new Error("Isolated output required");
const profile = path.join(output, "profile"), bridge = path.join(output, "bridge");
fs.mkdirSync(path.join(profile, "recovery"), { recursive: true }); fs.mkdirSync(bridge);
process.env.IMAGESTORAGE_TEST_USER_DATA = profile; process.env.IMAGESTORAGE_EXTENSION_CONFIG_DIR = bridge;
delete process.env.MUSEBOARD_DEV_SERVER_URL; app.disableHardwareAcceleration(); app.getAppPath = () => __filename;
process.argv.push("--imagestorage-extension");
let window, selectedFile, allowLast = false, defer = false, releaseDownload, deferredStarted = false;
const requests = [], cases = [], png = new Map();
const autosave = path.join(profile, "recovery", "autosave.json"), file = path.join(output, "board.json"), invalid = path.join(output, "invalid.json");
let initial;
app.on("browser-window-created", (_event, created) => { for (const name of ["show", "showInactive", "focus"]) created[name] = () => {}; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source) { return window.webContents.executeJavaScript(`(async()=>{${source}})()`); }
async function waitFor(source, timeout = 8000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await evaluate(`return Boolean(${source});`)) return; await sleep(30); } throw new Error(`Timed out: ${source}`); }
async function open() {
  await evaluate("document.querySelector('.sidebar-create-menu').click()");
  await waitFor("[...document.querySelectorAll('[role=menuitem]')].some(button=>/Import board file|ボードファイルを読み込む/.test(button.textContent))");
  await evaluate("[...document.querySelectorAll('[role=menuitem]')].find(button=>/Import board file|ボードファイルを読み込む/.test(button.textContent)).click()");
}
async function button(text) { await evaluate(`const button=[...document.querySelectorAll('.pinterest-board-import-dialog button')].find(button=>button.textContent===${JSON.stringify(text)});if(!button)throw new Error('Missing button');button.click();`); }
async function finish(error) {
  fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ ok: !error, error, cases, visibleWindows: BrowserWindow.getAllWindows().filter(win => win.isVisible()).length, requests }, null, 2)); app.exit(error ? 1 : 0);
}
const deadline = setTimeout(() => { void finish("QA deadline"); }, 50000);
void (async () => {
  try {
    for (const [index, color] of ["#496771", "#755448", "#53714a"].entries()) png.set(String(index + 1), await sharp({ create: { width: 141 + index, height: 193 + index, channels: 4, background: color } }).png().toBuffer());
    const existingFile = path.join(output, "existing.png"); fs.writeFileSync(existingFile, png.get("1"));
    initial = { format: "museboard", version: 2, savedAt: new Date().toISOString(), activeId: "a", boards: ["a", "b"].map(id => ({ id, name: `Existing ${id}`, viewport: { x: 30, y: 20, scale: 1 }, frames: [], items: id === "a" ? [{ id: "keep", type: "image", src: pathToFileURL(existingFile).href, x: 40, y: 70, w: 333, h: 210, z: 1 }] : [] })) };
    fs.writeFileSync(autosave, JSON.stringify(initial));
    const pins = [1, 2, 3].map(index => ({ pinUrl: `https://www.pinterest.com/pin/${index}/`, imageUrl: `https://i.pinimg.com/236x/aa/bb/cc/${String(index).repeat(32)}.png`, title: `資料 ${index}`, width: 100, height: 200 }));
    fs.writeFileSync(file, JSON.stringify({ format: "imagestorage-pinterest-board", version: 1, board: { name: "ファイルからの資料", url: "https://www.pinterest.com/tester/references/" }, pins: [...pins, { ...pins[0], imageUrl: pins[0].imageUrl.replace("236x", "originals") }] }));
    fs.writeFileSync(invalid, "invalid JSON"); selectedFile = invalid;
    dialog.showOpenDialog = async (_parent, options) => { assert.match(options.title, /^(Import board file|ボードファイルを読み込む|导入图板文件|보드 파일 가져오기)$/); return { canceled: false, filePaths: [selectedFile] }; };
    global.fetch = async value => {
      const url = String(value), id = url.match(/\/([123])\1{31}\.png$/)?.[1];
      if (!id || !url.startsWith("https://i.pinimg.com/")) throw new Error("Unexpected network request");
      requests.push(url);
      if (defer) { deferredStarted = true; await new Promise(resolve => { releaseDownload = resolve; }); }
      if (id === "3" && !allowLast) return new Response("missing", { status: 404 });
      return new Response(png.get(id), { headers: { "content-type": "image/png" } });
    };
    require("../../desktop/main.cjs"); await app.whenReady();
    for (let attempt = 0; attempt < 200 && !BrowserWindow.getAllWindows().length; attempt++) await sleep(30);
    window = BrowserWindow.getAllWindows()[0]; if (!window) throw new Error("No app window");
    await waitFor("document.querySelector('.sidebar-create-menu') && document.body.textContent.includes('Existing a')");
    await open(); await waitFor("document.body.textContent.includes('JSON形式')"); assert.equal(requests.length, 0);
    assert.equal(await evaluate("return Boolean(document.querySelector('.pinterest-board-import-dialog'))"), false); cases.push("invalid files are rejected before downloading or changing lists");
    selectedFile = file; await open(); await waitFor("document.querySelector('.pinterest-board-import-dialog')");
    assert.equal(await evaluate("return document.querySelector('.pinterest-board-import-dialog input').value"), "ファイルからの資料");
    assert.equal(requests.length, 0); cases.push("preview reports the board name and deduplicated count without downloading");
    await button("取り込む"); await waitFor("document.querySelector('.pinterest-board-import-results')?.textContent.includes('失敗 1枚')");
    assert.equal(JSON.parse(fs.readFileSync(autosave)).boards.length, 2);
    await window.webContents.capturePage(undefined, { stayHidden: true }); await sleep(100); fs.writeFileSync(path.join(output, "import-partial.png"), (await window.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    cases.push("partial failures keep the staged images without creating a partial list");
    const beforeRetry = requests.length; allowLast = true; await button("失敗した画像を再試行");
    await waitFor("!document.querySelector('.pinterest-board-import-dialog') && document.body.textContent.includes('ファイルからの資料')");
    const end = Date.now() + 9000; let saved;
    do { saved = JSON.parse(fs.readFileSync(autosave)); if (saved.boards.length === 3) break; await sleep(50); } while (Date.now() < end);
    assert.equal(saved.boards.length, 3); const imported = saved.boards.find(board => board.name === "ファイルからの資料"); assert.equal(imported.items.length, 3);
    assert(requests.slice(beforeRetry).every(url => url.includes("3".repeat(32))), "Retry downloaded successful images again");
    for (const item of imported.items) { const index = item.sourceUrl.match(/\/pin\/(\d+)\//)[1]; assert(fs.readFileSync(fileURLToPath(item.src)).equals(png.get(index)), "Original bytes changed"); assert.equal(item.originalImageUrl, pins[Number(index) - 1].imageUrl); }
    for (const key of ["x", "y", "w", "h", "src"]) assert.equal(saved.boards.find(board => board.id === "a").items[0][key], initial.boards[0].items[0][key]);
    assert.equal(new Set(imported.items.map(item => item.id)).size, 3); cases.push("retry saves only missing images and commits one list with original bytes and existing geometry intact");
    defer = true; await open(); await waitFor("document.querySelector('.pinterest-board-import-dialog')"); await button("取り込む");
    for (let attempt = 0; attempt < 100 && !deferredStarted; attempt++) await sleep(20);
    assert(deferredStarted); const beforeCancel = requests.length; await button("中止");
    await waitFor("!document.querySelector('.pinterest-board-import-dialog')"); defer = false; releaseDownload(); await sleep(700);
    assert.equal(requests.length, beforeCancel); assert.equal(JSON.parse(fs.readFileSync(autosave)).boards.length, 3); cases.push("cancelling during a download stops the remaining queue and creates no list");
    await open(); await waitFor("document.querySelector('.pinterest-board-import-dialog')"); const beforePreviewCancel = requests.length; await button("キャンセル");
    await waitFor("!document.querySelector('.pinterest-board-import-dialog')"); assert.equal(requests.length, beforePreviewCancel); assert.equal(JSON.parse(fs.readFileSync(autosave)).boards.length, 3); cases.push("cancelling preview performs no download and preserves existing lists");
    fs.writeFileSync(file, JSON.stringify({ format: "imagestorage-pinterest-board", version: 2, board: { name: "同じ画像の別ピン", url: "https://www.pinterest.com/tester/references/" }, pins: [pins[0], { ...pins[0], pinUrl: "https://www.pinterest.com/pin/222/" }] }));
    await open(); await waitFor("document.querySelector('.pinterest-board-import-dialog')"); const beforeShared = requests.length; await button("取り込む");
    await waitFor("!document.querySelector('.pinterest-board-import-dialog') && document.body.textContent.includes('同じ画像の別ピン')");
    const sharedEnd = Date.now() + 9000; let shared;
    do { shared = JSON.parse(fs.readFileSync(autosave)).boards.find(board => board.name === "同じ画像の別ピン"); if (shared) break; await sleep(50); } while (Date.now() < sharedEnd);
    assert.equal(shared.items.length, 2); assert.equal(new Set(shared.items.map(item => item.sourceUrl)).size, 2); assert.equal(shared.items[0].src, shared.items[1].src); assert.equal(requests.length - beforeShared, 1);
    cases.push("version 2 preserves distinct Pins sharing a source while downloading the image once");
    clearTimeout(deadline); await finish(null);
  } catch (error) { clearTimeout(deadline); await finish(String(error.stack || error)); }
})();
