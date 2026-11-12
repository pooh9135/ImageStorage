import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

async function source(file) {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.JS);
}

const [page, editor, main, titlebar] = await Promise.all([
  source("../app/page.tsx"), source("../app/ImageAnalysisWindow.tsx"), source("../desktop/main.cjs"),
  source("../desktop/src/NativeTitlebar.tsx"),
]);

// Execute the real callbacks with mocked state/IPC boundaries; do not copy the
// implementation into tests or start Electron against the user's profile.
function install(context, file, name, contains) {
  let found;
  function visit(node) {
    if (found) return;
    if ((ts.isVariableDeclaration(node) && node.name.getText(file) === name) ||
        (ts.isFunctionDeclaration(node) && node.name?.text === name)) {
      if (!contains || node.getText(file).includes(contains)) found = node;
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `Missing production callback: ${name}`);
  let text;
  if (ts.isFunctionDeclaration(found)) text = found.getText(file).replace(/^export\s+/, "");
  else {
    let expression = found.initializer;
    if (ts.isCallExpression(expression) && ["useCallback", "useMemo"].includes(expression.expression.getText(file))) {
      expression = expression.arguments[0];
    }
    text = `globalThis.${name} = ${expression.getText(file)};`;
  }
  vm.runInContext(ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function nativePointerContext({ cursor = { x: -1350, y: 180 }, zoom = 1, visible = true, minimized = false, destroyed = false } = {}) {
  const sent = [];
  const bounds = { x: -1500, y: 80, width: 1000, height: 740 };
  const context = vm.createContext({
    screen: { getCursorScreenPoint: () => cursor }, titlebarVisible: false,
    TITLEBAR_REVEAL_HEIGHT: 8, TITLEBAR_VISIBLE_HEIGHT: 38,
    mainWindow: {
      isDestroyed: () => destroyed, isVisible: () => visible, isMinimized: () => minimized,
      getContentBounds: () => bounds, getBounds: () => bounds,
      webContents: { isDestroyed: () => false, getZoomFactor: () => zoom, send: (...args) => sent.push(args) },
    },
  });
  for (const name of ["getWindowPointerPosition", "setTitlebarVisibility", "updateTitlebarVisibilityFromCursor"]) install(context, main, name);
  return { context, sent };
}

test("native cursor positions match CSS pixels at normal and enlarged Chromium zoom on a negative-coordinate monitor", () => {
  for (const zoom of [1, 1.25, 2]) {
    const { context } = nativePointerContext({ zoom });
    assert.deepEqual(plain(context.getWindowPointerPosition()), { clientX: 150 / zoom, clientY: 100 / zoom });
  }
});

test("native cursor positions distinguish actual window departure, hidden windows, and minimized windows", () => {
  for (const options of [
    { cursor: { x: -1501, y: 180 } }, { cursor: { x: -500, y: 180 } },
    { cursor: { x: -1350, y: 820 } }, { visible: false }, { minimized: true }, { destroyed: true },
  ]) assert.equal(nativePointerContext(options).context.getWindowPointerPosition(), null);
  assert.deepEqual(plain(nativePointerContext({ cursor: { x: -1500, y: 80 } }).context.getWindowPointerPosition()), { clientX: 0, clientY: 0 });
});

test("the existing native pointer poll publishes cursor coordinates independently of DOM hover events", () => {
  const { context, sent } = nativePointerContext({ zoom: 2 });
  context.updateTitlebarVisibilityFromCursor();
  assert.deepEqual(plain(sent), [["window:pointer-position", { clientX: 75, clientY: 50 }]]);
});

test("the preload bridge delivers native cursor updates and releases its listener on unsubscribe", async () => {
  const text = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
  let api, listener;
  const invoked = [], removed = [], updates = [];
  const context = vm.createContext({
    process: { argv: [] },
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } }, webUtils: {},
      ipcRenderer: {
        invoke: async channel => { invoked.push(channel); return { clientX: 120, clientY: 200 }; },
        on: (channel, value) => { listener = { channel, value }; },
        removeListener: (channel, value) => removed.push({ channel, value }),
      },
    }),
  });
  vm.runInContext(text, context);
  assert.deepEqual(plain(await api.getWindowPointerPosition()), { clientX: 120, clientY: 200 });
  assert.deepEqual(invoked, ["window:get-pointer-position"]);
  const remove = api.onWindowPointerPosition(position => updates.push(position));
  assert.equal(listener.channel, "window:pointer-position");
  listener.value({}, { clientX: 140, clientY: 220 }); listener.value({}, null);
  assert.deepEqual(updates, [{ clientX: 140, clientY: 220 }, null]);
  remove(); assert.deepEqual(removed, [listener]);
});

