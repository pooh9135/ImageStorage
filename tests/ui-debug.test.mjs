import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const canvasSource = await readFile(new URL("../app/canvas-settings.ts", import.meta.url), "utf8");
const canvasJavascript = ts.transpileModule(canvasSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DEFAULT_CANVAS_SETTINGS, normalizeCanvasSettings, applyCanvasSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(canvasJavascript).toString("base64")}`
);
const noteSource = await readFile(new URL("../app/note-settings.ts", import.meta.url), "utf8");
const noteJavascript = ts.transpileModule(noteSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { DEFAULT_NOTE_SETTINGS, normalizeNoteSettings, applyNoteSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(noteJavascript).toString("base64")}`
);
const imageDropSource = await readFile(new URL("../app/image-drop.ts", import.meta.url), "utf8");
const imageDropJavascript = ts.transpileModule(imageDropSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { getImageDropEffect, hasImageDropData } = await import(
  `data:text/javascript;base64,${Buffer.from(imageDropJavascript).toString("base64")}`
);
const managerJavascript = ts.transpileModule(await readFile(new URL("../app/list-manager.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { clearListHeader, mergeListManagerEntry, HEADER_IMAGE_FIELDS, getListManagerDropTarget } = await import(
  `data:text/javascript;base64,${Buffer.from(managerJavascript).toString("base64")}`
);
const autoScrollJavascript = ts.transpileModule(await readFile(new URL("../app/list-manager-autoscroll.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { createListManagerAutoScroll } = await import(`data:text/javascript;base64,${Buffer.from(autoScrollJavascript).toString("base64")}`);
const pointerDragJavascript = ts.transpileModule(await readFile(new URL("../app/list-manager-pointer-drag.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { createListManagerPointerDrag } = await import(`data:text/javascript;base64,${Buffer.from(pointerDragJavascript).toString("base64")}`);
const boardImportJavascript = ts.transpileModule(await readFile(new URL("../app/pinterest-board-import.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { pinterestBoardItems } = await import(`data:text/javascript;base64,${Buffer.from(boardImportJavascript).toString("base64")}`);

const text = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const page = ts.createSourceFile("page.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const editorText = await readFile(new URL("../app/ImageAnalysisWindow.tsx", import.meta.url), "utf8");
const editor = ts.createSourceFile("ImageAnalysisWindow.tsx", editorText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function install(context, name, file = page) {
  let declaration;
  function visit(node) {
    if ((ts.isVariableDeclaration(node) && node.name.getText(file) === name) ||
        (ts.isFunctionDeclaration(node) && node.name?.text === name)) declaration = node;
    if (!declaration) ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(declaration, `Missing production callback: ${name}`);
  let code;
  if (ts.isFunctionDeclaration(declaration)) code = declaration.getText(file).replace(/^export\s+/, "");
  else {
    let value = declaration.initializer;
    if (ts.isCallExpression(value) && value.expression.getText(file) === "useCallback") value = value.arguments[0];
    code = `globalThis.${name} = ${value.getText(file)};`;
  }
  vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

function installDropHandler(context, target, attribute, name) {
  let handler;
  function visit(node) {
    if (handler) return;
    if (ts.isJsxOpeningElement(node)) {
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const matches = target === "row"
        ? attributes.some((entry) => entry.name.getText(page) === "data-board-id")
        : attributes.some((entry) => entry.name.getText(page) === "ref" &&
          ts.isJsxExpression(entry.initializer) && entry.initializer.expression?.getText(page) === "canvasRef");
      if (matches) handler = attributes.find((entry) => entry.name.getText(page) === attribute)?.initializer?.expression;
    }
    if (!handler) ts.forEachChild(node, visit);
  }
  visit(page);
  assert.ok(handler, `Missing production ${target} ${attribute} handler`);
  vm.runInContext(ts.transpileModule(`globalThis.${name} = ${handler.getText(page)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const board = (id, items = []) => ({ id, name: id, items, viewport: { x: 0, y: 0, scale: 1 } });
const preview = { id: "image", type: "image", src: "blob:preview", processing: true, x: 14, y: 28, w: 120, h: 150, z: 2,
  caption: "User title", favorite: true, tags: ["reference"], analysis: { strokes: [{ id: "line" }] } };
const snapshot = (boards) => ({ activeId: "a", boards });

function installPageEffect(context, marker) {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(page) === "useEffect" && node.arguments[0]?.getText(page).includes(marker)) effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(page);
  assert.ok(effect, `Missing effect: ${marker}`);
  vm.runInContext(ts.transpileModule(`(${effect.getText(page)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
}

test("an old autosave debounce cannot overwrite a newly restored project before effect cleanup", async () => {
  const callbacks = [], saves = [];
  const context = vm.createContext({
    hydrated: true, activeId: "a", boards: [board("a")], canvasSettings: {},
    settings: { autoSaveEnabled: true, autoSaveDelayMs: 650 }, projectGenerationRef: { current: 1 },
    applyNoteSettings: (value) => value, applyCanvasSettings: (value) => value,
    STORAGE_KEY: "boards", ACTIVE_KEY: "active", localStorage: { setItem() {} },
    CustomEvent: class { constructor(name, detail) { Object.assign(this, { name, detail }); } },
    window: { dispatchEvent() {}, setTimeout(callback) { callbacks.push(callback); return callbacks.length; }, clearTimeout() {},
      museboardDesktop: { async autoSaveProject(data) { saves.push(data); return { saved: true }; } } },
  });
  installPageEffect(context, "imagestorage:autosave-status");
  context.projectGenerationRef.current++;
  context.boards = [board("restored")];
  callbacks[0]();
  assert.equal(saves.length, 0);
  installPageEffect(context, "imagestorage:autosave-status");
  callbacks[1]();
  await Promise.resolve();
  assert.equal(saves.length, 1);
  assert.equal(saves[0].boards[0].id, "restored");
});

test("image-editor saves create an undo step and invalidate stale redo without changing geometry", () => {
  let onUpdate;
  const context = vm.createContext({
    structuredClone, boardsRef: { current: [board("a", [{ ...preview, src: "file:durable", analysis: undefined }])] },
    activeIdRef: { current: "a" }, undoStackRef: { current: [] }, redoStackRef: { current: [] },
    window: { museboardDesktop: { onImageAnalysisUpdate(callback) { onUpdate = callback; } } },
    setBoards() {}, setActiveId() {}, setHistoryAvailability() {}, setWorkspaceFilter() {},
    setSelectedIds() {}, setSelectionMarquee() {}, setItemContextMenu() {},
  });
  for (const name of ["recordUndoSnapshot", "undoLastChange", "redoLastChange"]) install(context, name);
  installPageEffect(context, "onImageAnalysisUpdate");
  context.recordUndoSnapshot();
  context.boardsRef.current[0].items[0].x = 200;
  context.undoLastChange();
  assert.equal(context.redoStackRef.current.length, 1);
  const analysis = { preset: "thirds", gridVisible: true, strokes: [] };
  onUpdate({ itemId: "image", analysis });
  assert.equal(context.redoStackRef.current.length, 0);
  assert.equal(context.boardsRef.current[0].items[0].x, 14);
  context.redoLastChange();
  assert.deepEqual(plain(context.boardsRef.current[0].items[0].analysis), analysis);
  onUpdate({ itemId: "image", analysis: structuredClone(analysis) });
  assert.equal(context.undoStackRef.current.length, 1, "Identical editor saves are no-ops");
  context.undoLastChange();
  assert.equal(context.boardsRef.current[0].items[0].analysis, undefined);
  context.redoLastChange();
  assert.deepEqual(plain(context.boardsRef.current[0].items[0].analysis), analysis);
});

test("canvas release includes final coordinates; other pointers and cancellation cannot move it", () => {
  const events = new Map();
  class TestPointerEvent { constructor(x, y, pointerId = 1) { Object.assign(this, { clientX: x, clientY: y, pointerId }); } }
  const context = vm.createContext({
    PointerEvent: TestPointerEvent,
    actionRef: { current: null }, boardsRef: { current: [board("a", [{ ...preview, x: 0, y: 0 }])] },
    window: { addEventListener(name, listener) { events.set(name, listener); }, removeEventListener() {} },
    document: { body: { classList: { remove() {} } }, addEventListener() {}, removeEventListener() {} },
    setSelectionMarquee() {}, setSelectedIds() {},
  });
  context.updateBoard = (id, updater) => { context.boardsRef.current = context.boardsRef.current.map((entry) => entry.id === id ? updater(entry) : entry); };
  const action = { mode: "drag", pointerId: 1, boardId: "a", startClientX: 0, startClientY: 0, scale: 1, snapEnabled: false, itemOrigins: [{ id: "image", x: 0, y: 0 }] };
  installPageEffect(context, "const stopPointerAction");
  context.actionRef.current = action;
  events.get("pointermove")(new TestPointerEvent(30, 20));
  events.get("pointerup")(new TestPointerEvent(999, 999, 2));
  assert.equal(context.actionRef.current, action);
  events.get("pointerup")(new TestPointerEvent(50, 40));
  assert.equal(context.actionRef.current, null);
  assert.deepEqual(plain(context.boardsRef.current[0].items.map(({ x, y }) => ({ x, y }))), [{ x: 50, y: 40 }]);
  context.actionRef.current = action;
  events.get("pointercancel")(new TestPointerEvent(500, 400));
  assert.equal(context.boardsRef.current[0].items[0].x, 50);
  assert.equal(context.actionRef.current, null);
});

function sidebarPeekContext() {
  let now = 0, nextTimer = 0, painted = false, hovered = false;
  const timers = new Map();
  const pendingTimers = [];
  class PeekTarget {
    constructor(region) { this.region = region; }
    closest(selector) {
      return (selector === ".sidebar-toggle-button" && this.region === "toggle") ||
        (selector === ".chrome-menu" && this.region === "menu") ? this : null;
    }
  }
  const context = vm.createContext({
    Element: PeekTarget, sidebarCollapsed: true, sidebarMenu: null, sidebarPeekOpen: false,
    renderedOpen: false, sidebarPeekTimerRef: { current: null }, sidebarPeekPointerRef: { current: null },
    sidebarPeekNativePointerRef: { current: undefined }, sidebarPeekDecisionRef: { current: 0 },
    sidebarRef: { current: {
      getBoundingClientRect: () => ({ left: 5, right: painted ? 211 : 5, top: 5, bottom: 895 }),
      contains: (target) => target.region === "sidebar" || target.region === "toggle",
      matches: (selector) => selector === ":hover" && hovered,
      classList: { contains: (name) => name === "is-peeking" && painted },
    } },
    window: {
      setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  context.setSidebarPeekOpen = (value) => { context.renderedOpen = value; if (!value) painted = false; };
  for (const name of ["SIDEBAR_PEEK_REVEAL_WIDTH", "SIDEBAR_PEEK_KEEP_MARGIN", "SIDEBAR_PEEK_HIDE_DELAY", "isWithinSidebarPeek", "clearSidebarPeekTimer", "showSidebarPeek", "hideSidebarPeek", "handleSidebarPeekWindowLeave", "handleSidebarPeekPointerMove", "handleSidebarPeekNativePointer"]) install(context, name);
  return {
    context, timers,
    move(x, y = 200, region = "canvas") {
      context.handleSidebarPeekPointerMove({ clientX: x, clientY: y, target: new PeekTarget(region) });
    },
    paint() { painted = context.renderedOpen; },
    hover(value) { hovered = value; },
    settle() { return Promise.all(pendingTimers.splice(0)); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]);
        const pending = next[1].callback();
        if (pending?.then) pendingTimers.push(pending);
      }
      now = end;
    },
  };
}

test("compact sidebar opens from a usable edge band while leaving the window caption strip alone", () => {
  for (const [x, y, expected] of [[0, 200, true], [20, 200, true], [28, 200, true], [29, 200, false], [-1, 200, false], [20, 4, false]]) {
    const peek = sidebarPeekContext();
    peek.move(x, y);
    assert.equal(peek.context.renderedOpen, expected, `Pointer ${x},${y}`);
  }
  const pinned = sidebarPeekContext(); pinned.context.sidebarCollapsed = false;
  pinned.move(20);
  assert.equal(pinned.context.renderedOpen, false, "Pinned mode does not create a hover preview");
});

test("an edge-to-list move before React paints does not let a stale timer close the revealed sidebar", () => {
  const peek = sidebarPeekContext();
  peek.move(20);
  peek.move(150);
  assert.equal(peek.timers.size, 1, "The pre-paint move initially schedules a close");
  peek.paint();
  peek.advance(500);
  assert.equal(peek.context.renderedOpen, true, "Timer must use the latest position and visible pane bounds");
  assert.equal(peek.context.sidebarPeekTimerRef.current, null);
});

test("moving through sidebar children remains stable even before the pointer listener sees the new React state", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint();
  assert.equal(peek.context.sidebarPeekOpen, false, "Simulate the listener from the previous render");
  peek.move(180, 200, "sidebar"); peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true);
  assert.equal(peek.timers.size, 0);
});

test("compact sidebar tolerates a small rightward overshoot and closes after a deliberate departure", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint();
  peek.move(235); peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true, "A 24px overshoot remains within the grace area");
  peek.move(280); peek.advance(399);
  assert.equal(peek.context.renderedOpen, true, "Crossing the boundary does not close immediately");
  peek.advance(1);
  assert.equal(peek.context.renderedOpen, false);
});

test("returning to the compact list cancels a pending close and menu interaction keeps it open", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint(); peek.move(300); peek.advance(200);
  peek.move(100, 200, "sidebar"); peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true);
  assert.equal(peek.timers.size, 0);
  peek.context.sidebarMenu = "main";
  peek.move(350, 200, "menu"); peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true);
});

test("leaving the app clears the stale inside pointer so the compact sidebar can still close", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint(); peek.move(100, 200, "sidebar");
  peek.context.handleSidebarPeekWindowLeave();
  assert.equal(peek.context.sidebarPeekPointerRef.current, null);
  peek.advance(400);
  assert.equal(peek.context.renderedOpen, false);
});

test("the compact list remains open when pointer coordinates are lost while it is still hovered", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint(); peek.hover(true);
  peek.context.handleSidebarPeekWindowLeave();
  assert.equal(peek.context.sidebarPeekPointerRef.current, null);
  peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true, "Actual hover takes priority over a pointer-leave notification");
});

test("entering the compact list before a pending timeout fires keeps it open even with stale outside coordinates", () => {
  const peek = sidebarPeekContext();
  peek.move(20); peek.paint(); peek.move(350);
  peek.advance(200); peek.hover(true);
  peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true, "The timeout must recheck hover instead of trusting the previous pointer event");
  peek.hover(false); peek.context.handleSidebarPeekWindowLeave();
  peek.advance(400);
  assert.equal(peek.context.renderedOpen, false, "A real departure must still close the list");
});

test("the OS cursor inside the compact list prevents closure when DOM hover and pointer coordinates are both lost", async () => {
  const peek = sidebarPeekContext();
  peek.context.window.museboardDesktop = { getWindowPointerPosition: async () => ({ clientX: 150, clientY: 200 }) };
  peek.move(20); peek.paint(); peek.hover(false);
  peek.context.handleSidebarPeekWindowLeave();
  peek.advance(400); await peek.settle();
  assert.equal(peek.context.sidebarPeekPointerRef.current, null);
  assert.equal(peek.context.renderedOpen, true);
  assert.equal(peek.context.sidebarPeekTimerRef.current, null);
});

test("native cursor updates reveal and retain the list without DOM events and close only after a real departure", async () => {
  const peek = sidebarPeekContext();
  let nativePosition = { clientX: 20, clientY: 200 };
  peek.context.window.museboardDesktop = { getWindowPointerPosition: async () => nativePosition };
  peek.context.handleSidebarPeekNativePointer(nativePosition); peek.paint();
  nativePosition = { clientX: 150, clientY: 200 };
  peek.context.handleSidebarPeekNativePointer(nativePosition);
  peek.advance(1000);
  assert.equal(peek.context.renderedOpen, true);
  peek.hover(true); // Chromium hover may itself be stale after native transitions.
  nativePosition = { clientX: 350, clientY: 200 };
  peek.context.handleSidebarPeekNativePointer(nativePosition);
  peek.advance(400); await peek.settle();
  assert.equal(peek.context.renderedOpen, false, "The OS position, not stale DOM hover, decides departure");
});

test("returning to the list invalidates an in-flight native close decision", async () => {
  const peek = sidebarPeekContext();
  let finishQuery;
  peek.context.window.museboardDesktop = { getWindowPointerPosition: () => new Promise(resolve => { finishQuery = resolve; }) };
  peek.move(20); peek.paint(); peek.move(350); peek.advance(400);
  assert.equal(typeof finishQuery, "function");
  peek.move(100, 200, "sidebar");
  finishQuery({ clientX: 350, clientY: 200 }); await peek.settle();
  assert.equal(peek.context.renderedOpen, true, "An older IPC response cannot close a list that was re-entered");
});

test("a failed OS cursor query leaves the compact list open instead of guessing that the cursor left", async () => {
  const peek = sidebarPeekContext();
  peek.context.window.museboardDesktop = { getWindowPointerPosition: async () => { throw new Error("Pointer unavailable"); } };
  peek.move(20); peek.paint(); peek.move(350); peek.advance(400); await peek.settle();
  assert.equal(peek.context.renderedOpen, true);
  assert.equal(peek.context.sidebarPeekTimerRef.current, null, "A later update can retry the close");
});

function settingsContext(stored, preferredLanguages = [], legacyLanguage = null) {
  const context = vm.createContext({
    DEFAULT_CANVAS_SETTINGS, normalizeCanvasSettings, DEFAULT_NOTE_SETTINGS, normalizeNoteSettings,
    window: { museboardDesktop: { preferredLanguages } },
    localStorage: { getItem: (key) => key === "imagestorage-settings-v1" ? stored : legacyLanguage },
  });
  for (const name of ["SETTINGS_KEY", "LANGUAGE_KEY", "UI_LANGUAGES", "DEFAULT_SETTINGS", "defaultSettings"]) install(context, name);
  const declaration = page.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "readSettings");
  assert.ok(declaration);
  vm.runInContext(ts.transpileModule(`${declaration.getText(page)}; globalThis.readSettings = readSettings;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context;
}

test("first-run settings use the Windows language, while saved language and preferences take precedence", () => {
  const firstRun = settingsContext(null, ["fr-FR", "ja-JP", "en-US"]).readSettings();
  assert.equal(firstRun.language, "ja");
  assert.equal(firstRun.startupSidebar, "pinned");
  assert.equal(firstRun.autoSaveDelayMs, 1000);
  assert.equal(firstRun.autoSaveEnabled, true);
  assert.equal(settingsContext(null, ["fr-FR"]).readSettings().language, "en");
  assert.equal(settingsContext(null, ["ja-JP"], "en").readSettings().language, "en");
  const saved = settingsContext('{"language":"ko","autoSaveDelayMs":3000,"startupSidebar":"closed"}', ["ja-JP"]).readSettings();
  assert.equal(saved.language, "ko");
  assert.equal(saved.autoSaveDelayMs, 3000);
  assert.equal(saved.startupSidebar, "closed");
});

test("the starter list has an aligned sample and one guide in the chosen language", () => {
  const context = vm.createContext({});
  for (const name of ["STARTER_GUIDE_COPY", "createStarterBoard"]) install(context, name);
  for (const [language, heading] of [["ja", "ImageStorageへようこそ"], ["en", "Welcome to ImageStorage"], ["zh", "欢迎使用 ImageStorage"], ["ko", "ImageStorage에 오신 것을 환영합니다"]]) {
    const board = context.createStarterBoard(language);
    assert.equal(board.id, "default");
    assert.equal(board.items.length, 2);
    const [sample, guide] = board.items;
    assert.equal(sample.type, "image");
    assert.equal(guide.type, "note");
    assert.equal(sample.y, guide.y);
    assert.ok(sample.x + sample.w < guide.x);
    assert.ok(guide.text.startsWith(heading));
    assert.match(guide.text, /Pinterest/);
  }
});

test("updates only matching starter copy while preserving edited notes and other lists", () => {
  const context = vm.createContext({});
  for (const name of ["STARTER_GUIDE_COPY", "LEGACY_JAPANESE_STARTER_COPY", "LEGACY_STARTER_GUIDES",
    "createStarterBoard", "migrateStarterGuides"]) install(context, name);
  const starter = context.createStarterBoard("ja");
  const [artwork, guide] = starter.items;
  const japanese = {
    ...guide, id: "default-note-ja", x: 440, y: 55, w: 390, h: 335,
    text: [
      "ImageStorageへようこそ",
      "",
      "画像・URLを自由なキャンバスに集め、移動、比率固定の拡大縮小、回転ができます。",
      "保存リストへ画像やリンクを直接ドロップして整理できます。",
      "付箋へメモを残し、画像から6色のパレットを抽出できます。",
      "変更は自動保存され、右クリックで複製・前後移動・削除、Ctrl+Zで元に戻せます。",
    ].join("\n"),
  };
  const english = {
    ...guide, id: "default-note-en", y: 415,
    text: context.LEGACY_STARTER_GUIDES.find(({ id }) => id === "default-note-en").text,
  };
  const edited = { ...japanese, text: japanese.text + "\n\nMy own note" };
  const other = { ...starter, id: "other", items: [japanese] };
  const migrated = context.migrateStarterGuides([{ ...starter, items: [artwork, japanese, english] }, other]);
  assert.equal(migrated[0].items[0], artwork);
  assert.deepEqual(plain(migrated[0].items[1]), { ...japanese, text: guide.text });
  assert.deepEqual(plain(migrated[0].items[2]), { ...english, text: context.STARTER_GUIDE_COPY.en });
  assert.equal(migrated[1], other);
  assert.equal(context.migrateStarterGuides(migrated), migrated);

  const customized = [{ ...starter, items: [artwork, edited] }];
  assert.equal(context.migrateStarterGuides(customized), customized);
});

test("edge-to-edge stays off for fresh, legacy, malformed and non-boolean settings", () => {
  for (const stored of [null, "{", "null", "{}", '{"language":"ja"}', ...[false, "true", 1, null, {}].map((edgeToEdge) => JSON.stringify({ edgeToEdge }))]) {
    const context = settingsContext(stored);
    assert.equal(context.readSettings().edgeToEdge, false, `Unexpected opt-in from ${stored}`);
  }
  assert.equal(settingsContext('{"language":"ja"}').readSettings().language, "ja");
});

test("edge-to-edge restores an explicit opt-in and resetting settings turns it off", () => {
  const context = settingsContext('{"edgeToEdge":true,"language":"ja"}');
  context.settings = context.readSettings();
  assert.equal(context.settings.edgeToEdge, true);
  context.activeBoard = { ...board("a", [preview]), backgroundColor: "#123456", gridVisible: true };
  const originalBoard = structuredClone(context.activeBoard);
  context.backgroundRequestRef = { current: 4 };
  context.setSettings = (settings) => { context.settings = settings; };
  context.setSidebarCollapsed = (value) => { context.sidebarCollapsed = value; };
  context.updateActiveBoard = () => assert.fail("Reset must update global appearance, not board contents");
  install(context, "resetSettings");
  context.resetSettings();
  assert.equal(context.settings.edgeToEdge, false);
  assert.equal(context.sidebarCollapsed, false);
  assert.equal(context.backgroundRequestRef.current, 5, "Reset invalidates pending background requests");
  assert.deepEqual(context.settings.canvas, DEFAULT_CANVAS_SETTINGS);
  assert.deepEqual(plain(context.activeBoard), originalBoard, "Resetting appearance must retain board data");
});

test("settings without a shared canvas keep the one-time legacy migration marker", () => {
  for (const stored of [null, "{}", '{"language":"ja"}', '{"edgeToEdge":true}']) {
    const settings = settingsContext(stored).readSettings();
    assert.ok(Object.hasOwn(settings, "canvas"));
    assert.equal(settings.canvas, undefined, "Absent canvas must remain distinguishable from explicit defaults");
  }
});

test("an explicit shared canvas is normalized and is not mistaken for legacy settings", () => {
  const context = settingsContext(JSON.stringify({ language: "ja", canvas: {
    gridVisible: true, snapEnabled: "true", gridSize: 900, backgroundColor: "#A1B2C3", backgroundFit: "contain",
    backgroundImageSrc: " file:shared ", backgroundImageThumbnailSrc: "", backgroundImageAssetId: " asset-shared ",
    id: "must-not-be-a-board",
  } }));
  const settings = context.readSettings();
  assert.equal(settings.language, "ja");
  assert.deepEqual(settings.canvas, {
    gridVisible: true, snapEnabled: false, gridSize: 120, backgroundColor: "#a1b2c3", backgroundFit: "contain",
    backgroundImageSrc: "file:shared", backgroundImageThumbnailSrc: undefined, backgroundImageAssetId: "asset-shared",
  });
  assert.deepEqual(settingsContext('{"canvas":{}}').readSettings().canvas, DEFAULT_CANVAS_SETTINGS);
  assert.deepEqual(settingsContext('{"canvas":"invalid"}').readSettings().canvas, DEFAULT_CANVAS_SETTINGS);
});

test("finished conversion hydrates current, undo, and redo resources without replacing user edits", () => {
  const unrelated = board("b", [{ ...preview, src: "blob:other-board" }]);
  const state = { boards: [board("a", []), unrelated] };
  const context = vm.createContext({
    undoStackRef: { current: [snapshot([board("a", [structuredClone(preview)]), unrelated])] },
    redoStackRef: { current: [snapshot([board("a", [{ ...structuredClone(preview), x: 99 }])])] },
    updateBoard(id, updater) { state.boards = state.boards.map((entry) => entry.id === id ? updater(entry) : entry); },
  });
  install(context, "applyProcessedImages");
  context.applyProcessedImages("a", [{ id: "image", image: { src: "file:durable", thumbnailSrc: "file:thumb", assetId: "asset", palette: ["#abcdef"] }, error: null }]);
  assert.equal(state.boards[0].items.length, 0, "Conversion must not resurrect an undone import");
  assert.equal(state.boards[1].items[0].src, "blob:other-board", "Matching item IDs on other boards stay untouched");
  for (const stack of [context.undoStackRef.current, context.redoStackRef.current]) {
    const item = stack[0].boards[0].items[0];
    assert.equal(item.src, "file:durable");
    assert.equal(item.thumbnailSrc, "file:thumb");
    assert.equal(item.assetId, "asset");
    assert.equal(item.processing, false);
    assert.equal(item.caption, preview.caption);
    assert.deepEqual(plain(item.analysis), preview.analysis);
    assert.deepEqual(plain(item.tags), preview.tags);
    assert.equal(item.favorite, true);
  }
  assert.equal(context.undoStackRef.current[0].boards[0].items[0].x, 14);
  assert.equal(context.redoStackRef.current[0].boards[0].items[0].x, 99);
});

test("failed conversion retains the usable preview and ends processing throughout history", () => {
  let current = board("a", [structuredClone(preview)]);
  const context = vm.createContext({
    undoStackRef: { current: [snapshot([structuredClone(current)])] },
    redoStackRef: { current: [] },
    updateBoard(_id, updater) { current = updater(current); },
  });
  install(context, "applyProcessedImages");
  context.applyProcessedImages("a", [{ id: "image", image: null, error: "Storage failed" }]);
  assert.equal(current.items[0].src, "blob:preview");
  assert.equal(current.items[0].processing, false);
  assert.equal(context.undoStackRef.current[0].boards[0].items[0].processing, false);
});

test("conversion hydrates pending duplicates by source without overwriting a replacement image", () => {
  const duplicate = { ...structuredClone(preview), id: "copy", x: 230, caption: "Copy title" };
  const replaced = { ...structuredClone(preview), src: "file:replacement", processing: false, favorite: false };
  const independent = { ...structuredClone(preview), id: "independent", processing: false };
  let current = board("a", [replaced, duplicate, independent]);
  const context = vm.createContext({
    undoStackRef: { current: [snapshot([board("a", [structuredClone(preview), { ...structuredClone(duplicate), x: 55 }])])] },
    redoStackRef: { current: [snapshot([structuredClone(current)])] },
    updateBoard(_id, updater) { current = updater(current); },
  });
  install(context, "applyProcessedImages");
  context.applyProcessedImages("a", [{ id: "image", source: "blob:preview", image: { src: "file:durable", assetId: "asset" }, error: null }]);
  assert.deepEqual(plain(current.items[0]), replaced, "An existing ID with another source must keep its replacement");
  assert.equal(current.items[1].src, "file:durable");
  assert.equal(current.items[1].processing, false);
  assert.equal(current.items[1].x, 230);
  assert.equal(current.items[1].caption, "Copy title");
  assert.deepEqual(plain(current.items[1].analysis), preview.analysis);
  assert.deepEqual(plain(current.items[2]), independent, "An unrelated non-pending image is not a duplicate job");
  assert.equal(context.undoStackRef.current[0].boards[0].items[1].src, "file:durable");
  assert.equal(context.undoStackRef.current[0].boards[0].items[1].x, 55);
  assert.equal(context.redoStackRef.current[0].boards[0].items[0].src, "file:replacement");
});

test("duplicating selects the new item even when React defers the board updater", () => {
  const sourceBoard = board("a", [structuredClone(preview)]);
  let queuedUpdate;
  let selected;
  const context = vm.createContext({
    boardsRef: { current: [sourceBoard] }, activeIdRef: { current: "a" },
    makeId: () => "copy", recordUndoSnapshot() {},
    updateActiveBoard: (update) => { queuedUpdate = update; },
    setSelectedIds: (value) => { selected = value; }, setItemContextMenu() {},
  });
  install(context, "duplicateItem");
  context.duplicateItem("image");
  assert.deepEqual(plain(selected), ["copy"]);
  const changed = queuedUpdate(sourceBoard);
  assert.equal(changed.items[1].id, selected[0]);
  assert.equal(changed.items[1].x, preview.x + 28);
  assert.equal(changed.items[1].src, preview.src);
});

test("project replacement stops pending legacy migration and skips its remaining candidates", async () => {
  let finish;
  let calls = 0;
  const updates = [];
  const context = vm.createContext({
    generation: 1, projectGenerationRef: { current: 1 },
    candidates: [{ boardId: "a", item: { id: "same", src: "data:image/png;old" } }, { boardId: "a", item: { id: "second", src: "data:image/png;old" } }],
    desktop: { persistImageSource: () => { calls++; return new Promise((resolve) => { finish = resolve; }); } },
    updateBoard: (...args) => updates.push(args),
  });
  install(context, "migrateLegacyImages");
  const pending = context.migrateLegacyImages();
  context.projectGenerationRef.current++;
  finish({ image: { src: "file:old-project", assetId: "old-asset" } });
  await pending;
  assert.equal(calls, 1);
  assert.deepEqual(updates, []);
});

test("late import into another board preserves the currently selected item", () => {
  const context = vm.createContext({
    activeId: "a", activeIdRef: { current: "b" }, boardsRef: { current: [board("a"), board("b")] },
    canvasRef: { current: { clientWidth: 800, clientHeight: 600 } },
    getCanvasSidebarOffset: () => 0, makeId: () => "new-image", findOpenImagePosition: () => ({ x: 0, y: 0 }),
    recordUndoSnapshot() {}, selectedIds: ["b-image"],
  });
  context.updateBoard = (id, update) => { context.boardsRef.current = context.boardsRef.current.map((entry) => entry.id === id ? update(entry) : entry); };
  context.setSelectedIds = (value) => { context.selectedIds = value; };
  install(context, "addPreparedImages");
  context.addPreparedImages([{ name: "image.png", src: "file:image", width: 40, height: 40 }]);
  assert.deepEqual(context.selectedIds, ["b-image"]);
  assert.equal(context.boardsRef.current[0].items.length, 1);
  assert.equal(context.boardsRef.current[1].items.length, 0);
});

test("a URL import finishing after project replacement cannot alter the new project", async () => {
  let finish;
  const calls = [];
  const context = vm.createContext({
    activeId: "a", projectGenerationRef: { current: 1 }, text: (en) => en,
    window: { museboardDesktop: { importImageUrl: () => new Promise((resolve) => { finish = resolve; }) } },
    setImportNotice() {}, addPreparedImages: () => calls.push("add"), reportBoardImportResult: () => calls.push("notice"), reportImportResult() {},
  });
  install(context, "addImageUrl");
  const pending = context.addImageUrl("https://example.test/image.png");
  context.projectGenerationRef.current++;
  finish({ images: [{ src: "file:old-project" }], errors: [] });
  await pending;
  assert.deepEqual(calls, []);
});

function dropImportContext(dropped, desktop = {}) {
  const context = vm.createContext({
    Error,
    applyCanvasSettings, applyNoteSettings, DEFAULT_CANVAS_SETTINGS,
    settingsRef: { current: { ...DEFAULT_NOTE_SETTINGS, canvas: DEFAULT_CANVAS_SETTINGS } },
    getImageDropEffect, hasImageDropData,
    activeId: "a", activeIdRef: { current: "a" }, projectGenerationRef: { current: 1 },
    boardsRef: { current: [board("a", [{ ...preview, id: "a-image" }]), board("b"), board("c")] },
    canvasRef: { current: { clientWidth: 800, clientHeight: 600 } },
    text: (en) => en, window: { museboardDesktop: desktop },
    getCanvasSidebarOffset: () => 0, findOpenImagePosition: () => ({ x: 0, y: 0 }),
    switchBoard: () => assert.fail("Dropping an image must not switch the active saved list"),
    selectedIds: ["a-image"], notices: [], reports: [], imports: [], pendingImports: [],
    undoCount: 0, parseCount: 0, assetDropBoardId: "b", isDraggingFiles: true,
    optimizeStagedImages() {},
  });
  let imageId = 0;
  context.makeId = () => `dropped-image-${++imageId}`;
  context.recordUndoSnapshot = () => { context.undoCount++; };
  context.updateBoard = (id, updater) => {
    context.boardsRef.current = context.boardsRef.current.map((entry) => entry.id === id ? updater(entry) : entry);
  };
  context.setBoards = value => { context.boardsRef.current = typeof value === "function" ? value(context.boardsRef.current) : value; };
  context.setSelectedIds = (value) => { context.selectedIds = value; };
  context.setImportNotice = (notice) => { context.notices.push(notice); };
  context.setAssetDropBoardId = (id) => { context.assetDropBoardId = id; };
  context.setIsDraggingFiles = (value) => { context.isDraggingFiles = value; };
  context.readImageDrop = (transfer) => {
    assert.equal(transfer, context.transfer, "The original transfer must reach the shared parser");
    context.parseCount++;
    return dropped;
  };
  context.transfer = {};
  for (const name of ["addPreparedImages", "reportImportResult", "reportBoardImportResult", "addImageFiles", "addImageUrl", "dragCarriesAssets", "importDroppedImages", "handleBoardAssetDrop", "handleDrop"]) install(context, name);
  const report = context.reportImportResult;
  context.reportImportResult = (count, errors = []) => {
    context.reports.push({ count, errors: plain(errors) });
    report(count, errors);
  };
  for (const name of ["addImageFiles", "addImageUrl"]) {
    const callback = context[name];
    context[name] = (...args) => {
      context.imports.push({ name, args });
      const pending = callback(...args);
      context.pendingImports.push(pending);
      return pending;
    };
  }
  return context;
}

test("board file import appends one reversible list without changing existing image geometry", () => {
  const context = dropImportContext({}), before = plain(context.boardsRef.current);
  Object.assign(context, { pinterestBoardItems, boardFileGenerationRef: { current: 1 }, structuredClone, undoStackRef: { current: [] }, redoStackRef: { current: [] }, setHistoryAvailability() {}, makeEmptyBoard: () => board("imported"), setActiveId(value) { context.activeId = value; }, setShowSettings() {}, setSelectionMarquee() {}, setItemContextMenu() {}, setSearch() {}, setBoardFileImport(value) { context.draft = value; } });
  install(context, "recordUndoSnapshot"); install(context, "commitPinterestBoardFile");
  context.commitPinterestBoardFile("Imported", [{ pin: { imageUrl: "https://i.pinimg.com/a.png", pinUrl: "https://www.pinterest.com/pin/1/", title: "Reference" }, image: { src: "file:///original.png", name: "image.png", width: 300, height: 600 } }]);
  assert.deepEqual(plain(context.boardsRef.current.slice(0, 3)), before); assert.equal(context.boardsRef.current.length, 4); assert.equal(context.activeId, "imported"); assert.equal(context.undoStackRef.current.length, 1); assert.deepEqual(plain(context.undoStackRef.current[0].boards), before);
  const current = plain(context.boardsRef.current); context.projectGenerationRef.current = 2;
  assert.throws(() => context.commitPinterestBoardFile("Stale", [{ image: {} }]), /プロジェクト/); assert.deepEqual(plain(context.boardsRef.current), current); assert.equal(context.undoStackRef.current.length, 1);
});

test("a late board-file picker cannot open in another project or launch a second picker", async () => {
  let finish, calls = 0;
  const context = dropImportContext({}, { openPinterestBoardFile() { calls++; return new Promise(resolve => { finish = resolve; }); } });
  Object.assign(context, { boardFileChoosingRef: { current: false }, boardFileGenerationRef: { current: 0 }, setBoardFileImport() { assert.fail("Old project picker opened a dialog"); } });
  install(context, "choosePinterestBoardFile");
  const first = context.choosePinterestBoardFile(); await context.choosePinterestBoardFile(); assert.equal(calls, 1);
  context.projectGenerationRef.current = 2; finish({ canceled: false, boardFile: { pins: [] } }); await first;
  assert.equal(context.boardFileChoosingRef.current, false);
});

test("extension creation appends one populated list atomically and preserves existing lists and selection", () => {
  let listener;
  const commits = [], completions = [];
  const context = dropImportContext({}, {
    onExtensionImport(callback) { listener = callback; return () => {}; },
    completeExtensionImport(result) { completions.push(plain(result)); },
    publishExtensionState() {},
  });
  context.hydrated = true;
  context.activeWorkspace = "Art";
  context.canvasSettings = { backgroundColor: "#101010", gridVisible: true };
  context.noteColors = ["#333333"];
  context.extensionImportsRef = { current: new Map() };
  context.boards = context.boardsRef.current;
  const before = plain(context.boardsRef.current);
  context.setBoards = (updater) => { context.boardsRef.current = updater(context.boardsRef.current); commits.push(plain(context.boardsRef.current)); };
  install(context, "makeEmptyBoard");
  installPageEffect(context, "onExtensionImport");
  listener({ requestId: "create-request", generation: 1, boardId: "new-id", newBoardName: "  参考資料  ", image: droppedImage, sourceUrl: "https://www.pinterest.com/pin/200/" });
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].slice(0, -1), before);
  const created = commits[0].at(-1);
  assert.equal(created.name, "参考資料");
  assert.equal(created.id, "new-id");
  assert.equal(created.groupName, "Art");
  assert.equal(created.backgroundColor, "#101010");
  assert.equal(created.items.length, 1);
  assert.equal(created.items[0].src, droppedImage.src);
  assert.equal(created.items[0].sourceUrl, "https://www.pinterest.com/pin/200/");
  assert.equal(context.activeId, "a");
  assert.deepEqual(context.selectedIds, ["a-image"]);
  assert.equal(context.undoCount, 1);
  assert.deepEqual(completions, []);
  context.boards = context.boardsRef.current;
  installPageEffect(context, "publishExtensionState");
  assert.equal(completions.length, 1); assert.equal(completions[0].count, 1);
  assert.equal(completions[0].requestId, "create-request");
  assert.equal(completions[0].snapshot.activeId, "a");
  assert.equal(completions[0].snapshot.boards.at(-1).id, "new-id");
  assert.equal(completions[0].snapshot.boards.at(-1).items.length, 1);
});

test("extension creation rejects invalid names, existing list IDs and stale requests without mutation", () => {
  let listener;
  const completions = [];
  const context = dropImportContext({}, {
    onExtensionImport(callback) { listener = callback; return () => {}; },
    completeExtensionImport(result) { completions.push(plain(result)); },
  });
  context.hydrated = true;
  context.extensionImportsRef = { current: new Map() };
  const before = plain(context.boardsRef.current);
  installPageEffect(context, "onExtensionImport");
  const base = { requestId: "request", generation: 1, boardId: "new-id", newBoardName: "新しい資料", image: droppedImage };
  for (const patch of [{ newBoardName: " " }, { newBoardName: "x".repeat(121) }, { newBoardName: "x\u0000x" }, { boardId: "a" }, { generation: 0 }]) listener({ ...base, ...patch });
  assert.equal(completions.length, 5);
  assert(completions.every((result) => result.count === 0));
  assert.deepEqual(plain(context.boardsRef.current), before);
  assert.equal(context.undoCount, 0);
});

test("extension imports commit to the chosen inactive list and acknowledge only after the React state update", () => {
  let listener;
  const completions = [], states = [];
  const context = dropImportContext({}, {
    onExtensionImport(callback) { listener = callback; return () => {}; },
    completeExtensionImport(result) { completions.push(plain(result)); },
    publishExtensionState(state) { states.push(plain(state)); },
  });
  context.hydrated = true;
  context.extensionImportsRef = { current: new Map() };
  context.boards = context.boardsRef.current;
  installPageEffect(context, "onExtensionImport");
  const originalImageUrl = "https://i.pinimg.com/236x/01/23/45/0123456789abcdef0123456789abcdef.jpg";
  listener({ requestId: "native-request", generation: context.projectGenerationRef.current, boardId: "b", image: { ...droppedImage, originalImageUrl }, sourceUrl: "https://www.pinterest.com/pin/200/" });
  assert.equal(context.boardsRef.current[1].items[0].src, droppedImage.src);
  assert.equal(context.boardsRef.current[1].items[0].sourceUrl, "https://www.pinterest.com/pin/200/");
  assert.equal(context.activeId, "a");
  assert.deepEqual(context.selectedIds, ["a-image"]);
  assert.deepEqual(completions, []);
  context.boards = context.boardsRef.current;
  installPageEffect(context, "publishExtensionState");
  assert.equal(completions.length, 1); assert.equal(completions[0].count, 1);
  assert.equal(completions[0].requestId, "native-request");
  assert.equal(completions[0].snapshot.boards[1].items[0].src, droppedImage.src);
  assert.equal(completions[0].snapshot.boards[1].items[0].originalImageUrl, originalImageUrl);
  assert.deepEqual(states[0].boards[1].imageSources, [{ id: context.boardsRef.current[1].items[0].id, imageUrl: originalImageUrl, sourceUrl: "https://www.pinterest.com/pin/200/" }]);
  assert.equal(states[0].boards[1].id, "b");
  assert.equal("items" in states[0].boards[1], false);
});

for (const boardId of ["a", "b"]) test(`extension removal in ${boardId === "a" ? "the active" : "an inactive"} list preserves other items and supports Undo`, () => {
  let remove;
  const replies = [], states = [];
  const context = dropImportContext({}, { onExtensionRemove(callback) { remove = callback; }, completeExtensionImport(result) { replies.push(plain(result)); }, publishExtensionState(state) { states.push(plain(state)); } });
  const imageUrl = "https://example.test/selected.png";
  const selected = { ...preview, id: "remove", originalImageUrl: imageUrl, sourceUrl: "https://example.test/page" };
  context.boardsRef.current.find(board => board.id === boardId).items = [selected, { ...preview, id: "keep" }, { id: "note", type: "note", text: "Keep this note", x: 20, y: 30, w: 100, h: 100 }];
  context.boardsRef.current.find(board => board.id === boardId).frames = [{ id: "mixed", itemIds: ["remove", "keep"] }, { id: "empty", itemIds: ["remove"] }];
  const before = plain(context.boardsRef.current);
  context.selectedIds = boardId === "a" ? ["remove", "keep"] : ["a-image"];
  context.setSelectedIds = value => { context.selectedIds = typeof value === "function" ? value(context.selectedIds) : value; };
  Object.assign(context, { hydrated: true, structuredClone, extensionImportsRef: { current: new Map() }, undoStackRef: { current: [] }, redoStackRef: { current: [] }, setHistoryAvailability() {} });
  install(context, "recordUndoSnapshot"); installPageEffect(context, "onExtensionRemove");
  remove({ requestId: "remove-request", generation: 1, boardId, targets: [{ id: "remove", imageUrl, sourceUrl: selected.sourceUrl }] });
  assert.deepEqual(replies, [], "Must acknowledge only after React commits");
  const target = context.boardsRef.current.find(board => board.id === boardId);
  assert.deepEqual(plain(target.items.map(item => item.id)), ["keep", "note"]);
  assert.deepEqual(plain(target.frames), [{ id: "mixed", itemIds: ["keep"] }]);
  for (const board of before.filter(board => board.id !== boardId)) assert.deepEqual(plain(context.boardsRef.current.find(current => current.id === board.id)), board);
  context.boards = context.boardsRef.current; installPageEffect(context, "publishExtensionState");
  assert.deepEqual(plain(context.selectedIds), boardId === "a" ? ["keep"] : ["a-image"]);
  assert.equal(replies[0].count, 1); assert.equal(replies[0].snapshot.boards.find(board => board.id === boardId).items.some(item => item.id === "remove"), false);
  Object.assign(context, { setBoards(value) { context.boards = value; }, setActiveId() {}, setWorkspaceFilter() {}, setSelectionMarquee() {}, setItemContextMenu() {} });
  install(context, "undoLastChange"); context.undoLastChange();
  assert.deepEqual(plain(context.boardsRef.current), before, "Undo must restore image geometry, groups, and all other lists");
});

test("a stale removal cannot delete a replaced image, a note, or an image in another project", () => {
  let remove;
  const replies = [];
  const context = dropImportContext({}, { onExtensionRemove(callback) { remove = callback; }, completeExtensionImport(result) { replies.push(plain(result)); } });
  context.hydrated = true; context.extensionImportsRef = { current: new Map() };
  context.boardsRef.current[1].items = [{ ...preview, id: "changed", originalImageUrl: "https://example.test/replacement.png" }, { id: "note", type: "note", originalImageUrl: "https://example.test/original.png" }];
  installPageEffect(context, "onExtensionRemove");
  const before = plain(context.boardsRef.current);
  for (const [generation, id] of [[1, "changed"], [1, "note"], [2, "changed"]]) remove({ requestId: "stale", generation, boardId: "b", targets: [{ id, imageUrl: "https://example.test/original.png", sourceUrl: "" }] });
  assert.equal(replies.length, 3); assert(replies.every(reply => reply.count === -1 && !reply.snapshot));
  assert.deepEqual(plain(context.boardsRef.current), before); assert.equal(context.undoCount, 0);
});

test("a queued image replacement is revalidated when the removal commits", () => {
  let remove;
  const replies = [];
  const context = dropImportContext({}, { onExtensionRemove(callback) { remove = callback; }, completeExtensionImport(result) { replies.push(plain(result)); } });
  context.hydrated = true; context.extensionImportsRef = { current: new Map() };
  const imageUrl = "https://example.test/original.png";
  context.boardsRef.current[1].items = [{ ...preview, id: "changed", originalImageUrl: imageUrl }];
  const queued = structuredClone(context.boardsRef.current);
  queued[1].items[0].originalImageUrl = "https://example.test/replacement.png";
  context.updateBoard = (id, updater) => { context.boards = queued.map(board => board.id === id ? updater(board) : board); };
  context.setBoards = updater => { context.boards = updater(queued); };
  installPageEffect(context, "onExtensionRemove");
  remove({ requestId: "queued", generation: 1, boardId: "b", targets: [{ id: "changed", imageUrl, sourceUrl: "" }] });
  assert.equal(context.boards[1].items[0]?.originalImageUrl, "https://example.test/replacement.png");
  installPageEffect(context, "publishExtensionState");
  assert.equal(replies[0].count, -1);
  assert.equal(context.undoCount, 0);
});

test("removal Undo includes queued edits and records only one entry when React retries its updater", () => {
  let remove;
  const replies = [];
  const context = dropImportContext({}, { onExtensionRemove(callback) { remove = callback; }, completeExtensionImport(result) { replies.push(plain(result)); } });
  const imageUrl = "https://example.test/selected.png";
  context.boardsRef.current[1].items = [{ ...preview, id: "remove", originalImageUrl: imageUrl }];
  const queued = structuredClone(context.boardsRef.current);
  queued[0].items[0].x = 777;
  const expected = plain(queued);
  Object.assign(context, { hydrated: true, structuredClone, extensionImportsRef: { current: new Map() }, undoStackRef: { current: [] }, redoStackRef: { current: [] }, setHistoryAvailability() {} });
  context.setBoards = updater => { updater(queued); context.boards = updater(queued); };
  install(context, "recordUndoSnapshot"); installPageEffect(context, "onExtensionRemove");
  remove({ requestId: "retry", generation: 1, boardId: "b", targets: [{ id: "remove", imageUrl, sourceUrl: "" }] });
  assert.equal(context.undoStackRef.current.length, 0);
  installPageEffect(context, "publishExtensionState");
  assert.equal(replies[0].count, 1);
  assert.equal(context.undoStackRef.current.length, 1);
  assert.deepEqual(plain(context.undoStackRef.current[0].boards), expected);
});

test("removing an already absent image still snapshots the current list without adding an undo entry", () => {
  let remove;
  const replies = [];
  const context = dropImportContext({}, { onExtensionRemove(callback) { remove = callback; }, completeExtensionImport(result) { replies.push(plain(result)); } });
  context.hydrated = true; context.extensionImportsRef = { current: new Map() };
  installPageEffect(context, "onExtensionRemove");
  remove({ requestId: "absent", generation: 1, boardId: "b", targets: [] });
  assert.deepEqual(replies, []);
  context.boards = context.boardsRef.current; installPageEffect(context, "publishExtensionState");
  assert.equal(replies[0].count, 0); assert.equal(replies[0].snapshot.boards.length, 3);
  assert.equal(context.undoCount, 0);
});

test("extension requests from an old project are rejected even when the new project reuses a list ID", () => {
  let listener;
  const completions = [];
  const context = dropImportContext({}, {
    onExtensionImport(callback) { listener = callback; return () => {}; },
    completeExtensionImport(result) { completions.push(plain(result)); },
  });
  context.hydrated = true;
  context.extensionImportsRef = { current: new Map() };
  installPageEffect(context, "onExtensionImport");
  const before = plain(context.boardsRef.current);
  listener({ requestId: "old-request", generation: context.projectGenerationRef.current - 1, boardId: "b", image: droppedImage, sourceUrl: "https://example.test/" });
  assert.deepEqual(plain(context.boardsRef.current), before);
  assert.deepEqual(completions, [{ requestId: "old-request", count: 0 }]);
});

test("background image imports use a visible fallback position when settings hides the canvas", () => {
  const context = dropImportContext({});
  context.canvasRef.current = { clientWidth: 0, clientHeight: 0 };
  const positions = [];
  context.findOpenImagePosition = (_occupied, width, height, x, y) => { positions.push([x, y]); return { x: x - width / 2, y: y - height / 2 }; };
  const existing = plain(context.boardsRef.current[0].items);
  context.addPreparedImages([droppedImage], undefined, undefined, "b");
  assert.deepEqual(positions, [[450, 325]]);
  assert.deepEqual(plain(context.boardsRef.current[0].items), existing);
  assert.equal(context.activeId, "a");
});

const droppedImage = { name: "reference.png", src: "file:stored-reference", width: 120, height: 80 };

function dropTargetContext(target, effectAllowed, types = ["text/uri-list", "text/html"]) {
  const context = dropImportContext({ files: [], url: "https://cdn.example.test/reference.png" }, {
    importImageUrl: async () => ({ images: [droppedImage], errors: [] }),
  });
  context.board = context.boardsRef.current[1];
  context.activeBoard = context.boardsRef.current[0];
  context.isDraggingFiles = false;
  context.transfer = { effectAllowed, dropEffect: "none", types, getData: (type) => type === "text/x-imagestorage-board" ? "c" : "" };
  for (const [attribute, name] of [["onDragOver", "targetDragOver"], ["onDrop", "targetDrop"]]) installDropHandler(context, target, attribute, name);
  if (target === "canvas") installDropHandler(context, target, "onDragEnter", "targetDragEnter");
  const event = () => ({
    dataTransfer: context.transfer, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) },
    clientX: 40, clientY: 60,
  });
  return { context, event };
}

for (const target of ["row", "canvas"]) {
  test(`the ${target} drag handlers accept link-only browser images and retain copy imports`, async () => {
    for (const [effectAllowed, expected] of [["link", "link"], ["linkMove", "link"], ["copy", "copy"], ["copyLink", "copy"], ["copyMove", "copy"], ["all", "copy"], ["uninitialized", "copy"]]) {
      const { context, event } = dropTargetContext(target, effectAllowed);
      if (target === "canvas") {
        const enter = event();
        context.targetDragEnter(enter);
        assert.equal(enter.defaultPrevented, true);
        assert.equal(context.isDraggingFiles, true);
      }
      const over = event();
      context.targetDragOver(over);
      assert.equal(over.defaultPrevented, true, `${target}: ${effectAllowed} must allow a drop`);
      assert.equal(context.transfer.dropEffect, expected, `${target}: incompatible effects cancel native drops before onDrop`);
      assert.equal(context.transfer.effectAllowed, effectAllowed);
      if (target === "row") {
        assert.equal(over.propagationStopped, true);
        assert.equal(context.assetDropBoardId, "b");
      }
      context.targetDrop(event());
      await Promise.all(context.pendingImports);
      assert.equal(context.imports.length, 1);
      assert.equal(context.imports[0].args[3], target === "row" ? "b" : "a");
      assert.equal(context.boardsRef.current[target === "row" ? 1 : 0].items.length, target === "row" ? 1 : 2);
      assert.equal(context.activeId, "a");
    }
  });

  test(`the ${target} drag handlers reject none and move-only sources without advertising an import`, () => {
    for (const effectAllowed of ["none", "move"]) {
      const { context, event } = dropTargetContext(target, effectAllowed);
      if (target === "canvas") {
        const enter = event();
        context.targetDragEnter(enter);
        assert.equal(enter.defaultPrevented, false);
        assert.equal(context.isDraggingFiles, false);
        context.isDraggingFiles = true;
      }
      const over = event();
      context.targetDragOver(over);
      assert.equal(over.defaultPrevented, false);
      assert.equal(context.transfer.dropEffect, "none");
      assert.equal(context.transfer.effectAllowed, effectAllowed);
      assert.equal(target === "row" ? context.assetDropBoardId : context.isDraggingFiles, target === "row" ? null : false);
      assert.equal(context.imports.length, 0);
    }
  });
}

test("sidebar and canvas reject saved-list move payloads without reordering or importing them", () => {
  const types = ["text/x-imagestorage-board", "text/plain"];
  for (const target of ["row", "canvas"]) {
    const { context, event } = dropTargetContext(target, "move", types);
    const before = plain(context.boardsRef.current);
    context.getImageDropEffect = () => assert.fail("Saved-list moves are not external images");
    const over = event();
    context.targetDragOver(over);
    assert.equal(over.defaultPrevented, false);
    assert.equal(context.transfer.dropEffect, "none");
    context.targetDrop(event());
    assert.deepEqual(plain(context.boardsRef.current), before);
    assert.equal(context.imports.length, 0);
  }
});

for (const kind of ["files", "url"]) {
  test(`a ${kind} drop imports into an explicit inactive list without switching or changing selection`, async () => {
    const file = { name: "reference.png" };
    const url = "https://example.test/reference.png";
    const nativeCalls = [];
    const context = dropImportContext({ files: kind === "files" ? [file] : [], url }, {
      getPathForFile: (value) => { assert.equal(value, file); return "C:\\images\\reference.png"; },
      stageImageFiles: async (paths) => { nativeCalls.push(plain(paths)); return { images: [droppedImage], errors: [] }; },
      importImageUrl: async (value) => { nativeCalls.push(value); return { images: [droppedImage], errors: [] }; },
    });
    context.importDroppedImages(context.transfer, "b", 125, 250);
    await Promise.all(context.pendingImports);
    assert.equal(context.imports.length, 1, "Files take priority over an accompanying browser URL");
    assert.equal(context.imports[0].name, kind === "files" ? "addImageFiles" : "addImageUrl");
    assert.deepEqual(context.imports[0].args.slice(1), [125, 250, "b"]);
    assert.deepEqual(nativeCalls, kind === "files" ? [["C:\\images\\reference.png"]] : [url]);
    assert.equal(context.activeId, "a");
    assert.equal(context.activeIdRef.current, "a");
    assert.deepEqual(context.selectedIds, ["a-image"]);
    assert.equal(context.boardsRef.current[0].items.length, 1);
    const added = context.boardsRef.current[1].items[0];
    assert.equal(added.src, droppedImage.src);
    assert.equal(added.x + added.w / 2, 125);
    assert.equal(added.y + added.h / 2, 250);
    assert.equal(added.sourceUrl, kind === "url" ? url : undefined);
    assert.equal(context.undoCount, 1);
    assert.equal(context.assetDropBoardId, null);
    assert.equal(context.isDraggingFiles, false);
    assert.match(context.notices.at(-1), /1 image saved to b/);
  });
}

for (const error of ["empty", "browser-only"]) {
  test(`an ${error} image drop explains how to retry without starting an import`, () => {
    const context = dropImportContext({ files: [], url: null, error });
    context.importDroppedImages(context.transfer, "b");
    assert.equal(context.parseCount, 1);
    assert.equal(context.imports.length, 0);
    assert.equal(context.undoCount, 0);
    assert.equal(context.assetDropBoardId, null);
    assert.equal(context.isDraggingFiles, false);
    assert.deepEqual(context.selectedIds, ["a-image"]);
    assert.match(context.notices.at(-1), error === "browser-only" ? /Save the image, then drop the file/ : /Try dragging the image itself or its saved file/);
  });
}

test("a saved-list drop consumes the event so the canvas cannot import the same image again", async () => {
  const context = dropImportContext({ files: [], url: "https://example.test/reference.png" }, {
    importImageUrl: async () => ({ images: [droppedImage], errors: [] }),
  });
  const event = {
    dataTransfer: context.transfer, defaultPrevented: false, propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    currentTarget: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, clientX: 40, clientY: 60,
  };
  context.activeBoard = context.boardsRef.current[0];
  context.dragCarriesAssets = () => true;
  context.handleBoardAssetDrop(event, "b");
  // Model DOM bubbling: the canvas callback is reached only if the row did not consume the drop.
  if (!event.propagationStopped) context.handleDrop(event);
  await Promise.all(context.pendingImports);
  assert.equal(event.defaultPrevented, true, "Prevent browser navigation to the dropped image");
  assert.equal(event.propagationStopped, true);
  assert.equal(context.parseCount, 1);
  assert.equal(context.imports.length, 1);
  assert.equal(context.boardsRef.current[0].items.length, 1);
  assert.equal(context.boardsRef.current[1].items.length, 1);
  assert.deepEqual(context.selectedIds, ["a-image"]);
});

test("a rejected URL import resolves safely and replaces the loading notice with the import error", async () => {
  const context = dropImportContext({ files: [] }, {
    importImageUrl: async () => { throw new Error("The image server refused this download"); },
  });
  const pending = context.addImageUrl("https://example.test/refused.png", undefined, undefined, "b");
  assert.equal(context.notices[0], "Loading image…");
  await assert.doesNotReject(pending, "A dropped URL is fire-and-forget, so IPC failures must be caught");
  assert.deepEqual(context.reports, [{ count: 0, errors: [{ name: "URL", message: "The image server refused this download" }] }]);
  assert.match(context.notices.at(-1), /Could not import URL: The image server refused this download/);
  assert.equal(context.undoCount, 0);
  assert.equal(context.boardsRef.current[1].items.length, 0);
});

test("unreadable browser files report failure instead of silently skipping the import", async () => {
  const context = dropImportContext({ files: [{ name: "browser-link.url", arrayBuffer: async () => { throw new Error("Unreadable file"); } }] }, {
    getPathForFile: () => "",
    stageImageFiles: () => assert.fail("A virtual browser file has no native path"),
    convertImageFiles: () => assert.fail("Unreadable bytes must not be converted"),
  });
  context.prepareImagePreview = async () => { throw new Error("Not an image"); };
  context.importDroppedImages(context.transfer, "b");
  await Promise.all(context.pendingImports);
  assert.deepEqual(context.reports, [{ count: 0, errors: [{ name: "browser-link.url", message: "Unreadable file" }] }]);
  assert.match(context.notices.at(-1), /Could not import browser-link\.url/);
  assert.equal(context.boardsRef.current[1].items.length, 0);
  assert.equal(context.undoCount, 0);
});

test("mixed readable and unreadable browser files import the image and report the skipped file", async () => {
  const goodFile = { name: "reference.png", arrayBuffer: async () => new ArrayBuffer(0) };
  let converted;
  const context = dropImportContext({ files: [{ name: "broken.png" }, goodFile] }, {
    convertImageFiles: async (payload) => {
      converted = payload;
      return { images: [{ ...droppedImage, clientId: payload[0].id }], errors: [] };
    },
  });
  context.prepareImagePreview = async (file) => {
    if (file !== goodFile) throw new Error("Broken image");
    return droppedImage;
  };
  context.requestAnimationFrame = (callback) => callback();
  context.applyProcessedImages = () => {};
  context.importDroppedImages(context.transfer, "b");
  await Promise.all(context.pendingImports);
  assert.equal(converted.length, 1);
  assert.equal(converted[0].name, "reference.png");
  assert.equal(context.boardsRef.current[1].items.length, 1);
  assert.match(context.notices.at(-1), /1 image saved to b · 1 skipped/);
  assert.equal(context.boardsRef.current[0].items.length, 1);
  assert.deepEqual(context.selectedIds, ["a-image"]);
});

test("failed virtual-file storage never inserts a session blob or records a successful import", async () => {
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const bytes = new ArrayBuffer(4);
  const context = dropImportContext({}, {
    convertImageFiles: () => new Promise((resolve) => { finish = resolve; started(); }),
  });
  context.prepareImagePreview = () => assert.fail("Desktop imports must not insert blob previews");
  const pending = context.addImageFiles([{ name: "clipboard.png", arrayBuffer: async () => bytes }], undefined, undefined, "b");
  await waiting;
  assert.equal(context.boardsRef.current[1].items.length, 0);
  finish({ images: [], errors: [{ name: "clipboard.png", message: "ENOSPC" }] });
  await pending;
  assert.equal(context.boardsRef.current[1].items.length, 0);
  assert.equal(context.undoCount, 0);
  assert.match(context.notices.at(-1), /ENOSPC/);
});

test("virtual images enter the board and history only after durable storage succeeds", async () => {
  let finish;
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const context = dropImportContext({}, { convertImageFiles: () => new Promise((resolve) => { finish = resolve; started(); }) });
  const pending = context.addImageFiles([{ name: "clipboard.png", arrayBuffer: async () => new ArrayBuffer(4) }], 30, 40, "b");
  await waiting;
  assert.equal(context.undoCount, 0);
  finish({ images: [{ ...droppedImage, src: "file:stored-original" }], errors: [] });
  await pending;
  assert.equal(context.boardsRef.current[1].items[0].src, "file:stored-original");
  assert.equal(context.undoCount, 1);
});

for (const kind of ["files", "url"]) {
  test(`an awaited ${kind} drop retains its explicit target after the active list changes`, async () => {
    let finish;
    const waiting = new Promise((resolve) => { finish = resolve; });
    const context = dropImportContext({ files: kind === "files" ? [{ name: "reference.png" }] : [], url: "https://example.test/reference.png" }, {
      getPathForFile: () => "C:\\images\\reference.png", stageImageFiles: () => waiting, importImageUrl: () => waiting,
    });
    context.importDroppedImages(context.transfer, "b");
    assert.equal(context.boardsRef.current[1].items.length, 0, "Import waits for native image preparation");
    context.activeId = "c";
    context.activeIdRef.current = "c";
    context.selectedIds = ["c-image"];
    finish({ images: [droppedImage], errors: [] });
    await Promise.all(context.pendingImports);
    assert.equal(context.activeId, "c");
    assert.deepEqual(context.selectedIds, ["c-image"]);
    assert.equal(context.boardsRef.current[1].items.length, 1);
    assert.equal(context.boardsRef.current[2].items.length, 0);
    assert.match(context.notices.at(-1), /1 image saved to b/);
  });
}

for (const kind of ["native files", "browser files", "url"]) {
  test(`a ${kind} import finishing after its target list is removed reports zero instead of success`, async () => {
    let finish;
    const waiting = new Promise((resolve) => { finish = resolve; });
    const desktop = kind === "native files"
      ? { getPathForFile: () => "C:\\images\\reference.png", stageImageFiles: () => waiting }
      : kind === "url" ? { importImageUrl: () => waiting } : {};
    const context = dropImportContext({ files: kind === "url" ? [] : [{ name: "reference.png" }], url: "https://example.test/reference.png" }, desktop);
    context.prepareImagePreview = () => waiting;
    context.optimizeStagedImages = () => assert.fail("No image should be optimized for a deleted target");
    context.importDroppedImages(context.transfer, "b");
    context.boardsRef.current = context.boardsRef.current.filter((entry) => entry.id !== "b");
    finish(kind === "browser files" ? droppedImage : { images: [droppedImage], errors: [] });
    await Promise.all(context.pendingImports);
    assert.equal(context.undoCount, 0, "A missing destination must not create an undo entry");
    assert.deepEqual(context.selectedIds, ["a-image"]);
    assert.equal(context.boardsRef.current[0].items.length, 1);
    assert.deepEqual(context.reports, [{ count: 0, errors: [] }]);
    assert.equal(context.notices.at(-1), "No readable image was found");
  });
}

test("a stale header file picker cannot reopen an editor over a replacement project", async () => {
  let finish;
  const opened = [];
  const context = vm.createContext({
    projectGenerationRef: { current: 1 },
    headerImageRequestRef: { current: 0 }, listManagerSessionRef: { current: 0 },
    setHeaderImageError() {},
    window: { museboardDesktop: { chooseImageFiles: () => new Promise((resolve) => { finish = resolve; }) } },
    setHeaderImageDraft: (value) => opened.push(value),
  });
  install(context, "chooseHeaderImage");
  const pending = context.chooseHeaderImage("a");
  context.projectGenerationRef.current++;
  finish({ images: [{ src: "file:old-project" }] });
  await pending;
  assert.deepEqual(opened, []);
});

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

const stagedBackground = { src: "file:staged", thumbnailSrc: "file:staged-thumb", assetId: "staged-asset", processing: true, name: "background" };
const optimizedBackground = { src: "file:optimized", thumbnailSrc: "file:optimized-thumb", assetId: "optimized-asset" };
const clearBackground = { backgroundImageSrc: undefined, backgroundImageThumbnailSrc: undefined, backgroundImageAssetId: undefined };

function backgroundContext(desktop) {
  const context = settingsContext(JSON.stringify({ canvas: {
    ...DEFAULT_CANVAS_SETTINGS, gridVisible: true, gridSize: 70, backgroundFit: "contain", backgroundColor: "#123456",
  } }));
  context.settings = context.readSettings();
  context.backgroundRequestRef = { current: 0 };
  context.projectGenerationRef = { current: 1 };
  context.activeIdRef = { current: "a" };
  context.boardsRef = { current: [board("a", [structuredClone(preview)])] };
  context.undoStackRef = { current: [] };
  context.redoStackRef = { current: [] };
  context.window.museboardDesktop = desktop;
  context.closeListManager = () => {};
  context.setHeaderImageDraft = () => {};
  context.setHeaderImageError = () => {};
  context.setSettings = (value) => { context.settings = typeof value === "function" ? value(context.settings) : value; };
  context.setBoards = (value) => { context.boardsRef.current = value; };
  context.setSidebarCollapsed = (value) => { context.sidebarCollapsed = value; };
  for (const name of ["setHistoryAvailability", "setWorkspaceFilter", "setCollapsedGroups", "setActiveId",
    "setSelectedIds", "setSelectionMarquee", "setItemContextMenu", "setShowListManager", "setListManagerDraft", "setPendingDeleteBoardId"]) {
    context[name] = () => {};
  }
  for (const name of ["DEFAULT_GUIDE_COLOR", "migrateAnalysisGuideColor", "migrateBoardAnalysisGuides"]) install(context, name, editor);
  for (const name of ["pickBoardVisual", "updateCanvasSettings", "resetSettings", "handleProjectLoad"]) install(context, name);
  return context;
}

function replaceProject(context) {
  const replacement = { ...board("b", [{ id: "new-project-image", src: "file:new-project" }]), backgroundImageSrc: "file:project-specific-legacy" };
  context.handleProjectLoad({ detail: { format: "museboard", activeId: "b", boards: [replacement] } });
  return replacement;
}

test("background selection updates shared settings and preserves other appearance and board content", async () => {
  const conversion = deferred();
  const context = backgroundContext({
    chooseImageFiles: async () => ({ images: [stagedBackground] }),
    optimizeStagedImages: () => conversion.promise,
  });
  const originalBoards = structuredClone(context.boardsRef.current);
  const pending = context.pickBoardVisual();
  await new Promise(setImmediate);
  assert.equal(context.settings.canvas.backgroundImageSrc, stagedBackground.src);
  context.updateCanvasSettings({ gridSize: 95, backgroundFit: "tile" });
  conversion.resolve({ results: [{ image: optimizedBackground }] });
  await pending;
  assert.deepEqual(context.settings.canvas, {
    ...DEFAULT_CANVAS_SETTINGS, gridVisible: true, gridSize: 95, backgroundFit: "tile", backgroundColor: "#123456",
    backgroundImageSrc: optimizedBackground.src, backgroundImageThumbnailSrc: optimizedBackground.thumbnailSrc,
    backgroundImageAssetId: optimizedBackground.assetId,
  });
  assert.deepEqual(plain(context.boardsRef.current), originalBoards);
});

test("clearing a shared background prevents a pending optimization from restoring it", async () => {
  const conversion = deferred();
  const context = backgroundContext({ chooseImageFiles: async () => ({ images: [stagedBackground] }), optimizeStagedImages: () => conversion.promise });
  const pending = context.pickBoardVisual();
  await new Promise(setImmediate);
  assert.equal(context.settings.canvas.backgroundImageSrc, stagedBackground.src);
  context.updateCanvasSettings(clearBackground);
  const cleared = context.settings.canvas;
  conversion.resolve({ results: [{ image: optimizedBackground }] });
  await pending;
  assert.equal(context.settings.canvas, cleared);
  for (const key of Object.keys(clearBackground)) assert.equal(context.settings.canvas[key], undefined);
  assert.equal(context.settings.canvas.gridSize, 70);
});

test("resetting shared settings invalidates a pending background optimization", async () => {
  const conversion = deferred();
  const context = backgroundContext({ chooseImageFiles: async () => ({ images: [stagedBackground] }), optimizeStagedImages: () => conversion.promise });
  const pending = context.pickBoardVisual();
  await new Promise(setImmediate);
  context.resetSettings();
  conversion.resolve({ results: [{ image: optimizedBackground }] });
  await pending;
  assert.deepEqual(context.settings.canvas, DEFAULT_CANVAS_SETTINGS);
  assert.equal(context.sidebarCollapsed, false);
});

test("clearing or resetting while the file picker is pending discards the late choice", async () => {
  for (const action of ["clear", "reset"]) {
    const picker = deferred();
    let optimized = false;
    const context = backgroundContext({ chooseImageFiles: () => picker.promise, optimizeStagedImages: async () => { optimized = true; return { results: [] }; } });
    const pending = context.pickBoardVisual();
    if (action === "clear") context.updateCanvasSettings(clearBackground);
    else context.resetSettings();
    const expected = context.settings;
    picker.resolve({ images: [stagedBackground] });
    await pending;
    assert.equal(context.settings, expected, `${action} must discard the pending file choice`);
    assert.equal(optimized, false);
  }
});

test("project import invalidates both pending picker and optimization results without changing global appearance", async () => {
  for (const phase of ["picker", "optimization"]) {
    const picker = deferred(), conversion = deferred();
    let optimized = false;
    const context = backgroundContext({
      chooseImageFiles: () => phase === "picker" ? picker.promise : Promise.resolve({ images: [stagedBackground] }),
      optimizeStagedImages: () => { optimized = true; return conversion.promise; },
    });
    const pending = context.pickBoardVisual();
    await new Promise(setImmediate);
    const expectedSettings = context.settings;
    const replacement = replaceProject(context);
    assert.equal(context.projectGenerationRef.current, 2, "Real project-load callback advances the generation");
    if (phase === "picker") picker.resolve({ images: [stagedBackground] });
    else conversion.resolve({ results: [{ image: optimizedBackground }] });
    await pending;
    assert.equal(context.settings, expectedSettings);
    assert.deepEqual(plain(context.boardsRef.current), [replacement]);
    assert.equal(optimized, phase === "optimization");
  }
});

test("a newer background picker wins even when an older picker resolves last", async () => {
  const first = deferred(), second = deferred();
  let picks = 0;
  const context = backgroundContext({ chooseImageFiles: () => (++picks === 1 ? first.promise : second.promise) });
  const older = context.pickBoardVisual();
  const newer = context.pickBoardVisual();
  second.resolve({ images: [{ src: "file:new-choice", assetId: "new-choice" }] });
  await newer;
  first.resolve({ images: [{ src: "file:old-choice", assetId: "old-choice" }] });
  await older;
  assert.equal(context.settings.canvas.backgroundImageSrc, "file:new-choice");
  assert.equal(context.settings.canvas.backgroundImageAssetId, "new-choice");
});

test("a newer optimization wins even when both selections use the same staged source", async () => {
  const first = deferred(), second = deferred();
  let conversions = 0;
  const context = backgroundContext({
    chooseImageFiles: async () => ({ images: [stagedBackground] }),
    optimizeStagedImages: () => (++conversions === 1 ? first.promise : second.promise),
  });
  const older = context.pickBoardVisual();
  await new Promise(setImmediate);
  const newer = context.pickBoardVisual();
  await new Promise(setImmediate);
  second.resolve({ results: [{ image: { ...optimizedBackground, src: "file:newest" } }] });
  await newer;
  first.resolve({ results: [{ image: { ...optimizedBackground, src: "file:obsolete" } }] });
  await older;
  assert.equal(context.settings.canvas.backgroundImageSrc, "file:newest");
});

test("switching lists clears context actions belonging to the previous list", () => {
  const context = vm.createContext({ web: { selectBoard() {} }, selectedIds: ["old"], itemContextMenu: { itemId: "old" }, marquee: {}, showSettings: true, settingsTabOpen: true });
  context.setShowSettings = (value) => { context.showSettings = value; };
  context.setActiveId = (value) => { context.activeId = value; };
  context.setSelectedIds = (value) => { context.selectedIds = value; };
  context.setSelectionMarquee = (value) => { context.marquee = value; };
  context.setItemContextMenu = (value) => { context.itemContextMenu = value; };
  install(context, "switchBoard");
  context.switchBoard("b");
  assert.equal(context.activeId, "b");
  assert.equal(context.showSettings, false);
  assert.equal(context.settingsTabOpen, true, "Switching to a list keeps the settings tab available");
  assert.equal(context.itemContextMenu, null);
  assert.equal(context.marquee, null);
  assert.equal(context.selectedIds.length, 0);
});

test("settings opens as one temporary tab, survives list switching, and can close and reopen", () => {
  const context = vm.createContext({
    showSettings: false, settingsTabOpen: false, activeId: "a", web: { selectBoard() {} },
    window: { requestAnimationFrame: () => 0 },
    document: { querySelector: () => null },
    setSelectedIds() {}, setSelectionMarquee() {}, setItemContextMenu() {},
  });
  for (const [setter, field] of Object.entries({
    setShowSettings: "showSettings", setSettingsTabOpen: "settingsTabOpen", setActiveId: "activeId",
  })) context[setter] = (value) => { context[field] = typeof value === "function" ? value(context[field]) : value; };
  for (const name of ["openSettingsPage", "closeSettingsPage", "switchBoard"]) install(context, name);
  context.openSettingsPage();
  context.openSettingsPage();
  assert.equal(context.settingsTabOpen, true);
  assert.equal(context.showSettings, true);
  assert.equal(context.activeId, "a", "Opening settings retains the selected saved list");

  context.switchBoard("b");
  assert.equal(context.settingsTabOpen, true);
  assert.equal(context.showSettings, false);
  assert.equal(context.activeId, "b");
  context.closeSettingsPage();
  assert.equal(context.settingsTabOpen, false);
  assert.equal(context.showSettings, false);
  assert.equal(context.activeId, "b", "Closing the inactive settings tab does not switch saved lists");

  context.openSettingsPage();
  assert.equal(context.settingsTabOpen, true);
  assert.equal(context.showSettings, true);
  context.closeSettingsPage();
  assert.equal(context.settingsTabOpen, false);
  assert.equal(context.showSettings, false);
  assert.equal(context.activeId, "b", "Closing selected settings returns to the latest saved list");
});

function listManagerContext(initial = [board("a"), board("b"), board("c")]) {
  let nextId = 0;
  const frames = new Map();
  const scheduler = { request(callback) { const id = ++nextId; frames.set(id, callback); return id; }, cancel(id) { frames.delete(id); } };
  const eventTarget = () => {
    const listeners = new Map();
    return {
      addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
      dispatch(type, event = {}) { for (const callback of [...(listeners.get(type) ?? [])]) callback(event); return event; },
      listenerCount() { return [...listeners.values()].reduce((sum, callbacks) => sum + callbacks.size, 0); },
    };
  };
  const createElement = () => ({ style: {}, children: [], removed: false,
    setAttribute() {}, append(child) { this.children.push(child); }, remove() { this.removed = true; } });
  const context = vm.createContext({
    structuredClone, boards: structuredClone(initial), activeId: initial[0].id,
    canvasSettings: { ...DEFAULT_CANVAS_SETTINGS },
    boardsRef: { current: structuredClone(initial) }, activeIdRef: { current: initial[0].id },
    undoStackRef: { current: [] }, redoStackRef: { current: [] },
    showListManager: false, listManagerDraft: [], pendingDeleteBoardId: null,
    listManagerBaseRef: { current: [] }, listManagerSessionRef: { current: 0 },
    listManagerDragRef: { current: null }, listManagerDropTargetRef: { current: null },
    listManagerPointerDragRef: { current: null }, listManagerGhostRef: { current: null },
    listManagerIndicatorRef: { current: null },
    listManagerPreviewDragRef: { current: null },
    listManagerAutoScrollRef: { current: null },
    listManagerContentRef: { current: null },
    headerImageRequestRef: { current: 0 }, headerImageDragRef: { current: null },
    projectGenerationRef: { current: 1 }, headerImageDraft: null,
    clearListHeader, mergeListManagerEntry, getListManagerDropTarget, createListManagerPointerDrag,
    createListManagerAutoScroll: (host, isDragging, onScroll) => createListManagerAutoScroll(host, isDragging, onScroll, scheduler),
    activeWorkspace: null, workspaceFilter: null, selectedIds: ["existing-selection"],
    search: "", showSettings: false, collapsedGroups: new Set(), web: { selectBoard() {} },
    useMemo: (factory) => factory(),
    window: { ...eventTarget(), requestAnimationFrame: () => 0 },
    document: { ...eventTarget(), hidden: false, querySelector: () => null, createElement, body: createElement() },
    noteColors: ["#aabbcc"], text: (english) => english, makeId: () => `empty-${++nextId}`,
    setSelectionMarquee() {}, setItemContextMenu() {},
  });
  for (const [setter, field] of Object.entries({
    setShowListManager: "showListManager", setListManagerDraft: "listManagerDraft",
    setPendingDeleteBoardId: "pendingDeleteBoardId", setWorkspaceFilter: "workspaceFilter",
    setSelectedIds: "selectedIds", setHistoryAvailability: "historyAvailability",
    setSearch: "search", setShowSettings: "showSettings", setCollapsedGroups: "collapsedGroups",
    setHeaderImageDraft: "headerImageDraft", setImportNotice: "importNotice",
    setHeaderImageError: "headerImageError",
    setListManagerDraggedId: "listManagerDraggedId", setListManagerDropTarget: "listManagerDropTarget",
  })) context[setter] = (value) => { context[field] = typeof value === "function" ? value(context[field]) : value; };
  context.setBoards = (value) => {
    context.boards = typeof value === "function" ? value(context.boards) : value;
    context.boardsRef.current = context.boards;
  };
  context.setActiveId = (value) => { context.activeId = value; context.activeIdRef.current = value; };
  context.managerScrollOffset = 0;
  context.managerFrames = frames;
  context.listManagerContentRef.current = {
    ...eventTarget(),
    get scrollTop() { return context.managerScrollOffset; },
    set scrollTop(value) { context.managerScrollOffset = value; },
    scrollHeight: 2000, clientHeight: 1000,
    getBoundingClientRect: () => ({ left: 0, right: 500, top: 0, bottom: 1000, height: 1000 }),
    querySelectorAll: () => context.listManagerDraft.map((board, index) => ({ dataset: { boardId: board.id },
      querySelector: (selector) => selector === ".list-manager-name" ? { value: board.name } : { cloneNode: () => ({ preview: board.id }) },
      getBoundingClientRect: () => ({ left: 18, right: 482, width: 464,
        top: 100 + index * 110 - context.managerScrollOffset, bottom: 200 + index * 110 - context.managerScrollOffset }) })),
  };
  for (const name of ["makeEmptyBoard", "recordUndoSnapshot", "undoLastChange", "redoLastChange", "removeBoard",
    "openListManager", "endListManagerDrag", "closeListManager", "confirmBoardDeletion", "saveListManager", "addListManagerBoard", "moveListManagerBoard",
    "commitListManagerDrop",
    "getListManagerDragTarget", "updateListManagerDragTarget",
    "prepareListManagerDrag", "openListManagerPreview",
    "HEADER_IMAGE_ASPECT_RATIO", "HEADER_IMAGE_DEFAULT_POSITION", "HEADER_IMAGE_MIN_SCALE", "HEADER_IMAGE_MAX_SCALE",
    "clamp", "getHeaderImageLayout", "constrainHeaderImageDraft", "cancelHeaderImageEditor", "chooseHeaderImage",
    "openHeaderImageEditor", "applyHeaderImage", "restoreHeaderImageList", "updateBoard"]) install(context, name);
  let managerEffect;
  const findEffect = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(page) === "useEffect" && node.arguments[0]?.getText(page).includes("createListManagerPointerDrag({")) managerEffect = node.arguments[0];
    if (!managerEffect) ts.forEachChild(node, findEffect);
  };
  findEffect(page);
  assert.ok(managerEffect, "Missing manager pointer lifecycle effect");
  vm.runInContext(ts.transpileModule(`globalThis.mountListManagerDrag = ${managerEffect.getText(page)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText, context);
  return context;
}

test("new empty lists inherit shared canvas appearance without inheriting legacy board overrides", () => {
  const context = listManagerContext([{ ...board("a", [preview]), gridVisible: false, backgroundImageSrc: "file:legacy-board" }]);
  context.canvasSettings = normalizeCanvasSettings({
    gridVisible: true, snapEnabled: true, gridSize: 85, backgroundColor: "#234567", backgroundFit: "contain",
    backgroundImageSrc: "file:shared", backgroundImageThumbnailSrc: "file:shared-thumb", backgroundImageAssetId: "shared-asset",
  });
  const created = context.makeEmptyBoard();
  assert.deepEqual(normalizeCanvasSettings(created), context.canvasSettings);
  assert.equal(created.items.length, 0);
  assert.equal(created.frames.length, 0);
  assert.deepEqual(plain(created.viewport), { x: 80, y: 70, scale: 1 });
  assert.equal(context.boards[0].backgroundImageSrc, "file:legacy-board");
  context.canvasSettings = { ...DEFAULT_CANVAS_SETTINGS };
  const cleared = context.makeEmptyBoard();
  for (const key of Object.keys(clearBackground)) {
    assert.ok(Object.hasOwn(cleared, key));
    assert.equal(cleared[key], undefined);
  }
});

test("new lists append after grouped and ungrouped lists without changing stored or visible relative order", () => {
  const initial = [{ ...board("a"), groupName: "Art" }, board("b"), { ...board("c"), groupName: "Art" }, { ...board("d"), groupName: "Design" }];
  const context = listManagerContext(initial);
  context.search = "previous search";
  context.showSettings = true;
  install(context, "createBoard");
  context.createBoard();
  const created = context.boards.at(-1);
  assert.deepEqual(plain(context.boards.slice(0, -1)), initial);
  assert.equal(context.activeId, created.id);
  assert.equal(created.groupName, undefined);
  assert.equal(context.search, "");
  assert.equal(context.showSettings, false);
  install(context, "filteredBoards");
  assert.deepEqual(plain(context.filteredBoards.map(({ id }) => id)), [...initial.map(({ id }) => id), created.id]);
  context.undoLastChange();
  assert.deepEqual(plain(context.boards), initial);
});

test("creating in a collapsed workspace reveals the appended list and leaves other groups collapsed", () => {
  const context = listManagerContext([{ ...board("a"), groupName: "Art" }, board("b"), { ...board("c"), groupName: "Art" }]);
  context.activeWorkspace = "Art";
  context.workspaceFilter = "Art";
  context.collapsedGroups = new Set(["Art", "Design"]);
  install(context, "createBoard");
  context.createBoard();
  const created = context.boards.at(-1);
  assert.equal(created.groupName, "Art");
  assert.equal(context.collapsedGroups.has("Art"), false);
  assert.equal(context.collapsedGroups.has("Design"), true);
  install(context, "filteredBoards");
  assert.deepEqual(plain(context.filteredBoards.map(({ id }) => id)), ["a", "c", created.id]);
});

test("saving list-manager drag order updates all-list, workspace, and search views", () => {
  const context = listManagerContext([{ ...board("a"), groupName: "Art" }, board("b"), { ...board("c"), groupName: "Art" }, { ...board("d"), groupName: "Design" }]);
  context.openListManager();
  context.listManagerDropTargetRef.current = { boardId: "a", edge: "before" };
  context.commitListManagerDrop("c");
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["c", "a", "b", "d"]);
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b", "c", "d"], "Draft ordering waits for Save");
  context.saveListManager();
  install(context, "filteredBoards");
  assert.deepEqual(plain(context.filteredBoards.map(({ id }) => id)), ["c", "a", "b", "d"]);
  context.activeWorkspace = "Art";
  install(context, "filteredBoards");
  assert.deepEqual(plain(context.filteredBoards.map(({ id }) => id)), ["c", "a"]);
  context.activeWorkspace = null;
  context.search = "art";
  install(context, "filteredBoards");
  assert.deepEqual(plain(context.filteredBoards.map(({ id }) => id)), ["c", "a"]);
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["c", "a", "b", "d"], "Filtering never mutates stored order");
});

test("list manager cancels draft names and confirmed deletions without changing saved lists", () => {
  const context = listManagerContext();
  const before = plain(context.boards);
  context.openListManager();
  context.listManagerDraft[0].name = "Draft name";
  context.pendingDeleteBoardId = "b";
  context.confirmBoardDeletion("b");
  assert.equal(context.pendingDeleteBoardId, null);
  assert.equal(context.listManagerDraft.length, 2);
  assert.deepEqual(plain(context.boards), before);
  context.closeListManager();
  assert.equal(context.showListManager, false);
  assert.equal(context.listManagerDraft.length, 0);
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.undoStackRef.current.length, 0);
  context.openListManager();
  assert.deepEqual(plain(context.listManagerDraft), before);
});

test("saving multiple names and a deletion forms one reversible history entry and preserves current resources", () => {
  const context = listManagerContext();
  context.openListManager();
  context.listManagerDraft[0].name = "  Renamed A  ";
  context.listManagerDraft[2].name = "Renamed C";
  context.confirmBoardDeletion("b");
  context.setBoards(context.boards.map((entry) => entry.id === "a" ? { ...entry, items: [{ ...preview, src: "file:completed", processing: false }] } : entry));
  const before = plain(context.boards);
  context.saveListManager();
  assert.deepEqual(plain(context.boards.map(({ id, name }) => ({ id, name }))), [{ id: "a", name: "Renamed A" }, { id: "c", name: "Renamed C" }]);
  assert.equal(context.boards[0].items[0].src, "file:completed");
  assert.equal(context.selectedIds[0], "existing-selection");
  assert.equal(context.undoStackRef.current.length, 1);
  assert.equal(context.showListManager, false);
  const after = plain(context.boards);
  context.undoLastChange();
  assert.deepEqual(plain(context.boards), before);
  context.redoLastChange();
  assert.deepEqual(plain(context.boards), after);
});

test("deleting the active list selects another member of the current workspace", () => {
  const context = listManagerContext([{ ...board("a"), groupName: "Art" }, board("b"), { ...board("c"), groupName: "Art" }]);
  context.activeWorkspace = "Art";
  context.workspaceFilter = "Art";
  context.openListManager();
  context.confirmBoardDeletion("a");
  context.saveListManager();
  assert.equal(context.activeId, "c");
  assert.equal(context.workspaceFilter, "Art");
  assert.equal(context.selectedIds.length, 0);
});

test("deleting every list creates one empty valid list and Undo restores the removed content", () => {
  const context = listManagerContext([{ ...board("a", [preview]), groupName: "Art" }]);
  context.activeWorkspace = "Art";
  context.workspaceFilter = "Art";
  const before = plain(context.boards);
  context.openListManager();
  context.confirmBoardDeletion("a");
  context.saveListManager();
  assert.equal(context.boards.length, 1);
  assert.notEqual(context.boards[0].id, "a");
  assert.equal(context.boards[0].id, context.activeId);
  assert.equal(context.boards[0].items.length, 0);
  assert.equal(context.boards[0].frames.length, 0);
  assert.equal(context.boards[0].groupName, "Art");
  assert.equal(context.boards[0].viewport.scale, 1);
  context.undoLastChange();
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.activeId, "a");
  context.removeBoard("a");
  assert.equal(context.boards.length, 1, "Direct deletion also retains a valid empty list");
  assert.equal(context.activeId, context.boards[0].id);
});

test("saving an unchanged list manager preserves redo history; blank names get a usable fallback", () => {
  const context = listManagerContext();
  context.redoStackRef.current = [{ activeId: "a", boards: plain(context.boards) }];
  context.openListManager();
  context.saveListManager();
  assert.equal(context.undoStackRef.current.length, 0);
  assert.equal(context.redoStackRef.current.length, 1);
  context.openListManager();
  context.listManagerDraft[0].name = "   ";
  context.saveListManager();
  assert.equal(context.boards[0].name, "Untitled list");
  assert.equal(context.undoStackRef.current.length, 1);
});

const headerBoard = (id) => ({
  ...board(id, [structuredClone(preview)]), updated: "before", groupName: "Art",
  headerImageSrc: "file:original.png", headerImageThumbnailSrc: "file:thumb.webp", headerImageAssetId: "header-asset",
  headerImageWidth: 1800, headerImageHeight: 2400, headerImagePositionX: 50, headerImagePositionY: 50, headerImageScale: 1,
});

function managerPointerEvent(y = 110, overrides = {}) {
  return {
    pointerId: 7, button: 0, buttons: 1, isPrimary: true,
    clientX: 100, clientY: y, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; },
    ...overrides,
  };
}

function prepareManagerPointer(context, source, control = null, overrides = {}) {
  if (!context.listManagerPointerDragRef.current) context.managerDragCleanup = context.mountListManagerDrag();
  const captures = new Set();
  const captureTarget = {
    dataset: { boardId: source },
    setPointerCapture(id) { captures.add(id); }, hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { captures.delete(id); context.listManagerContentRef.current.dispatch("lostpointercapture", { pointerId: id, target: captureTarget }); },
  };
  const index = context.listManagerDraft.findIndex((entry) => entry.id === source);
  const event = managerPointerEvent(150 + index * 110, { clientX: 94, currentTarget: captureTarget,
    target: { closest: () => control ? { matches: () => control === "preview" } : null }, ...overrides });
  context.prepareListManagerDrag(event, source);
  return event;
}

function startManagerPointer(context, source, y, control = null) {
  prepareManagerPointer(context, source, control);
  return context.window.dispatch("pointermove", managerPointerEvent(y));
}

function managerScrollHarness() {
  let nextId = 0, time = 0, dragging = true;
  const pending = new Map(), scrolled = [];
  const host = { scrollTop: 200, scrollHeight: 1400, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 100, bottom: 500, left: 10, right: 210, height: 400 }) };
  const scroll = createListManagerAutoScroll(host, () => dragging, (x, y) => scrolled.push({ x, y }), {
    request(callback) { pending.set(++nextId, callback); return nextId; }, cancel(id) { pending.delete(id); },
  });
  return { host, scroll, pending, scrolled, setDragging(value) { dragging = value; },
    tick() { time += 16; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach((callback) => callback(time)); } };
}

test("manager auto-scroll continues with a stationary dragged image and refreshes the insertion position", () => {
  const h = managerScrollHarness();
  h.scroll.update(100, 490);
  h.scroll.update(100, 490);
  assert.equal(h.pending.size, 1, "There must be only one animation loop");
  h.tick();
  const first = h.host.scrollTop;
  h.tick();
  assert.ok(first > 200);
  assert.ok(h.host.scrollTop > first, "No new dragover event is required to keep scrolling");
  assert.deepEqual(h.scrolled, [{ x: 100, y: 490 }, { x: 100, y: 490 }]);
});

test("manager auto-scroll moves both ways and accelerates nearer the edge", () => {
  const near = managerScrollHarness(), far = managerScrollHarness(), up = managerScrollHarness();
  near.scroll.update(100, 499); far.scroll.update(100, 450); up.scroll.update(100, 101);
  near.tick(); far.tick(); up.tick();
  assert.ok(near.host.scrollTop > far.host.scrollTop);
  assert.ok(far.host.scrollTop > 200);
  assert.ok(up.host.scrollTop < 200);
});

test("manager auto-scroll stops in the center, outside the list, on drag completion and on explicit cancellation", () => {
  for (const stop of [(h) => h.scroll.update(100, 300), (h) => h.scroll.update(300, 490),
    (h) => h.scroll.update(100, 525), (h) => h.setDragging(false), (h) => h.scroll.stop()]) {
    const h = managerScrollHarness();
    h.scroll.update(100, 490); h.tick();
    const before = h.host.scrollTop;
    stop(h); h.tick(); h.tick();
    assert.equal(h.host.scrollTop, before);
    assert.equal(h.pending.size, 0);
  }
  const h = managerScrollHarness();
  h.setDragging(false); h.scroll.update(100, 490);
  assert.equal(h.pending.size, 0, "External images must not scroll the manager");
});

test("manager auto-scroll clamps to the list bounds and drag cleanup stops the controller", () => {
  for (const [position, y, expected] of [[999, 499, 1000], [1, 101, 0]]) {
    const h = managerScrollHarness();
    h.host.scrollTop = position; h.scroll.update(100, y); h.tick(); h.tick();
    assert.equal(h.host.scrollTop, expected);
    assert.equal(h.pending.size, 0);
  }
  const h = managerScrollHarness(), context = listManagerContext();
  context.listManagerAutoScrollRef.current = h.scroll;
  h.scroll.update(100, 490);
  context.endListManagerDrag();
  assert.equal(h.pending.size, 0);
});

test("manager auto-scroll builds speed gradually and reverses without moving in the old direction", () => {
  const h = managerScrollHarness();
  h.scroll.update(100, 499); h.tick();
  const first = h.host.scrollTop - 200;
  let previous = h.host.scrollTop, last = first;
  for (let i = 0; i < 10; i++) { h.tick(); last = h.host.scrollTop - previous; previous = h.host.scrollTop; }
  assert.ok(first > 0 && first < last / 2, "Entering an edge must not immediately jump at full speed");
  h.scroll.update(100, 101); h.tick();
  assert.ok(h.host.scrollTop < previous, "Reversing direction must not continue the previous scroll");
});

test("slow edge scrolling continues on hosts that round scrollTop to whole pixels", () => {
  const h = managerScrollHarness();
  let position = 200;
  Object.defineProperty(h.host, "scrollTop", { get: () => position, set: (value) => { position = Math.round(value); } });
  h.scroll.update(100, 437);
  for (let i = 0; i < 60; i++) h.tick();
  assert.ok(position > 200, "Fractional movements must accumulate instead of stopping the loop");
  assert.equal(h.pending.size, 1);
});

test("manager auto-scroll tolerates a small vertical overshoot but stops past the edge apron", () => {
  for (const [inside, outside, direction] of [[524, 525, 1], [76, 75, -1]]) {
    const h = managerScrollHarness();
    h.scroll.update(100, inside);
    h.tick();
    assert.ok((h.host.scrollTop - 200) * direction > 0);
    const before = h.host.scrollTop;
    h.scroll.update(100, outside);
    h.tick();
    assert.equal(h.host.scrollTop, before);
    assert.equal(h.pending.size, 0);
  }
});

test("manager gaps and list padding resolve to stable insertion slots; outside and unchanged slots are ignored", () => {
  const rows = [{ id: "a", top: 100, bottom: 200 }, { id: "b", top: 210, bottom: 310 }, { id: "c", top: 320, bottom: 420 }];
  const bounds = { left: 0, right: 500, top: 0, bottom: 1000 };
  assert.deepEqual(getListManagerDropTarget(rows, "a", 100, 315, bounds), { boardId: "b", edge: "after" });
  assert.deepEqual(getListManagerDropTarget(rows, "c", 100, 50, bounds), { boardId: "a", edge: "before" });
  assert.deepEqual(getListManagerDropTarget(rows, "a", 100, 800, bounds), { boardId: "c", edge: "after" });
  for (const [source, x, y] of [["a", 100, 150], ["a", 100, 220], ["b", 100, 190], ["a", 501, 315], ["a", 100, -25], ["missing", 100, 315]]) {
    assert.equal(getListManagerDropTarget(rows, source, x, y, bounds), null);
  }
});

test("manager destinations use one canonical slot and tolerate midpoint jitter in either direction", () => {
  const rows = [{ id: "a", top: 100, bottom: 200 }, { id: "b", top: 210, bottom: 310 }, { id: "c", top: 320, bottom: 420 }];
  const bounds = { left: 0, right: 500, top: 0, bottom: 1000 };
  let previous = getListManagerDropTarget(rows, "a", 100, 315, bounds);
  for (const y of [321, 369, 371, 367, 377]) {
    previous = getListManagerDropTarget(rows, "a", 100, y, bounds, previous);
    assert.deepEqual(previous, { boardId: "b", edge: "after" });
  }
  previous = getListManagerDropTarget(rows, "a", 100, 379, bounds, previous);
  assert.deepEqual(previous, { boardId: "c", edge: "after" });
  for (const y of [371, 369, 363]) {
    previous = getListManagerDropTarget(rows, "a", 100, y, bounds, previous);
    assert.deepEqual(previous, { boardId: "c", edge: "after" });
  }
  assert.deepEqual(getListManagerDropTarget(rows, "a", 100, 361, bounds, previous), { boardId: "b", edge: "after" });
  assert.equal(getListManagerDropTarget(rows, "a", 100, 200, bounds, previous), null, "Returning to the original slot must clear the marker");
  assert.deepEqual(getListManagerDropTarget(rows, "c", 100, -24, bounds), { boardId: "a", edge: "before" });
  assert.equal(getListManagerDropTarget(rows, "c", 100, -25, bounds), null);
  assert.deepEqual(getListManagerDropTarget(rows, "a", 100, 1024, bounds), { boardId: "c", edge: "after" });
  assert.equal(getListManagerDropTarget(rows, "a", 100, 1025, bounds), null);
});

test("dropping in a row gap uses the same slot as the insertion marker", () => {
  const context = listManagerContext();
  context.openListManager();
  startManagerPointer(context, "a", 315);
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "b", edge: "after" });
  const marker = context.listManagerDropTarget;
  context.window.dispatch("pointermove", managerPointerEvent(315));
  assert.equal(context.listManagerDropTarget, marker, "Repeated events must not replace an unchanged marker");
  context.window.dispatch("pointerup", managerPointerEvent(315, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["b", "a", "c"]);
});

test("manual scrolling with a stationary captured pointer refreshes the destination from current geometry", () => {
  const context = listManagerContext();
  context.openListManager();
  startManagerPointer(context, "a", 300);
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "b", edge: "after" });
  context.managerScrollOffset = 110;
  context.listManagerContentRef.current.dispatch("scroll");
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "c", edge: "after" });
  context.window.dispatch("pointermove", managerPointerEvent(300));
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "c", edge: "after" });
  context.window.dispatch("pointerup", managerPointerEvent(300, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["b", "c", "a"]);
});

