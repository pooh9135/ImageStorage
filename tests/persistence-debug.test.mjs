import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { savedBackupPaths, hasTransientSources } from "../desktop/storage-tools.cjs";

const mainText = await readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8");
const main = ts.createSourceFile("main.cjs", mainText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

// Run the production event handlers against a fake clock and IPC boundary.
// No Electron instance or real user-data directory is opened by these tests.
function installHandler(context, target, event, name) {
  let handler;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(main) === target &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === event) {
      assert.equal(handler, undefined, `Duplicate ${target}(${event}) handler`);
      handler = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  }
  visit(main);
  assert.ok(handler, `Missing production handler: ${target}(${event})`);
  vm.runInContext(`globalThis.${name} = ${handler.getText(main)};`, context);
}

function installFunction(context, name) {
  const declaration = main.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `Missing production function: ${name}`);
  vm.runInContext(declaration.getText(main), context);
}

test("a second instance exits before initialization and the original instance is restored and focused", async () => {
  let quits = 0, initialized = 0, created = 0;
  const context = vm.createContext({
    app: { requestSingleInstanceLock: () => false, quit() { quits++; } },
    installRuntimeDiagnostics() { initialized++; }, createWindow() { created++; },
  });
  const lock = main.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(main) === "primaryInstance"));
  const gate = main.statements[main.statements.indexOf(lock) + 1];
  vm.runInContext(lock.getText(main) + "\n" + gate.getText(main), context);
  assert.equal(quits, 1); assert.equal(initialized, 0);
  const ready = main.statements.find((node) => ts.isExpressionStatement(node) && node.getText(main).startsWith("app.whenReady().then"));
  vm.runInContext(`globalThis.ready = ${ready.expression.arguments[0].getText(main)}`, context);
  await context.ready();
  assert.equal(created, 0);
  let restored = 0, shown = 0, focused = 0;
  context.mainWindow = { isDestroyed: () => false, isMinimized: () => true,
    restore() { restored++; }, show() { shown++; }, focus() { focused++; } };
  installHandler(context, "app.on", "second-instance", "secondInstance");
  context.extensionBackgroundMode = true;
  context.secondInstance({}, ["ImageStorage.exe", "--imagestorage-extension"]);
  assert.equal(shown, 0); assert.equal(focused, 0);
  assert.equal(context.extensionBackgroundMode, true);
  context.secondInstance();
  assert.equal(restored, 1); assert.equal(shown, 1); assert.equal(focused, 1);
  assert.equal(context.extensionBackgroundMode, false);
});

function restoreContext() {
  const calls = [];
  const webContents = {};
  const context = vm.createContext({
    Error, mainWindow: { webContents }, restoringBackup: false, closeRequestPending: false,
    analysisWindows: new Map(), projectGeneration: 7, currentProjectPath: "current.imagestorage",
    storageTools: {
      async readBackup() { calls.push("read"); return { format: "museboard", restored: true }; },
      async createBackup(data, reason) { calls.push({ data, reason }); },
    },
    async drainPendingWrites() { calls.push("drain"); },
    async queueRecoverySnapshot(data) { calls.push({ recovery: data }); return { saved: true }; },
  });
  installFunction(context, "storageRequest");
  installHandler(context, "ipcMain.handle", "storage:restore-backup", "restoreBackup");
  installHandler(context, "ipcMain.on", "storage:restore-complete", "completeRestore");
  installHandler(context, "ipcMain.handle", "project:auto-save", "autoSave");
  return { context, calls, event: { sender: webContents } };
}

test("restore protects current lists before replacement and blocks stale autosave until renderer acknowledgement", async () => {
  const { context, calls, event } = restoreContext();
  const current = { currentLists: "unsaved work" };
  const result = await context.restoreBackup(event, {}, current);
  assert.equal(result.data.restored, true);
  assert.deepEqual(calls.slice(0, 3), ["read", "drain", { data: current, reason: "before-restore" }]);
  assert.equal(calls[3].recovery.restored, true);
  assert.equal(context.projectGeneration, 8);
  assert.equal(context.currentProjectPath, null);
  assert.equal((await context.autoSave(event, { stale: true })).saved, false);
  assert.equal(calls.length, 4);
  context.completeRestore({ sender: {} });
  assert.equal(context.restoringBackup, true);
  context.completeRestore(event);
  assert.equal(context.restoringBackup, false);
  await context.autoSave(event, { fresh: true });
  assert.equal(calls.at(-1).recovery.fresh, true);
});