const board = (id) => ({ id, name: id, viewport: { x: 0, y: 0, scale: 1 }, items: [] });
const project = (boards) => ({ format: "museboard", version: 2, activeId: boards[0].id, boards });

function installGuideMigration(context) {
  for (const name of ["DEFAULT_GUIDE_COLOR", "migrateAnalysisGuideColor", "migrateBoardAnalysisGuides"]) install(context, editor, name);
}

test("opening another project clears both history directions", () => {
  const context = vm.createContext({
    structuredClone,
    boardsRef: { current: [board("A")] }, activeIdRef: { current: "A" }, projectGenerationRef: { current: 0 },
    undoStackRef: { current: [] }, redoStackRef: { current: [] },
    historyAvailability: { undo: false, redo: false },
    workspaceFilter: null, collapsedGroups: new Set(),
    showListManager: true, listManagerDraft: [{ id: "A", name: "Unsaved name" }], pendingDeleteBoardId: "A",
    listManagerSessionRef: { current: 1 }, listManagerBaseRef: { current: [] }, headerImageRequestRef: { current: 0 },
    setHeaderImageDraft() {}, setHeaderImageError() {},
    endListManagerDrag() {},
    listManagerPreviewDragRef: { current: null },
    setSelectedIds() {}, setSelectionMarquee() {}, setItemContextMenu() {},
  });
  context.setBoards = (value) => { context.boards = value; context.boardsRef.current = value; };
  context.setActiveId = (value) => { context.activeId = value; };
  for (const [setter, field] of Object.entries({
    setHistoryAvailability: "historyAvailability", setWorkspaceFilter: "workspaceFilter", setCollapsedGroups: "collapsedGroups",
    setShowListManager: "showListManager", setListManagerDraft: "listManagerDraft", setPendingDeleteBoardId: "pendingDeleteBoardId",
  })) context[setter] = (value) => { context[field] = typeof value === "function" ? value(context[field]) : value; };
  installGuideMigration(context);
  for (const name of ["recordUndoSnapshot", "undoLastChange", "redoLastChange", "closeListManager", "handleProjectLoad"]) install(context, page, name);
  context.recordUndoSnapshot();
  assert.deepEqual(plain(context.historyAvailability), { undo: true, redo: false });
  context.setBoards([{ ...board("A"), name: "Edited A" }]);
  context.undoLastChange();
  assert.equal(context.redoStackRef.current.length, 1);
  assert.deepEqual(plain(context.historyAvailability), { undo: false, redo: true });
  context.workspaceFilter = "Previous project space";
  context.collapsedGroups = new Set(["Previous project space"]);
  const imported = project([
    { ...board("B"), items: [{ id: "old-guide", analysis: { preset: "thirds", gridVisible: false, guideColor: "#2aa8ef", strokes: [] } }] },
    { ...board("C"), items: [{ id: "new-guide", analysis: { preset: "thirds", gridVisible: false, guideColor: "#2aa8ef", guideColorVersion: 1, strokes: [] } }] },
  ]);
  context.handleProjectLoad({ detail: imported });
  context.redoLastChange();
  assert.equal(context.boards[0].id, "B");
  assert.equal(context.activeIdRef.current, "B");
  assert.equal(context.undoStackRef.current.length, 0);
  assert.equal(context.redoStackRef.current.length, 0);
  assert.deepEqual(plain(context.historyAvailability), { undo: false, redo: false });
  assert.equal(context.workspaceFilter, null);
  assert.equal(context.collapsedGroups.size, 0);
  assert.equal(context.showListManager, false);
  assert.equal(context.listManagerDraft.length, 0);
  assert.equal(context.pendingDeleteBoardId, null);
  assert.equal(context.boards[0].items[0].analysis.guideColor, "#ff0000");
  assert.equal(context.boards[0].items[0].analysis.guideColorVersion, 1);
  assert.equal(context.boards[1].items[0].analysis.guideColor, "#2aa8ef");
  assert.equal(imported.boards[0].items[0].analysis.guideColor, "#2aa8ef", "Opening keeps the imported source snapshot immutable");
});