test("the page pointer lifecycle uses one scroll loop and retargets during stationary edge scrolling", () => {
  const context = listManagerContext(Array.from({ length: 20 }, (_, index) => board(`list-${index}`)));
  context.openListManager();
  startManagerPointer(context, "list-0", 990);
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "list-7", edge: "after" });
  assert.equal(context.managerFrames.size, 1);
  const ghost = context.listManagerGhostRef.current;
  assert.equal(ghost.style.transform, "translate(114px, 1004px)");
  assert.equal(ghost.children[1].textContent, "list-0");
  for (let frame = 1; frame <= 25; frame++) {
    const callbacks = [...context.managerFrames.values()];
    context.managerFrames.clear();
    callbacks.forEach((callback) => callback(frame * 16));
    assert.equal(context.managerFrames.size, 1);
  }
  assert.ok(context.managerScrollOffset > 110);
  const destination = plain(context.listManagerDropTarget);
  assert.notEqual(destination.boardId, "list-7");
  context.window.dispatch("pointerup", managerPointerEvent(990, { buttons: 0 }));
  const ids = plain(context.listManagerDraft.map(({ id }) => id));
  assert.equal(ids.indexOf("list-0"), ids.indexOf(destination.boardId) + 1);
  assert.equal(ghost.removed, true);
  assert.equal(context.listManagerGhostRef.current, null);
  assert.equal(context.managerFrames.size, 0);
  assert.equal(context.boards[0].id, "list-0", "The saved order remains unchanged before Save");
});