test("failed safety backup or an open editor prevents restoring over current lists", async () => {
  const { context, calls, event } = restoreContext();
  context.storageTools.createBackup = async () => { throw new Error("ENOSPC"); };
  assert.match((await context.restoreBackup(event, {}, {})).error, /ENOSPC/);
  assert.equal(context.projectGeneration, 7);
  assert.equal(context.currentProjectPath, "current.imagestorage");
  assert.equal(context.restoringBackup, false);
  assert.equal(calls.some((call) => call?.recovery), false);
  context.analysisWindows.set("open", { isDestroyed: () => false });
  const count = calls.length;
  assert.match((await context.restoreBackup(event, {}, {})).error, /editor/);
  assert.equal(calls.length, count);
});

test("folder exports remain in the close-drained write queue and a failure allows the next export", async () => {
  const context = vm.createContext({ projectSaveQueue: Promise.resolve(), recoveryWriteQueue: Promise.resolve() });
  installFunction(context, "queueStorageWrite"); installFunction(context, "drainPendingWrites");
  let finish;
  const exporting = context.queueStorageWrite(() => new Promise((resolve) => { finish = resolve; }));
  let drained = false;
  const closing = context.drainPendingWrites().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  finish(); await exporting; await closing;
  assert.equal(drained, true);
  await assert.rejects(context.queueStorageWrite(async () => { throw new Error("Disk full"); }), /Disk full/);
  assert.equal(await context.queueStorageWrite(async () => "retry"), "retry");
});

function closeContext(save) {
  let nextTimer = 1;
  const timers = new Map();
  const calls = { close: 0, requested: 0, saves: 0, errors: [] };
  const context = vm.createContext({
    Error,
    closeApproved: false,
    closeRequestPending: false,
    closeRecoveryPending: false,
    closeFallbackTimer: null,
    analysisWindows: new Map(), editorCloseNoticePending: false, restoringBackup: false,
    projectSaveQueue: Promise.resolve(),
    recoveryWriteQueue: Promise.resolve(),
    mainWindow: {
      close() { calls.close += 1; },
      webContents: { send(channel) { assert.equal(channel, "app:request-close"); calls.requested += 1; } },
    },
    setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    queueRecoverySnapshot(data) { calls.saves += 1; return save(data); },
    dialog: { showErrorBox(title, message) { calls.errors.push({ title, message }); } },
  });
  installFunction(context, "drainPendingWrites");
  installHandler(context, "mainWindow.on", "close", "requestClose");
  installHandler(context, "ipcMain.on", "window:close-ready", "completeClose");
  return {
    context, calls, timers,
    request() { context.requestClose({ preventDefault() {} }); },
    runTimers() {
      return Promise.all([...timers].map(([id, timer]) => {
        timers.delete(id);
        return timer.callback();
      }));
    },
  };
}

test("acknowledged close waits for recovery even beyond the renderer timeout", async () => {
  let resolveSave;
  const save = new Promise((resolve) => { resolveSave = resolve; });
  const state = closeContext(() => save);
  state.request();
  assert.equal(state.timers.size, 1);
  const finishing = state.context.completeClose({}, { format: "museboard" });
  try {
    assert.equal(state.timers.size, 0, "renderer timeout must stop before awaiting disk writes");
    state.runTimers();
    assert.equal(state.calls.close, 0);
    assert.equal(state.context.closeApproved, false);
  } finally {
    resolveSave({ saved: true, error: null });
    await finishing;
  }
  assert.equal(state.calls.close, 1);
  assert.equal(state.context.closeApproved, true);
});

test("recovery failure keeps the window open and allows a later close retry", async () => {
  let succeeds = false;
  const state = closeContext(async () => succeeds
    ? { saved: true, error: null }
    : { saved: false, error: "ENOSPC: no space left on device" });
  state.request();
  await state.context.completeClose({}, { format: "museboard" });
  state.runTimers();
  assert.equal(state.calls.close, 0);
  assert.equal(state.context.closeApproved, false);
  assert.equal(state.context.closeRequestPending, false);
  assert.equal(state.calls.errors.length, 1);
  assert.match(state.calls.errors[0].message, /ENOSPC/);
  succeeds = true;
  state.request();
  await state.context.completeClose({}, { format: "museboard" });
  assert.equal(state.calls.close, 1);
  assert.equal(state.calls.saves, 2);
});