for (const storage of ["autosave", "localStorage"]) {
  test(`${storage} restoration migrates guides on inactive lists before any edit or save`, async () => {
    const restored = [board("A"), { ...board("B"), items: [{ id: "image-B", analysis: {
      preset: "thirds", gridVisible: false, guideColor: "#2aa8ef", strokes: [],
    } }] }];
    const values = new Map([["boards", JSON.stringify(restored)], ["active", "A"], ["aligned", "complete"], ["starter-version", "test"]]);
    const context = vm.createContext({
      canceled: false, activeIdRef: { current: "A" }, boardsRef: { current: [board("starter")] },
      initialSettingsRef: { current: { reopenPreviousBoard: true, startupSidebar: "open" } },
      STORAGE_KEY: "boards", ACTIVE_KEY: "active", ALIGNED_LAYOUT_KEY: "aligned", STARTER_VERSION_KEY: "starter-version", STARTER_VERSION: "test",
      starterBoards: [board("starter")], isLegacyUntitledStarter: () => false,
      localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      window: { museboardDesktop: { loadAutosave: async () => storage === "autosave" ? { found: true, data: project(restored) } : { found: false } } },
      setSettings() {}, setSidebarCollapsed() {}, setSidebarPeekOpen() {}, setImportNotice() {},
    });
    context.setBoards = (value) => { context.boards = value; };
    context.setActiveId = (value) => { context.activeId = value; };
    context.setHydrated = (value) => { context.hydrated = value; };
    installGuideMigration(context);
    for (const name of [
      "STARTER_GUIDE_COPY", "LEGACY_JAPANESE_STARTER_COPY", "LEGACY_STARTER_GUIDES",
      "migrateStarterGuides", "hydrate",
    ]) install(context, page, name);
    await context.hydrate();
    assert.equal(context.hydrated, true);
    assert.equal(context.activeId, "A");
    assert.equal(context.boardsRef.current, context.boards);
    assert.equal(context.boards[1].items[0].analysis.guideColor, "#ff0000");
    assert.equal(context.boards[1].items[0].analysis.guideColorVersion, 1);
    assert.equal(restored[1].items[0].analysis.guideColor, "#2aa8ef");
  });
}

function keyboardContext() {
  const context = vm.createContext({
    showSettings: false, showLibrary: false, showBoardGrouping: false, showListManager: false, showShortcuts: false,
    showCommandPalette: false, sidebarMenu: null, storageBusy: false, boardFileImport: null,
    imageInfoDraft: null, headerImageDraft: null, pendingDeleteBoardId: null,
    selectedId: "image-A", selectedIds: ["image-A"], selectedItem: { id: "image-A", type: "image" },
    calls: [], spacePressedRef: { current: false },
    document: { body: { classList: { add() {}, remove() {} } } },
  });
  for (const name of ["deleteSelected", "addSticky", "rotateImage", "duplicateItem", "undoLastChange", "redoLastChange", "toggleSidebar", "addImageFiles", "addImageUrl"]) {
    context[name] = () => context.calls.push(name);
  }
  for (const [setter, field] of Object.entries({
    setShowSettings: "showSettings", setShowLibrary: "showLibrary", setShowBoardGrouping: "showBoardGrouping",
    setShowShortcuts: "showShortcuts", setImageInfoDraft: "imageInfoDraft", setHeaderImageDraft: "headerImageDraft",
    setShowCommandPalette: "showCommandPalette", setSidebarMenu: "sidebarMenu", setShowListManager: "showListManager",
    setPendingDeleteBoardId: "pendingDeleteBoardId", setSelectedIds: "selectedIds",
    setBoardFileImport: "boardFileImport",
    setSelectionMarquee: "selectionMarquee", setItemContextMenu: "itemContextMenu",
  })) context[setter] = (value) => { context[field] = value; };
  context.closeSettingsPage = () => { context.showSettings = false; };
  context.closeListManager = () => { context.showListManager = false; };
  context.cancelHeaderImageEditor = () => { context.headerImageDraft = null; };
  install(context, page, "modalInteractionBlocked");
  install(context, page, "canvasShortcutsBlocked");
  install(context, page, "handleKeyDown", "deleteSelected");
  install(context, page, "handlePaste");
  return context;
}

const keyEvent = (key, extra = {}) => ({
  key, code: key, target: { tagName: "BUTTON", isContentEditable: false },
  ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...extra,
});