test("pointer release commits the displayed hysteresis slot instead of jumping across a nearby midpoint", () => {
  const context = listManagerContext();
  context.openListManager();
  startManagerPointer(context, "a", 350);
  context.window.dispatch("pointermove", managerPointerEvent(371));
  assert.deepEqual(plain(context.listManagerDropTarget), { boardId: "b", edge: "after" });
  context.window.dispatch("pointerup", managerPointerEvent(372, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["b", "a", "c"]);
});

test("the insertion indicator stays within the scroll viewport at both clipped edges", () => {
  const top = listManagerContext();
  top.openListManager();
  top.managerScrollOffset = 140;
  startManagerPointer(top, "c", -10);
  const topIndicator = top.listManagerIndicatorRef.current;
  assert.deepEqual(plain(top.listManagerDropTarget), { boardId: "a", edge: "before" });
  assert.equal(topIndicator.hidden, false);
  assert.equal(topIndicator.style.transform, "translate(18px, 1px)");
  assert.equal(topIndicator.style.width, "464px");
  assert.ok(top.document.body.children.includes(topIndicator), "The line must be outside the clipped scroll content");
  top.endListManagerDrag();
  assert.equal(topIndicator.removed, true);

  const bottom = listManagerContext(Array.from({ length: 20 }, (_, index) => board(`list-${index}`)));
  bottom.openListManager();
  bottom.managerScrollOffset = 50;
  startManagerPointer(bottom, "list-0", 1010);
  const bottomIndicator = bottom.listManagerIndicatorRef.current;
  assert.deepEqual(plain(bottom.listManagerDropTarget), { boardId: "list-8", edge: "after" });
  assert.equal(bottomIndicator.hidden, false);
  assert.equal(bottomIndicator.style.transform, "translate(18px, 997px)");
  bottom.window.dispatch("pointermove", managerPointerEvent(1025));
  assert.equal(bottomIndicator.hidden, true, "Exiting the drop apron must hide the line");
  bottom.endListManagerDrag();
  assert.equal(bottomIndicator.removed, true);
  assert.equal(bottom.listManagerIndicatorRef.current, null);
});

test("transferring preview capture to its row retains the drag and another press cannot clear its click guard", () => {
  const context = listManagerContext([headerBoard("a"), headerBoard("b")]);
  context.openListManager();
  startManagerPointer(context, "a", 300, "preview");
  const drag = context.listManagerPointerDragRef.current;
  for (const target of [{ dataset: {} }, { dataset: { boardId: "b" } }]) {
    context.listManagerContentRef.current.dispatch("lostpointercapture", { pointerId: 7, target });
    assert.equal(drag.active, true, "Only loss of the current row's capture may cancel reordering");
  }
  prepareManagerPointer(context, "b", "preview", { pointerId: 8 });
  assert.equal(context.listManagerDragRef.current, "a");
  assert.equal(context.listManagerPreviewDragRef.current, "a");
  context.window.dispatch("pointerup", managerPointerEvent(300, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["b", "a"]);
  const click = { detail: 1, prevented: false, preventDefault() { this.prevented = true; } };
  context.openListManagerPreview(click, context.listManagerDraft[1]);
  assert.equal(click.prevented, true);
  assert.equal(context.headerImageDraft, null);
});

test("page drag cancellation events stop scrolling, remove the preview, and preserve the draft order", () => {
  const cancelActions = [
    (context) => context.window.dispatch("keydown", managerPointerEvent(990, { key: "Escape" })),
    (context) => context.window.dispatch("blur"),
    (context) => context.window.dispatch("resize"),
    (context) => { context.document.hidden = true; context.document.dispatch("visibilitychange"); },
    (context) => context.window.dispatch("pointercancel", managerPointerEvent(990)),
    (context) => context.listManagerContentRef.current.dispatch("lostpointercapture", { pointerId: 7, target: { dataset: { boardId: "a" } } }),
  ];
  for (const cancel of cancelActions) {
    const context = listManagerContext();
    context.openListManager();
    startManagerPointer(context, "a", 990);
    const ghost = context.listManagerGhostRef.current;
    const indicator = context.listManagerIndicatorRef.current;
    assert.equal(context.managerFrames.size, 1);
    cancel(context);
    assert.equal(context.listManagerPointerDragRef.current.active, false);
    assert.equal(context.listManagerDragRef.current, null);
    assert.equal(context.listManagerDropTarget, null);
    assert.equal(context.listManagerGhostRef.current, null);
    assert.equal(ghost.removed, true);
    assert.equal(indicator.removed, true);
    assert.equal(context.listManagerIndicatorRef.current, null);
    assert.equal(context.managerFrames.size, 0);
    context.window.dispatch("pointerup", managerPointerEvent(990, { buttons: 0 }));
    assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["a", "b", "c"]);
    context.managerDragCleanup();
    assert.equal(context.window.listenerCount(), 0);
    assert.equal(context.document.listenerCount(), 0);
    assert.equal(context.listManagerContentRef.current.listenerCount(), 0);
    assert.equal(context.listManagerPointerDragRef.current, null);
    assert.equal(context.listManagerAutoScrollRef.current, null);
  }
});

test("manager drag drops before and after rows without changing saved lists until Save", () => {
  for (const [source, y, expected] of [["c", 110, ["c", "a", "b"]], ["a", 410, ["b", "c", "a"]]]) {
    const context = listManagerContext();
    context.openListManager();
    const event = startManagerPointer(context, source, y);
    assert.equal(event.prevented, true);
    assert.equal(context.listManagerDropTarget.edge, y < 150 ? "before" : "after");
    context.window.dispatch("pointerup", managerPointerEvent(y, { buttons: 0 }));
    assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), expected);
    assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b", "c"]);
    assert.equal(context.listManagerDragRef.current, null);
    assert.equal(context.listManagerDropTarget, null);
    context.saveListManager();
    assert.deepEqual(plain(context.boards.map(({ id }) => id)), expected);
    context.undoLastChange();
    assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b", "c"]);
  }
});