test("a rejected recovery write is handled without closing or leaking an IPC rejection", async () => {
  const state = closeContext(async () => { throw new Error("EACCES: recovery directory unavailable"); });
  state.request();
  await assert.doesNotReject(state.context.completeClose({}, { format: "museboard" }));
  state.runTimers();
  assert.equal(state.calls.close, 0);
  assert.equal(state.context.closeRequestPending, false);
  assert.equal(state.context.closeRecoveryPending, false);
  assert.match(state.calls.errors[0].message, /EACCES/);
});

test("repeated close requests and duplicate acknowledgements do not queue duplicate writes", async () => {
  let resolveSave;
  const save = new Promise((resolve) => { resolveSave = resolve; });
  const state = closeContext(() => save);
  state.request();
  state.request();
  const first = state.context.completeClose({}, { format: "museboard" });
  const second = state.context.completeClose({}, { format: "museboard" });
  try {
    assert.equal(state.calls.requested, 1);
    assert.equal(state.calls.saves, 1);
    state.runTimers();
    assert.equal(state.calls.close, 0);
  } finally {
    resolveSave({ saved: true, error: null });
    await Promise.all([first, second]);
  }
  assert.equal(state.calls.close, 1);
});

test("disabling recovery still closes without creating a snapshot", async () => {
  const state = closeContext(async () => { throw new Error("unexpected save"); });
  state.request();
  await state.context.completeClose({}, { skipRecovery: true });
  assert.equal(state.calls.saves, 0);
  assert.equal(state.calls.close, 1);
  assert.equal(state.timers.size, 0);
});

test("main-window close waits for image editors instead of orphaning their Save operation", async () => {
  const state = closeContext(async () => ({ saved: true }));
  let focused = 0, notices = 0;
  state.context.dialog.showMessageBox = async () => { notices++; };
  state.context.analysisWindows.set("image", { isDestroyed: () => false, isMinimized: () => false,
    show() {}, focus() { focused++; } });
  state.request(); state.request();
  assert.equal(focused, 2);
  assert.equal(notices, 1, "Repeated close clicks must not open duplicate dialogs");
  assert.equal(state.calls.requested, 0);
  assert.equal(state.timers.size, 0);
  assert.equal(state.calls.close, 0);
  await Promise.resolve();
  state.context.analysisWindows.clear();
  state.request();
  await state.context.completeClose({}, { format: "museboard" });
  assert.equal(state.calls.close, 1);
});

test("closing also waits for an already requested portable project save", async () => {
  let finishProjectSave;
  const state = closeContext(async () => ({ saved: true }));
  state.context.projectSaveQueue = new Promise((resolve) => { finishProjectSave = resolve; });
  state.request();
  const finishing = state.context.completeClose({}, { skipRecovery: true });
  await Promise.resolve();
  try {
    state.runTimers();
    assert.equal(state.calls.close, 0);
  } finally {
    finishProjectSave();
    await finishing;
  }
  assert.equal(state.calls.close, 1);
});

test("the no-acknowledgement fallback drains both existing write queues", async () => {
  const state = closeContext(async () => { throw new Error("renderer did not acknowledge"); });
  let finishProjectSave;
  let finishRecoverySave;
  state.context.projectSaveQueue = new Promise((resolve) => { finishProjectSave = resolve; });
  state.context.recoveryWriteQueue = new Promise((resolve) => { finishRecoverySave = resolve; });
  state.request();
  const finishing = state.runTimers();
  await Promise.resolve();
  assert.equal(state.calls.close, 0);
  assert.equal(state.context.closeRecoveryPending, true);
  finishProjectSave();
  await Promise.resolve();
  assert.equal(state.calls.close, 0, "the remaining autosave must also finish");
  finishRecoverySave();
  await finishing;
  assert.equal(state.calls.saves, 0);
  assert.equal(state.calls.close, 1);
});