test("data management operations block canvas edits and Escape cannot close the settings mid-operation", () => {
  const context = keyboardContext();
  context.storageBusy = true;
  context.showSettings = true;
  install(context, page, "modalInteractionBlocked");
  install(context, page, "canvasShortcutsBlocked");
  context.handleKeyDown(keyEvent("Delete"));
  context.handleKeyDown(keyEvent("z", { ctrlKey: true }));
  context.handleKeyDown(keyEvent("Escape"));
  assert.deepEqual(context.calls, []);
  assert.equal(context.showSettings, true);
  assert.equal(context.storageBusy, true);
});

test("every modal blocks canvas keyboard/paste actions, and Escape cancels it", () => {
  const cases = [
    ...["showSettings", "showLibrary", "showBoardGrouping", "showListManager", "showShortcuts", "imageInfoDraft", "headerImageDraft", "pendingDeleteBoardId", "showCommandPalette", "boardFileImport"].map((field) => [field, true]),
    ["sidebarMenu", "main"],
    ["sidebarMenu", "create"],
  ];
  for (const [field, value] of cases) {
    const context = keyboardContext();
    context[field] = value;
    install(context, page, "modalInteractionBlocked");
    install(context, page, "canvasShortcutsBlocked");
    for (const key of ["Delete", "Backspace", "n", "r"]) context.handleKeyDown(keyEvent(key));
    context.handleKeyDown(keyEvent(" ", { code: "Space" }));
    for (const modifier of ["ctrlKey", "metaKey"]) {
      for (const key of ["z", "d", "b", "k"]) context.handleKeyDown(keyEvent(key, { [modifier]: true }));
      context.handleKeyDown(keyEvent("z", { [modifier]: true, shiftKey: true }));
    }
    context.handlePaste({ target: { tagName: "BUTTON" }, clipboardData: { files: [{}] }, preventDefault() {} });
    context.handlePaste({ target: { tagName: "BUTTON" }, clipboardData: { files: [], getData: () => "https://example.com/reference.png" }, preventDefault() {} });
    assert.deepEqual(context.calls, [], `${field}=${value}`);
    assert.equal(context.spacePressedRef.current, false);
    context.handleKeyDown(keyEvent("Escape"));
    assert.ok(!context[field], `${field} must close on Escape`);
    assert.deepEqual(context.selectedIds, ["image-A"], "Closing an overlay must keep the canvas selection");
  }
  const canvas = keyboardContext();
  for (const modifier of ["ctrlKey", "metaKey", "altKey"]) canvas.handleKeyDown(keyEvent("n", { [modifier]: true }));
  assert.deepEqual(canvas.calls, [], "Modified N must not create a note");
  canvas.handleKeyDown(keyEvent("Delete"));
  canvas.handleKeyDown(keyEvent("n"));
  assert.deepEqual(canvas.calls, ["deleteSelected", "addSticky"]);
});

test("command search opens by shortcut and restores canvas actions after Escape", () => {
  const context = keyboardContext();
  context.handleKeyDown(keyEvent("k", { ctrlKey: true }));
  assert.equal(context.showCommandPalette, true);
  install(context, page, "modalInteractionBlocked");
  install(context, page, "canvasShortcutsBlocked");
  context.handleKeyDown(keyEvent("Delete"));
  context.handlePaste({ target: { tagName: "INPUT" }, clipboardData: { files: [{}] }, preventDefault() {} });
  assert.deepEqual(context.calls, []);

  context.handleKeyDown(keyEvent("Escape", { target: { tagName: "INPUT" } }));
  assert.equal(context.showCommandPalette, false);
  install(context, page, "modalInteractionBlocked");
  install(context, page, "canvasShortcutsBlocked");
  context.handleKeyDown(keyEvent("Delete"));
  context.handlePaste({ target: { tagName: "BUTTON" }, clipboardData: { files: [{}] }, preventDefault() {} });
  assert.deepEqual(context.calls, ["deleteSelected", "addImageFiles"]);
});

test("Escape closes only deletion confirmation before the list manager and leaves settings intact", () => {
  const context = keyboardContext();
  context.showSettings = true;
  context.showListManager = true;
  context.pendingDeleteBoardId = "a";
  const refresh = () => {
    install(context, page, "modalInteractionBlocked");
    install(context, page, "canvasShortcutsBlocked");
  };
  refresh();
  context.handleKeyDown(keyEvent("Escape"));
  assert.equal(context.pendingDeleteBoardId, null);
  assert.equal(context.showListManager, true);
  assert.equal(context.showSettings, true);
  refresh();
  context.handleKeyDown(keyEvent("Escape"));
  assert.equal(context.showListManager, false);
  assert.equal(context.showSettings, true);
  refresh();
  context.handleKeyDown(keyEvent("Escape"));
  assert.equal(context.showSettings, false);
});