test("manager controls and unrelated external drags cannot start a list reorder", () => {
  const context = listManagerContext();
  context.openListManager();
  prepareManagerPointer(context, "a", "input");
  const event = context.window.dispatch("pointermove", managerPointerEvent(400));
  assert.equal(event.prevented, false);
  assert.equal(context.listManagerDragRef.current, null);
  const external = managerPointerEvent();
  context.window.dispatch("dragover", external);
  context.window.dispatch("drop", external);
  assert.equal(external.prevented, false);
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["a", "b", "c"]);
});

test("manager preview images can start reordering while other controls and right clicks remain excluded", () => {
  const context = listManagerContext([headerBoard("a"), headerBoard("b")]);
  context.openListManager();
  for (const [control, button, allowed] of [["preview", 0, true], [null, 0, true], ["input", 0, false], ["button", 0, false], ["label", 0, false], ["preview", 2, false]]) {
    prepareManagerPointer(context, "a", control, { button, buttons: button === 0 ? 1 : 2 });
    assert.equal(context.listManagerPointerDragRef.current.pointer !== null, allowed);
    context.listManagerPointerDragRef.current.cancel();
  }
  startManagerPointer(context, "a", 300, "preview");
  context.window.dispatch("pointerup", managerPointerEvent(300, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["b", "a"]);
  assert.equal(context.headerImageDraft, null, "Dragging the preview must not open its crop editor");
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b"]);
});

test("preview dragging suppresses its trailing click but a fresh click or keyboard activation still opens the editor", () => {
  const context = listManagerContext([headerBoard("a"), headerBoard("b")]);
  context.openListManager();
  const entry = context.listManagerDraft[1];
  startManagerPointer(context, entry.id, 110, "preview");
  context.endListManagerDrag();
  const trailingClick = { detail: 1, prevented: false, preventDefault() { this.prevented = true; } };
  context.openListManagerPreview(trailingClick, entry);
  assert.equal(trailingClick.prevented, true);
  assert.equal(context.headerImageDraft, null);
  context.openListManagerPreview({ detail: 0 }, entry);
  assert.equal(context.headerImageDraft.boardId, entry.id);
  context.cancelHeaderImageEditor();
  const down = prepareManagerPointer(context, entry.id, "preview");
  context.window.dispatch("pointerup", managerPointerEvent(down.clientY, { clientX: down.clientX, buttons: 0 }));
  context.openListManagerPreview({ detail: 1 }, entry);
  assert.equal(context.headerImageDraft.boardId, entry.id);
  assert.equal(context.activeId, "a");
});

test("manager clears no-op and outside destinations, and Cancel discards a completed reorder", () => {
  const context = listManagerContext();
  context.openListManager();
  for (const destination of [managerPointerEvent(150), managerPointerEvent(300, { clientX: 501 }), managerPointerEvent(1025)]) {
    startManagerPointer(context, "a", 315);
    assert.ok(context.listManagerDropTarget);
    context.window.dispatch("pointermove", destination);
    assert.equal(context.listManagerDropTarget, null);
    context.window.dispatch("pointerup", { ...destination, buttons: 0 });
    assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["a", "b", "c"]);
  }
  startManagerPointer(context, "c", 110);
  context.window.dispatch("pointerup", managerPointerEvent(110, { buttons: 0 }));
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["c", "a", "b"]);
  context.closeListManager();
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b", "c"]);
  assert.equal(context.undoStackRef.current.length, 0);
  assert.equal(context.listManagerDraggedId, null);
});