test("skipRecovery still waits for autosaves started before the setting was disabled", async () => {
  const state = closeContext(async () => { throw new Error("new recovery is disabled"); });
  let finishRecoverySave;
  state.context.recoveryWriteQueue = new Promise((resolve) => { finishRecoverySave = resolve; });
  state.request();
  const finishing = state.context.completeClose({}, { skipRecovery: true });
  await Promise.resolve();
  assert.equal(state.calls.close, 0);
  finishRecoverySave();
  await finishing;
  assert.equal(state.calls.saves, 0);
  assert.equal(state.calls.close, 1);
});

test("a write queued while close is draining is included before the final close", async () => {
  const state = closeContext(async () => ({ saved: true }));
  let finishFirstSave;
  state.context.recoveryWriteQueue = new Promise((resolve) => { finishFirstSave = resolve; });
  state.request();
  const finishing = state.context.completeClose({}, { skipRecovery: true });
  let finishNextSave;
  state.context.recoveryWriteQueue = state.context.recoveryWriteQueue.then(() =>
    new Promise((resolve) => { finishNextSave = resolve; }),
  );
  finishFirstSave();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(state.calls.close, 0);
  finishNextSave();
  await finishing;
  assert.equal(state.calls.close, 1);
});

const magic = Buffer.from("IMAGESTORAGE_PROJECT_V3\n");

async function projectContext(t, overrides = {}) {
  const root = fileURLToPath(new URL("../work/debug-0.15.1/", import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(root, "regression-"));
  assert.equal(path.dirname(fixture), path.resolve(root));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const fileA = path.join(fixture, "A.imagestorage");
  const fileB = path.join(fixture, "B.imagestorage");
  const context = vm.createContext({
    fs, fsSync, path, process, Buffer, randomUUID, pipeline, Error,
    // Fix the timestamp to exercise requests within a single millisecond.
    Date: { now: () => 12345 },
    projectGeneration: 0, projectSaveQueue: Promise.resolve(), analysisWindows: new Map(), restoringBackup: false,
    closeRecoveryPending: false, currentProjectPath: fileA, mainWindow: {},
    PORTABLE_PROJECT_MAGIC: magic, PORTABLE_PROJECT_LENGTH_BYTES: 8,
    MAX_PROJECT_MANIFEST_BYTES: 32 * 1024 * 1024,
    validProjectSnapshot: () => true,
    async preparePortableProject(data) {
      const temporaryDirectory = await fs.mkdtemp(path.join(fixture, "prepare-"));
      return { manifest: data, payloads: [], temporaryDirectory };
    },
    loadProjectFile: async () => ({ name: "B" }),
    dialog: {
      showOpenDialog: async () => ({ canceled: false, filePaths: [fileB] }),
      showMessageBox: async () => {},
    },
    ...overrides,
  });
  for (const name of ["uiLanguage", "uiText", "replaceFileSafely", "writePortableProject", "saveProjectSnapshot", "closeImageAnalysisWindows"]) installFunction(context, name);
  installHandler(context, "ipcMain.handle", "project:save", "saveProject");
  installHandler(context, "ipcMain.handle", "project:open", "openProject");
  const readManifest = async (target) => {
    const content = await fs.readFile(target);
    assert.ok(content.subarray(0, magic.length).equals(magic));
    const length = Number(content.readBigUInt64BE(magic.length));
    assert.equal(content.length, magic.length + 8 + length);
    return JSON.parse(content.subarray(magic.length + 8).toString("utf8"));
  };
  return { context, fixture, fileA, fileB, readManifest };
}

test("simultaneous save requests write sequentially and retain the newest complete file", async (t) => {
  const { context, fileA, readManifest } = await projectContext(t);
  const prepare = context.preparePortableProject;
  let active = 0;
  let maximumActive = 0;
  context.preparePortableProject = async (data) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const result = await prepare(data);
    active -= 1;
    return result;
  };
  await fs.writeFile(fileA, "previous saved project");
  const results = await Promise.all([
    context.saveProject({}, { name: "first" }),
    context.saveProject({}, { name: "second" }),
  ]);
  assert.ok(results.every((result) => !result.canceled));
  assert.equal(maximumActive, 1);
  assert.deepEqual(await readManifest(fileA), { name: "second" });
});