test("Escape returns from a nested header editor to the list manager before dismissing the manager", () => {
  const context = keyboardContext();
  context.showListManager = true;
  context.headerImageDraft = { boardId: "b", managerSession: 2 };
  install(context, page, "modalInteractionBlocked");
  install(context, page, "canvasShortcutsBlocked");
  context.handleKeyDown(keyEvent("Escape"));
  assert.equal(context.headerImageDraft, null);
  assert.equal(context.showListManager, true);
  context.handleKeyDown(keyEvent("Escape"));
  assert.equal(context.showListManager, false);
});

test("native project shortcuts respect open overlays and previously handled events", () => {
  let modalOpen = true;
  const calls = [];
  const context = vm.createContext({
    emitSaveRequest: () => calls.push("save"),
    openProject: () => calls.push("open"),
    document: {
      querySelector(selector) {
        assert.equal(selector, '.app-shell[data-canvas-shortcuts-blocked="true"], .app-shell[data-modal-open="true"]');
        return modalOpen ? {} : null;
      },
    },
  });
  install(context, titlebar, "handleKeyDown", "openProject");
  const projectKey = (key, modifier, defaultPrevented = false) => keyEvent(key, {
    [modifier]: true,
    defaultPrevented,
    prevented: 0,
    preventDefault() { this.defaultPrevented = true; this.prevented += 1; },
  });

  for (const modifier of ["ctrlKey", "metaKey"]) {
    for (const key of ["s", "O"]) {
      const event = projectKey(key, modifier);
      context.handleKeyDown(event);
      assert.equal(event.defaultPrevented, true, `${modifier}+${key} is suppressed while a modal is open`);
    }
  }
  assert.deepEqual(calls, []);

  modalOpen = false;
  for (const key of ["s", "o"]) context.handleKeyDown(projectKey(key, "ctrlKey", true));
  assert.deepEqual(calls, [], "A shortcut already handled by an editor must not reach project IPC");

  for (const modifier of ["ctrlKey", "metaKey"]) {
    for (const key of ["s", "o"]) {
      const event = projectKey(key, modifier);
      context.handleKeyDown(event);
      context.handleKeyDown(event);
      assert.equal(event.prevented, 1, "The same keyboard event must not execute twice");
    }
  }
  assert.deepEqual(calls, ["save", "open", "save", "open"]);
  const undo = projectKey("z", "ctrlKey");
  context.handleKeyDown(undo);
  assert.equal(undo.defaultPrevented, false, "Other canvas shortcuts remain available");
});

function editorContext() {
  const context = vm.createContext({
    structuredClone,
    localStorage: { getItem: () => JSON.stringify({ preset: "none", gridVisible: false, guideColor: "#0000ff" }) },
    window: { requestAnimationFrame: (fn) => fn(), setTimeout() {} },
    initializedRef: { current: false }, activeStrokeRef: { current: null }, strokeSessionRef: { current: null },
    analysisRef: { current: null }, undoStackRef: { current: [] }, redoStackRef: { current: [] },
    savedAnalysisRef: { current: "" },
    desktop: { close() {} },
  });
  context.setAnalysis = (update) => { context.analysis = typeof update === "function" ? update(context.analysis) : update; };
  context.setPayload = (value) => { context.payload = value; };
  context.setPreferences = (update) => { context.preferences = update(context.preferences); };
  context.desktop.updateImageAnalysis = (value) => { context.saved = value; };
  for (const name of ["EMPTY_ANALYSIS", "DEFAULT_GUIDE_COLOR", "DEFAULT_PREFERENCES", "PRESETS", "PREFERENCES_KEY", "cloneAnalysis", "migrateAnalysisGuideColor", "getSavedPreferences", "stopActiveStroke", "cancelActiveStroke", "initialize", "recordAnalysisUndo", "updateAnalysis", "undoAnalysis", "redoAnalysis", "resetAnalysis", "saveAnalysis"]) install(context, editor, name);
  context.preferences = context.getSavedPreferences();
  return context;
}

const savedAnalysis = () => ({
  preset: "thirds", gridVisible: true, guideColor: "#ff0000", guideColorVersion: 1,
  strokes: [{ id: "line-A", kind: "line", color: "#123456", width: 3,
    points: [{ x: -100, y: 50 }, { x: 1200, y: 900 }] }],
});