test("list manager appends multiple complete draft lists, keeps names distinct, and cancels all creations", () => {
  const context = listManagerContext([board("a"), { ...board("b"), name: "Untitled board 4" }]);
  const before = plain(context.boards);
  context.openListManager();
  context.addListManagerBoard();
  context.addListManagerBoard();
  assert.deepEqual(plain(context.listManagerDraft.map(({ name }) => name)), ["a", "Untitled board 4", "Untitled board 3", "Untitled board 5"]);
  for (const created of context.listManagerDraft.slice(2)) {
    assert.equal(created.items.length, 0);
    assert.deepEqual(normalizeCanvasSettings(created), context.canvasSettings);
  }
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.activeId, "a");
  context.closeListManager();
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.undoStackRef.current.length, 0);
});

test("list manager saves creation, names, grouping, order and deletion as one reversible operation", () => {
  const context = listManagerContext([headerBoard("a"), board("b"), board("c")]);
  const before = plain(context.boards);
  context.openListManager();
  context.addListManagerBoard();
  const created = context.listManagerDraft.at(-1);
  created.name = "  New reference  ";
  created.groupName = "  Design  ";
  context.moveListManagerBoard(created.id, -1);
  context.moveListManagerBoard(created.id, -1);
  context.confirmBoardDeletion("b");
  context.listManagerDraft[0].name = "Renamed";
  context.saveListManager();
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", created.id, "c"]);
  assert.equal(context.boards[0].name, "Renamed");
  assert.equal(context.boards[1].name, "New reference");
  assert.equal(context.boards[1].groupName, "Design");
  assert.deepEqual(plain(context.boards[0].items), before[0].items);
  assert.deepEqual(plain(context.boards[0].viewport), before[0].viewport);
  assert.equal(context.activeId, "a");
  assert.equal(context.undoStackRef.current.length, 1);
  const after = plain(context.boards);
  context.undoLastChange();
  assert.deepEqual(plain(context.boards), before);
  context.redoLastChange();
  assert.deepEqual(plain(context.boards), after);
});