test("opening B during an A save preserves both files and cancels queued snapshots from A", async (t) => {
  const { context, fileA, fileB, readManifest } = await projectContext(t);
  const prepare = context.preparePortableProject;
  let announceStarted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  let finishFirstSave;
  const blocked = new Promise((resolve) => { finishFirstSave = resolve; });
  context.preparePortableProject = async (data) => {
    if (data.name === "saved A") { announceStarted(); await blocked; }
    return prepare(data);
  };
  await fs.writeFile(fileA, "previous A");
  await fs.writeFile(fileB, "previous B");
  const savingA = context.saveProject({}, { name: "saved A" });
  await started;
  const staleA = context.saveProject({}, { name: "queued A" });
  await context.openProject();
  assert.equal(context.currentProjectPath, fileB);
  const savingB = context.saveProject({}, { name: "saved B" });
  finishFirstSave();
  const results = await Promise.all([savingA, staleA, savingB]);
  assert.equal(results[0].canceled, false);
  assert.equal(results[1].canceled, true);
  assert.equal(results[2].canceled, false);
  assert.equal(context.currentProjectPath, fileB);
  assert.deepEqual(await readManifest(fileA), { name: "saved A" });
  assert.deepEqual(await readManifest(fileB), { name: "saved B" });
});

test("opening another project while the save dialog is pending cancels its stale snapshot", async (t) => {
  const { context, fileA, fileB } = await projectContext(t, { currentProjectPath: null });
  let announceDialog;
  const started = new Promise((resolve) => { announceDialog = resolve; });
  let resolveDialog;
  context.dialog.showSaveDialog = () => {
    announceDialog();
    return new Promise((resolve) => { resolveDialog = resolve; });
  };
  const pending = context.saveProject({}, { name: "unsaved A" });
  await started;
  await context.openProject();
  resolveDialog({ canceled: false, filePath: fileA });
  assert.equal((await pending).canceled, true);
  assert.equal(context.currentProjectPath, fileB);
  assert.equal(fsSync.existsSync(fileA), false);
});

function recoveryProject(name) {
  return {
    format: "museboard", activeId: "board", version: 2,
    boards: [{ id: "board", name, viewport: { x: 0, y: 0, scale: 1 }, items: [] }],
  };
}

async function recoveryContext(t) {
  const state = await projectContext(t);
  Object.assign(state.context, {
    Date,
    recoveryDirectory: path.join(state.fixture, "recovery"),
    autoSavePath: path.join(state.fixture, "recovery", "autosave.json"),
    recoveryWriteQueue: Promise.resolve(),
    hasTransientSources,
    scheduleAssetCleanup() {},
  });
  state.context.ensureStorageDirectories = () => fs.mkdir(state.context.recoveryDirectory, { recursive: true });
  for (const name of ["validProjectSnapshot", "writeJsonAtomically", "saveRecoverySnapshot", "queueRecoverySnapshot", "recoverySnapshotPaths", "loadRecoverySnapshot"]) {
    installFunction(state.context, name);
  }
  return state;
}

test("corrupted latest recovery falls back to the previous complete snapshot", async (t) => {
  const { context } = await recoveryContext(t);
  assert.equal((await context.queueRecoverySnapshot(recoveryProject("previous"))).saved, true);
  assert.equal((await context.queueRecoverySnapshot(recoveryProject("latest"))).saved, true);
  await fs.writeFile(context.autoSavePath, "{interrupted JSON");
  const loaded = await context.loadRecoverySnapshot();
  assert.equal(loaded.found, true);
  assert.equal(loaded.recoveredFromBackup, true);
  assert.equal(loaded.data.boards[0].name, "previous");
});

test("autosave rejects session-only image sources without replacing the last usable recovery", async (t) => {
  const { context } = await recoveryContext(t);
  await context.queueRecoverySnapshot(recoveryProject("last good"));
  const data = recoveryProject("bad image");
  data.boards[0].items.push({ id: "i", type: "image", src: "blob:temporary", x: 0, y: 0, w: 30, h: 40, z: 1 });
  const result = await context.queueRecoverySnapshot(data);
  assert.equal(result.saved, false);
  assert.match(result.error, /incomplete/);
  assert.equal((await context.loadRecoverySnapshot()).data.boards[0].name, "last good");
});