function visible(context) {
  install(context, editor, "visibleAnalysis");
  return context.visibleAnalysis;
}

test("reopening an image preserves its guides instead of another image's preferences", () => {
  const context = editorContext();
  context.initialize({ itemId: "A", analysis: savedAnalysis() });
  assert.deepEqual(plain(visible(context)), savedAnalysis());
  context.saveAnalysis();
  assert.deepEqual(plain(context.saved.analysis), savedAnalysis());
  context.initialize({ itemId: "B" });
  assert.equal(visible(context).preset, "none");
  assert.equal(visible(context).gridVisible, false);
  assert.equal(visible(context).strokes.length, 0);
});

test("reset undo/redo restores strokes, guides, grid and guide color together", () => {
  const context = editorContext();
  context.initialize({ itemId: "A", analysis: savedAnalysis() });
  context.resetAnalysis();
  const reset = plain(visible(context));
  assert.equal(reset.preset, "none");
  assert.equal(reset.gridVisible, false);
  assert.equal(reset.strokes.length, 0);
  context.undoAnalysis();
  assert.deepEqual(plain(visible(context)), savedAnalysis());
  context.redoAnalysis();
  assert.deepEqual(plain(visible(context)), reset);
  context.updateAnalysis({ preset: "golden", gridVisible: true, guideColor: "#00ff00" });
  context.undoAnalysis();
  assert.deepEqual(plain(visible(context)), reset);
});

test("rotated images open the original source at its original aspect ratio", () => {
  const context = vm.createContext({
    board: { ...board("A"), items: [{ id: "image-A", type: "image", src: "portrait.webp", x: 10, y: 20, w: 330, h: 457 }] },
    recordUndoSnapshot() {}, setItemContextMenu() {}, window: { museboardDesktop: {} },
  });
  context.updateActiveBoard = (update) => { context.board = update(context.board); };
  context.window.museboardDesktop.openImageAnalysis = (payload) => { context.payload = payload; };
  for (const name of ["normalizeRotation", "rotateImage", "openImageAnalysis"]) install(context, page, name);
  for (let turn = 0; turn < 4; turn++) {
    if (turn) context.rotateImage("image-A", 90);
    context.openImageAnalysis(context.board.items[0]);
    assert.equal(context.payload.width / context.payload.height, 330 / 457);
    assert.equal(context.payload.src, "portrait.webp");
  }
});

test("project validation rejects malformed nested data but keeps legacy valid data", () => {
  const context = vm.createContext({});
  install(context, main, "validProjectSnapshot");
  const valid = project([{ ...board("A"), items: [
    { id: "image-A", type: "image", src: "./sample.webp", x: 0, y: 0, w: 330, h: 457, z: 1, analysis: savedAnalysis() },
    { id: "note-A", type: "note", text: "Legacy note", x: -20, y: -40, w: 250, h: 180, z: 2 },
  ] }]);
  assert.equal(context.validProjectSnapshot(valid), true);
  assert.equal(context.validProjectSnapshot(project([board("empty")])), true);
  for (const corrupt of [
    (value) => { value.boards[0] = null; },
    (value) => { delete value.boards[0].items; },
    (value) => { delete value.boards[0].viewport; },
    (value) => { value.boards[0].viewport.scale = 0; },
    (value) => { value.boards[0].items[0].w = "wide"; },
    (value) => { value.boards[0].items[0].tags = [null]; },
    (value) => { value.boards[0].items[0].analysis.strokes[0].points = []; },
    (value) => { value.boards[0].items[0].analysis.strokes[0].points[0].x = Infinity; },
    (value) => { value.boards.push(structuredClone(value.boards[0])); },
    (value) => { value.boards[0].items.push(structuredClone(value.boards[0].items[0])); },
  ]) {
    const value = structuredClone(valid);
    corrupt(value);
    assert.equal(context.validProjectSnapshot(value), false);
  }
});

const pinterestAsset = "12/d4/5e/12d45e4bc887f5e21487201aef0eb8dd.jpg";
const pinterestPreview = `https://i.pinimg.com/236x/${pinterestAsset}`;
const pinterestOriginal = `https://i.pinimg.com/originals/${pinterestAsset}`;

function imageResponse(url, buffer, contentType = "image/jpeg") {
  return { buffer, response: { url, headers: { get: (name) => name === "content-type" ? contentType : null } } };
}