test("manager reorder stops at list edges and leaves the saved order intact until Save", () => {
  const context = listManagerContext();
  context.openListManager();
  const originalDraft = context.listManagerDraft;
  for (const [id, direction] of [["a", -1], ["c", 1], ["missing", 1]]) context.moveListManagerBoard(id, direction);
  assert.equal(context.listManagerDraft, originalDraft);
  context.moveListManagerBoard("c", -1);
  assert.deepEqual(plain(context.listManagerDraft.map(({ id }) => id)), ["a", "c", "b"]);
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "b", "c"]);
  assert.equal(context.undoStackRef.current.length, 0);
  context.saveListManager();
  assert.deepEqual(plain(context.boards.map(({ id }) => id)), ["a", "c", "b"]);
  assert.equal(context.undoStackRef.current.length, 1);
});

test("a newly created draft list can be confirmed and deleted before it has ever been saved", () => {
  const context = listManagerContext();
  context.openListManager();
  context.addListManagerBoard();
  const created = context.listManagerDraft.at(-1);
  context.pendingDeleteBoardId = created.id;
  install(context, "pendingDeleteBoard");
  assert.equal(context.pendingDeleteBoard.id, created.id);
  context.confirmBoardDeletion(created.id);
  context.saveListManager();
  assert.equal(context.boards.length, 3);
  assert.equal(context.undoStackRef.current.length, 0);
});