test("an unavailable recovery directory does not poison later queued saves", async (t) => {
  const { context } = await recoveryContext(t);
  const ensureStorageDirectories = context.ensureStorageDirectories;
  context.ensureStorageDirectories = async () => { throw new Error("temporary EACCES"); };
  const failed = await context.queueRecoverySnapshot(recoveryProject("failed"));
  assert.equal(failed.saved, false);
  assert.match(failed.error, /EACCES/);
  context.ensureStorageDirectories = ensureStorageDirectories;
  assert.equal((await context.queueRecoverySnapshot(recoveryProject("retried"))).saved, true);
  const loaded = await context.loadRecoverySnapshot();
  assert.equal(loaded.found, true);
  assert.equal(loaded.data.boards[0].name, "retried");
});

test("opening another project closes and unregisters its old image editors", async (t) => {
  const { context } = await projectContext(t);
  let closed = 0;
  context.analysisWindows.set("shared-image-id", {
    isDestroyed: () => false,
    close() { closed += 1; },
  });
  assert.equal((await context.openProject()).canceled, false);
  assert.equal(context.projectGeneration, 1);
  assert.equal(closed, 1);
  assert.equal(context.analysisWindows.size, 0);
});

test("image edits are accepted only from the registered window in the current project", () => {
  const sender = {};
  const editor = {
    webContents: sender, __projectGeneration: 2,
    __imageAnalysisPayload: { itemId: "shared-image-id" }, isDestroyed: () => false,
  };
  const sent = [];
  const context = vm.createContext({
    projectGeneration: 2,
    analysisWindows: new Map([["shared-image-id", editor]]),
    mainWindow: { isDestroyed: () => false, webContents: { send(channel, value) { sent.push({ channel, value }); } } },
  });
  installHandler(context, "ipcMain.on", "image-analysis:update", "updateAnalysis");
  const payload = { itemId: "shared-image-id", analysis: { preset: "golden", strokes: [] } };
  context.updateAnalysis({ sender: {} }, payload);
  assert.equal(sent.length, 0, "a previous editor cannot send through a new same-ID editor");
  editor.__projectGeneration = 1;
  context.updateAnalysis({ sender }, payload);
  assert.equal(sent.length, 0, "an old project generation cannot modify the new project");
  editor.__projectGeneration = 2;
  context.updateAnalysis({ sender }, payload);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "image-analysis:updated");
  assert.equal(editor.__imageAnalysisPayload.analysis, payload.analysis);
  context.analysisWindows.clear();
  context.updateAnalysis({ sender }, payload);
  assert.equal(sent.length, 1, "an unregistered window cannot forward an edit");
});

test("a late old-editor closed event does not remove a newly opened same-ID editor", () => {
  const oldEditor = {};
  const newEditor = {};
  const context = vm.createContext({
    analysisWindow: oldEditor, payload: { itemId: "shared-image-id" },
    analysisWindows: new Map([["shared-image-id", newEditor]]),
  });
  installHandler(context, "analysisWindow.on", "closed", "editorClosed");
  context.editorClosed();
  assert.equal(context.analysisWindows.get("shared-image-id"), newEditor);
  context.analysisWindows.set("shared-image-id", oldEditor);
  context.editorClosed();
  assert.equal(context.analysisWindows.size, 0);
});

test("image editor initialization rejects stale generations and unregistered windows", () => {
  const editor = { __projectGeneration: 1, __imageAnalysisPayload: { itemId: "shared-image-id" } };
  const context = vm.createContext({
    projectGeneration: 2,
    analysisWindows: new Map([["shared-image-id", editor]]),
    BrowserWindow: { fromWebContents: () => editor },
  });
  installHandler(context, "ipcMain.handle", "image-analysis:get-init", "getAnalysisInit");
  assert.equal(context.getAnalysisInit({ sender: {} }), null);
  editor.__projectGeneration = 2;
  assert.equal(context.getAnalysisInit({ sender: {} }), editor.__imageAnalysisPayload);
  context.analysisWindows.clear();
  assert.equal(context.getAnalysisInit({ sender: {} }), null);
});