function remoteImageContext(routes = new Map(), invalidBuffers = new Set()) {
  const requests = [];
  const validated = [];
  const persisted = [];
  const persistAttempts = [];
  const localReads = [];
  const localImage = Buffer.from("local-image-pixels");
  const context = vm.createContext({
    URL, Buffer, path: path.win32, fileURLToPath, MAX_IMAGE_BYTES: 120 * 1024 * 1024,
    fs: { async readFile(filePath) { localReads.push(filePath); return localImage; } },
    async fetchBuffer(url) {
      requests.push(url);
      assert.ok(routes.has(url), `Unexpected network request ${url}`);
      const response = routes.get(url);
      if (response instanceof Error) throw response;
      return response;
    },
    async readImageDimensions(buffer) {
      validated.push(buffer);
      if (invalidBuffers.has(buffer)) throw new Error("Unsupported image data");
      return { width: 1415, height: 2048 };
    },
    async persistImageBuffer(buffer, name) {
      persistAttempts.push(buffer);
      if (invalidBuffers.has(buffer)) throw new Error("Unsupported image data");
      persisted.push({ buffer, name });
      return { src: "file:stored-image", name };
    },
  });
  for (const name of ["cleanImageName", "bufferFromDataUrl", "parseHtmlAttributes", "decodeHtmlEntities", "findPageImageUrl",
    "getPinterestOriginalUrl", "fetchImageForImport", "importImageUrl"]) install(context, main, name);
  return { context, requests, validated, persisted, persistAttempts, localReads, localImage };
}

test("Pinterest original lookup is restricted to the exact CDN and recognized resized asset paths", () => {
  const { context } = remoteImageContext();
  for (const size of [236, 474, 564, 736, 1200]) {
    assert.equal(context.getPinterestOriginalUrl(`https://i.pinimg.com/${size}x/${pinterestAsset}`), pinterestOriginal);
  }
  for (const extension of ["jpg", "jpeg", "png", "webp", "gif", "avif"]) {
    const asset = pinterestAsset.replace(/jpg$/, extension);
    assert.equal(context.getPinterestOriginalUrl(`https://i.pinimg.com/236x/${asset}`), `https://i.pinimg.com/originals/${asset}`);
  }
  assert.equal(context.getPinterestOriginalUrl(`http://i.pinimg.com/236x/${pinterestAsset}`), pinterestOriginal);
  assert.equal(context.getPinterestOriginalUrl(`${pinterestPreview}?tracking=one#preview`), pinterestOriginal);
  for (const url of [
    pinterestOriginal,
    `https://other.test/236x/${pinterestAsset}`,
    `https://i.pinimg.com.other.test/236x/${pinterestAsset}`,
    `https://www.i.pinimg.com/236x/${pinterestAsset}`,
    `https://user:password@i.pinimg.com/236x/${pinterestAsset}`,
    `https://i.pinimg.com:8443/236x/${pinterestAsset}`,
    `ftp://i.pinimg.com/236x/${pinterestAsset}`,
    `https://i.pinimg.com/236x100/${pinterestAsset}`,
    `https://i.pinimg.com/0x/${pinterestAsset}`,
    `https://i.pinimg.com/236x/12/d4/${pinterestAsset.split("/").at(-1)}`,
    `https://i.pinimg.com/236x/gg/d4/5e/${pinterestAsset.split("/").at(-1)}`,
    pinterestPreview.replace(/\.jpg$/, ".svg"),
    pinterestPreview.replace("12d45e4bc887f5e21487201aef0eb8dd", "short-name"),
    `${pinterestPreview}/extra`,
    "not a URL",
  ]) assert.equal(context.getPinterestOriginalUrl(url), null, url);
});

test("a Pinterest image import validates and persists the original without downloading the small preview", async () => {
  const originalBytes = Buffer.from("full-resolution-original");
  const fixture = remoteImageContext(new Map([[pinterestOriginal, imageResponse(pinterestOriginal, originalBytes)]]));
  const result = await fixture.context.importImageUrl(pinterestPreview);
  assert.equal(result.src, "file:stored-image");
  assert.deepEqual(fixture.requests, [pinterestOriginal]);
  assert.deepEqual(fixture.validated, [originalBytes]);
  assert.equal(fixture.persisted.length, 1);
  assert.equal(fixture.persisted[0].buffer, originalBytes, "The downloaded original reaches persistence without conversion or replacement");
  assert.equal(fixture.persistAttempts.length, 1);
});