test("header editing from the manager leaves the active list and selection alone, then stages its full-resolution crop", () => {
  const context = listManagerContext([board("a"), headerBoard("b")]);
  const before = plain(context.boards);
  context.openListManager();
  context.openHeaderImageEditor(context.listManagerDraft[1], context.listManagerSessionRef.current);
  assert.equal(context.headerImageDraft.src, "file:original.png");
  assert.equal(context.headerImageDraft.imageWidth, 1800);
  assert.equal(context.activeId, "a");
  assert.deepEqual(plain(context.selectedIds), ["existing-selection"]);
  context.headerImageDraft = { ...context.headerImageDraft, scale: 2, positionX: 60, positionY: 40 };
  context.applyHeaderImage();
  assert.equal(context.headerImageDraft, null);
  assert.equal(context.listManagerDraft[1].headerImageScale, 2);
  assert.equal(context.listManagerDraft[1].headerImagePositionX, 60);
  assert.equal(context.listManagerDraft[1].headerImagePositionY, 40);
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.undoStackRef.current.length, 0);
  context.saveListManager();
  assert.equal(context.boards[1].headerImageScale, 2);
  assert.equal(context.boards[1].headerImagePositionX, 60);
  assert.equal(context.undoStackRef.current.length, 1);
  assert.deepEqual(plain(context.boards[1].items), before[1].items);
});