async function globalBackgroundContext(t) {
  const state = await recoveryContext(t);
  Object.assign(state.context, {
    fileURLToPath,
    savedBackupPaths, mainWindow: null,
    assetDirectory: path.join(state.fixture, "assets"),
    assetCleanupStatePath: path.join(state.fixture, "recovery", "asset-cleanup-state.json"),
    globalBackgroundPath: path.join(state.fixture, "global-background.json"),
    globalBackgroundAssetReferences: { fileNames: new Set(), fallbackAssetIds: new Set() },
    assetCleanupRunning: false,
    lastAssetCleanupAt: 0,
    DEFAULT_ASSET_CLEANUP_GRACE_MS: 7 * 24 * 60 * 60 * 1000,
    process: { env: { IMAGESTORAGE_CLEANUP_GRACE_MS: "0" } },
  });
  for (const name of ["ensureStorageDirectories", "normalizeGlobalBackgroundReference", "collectGlobalBackgroundReference",
    "queueGlobalBackground", "assetIdFromFileName", "assetIdFromSource", "collectReferencedAssetFiles",
    "readCleanupState", "collectRecoveryAssetReferences", "cleanupUnusedAssets", "drainPendingWrites"]) {
    installFunction(state.context, name);
  }
  installHandler(state.context, "ipcMain.handle", "settings:save-global-background", "saveGlobalBackground");
  await state.context.ensureStorageDirectories();
  state.reference = (id) => ({
    backgroundImageSrc: pathToFileURL(path.join(state.context.assetDirectory, `image-${id}.webp`)).href,
    backgroundImageThumbnailSrc: pathToFileURL(path.join(state.context.assetDirectory, `thumbnail-${id}.webp`)).href,
    backgroundImageAssetId: id,
  });
  return state;
}

test("asset cleanup never deletes live-session, Undo or draft assets absent from recovery", async (t) => {
  const { context } = await globalBackgroundContext(t);
  await context.queueRecoverySnapshot(recoveryProject("empty on disk"));
  const file = path.join(context.assetDirectory, "image-only-in-undo.webp");
  await fs.writeFile(file, "live asset");
  context.mainWindow = {};
  assert.equal((await context.cleanupUnusedAssets()).reason, "active-session");
  assert.equal(fsSync.existsSync(file), true);
  context.mainWindow = null;
  context.analysisWindows.set("image", {});
  assert.equal((await context.cleanupUnusedAssets()).reason, "active-session");
  assert.equal(fsSync.existsSync(file), true);
});

test("startup cleanup protects all named backup assets and fails closed for unreadable backups", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  await context.queueRecoverySnapshot(recoveryProject("latest"));
  const old = reference("manual-old-asset");
  const file = fileURLToPath(old.backgroundImageSrc);
  await fs.writeFile(file, "backup only");
  const data = recoveryProject("checkpoint");
  data.boards[0].headerImageSrc = old.backgroundImageSrc;
  const backup = path.join(context.recoveryDirectory, "snapshots", "backup-test.json");
  await context.writeJsonAtomically(backup, JSON.stringify(data));
  assert.equal((await context.cleanupUnusedAssets()).deletedFiles, 0);
  assert.equal(fsSync.existsSync(file), true);
  await fs.writeFile(backup, "{broken");
  const result = await context.cleanupUnusedAssets();
  assert.equal(result.reason, "unreadable-backup");
  assert.equal(fsSync.existsSync(file), true);
});

test("global background persistence stores only its reference fields and clearing creates no autosave", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  const expected = reference("background-one");
  assert.equal((await context.saveGlobalBackground({}, { ...expected, language: "ja", boards: ["ignored"] })).saved, true);
  assert.deepEqual(JSON.parse(await fs.readFile(context.globalBackgroundPath, "utf8")), { version: 1, reference: expected });
  assert.equal(fsSync.existsSync(context.autoSavePath), false, "Saving preferences must not enable project recovery");
  assert.equal((await context.saveGlobalBackground({}, { backgroundImageSrc: 42 })).saved, false);
  assert.deepEqual(JSON.parse(await fs.readFile(context.globalBackgroundPath, "utf8")).reference, expected);
  assert.equal((await context.saveGlobalBackground({}, null)).saved, true);
  assert.deepEqual(JSON.parse(await fs.readFile(context.globalBackgroundPath, "utf8")), { version: 1, reference: {} });
  assert.equal(context.globalBackgroundAssetReferences.fileNames.size, 0);
});