for (const failure of ["404", "timeout", "unreadable response"]) {
  test(`a Pinterest original ${failure} falls back to the working requested image`, async () => {
    const invalid = Buffer.from("<html>Not an image</html>");
    const previewBytes = Buffer.from("working-preview-pixels");
    const requested = `${pinterestPreview}?original-request=retained`;
    const originalResult = failure === "unreadable response"
      ? imageResponse(pinterestOriginal, invalid, "text/html")
      : new Error(failure === "404" ? "The server returned 404" : "The image download timed out");
    const fixture = remoteImageContext(new Map([
      [pinterestOriginal, originalResult], [requested, imageResponse(requested, previewBytes)],
    ]), new Set([invalid]));
    await fixture.context.importImageUrl(requested);
    assert.deepEqual(fixture.requests, [pinterestOriginal, requested]);
    assert.equal(fixture.persisted.length, 1);
    assert.equal(fixture.persisted[0].buffer, previewBytes);
    assert.deepEqual(fixture.persistAttempts, [previewBytes], "Invalid original candidates must never be persisted");
    assert.deepEqual(fixture.validated, failure === "unreadable response" ? [invalid] : []);
  });
}

test("ordinary image hosts, existing originals and URLs with credentials or custom ports keep their original request", async () => {
  for (const url of [
    "https://cdn.example.test/photo.jpg", pinterestOriginal,
    `https://user:password@i.pinimg.com/236x/${pinterestAsset}`,
    `https://i.pinimg.com:8443/236x/${pinterestAsset}`,
  ]) {
    const buffer = Buffer.from("existing-source-pixels");
    const fixture = remoteImageContext(new Map([[url, imageResponse(url, buffer)]]));
    await fixture.context.importImageUrl(url);
    assert.deepEqual(fixture.requests, [url]);
    assert.deepEqual(fixture.validated, []);
    assert.equal(fixture.persisted[0].buffer, buffer);
  }
});

test("a Pinterest page preview is upgraded to its original image after metadata extraction", async () => {
  const pinUrl = "https://www.pinterest.com/pin/123/";
  const html = Buffer.from(`<html><head><meta property="og:image" content="${pinterestPreview}"></head></html>`);
  const originalBytes = Buffer.from("original-from-page-metadata");
  const fixture = remoteImageContext(new Map([
    [pinUrl, imageResponse(pinUrl, html, "text/html")],
    [pinterestOriginal, imageResponse(pinterestOriginal, originalBytes)],
  ]), new Set([html]));
  await fixture.context.importImageUrl(pinUrl);
  assert.deepEqual(fixture.requests, [pinUrl, pinterestOriginal]);
  assert.deepEqual(fixture.validated, [originalBytes]);
  assert.equal(fixture.persisted.length, 1);
  assert.equal(fixture.persisted[0].buffer, originalBytes);
  assert.deepEqual(fixture.persistAttempts, [html, originalBytes]);
});

test("data URLs and local file imports bypass Pinterest lookup and remote fetching", async () => {
  const fixture = remoteImageContext();
  const dataBytes = Buffer.from("inline-image-pixels");
  await fixture.context.importImageUrl(`data:image/png;base64,${dataBytes.toString("base64")}`);
  const fileUrl = "file:///C:/Pictures/local.png";
  const windowsPath = "C:\\Pictures\\local.png";
  const networkPath = "\\\\server\\Pictures\\local.png";
  for (const value of [fileUrl, windowsPath, networkPath]) await fixture.context.importImageUrl(value);
  assert.deepEqual(fixture.requests, []);
  assert.deepEqual(fixture.validated, []);
  assert.deepEqual(fixture.localReads, [fileURLToPath(fileUrl), windowsPath, networkPath]);
  assert.deepEqual(fixture.persisted[0].buffer, dataBytes);
  assert.equal(fixture.persisted.length, 4);
  for (const saved of fixture.persisted.slice(1)) assert.equal(saved.buffer, fixture.localImage);
});

test("a failed original and failed preview still report the requested image failure", async () => {
  const fixture = remoteImageContext(new Map([
    [pinterestOriginal, new Error("The server returned 404")],
    [pinterestPreview, new Error("The server returned 403")],
  ]));
  await assert.rejects(fixture.context.importImageUrl(pinterestPreview), /The server returned 403/);
  assert.deepEqual(fixture.requests, [pinterestOriginal, pinterestPreview]);
  assert.equal(fixture.persisted.length, 0);
});