test("cancelling either the crop or the whole manager preserves the original header", () => {
  const context = listManagerContext([headerBoard("a")]);
  const before = plain(context.boards);
  context.openListManager();
  context.openHeaderImageEditor(context.listManagerDraft[0], context.listManagerSessionRef.current);
  context.headerImageDraft.scale = 2;
  context.cancelHeaderImageEditor();
  assert.equal(context.showListManager, true);
  assert.equal(context.listManagerDraft[0].headerImageScale, 1);
  context.openHeaderImageEditor(context.listManagerDraft[0], context.listManagerSessionRef.current);
  context.headerImageDraft.scale = 2;
  context.applyHeaderImage();
  context.closeListManager();
  assert.deepEqual(plain(context.boards), before);
  assert.equal(context.undoStackRef.current.length, 0);
});

test("restoring automatic previews clears all header metadata only on Save and Undo restores it", () => {
  const context = listManagerContext([headerBoard("a")]);
  const before = plain(context.boards);
  context.openListManager();
  context.openHeaderImageEditor(context.listManagerDraft[0], context.listManagerSessionRef.current);
  context.restoreHeaderImageList();
  for (const field of HEADER_IMAGE_FIELDS) assert.equal(context.listManagerDraft[0][field], undefined);
  assert.deepEqual(plain(context.boards), before);
  context.saveListManager();
  for (const field of HEADER_IMAGE_FIELDS) assert.equal(context.boards[0][field], undefined);
  assert.deepEqual(plain(context.boards[0].items), before[0].items);
  context.undoLastChange();
  assert.deepEqual(plain(context.boards), before);
});

test("saving manager metadata preserves imports, viewport changes, and refreshed header asset URLs", () => {
  const context = listManagerContext([headerBoard("a")]);
  context.openListManager();
  context.listManagerDraft[0].name = "Edited name";
  context.listManagerDraft[0].headerImagePositionY = 40;
  const live = { ...context.boards[0],
    items: [{ ...preview, src: "file:optimized", processing: false }], viewport: { x: -60, y: 20, scale: 1.5 },
    headerImageSrc: "file:refreshed-original", headerImageThumbnailSrc: "file:refreshed-thumb", headerImageAssetId: "refreshed-asset",
  };
  context.setBoards([live]);
  context.saveListManager();
  const saved = context.boards[0];
  assert.equal(saved.name, "Edited name");
  assert.equal(saved.headerImagePositionY, 40);
  assert.equal(saved.headerImageSrc, live.headerImageSrc);
  assert.equal(saved.headerImageThumbnailSrc, live.headerImageThumbnailSrc);
  assert.equal(saved.headerImageAssetId, live.headerImageAssetId);
  assert.equal(saved.items, live.items);
  assert.equal(saved.viewport, live.viewport);
});

test("replacing a header replaces its crop and assets together instead of mixing old resources", () => {
  const original = Object.freeze(headerBoard("a"));
  const draft = { ...original, headerImageSrc: "file:new-original", headerImageThumbnailSrc: undefined, headerImageAssetId: "new-asset", headerImageWidth: 3000, headerImageHeight: 1000, headerImagePositionY: 50 };
  const live = { ...original, headerImageThumbnailSrc: "file:late-old-thumb" };
  const saved = mergeListManagerEntry(draft, original, live, "Untitled");
  for (const field of HEADER_IMAGE_FIELDS) assert.equal(saved[field], draft[field]);
  assert.equal(original.headerImageSrc, "file:original.png");
});

test("group changes can clear the current workspace filter and reveal lists in a formerly collapsed group", () => {
  const context = listManagerContext([headerBoard("a"), headerBoard("b")]);
  context.activeWorkspace = "Art";
  context.workspaceFilter = "Art";
  context.collapsedGroups = new Set(["Design", "Other"]);
  context.openListManager();
  context.listManagerDraft[0].groupName = "  Design  ";
  context.listManagerDraft[1].groupName = "  ";
  context.saveListManager();
  assert.equal(context.boards[0].groupName, "Design");
  assert.equal(context.boards[1].groupName, undefined);
  assert.equal(context.workspaceFilter, null);
  assert.equal(context.collapsedGroups.has("Design"), false);
  assert.equal(context.collapsedGroups.has("Other"), true);
  assert.equal(context.activeId, "a");
});

test("closing and reopening the manager rejects a late header picker for the old session", async () => {
  const picker = deferred();
  const context = listManagerContext();
  context.window.museboardDesktop = { chooseImageFiles: () => picker.promise };
  context.openListManager();
  const pending = context.chooseHeaderImage("b", context.listManagerSessionRef.current);
  context.closeListManager();
  context.openListManager();
  picker.resolve({ images: [{ src: "file:old-choice", width: 2000, height: 1600 }] });
  await pending;
  assert.equal(context.headerImageDraft, null);
  assert.equal(context.listManagerDraft[1].headerImageSrc, undefined);
});

test("a header chosen for an unsaved list retains its full-resolution source and saves to that list only", async () => {
  const context = listManagerContext();
  context.window.museboardDesktop = { chooseImageFiles: async () => ({ images: [{ src: "file:full-res", thumbnailSrc: "file:small-thumb", assetId: "new-asset", width: 4096, height: 3072 }] }) };
  context.openListManager();
  context.addListManagerBoard();
  const target = context.listManagerDraft.at(-1);
  await context.chooseHeaderImage(target.id, context.listManagerSessionRef.current);
  assert.equal(context.headerImageDraft.src, "file:full-res");
  assert.equal(context.headerImageDraft.imageWidth, 4096);
  context.applyHeaderImage();
  context.saveListManager();
  assert.equal(context.boards.at(-1).headerImageSrc, "file:full-res");
  assert.equal(context.boards.at(-1).headerImageAssetId, "new-asset");
  assert.equal(context.boards[0].headerImageSrc, undefined);
  assert.equal(context.activeId, "a");
});

test("cancelling a header editor invalidates pending optimization without changing its parent draft", async () => {
  const conversion = deferred();
  const optimizing = deferred();
  const context = listManagerContext([headerBoard("a")]);
  context.window.museboardDesktop = {
    chooseImageFiles: async () => ({ images: [{ src: "file:staged-new", processing: true, width: 2400, height: 1800 }] }),
    optimizeStagedImages: () => { optimizing.resolve(); return conversion.promise; },
  };
  context.openListManager();
  const pending = context.chooseHeaderImage("a", context.listManagerSessionRef.current);
  await optimizing.promise;
  assert.equal(context.headerImageDraft.src, "file:staged-new");
  context.cancelHeaderImageEditor();
  conversion.resolve({ results: [{ image: { src: "file:optimized-new", width: 2400, height: 1800 } }] });
  await pending;
  assert.equal(context.headerImageDraft, null);
  assert.equal(context.listManagerDraft[0].headerImageSrc, "file:original.png");
  assert.equal(context.showListManager, true);
});

test("a header picker failure reports the problem and leaves saved lists and drafts intact", async () => {
  const context = listManagerContext([headerBoard("a")]);
  context.window.museboardDesktop = { chooseImageFiles: async () => { throw new Error("unreadable"); } };
  context.openListManager();
  const before = plain(context.boards);
  await context.chooseHeaderImage("a", context.listManagerSessionRef.current);
  assert.match(context.headerImageError, /Could not load/);
  assert.deepEqual(plain(context.boards), before);
  assert.deepEqual(plain(context.listManagerDraft), before);
  assert.equal(context.headerImageDraft, null);
});

test("sidebar header edits still apply immediately without opening a list-manager transaction", () => {
  const context = listManagerContext([board("a"), headerBoard("b")]);
  context.openHeaderImageEditor(context.boards[1]);
  assert.equal(context.activeId, "b");
  context.headerImageDraft.scale = 2;
  context.applyHeaderImage();
  assert.equal(context.boards[1].headerImageScale, 2);
  assert.equal(context.undoStackRef.current.length, 1);
  assert.equal(context.showListManager, false);
});