test("global background writes are serialized and the existing close drain waits for their latest value", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  const write = context.writeJsonAtomically;
  let started, release;
  const firstStarted = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  context.writeJsonAtomically = async (...args) => {
    calls += 1;
    if (calls === 1) { started(); await blocked; }
    return write(...args);
  };
  const first = context.saveGlobalBackground({}, reference("background-first"));
  await firstStarted;
  const second = context.saveGlobalBackground({}, reference("background-second"));
  let drained = false;
  const drain = context.drainPendingWrites().then(() => { drained = true; });
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  assert.equal(drained, false);
  assert.equal(context.globalBackgroundAssetReferences.fileNames.has("image-background-second.webp"), true);
  release();
  assert.ok((await Promise.all([first, second])).every(result => result.saved));
  await drain;
  assert.deepEqual(JSON.parse(await fs.readFile(context.globalBackgroundPath, "utf8")).reference, reference("background-second"));
});

test("cleanup protects a persisted global background absent from all recovery boards, including after restart", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  await context.queueRecoverySnapshot(recoveryProject("Unrelated imported project"));
  const current = reference("background-current");
  const orphan = path.join(context.assetDirectory, "image-background-orphan.webp");
  for (const target of [fileURLToPath(current.backgroundImageSrc), fileURLToPath(current.backgroundImageThumbnailSrc), orphan]) await fs.writeFile(target, "fixture");
  await context.saveGlobalBackground({}, current);
  context.globalBackgroundAssetReferences = { fileNames: new Set(), fallbackAssetIds: new Set() };
  const result = await context.cleanupUnusedAssets();
  assert.equal(result.deletedFiles, 1);
  assert.equal(fsSync.existsSync(orphan), false);
  assert.equal(fsSync.existsSync(fileURLToPath(current.backgroundImageSrc)), true);
  assert.equal(fsSync.existsSync(fileURLToPath(current.backgroundImageThumbnailSrc)), true);
  await context.saveGlobalBackground({}, {});
  assert.equal((await context.cleanupUnusedAssets()).deletedFiles, 2, "Explicitly clearing the preference releases its references");
});

test("cleanup falls back to an atomic sidecar previous file and skips deletion when both copies are unreadable", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  await context.queueRecoverySnapshot(recoveryProject("Old recovery"));
  const current = reference("background-backup");
  await fs.writeFile(fileURLToPath(current.backgroundImageSrc), "fixture");
  await fs.writeFile(context.globalBackgroundPath, "{interrupted");
  await fs.writeFile(`${context.globalBackgroundPath}.previous`, JSON.stringify({ version: 1, reference: current }));
  assert.equal((await context.cleanupUnusedAssets()).deletedFiles, 0);
  await fs.writeFile(`${context.globalBackgroundPath}.previous`, "invalid");
  const result = await context.cleanupUnusedAssets();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "unreadable-global-background");
  assert.equal(fsSync.existsSync(fileURLToPath(current.backgroundImageSrc)), true);
});

test("a global background selected while cleanup awaits stat remains protected", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  await context.queueRecoverySnapshot(recoveryProject("Old recovery"));
  const current = reference("background-racing");
  const target = fileURLToPath(current.backgroundImageSrc);
  await fs.writeFile(target, "fixture");
  context.fs = { ...fs, async stat(filePath) {
    const result = await fs.stat(filePath);
    if (filePath === target) await context.saveGlobalBackground({}, current);
    return result;
  } };
  const result = await context.cleanupUnusedAssets();
  assert.equal(result.deletedFiles, 0);
  assert.equal(fsSync.existsSync(target), true);
});

test("a failed global background write reports the error, keeps live protection and permits retry", async (t) => {
  const { context, reference } = await globalBackgroundContext(t);
  const write = context.writeJsonAtomically;
  context.writeJsonAtomically = async () => { throw Error("EACCES fixture"); };
  const failed = await context.saveGlobalBackground({}, reference("background-retry"));
  assert.equal(failed.saved, false);
  assert.match(failed.error, /EACCES/);
  assert.equal(context.globalBackgroundAssetReferences.fileNames.has("image-background-retry.webp"), true);
  context.writeJsonAtomically = write;
  assert.equal((await context.saveGlobalBackground({}, reference("background-retry"))).saved, true);
  await context.drainPendingWrites();
  assert.equal(JSON.parse(await fs.readFile(context.globalBackgroundPath, "utf8")).reference.backgroundImageAssetId, "background-retry");
});
