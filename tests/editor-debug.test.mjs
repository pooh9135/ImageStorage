import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const text = await readFile(new URL("../app/ImageAnalysisWindow.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("ImageAnalysisWindow.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const plain = (value) => JSON.parse(JSON.stringify(value));
function find(predicate) {
  let match;
  function visit(node) { if (match) return; if (predicate(node)) match = node; else ts.forEachChild(node, visit); }
  visit(source);
  return match;
}
function execute(context, code) {
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
}
function install(context, name, optional = false) {
  const node = find((node) => (ts.isVariableDeclaration(node) && node.name.getText(source) === name) || (ts.isFunctionDeclaration(node) && node.name?.text === name));
  if (!node && optional) return;
  assert.ok(node, `Missing production callback ${name}`);
  if (ts.isFunctionDeclaration(node)) return execute(context, node.getText(source).replace(/^export\s+/, ""));
  let expression = node.initializer;
  if (ts.isCallExpression(expression) && expression.expression.getText(source) === "useCallback") expression = expression.arguments[0];
  execute(context, `globalThis.${name} = ${expression.getText(source)};`);
}
function installPointerEnd(context, name, attribute) {
  if (find((node) => ts.isVariableDeclaration(node) && node.name.getText(source) === name)) return install(context, name);
  const node = find((node) => ts.isJsxAttribute(node) && node.name.getText(source) === attribute);
  execute(context, `globalThis.${name} = ${node.initializer.expression.getText(source)};`);
}
function fixture(initial = { preset: "none", gridVisible: false, guideColor: "#2aa8ef", strokes: [] }) {
  const captures = new Set();
  const target = { setPointerCapture: (id) => captures.add(id), hasPointerCapture: (id) => captures.has(id), releasePointerCapture: (id) => captures.delete(id) };
  let rect = { left: 100, top: 100, width: 200, height: 100 };
  const context = vm.createContext({
    structuredClone,
    preferences: { tool: "line", color: "#ff0000", lineWidth: 5 },
    payload: { itemId: "image-A" },
    analysis: initial, analysisRef: { current: initial }, activeStrokeRef: { current: null },
    strokeSessionRef: { current: null }, undoStackRef: { current: [] }, redoStackRef: { current: [] }, initializedRef: { current: true },
    savedAnalysisRef: { current: "" },
    imageFrameRef: { current: { getBoundingClientRect: () => rect } },
    localStorage: { getItem: () => null },
    window: { requestAnimationFrame: (fn) => fn(), setTimeout() {} },
    desktop: { updateImageAnalysis(value) { context.saved = value; }, close() {} },
  });
  context.setAnalysis = (value) => { context.analysis = value; };
  context.setPayload = (value) => { context.payload = value; };
  for (const name of ["makeStrokeId", "cloneAnalysis", "recordAnalysisUndo", "updateAnalysis", "undoAnalysis", "redoAnalysis", "pointFromEvent", "handlePointerDown", "handlePointerMove", "resetAnalysis", "saveAnalysis", "EMPTY_ANALYSIS", "DEFAULT_GUIDE_COLOR", "DEFAULT_PREFERENCES", "PRESETS", "PREFERENCES_KEY", "migrateAnalysisGuideColor", "migrateBoardAnalysisGuides", "getSavedPreferences"]) install(context, name);
  for (const name of ["stopActiveStroke", "cancelActiveStroke"]) install(context, name, true);
  installPointerEnd(context, "handlePointerUp", "onPointerUp");
  installPointerEnd(context, "handlePointerCancel", "onPointerCancel");
  const event = (x, id = 1, y = 150) => ({ clientX: x, clientY: y, button: 0, pointerId: id, pointerType: "mouse", currentTarget: target, preventDefault() {} });
  return { context, event, resize: (value) => { rect = value; }, captures };
}

test("fresh and legacy editor preferences default guides to red while the drawing pen remains blue", () => {
  const { context } = fixture();
  for (const stored of [null, "{}", '{"tool":"line","lineWidth":8}', '{"guideColor":"#2aa8ef"}', '{"guideColor":" #2AA8EF "}']) {
    context.localStorage.getItem = () => stored;
    const preferences = context.getSavedPreferences();
    assert.equal(preferences.guideColor, "#ff0000");
    assert.equal(preferences.guideColorVersion, 1);
    assert.equal(preferences.color, "#2aa8ef");
  }
  context.localStorage.getItem = () => JSON.stringify({ guideColor: "#17cc55", color: "#123456" });
  assert.equal(context.getSavedPreferences().guideColor, "#17cc55", "An explicitly saved guide color takes precedence over the new default");
  assert.equal(context.getSavedPreferences().color, "#123456");
  context.localStorage.getItem = () => JSON.stringify({ guideColor: "#2aa8ef", guideColorVersion: 1 });
  assert.equal(context.getSavedPreferences().guideColor, "#2aa8ef", "Blue chosen after the update remains blue on restart");
});

test("image initialization migrates old default guides while retaining custom colors and blue chosen after updating", () => {
  const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.getText(source).includes("getImageAnalysisInit"));
  for (const [savedPreferences, savedAnalysis, expected] of [
    [null, undefined, "#ff0000"],
    ["{}", { preset: "thirds", gridVisible: true, strokes: [] }, "#ff0000"],
    ['{"guideColor":"#17cc55"}', undefined, "#17cc55"],
    ['{"guideColor":"#17cc55"}', { preset: "thirds", gridVisible: true, guideColor: "#ee8844", strokes: [] }, "#ee8844"],
    ['{"guideColor":"#17cc55"}', { preset: "thirds", gridVisible: true, guideColor: "#2aa8ef", strokes: [] }, "#ff0000"],
    ['{"guideColor":"#17cc55"}', { preset: "thirds", gridVisible: true, guideColor: "#2aa8ef", guideColorVersion: 1, strokes: [] }, "#2aa8ef"],
  ]) {
    const { context } = fixture();
    context.localStorage.getItem = () => savedPreferences;
    let initialize;
    context.desktop.onImageAnalysisInit = (callback) => { initialize = callback; return () => {}; };
    execute(context, `globalThis.initializeEffect = ${effect.arguments[0].getText(source)};`);
    const cleanup = context.initializeEffect();
    initialize({ itemId: "image-A", analysis: savedAnalysis });
    assert.equal(context.analysis.guideColor, expected);
    assert.equal(context.analysis.guideColorVersion, 1);
    context.saveAnalysis();
    assert.equal(context.saved.analysis.guideColor, expected, "Save retains the resolved image guide color");
    assert.equal(context.saved.analysis.guideColorVersion, 1, "The persisted marker prevents another conversion when reopening");
    context.resetAnalysis();
    assert.equal(context.analysis.guideColor, expected, "Reset clears marks and guides without resetting the chosen color");
    cleanup();
  }
});

test("guide color migration is immutable and idempotent without recoloring drawing strokes", () => {
  const { context } = fixture();
  const legacy = { preset: "thirds", gridVisible: true, guideColor: "#2aa8ef", strokes: [
    { id: "pen", kind: "line", color: "#2aa8ef", width: 5, points: [{ x: 0, y: 0 }, { x: 1000, y: 1000 }] },
  ] };
  const migrated = context.migrateAnalysisGuideColor(legacy);
  assert.equal(legacy.guideColor, "#2aa8ef");
  assert.equal(legacy.guideColorVersion, undefined);
  assert.equal(migrated.guideColor, "#ff0000");
  assert.equal(migrated.guideColorVersion, 1);
  assert.equal(migrated.strokes, legacy.strokes);
  assert.equal(migrated.strokes[0].color, "#2aa8ef");
  assert.equal(context.migrateAnalysisGuideColor(migrated), migrated);
  const chosenBlue = { ...migrated, guideColor: "#2aa8ef" };
  assert.equal(context.migrateAnalysisGuideColor(chosenBlue), chosenBlue);
});

test("guide migration covers every saved list and leaves unchanged boards and items intact", () => {
  const { context } = fixture();
  const analysis = { preset: "thirds", gridVisible: false, strokes: [] };
  const untouched = { id: "note", type: "note", text: "Keep this note" };
  const alreadyMigrated = { id: "new", items: [{ id: "new-blue", analysis: { ...analysis, guideColor: "#2aa8ef", guideColorVersion: 1 } }] };
  const boards = [
    { id: "first", items: [{ id: "old-blue", analysis: { ...analysis, guideColor: "#2aa8ef" } }, untouched] },
    { id: "inactive", items: [{ id: "old-custom", analysis: { ...analysis, guideColor: "#ee8844" } }, { id: "old-missing", analysis }] },
    alreadyMigrated,
  ];
  const before = plain(boards);
  const migrated = context.migrateBoardAnalysisGuides(boards);
  assert.notEqual(migrated, boards);
  assert.deepEqual(plain(boards), before, "Migration does not mutate loaded or historical snapshots");
  assert.equal(migrated[0].items[0].analysis.guideColor, "#ff0000");
  assert.equal(migrated[1].items[0].analysis.guideColor, "#ee8844");
  assert.equal(migrated[1].items[1].analysis.guideColor, "#ff0000");
  assert.equal(migrated[0].items[1], untouched);
  assert.equal(migrated[2], alreadyMigrated);
  assert.equal(context.migrateBoardAnalysisGuides(migrated), migrated);
  const reopened = context.migrateBoardAnalysisGuides(plain(migrated));
  assert.equal(reopened[2].items[0].analysis.guideColor, "#2aa8ef");
  assert.ok(reopened.flatMap((board) => board.items).filter((item) => item.analysis).every((item) => item.analysis.guideColorVersion === 1));
});

test("line release coordinates are retained even without a final pointermove", () => {
  const { context, event, captures } = fixture();
  context.handlePointerDown(event(80));
  context.handlePointerMove(event(160));
  context.handlePointerUp(event(320));
  assert.deepEqual(plain(context.analysis.strokes[0].points), [{ x: -100, y: 500, pressure: 1 }, { x: 1100, y: 500, pressure: 1 }]);
  assert.equal(captures.size, 0);
});

test("secondary pointers cannot replace or finish an active line", () => {
  const { context, event } = fixture();
  context.handlePointerDown(event(120, 1));
  context.handlePointerDown(event(220, 2));
  context.handlePointerMove(event(280, 2));
  context.handlePointerCancel(event(280, 2));
  context.handlePointerMove(event(180, 1));
  context.handlePointerUp(event(200, 1));
  assert.equal(context.analysis.strokes.length, 1);
  assert.equal(context.analysis.strokes[0].points[0].x, 100);
  assert.equal(context.analysis.strokes[0].points[1].x, 500);
});

test("pen release keeps the last drawing pressure while recording the final position", () => {
  const { context, event } = fixture();
  context.handlePointerDown({ ...event(120), pointerType: "pen", pressure: 0.6 });
  context.handlePointerMove({ ...event(220), pointerType: "pen", pressure: 0.8 });
  context.handlePointerUp({ ...event(240), type: "pointerup", pointerType: "pen", pressure: 0 });
  assert.equal(context.analysis.strokes[0].points[1].x, 700);
  assert.equal(context.analysis.strokes[0].points[1].pressure, 0.8);
});

test("canceling a line restores the previous drawing and redo history", () => {
  const { context, event } = fixture();
  const previous = plain(context.analysis);
  const future = { ...previous, preset: "thirds" };
  context.redoStackRef.current = [future];
  context.handlePointerDown(event(80));
  context.handlePointerMove(event(270));
  context.handlePointerCancel(event(270));
  assert.deepEqual(plain(context.analysis), previous);
  assert.equal(context.undoStackRef.current.length, 0);
  assert.deepEqual(plain(context.redoStackRef.current), [future]);
  context.redoAnalysis();
  assert.equal(context.analysis.preset, "thirds");
});

test("selecting the unchanged guide does not discard redo", () => {
  const { context } = fixture();
  context.updateAnalysis({ preset: "thirds" });
  context.undoAnalysis();
  context.updateAnalysis({ preset: "none" });
  context.redoAnalysis();
  assert.equal(context.analysis.preset, "thirds");
});

test("resizing preserves stored normalized marks and Save uses the latest state", () => {
  const { context, event, resize } = fixture();
  context.handlePointerDown(event(150));
  context.handlePointerMove(event(250));
  context.handlePointerUp(event(250));
  const stored = plain(context.analysis.strokes);
  resize({ left: 100, top: 100, width: 400, height: 200 });
  context.visibleAnalysis = { preset: "none", gridVisible: false, strokes: [] };
  context.updateAnalysis({ preset: "thirds" });
  context.saveAnalysis();
  assert.deepEqual(plain(context.saved.analysis.strokes), stored);
  assert.equal(context.saved.analysis.preset, "thirds");
  context.undoAnalysis();
  assert.deepEqual(plain(context.analysis.strokes), stored);
  assert.equal(context.analysis.preset, "none");
});

test("a delayed initial IPC reply cannot overwrite a newer payload and edits", async () => {
  const { context } = fixture();
  let reply;
  let push;
  context.desktop.getImageAnalysisInit = () => new Promise((resolve) => { reply = resolve; });
  context.desktop.onImageAnalysisInit = (callback) => { push = callback; return () => {}; };
  const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.getText(source).includes("getImageAnalysisInit"));
  execute(context, `globalThis.initializeEffect = ${effect.arguments[0].getText(source)};`);
  const cleanup = context.initializeEffect();
  push({ itemId: "newer", analysis: { preset: "none", gridVisible: false, strokes: [] } });
  context.updateAnalysis({ preset: "thirds" });
  reply({ itemId: "older", analysis: { preset: "diagonals", gridVisible: false, strokes: [] } });
  await Promise.resolve();
  assert.equal(context.payload.itemId, "newer");
  assert.equal(context.analysis.preset, "thirds");
  cleanup();
});

test("unmounting ignores pending initialization and releases an active capture", async () => {
  const { context, event, captures } = fixture();
  let reply;
  let removeCount = 0;
  context.desktop.getImageAnalysisInit = () => new Promise((resolve) => { reply = resolve; });
  context.desktop.onImageAnalysisInit = () => () => { removeCount += 1; };
  const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.getText(source).includes("getImageAnalysisInit"));
  execute(context, `globalThis.initializeEffect = ${effect.arguments[0].getText(source)};`);
  const cleanup = context.initializeEffect();
  context.handlePointerDown(event(120));
  cleanup();
  reply({ itemId: "late", analysis: { preset: "thirds", gridVisible: false, strokes: [] } });
  await Promise.resolve();
  assert.equal(context.payload.itemId, "image-A");
  assert.equal(captures.size, 0);
  assert.equal(removeCount, 1);
});
