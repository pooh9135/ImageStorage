import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const javascript = ts.transpileModule(await readFile(new URL("../app/list-manager-pointer-drag.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { createListManagerPointerDrag } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const event = (overrides = {}) => ({ pointerId: 7, clientX: 100, clientY: 100, button: 0, buttons: 1, isPrimary: true, ...overrides });

function harness(overrides = {}) {
  const log = [], captures = new Set();
  let onRelease = () => {};
  const target = {
    setPointerCapture(id) { log.push(["capture", id]); captures.add(id); },
    hasPointerCapture(id) { return captures.has(id); },
    releasePointerCapture(id) { log.push(["release", id]); captures.delete(id); onRelease(id); },
  };
  const drag = createListManagerPointerDrag({
    onStart: (...args) => log.push(["start", ...args]),
    onMove: (...args) => log.push(["move", ...args]),
    onDrop: (...args) => log.push(["drop", ...args]),
    onEnd: () => log.push(["end"]),
    ...overrides,
  });
  return { drag, log, target, captures, setOnRelease(callback) { onRelease = callback; },
    begin() { return drag.begin(event(), "source", target); },
    activate() { drag.begin(event(), "source", target); return drag.move(event({ clientX: 106 })); } };
}

test("manager pointer drag accepts only a primary left press", () => {
  const h = harness();
  for (const changes of [{ button: 2, buttons: 2 }, { buttons: 0 }, { isPrimary: false }]) {
    assert.equal(h.drag.begin(event(changes), "source", h.target), false);
  }
  assert.equal(h.drag.pointer, null);
  assert.deepEqual(h.log, []);
  assert.equal(h.drag.begin(event({ isPrimary: undefined }), "source", h.target), true);
});

test("manager clicks and movements shorter than six pixels do not capture or reorder", () => {
  const h = harness();
  assert.equal(h.begin(), true);
  assert.equal(h.drag.move(event({ clientX: 105.99 })), false);
  assert.equal(h.drag.active, false);
  assert.equal(h.drag.finish(event({ clientX: 105.99, buttons: 0 })), false);
  assert.equal(h.drag.pointer, null);
  assert.deepEqual(h.log, []);
});

test("manager pointer drag starts at six pixels and continues on the same captured pointer", () => {
  const h = harness();
  assert.equal(h.activate(), true);
  assert.equal(h.drag.active, true);
  assert.deepEqual(h.log, [["capture", 7], ["start", "source", 106, 100], ["move", 106, 100]]);
  assert.equal(h.drag.move(event({ clientX: 110, clientY: 200 })), true);
  assert.equal(h.log.filter(([kind]) => kind === "capture").length, 1);
  assert.deepEqual(h.drag.pointer, { x: 110, y: 200 });
  const position = h.drag.pointer;
  position.x = -100;
  assert.deepEqual(h.drag.pointer, { x: 110, y: 200 }, "Callers cannot mutate the recorded position");
});

test("a second pointer cannot replace, move, finish, or cancel an active manager drag", () => {
  const h = harness();
  h.activate();
  const before = [...h.log];
  assert.equal(h.drag.begin(event({ pointerId: 8 }), "other", h.target), false);
  assert.equal(h.drag.move(event({ pointerId: 8, clientY: 900 })), false);
  assert.equal(h.drag.finish(event({ pointerId: 8, buttons: 0 })), false);
  h.drag.lostCapture({ pointerId: 8 });
  assert.equal(h.drag.active, true);
  assert.deepEqual(h.log, before);
  assert.deepEqual(h.drag.pointer, { x: 106, y: 100 });
});

test("manager release updates the final destination before committing once and releasing capture", () => {
  const h = harness();
  h.activate();
  assert.equal(h.drag.finish(event({ clientX: 350, clientY: 800, buttons: 0 })), true);
  assert.deepEqual(h.log.slice(-4), [["move", 350, 800], ["drop", "source"], ["release", 7], ["end"]]);
  assert.equal(h.drag.finish(event({ buttons: 0 })), false);
  assert.equal(h.drag.active, false);
  assert.equal(h.drag.pointer, null);
  assert.equal(h.captures.size, 0);
  assert.equal(h.log.filter(([kind]) => kind === "drop").length, 1);
});

test("losing the left button cancels a manager drag without committing", () => {
  for (const activate of [false, true]) {
    const h = harness();
    if (activate) h.activate(); else h.begin();
    assert.equal(h.drag.move(event({ clientY: 300, buttons: 0 })), false);
    assert.equal(h.drag.active, false);
    assert.equal(h.drag.pointer, null);
    assert.equal(h.log.some(([kind]) => kind === "drop"), false);
    assert.equal(h.log.filter(([kind]) => kind === "end").length, Number(activate));
    assert.equal(h.captures.size, 0);
  }
});

test("manager cancellation is idempotent and permits a fresh drag", () => {
  const h = harness();
  h.activate();
  h.drag.cancel();
  h.drag.cancel();
  assert.equal(h.drag.active, false);
  assert.equal(h.log.filter(([kind]) => kind === "end").length, 1);
  assert.equal(h.log.some(([kind]) => kind === "drop"), false);
  assert.equal(h.drag.begin(event({ pointerId: 8 }), "other", h.target), true);
  assert.equal(h.drag.move(event({ pointerId: 8, clientY: 120 })), true);
  h.drag.finish(event({ pointerId: 8, clientY: 120, buttons: 0 }));
  assert.deepEqual(h.log.filter(([kind]) => kind === "drop"), [["drop", "other"]]);
});

test("lost pointer capture cancels the matching drag without a drop", () => {
  const h = harness();
  h.activate();
  h.captures.delete(7);
  h.drag.lostCapture({ pointerId: 7 });
  assert.equal(h.drag.active, false);
  assert.equal(h.drag.pointer, null);
  assert.deepEqual(h.log.slice(-1), [["end"]]);
  assert.equal(h.log.some(([kind]) => kind === "drop" || kind === "release"), false);
});

test("synchronous lostcapture during cleanup cannot recursively end or commit the drag", () => {
  for (const complete of [false, true]) {
    const h = harness();
    h.setOnRelease((pointerId) => {
      assert.equal(h.drag.active, false, "State must clear before releasing capture");
      assert.equal(h.drag.pointer, null);
      h.drag.lostCapture({ pointerId });
      h.drag.cancel();
    });
    h.activate();
    if (complete) h.drag.finish(event({ buttons: 0 })); else h.drag.cancel();
    assert.equal(h.log.filter(([kind]) => kind === "end").length, 1);
    assert.equal(h.log.filter(([kind]) => kind === "release").length, 1);
    assert.equal(h.log.filter(([kind]) => kind === "drop").length, Number(complete));
  }
});

test("a reentrant finish cannot commit the same manager drag twice", () => {
  let drag, drops = 0;
  const h = harness({ onDrop() { drops += 1; assert.equal(drag.finish(event({ buttons: 0 })), false); } });
  drag = h.drag;
  h.activate();
  h.drag.finish(event({ buttons: 0 }));
  assert.equal(drops, 1);
  assert.equal(h.log.filter(([kind]) => kind === "end").length, 1);
});

test("capture failure abandons a pending drag before starting any visual or scrolling state", () => {
  const h = harness();
  h.target.setPointerCapture = () => { throw new Error("Pointer already ended"); };
  assert.equal(h.activate(), false);
  assert.equal(h.drag.active, false);
  assert.equal(h.drag.pointer, null);
  assert.deepEqual(h.log, []);
});

test("cancellation during the final move prevents a stale drop", () => {
  let drag, cancel = false, drops = 0;
  const h = harness({ onMove() { if (cancel) drag.cancel(); }, onDrop() { drops += 1; } });
  drag = h.drag;
  h.activate();
  cancel = true;
  h.drag.finish(event({ clientY: 800, buttons: 0 }));
  assert.equal(drops, 0);
  assert.equal(h.drag.active, false);
  assert.equal(h.log.filter(([kind]) => kind === "end").length, 1);
});

test("callback failures release capture and clear the session", () => {
  for (const callback of ["onStart", "onMove", "onDrop"]) {
    const error = new Error(callback);
    const h = harness({ [callback]() { throw error; } });
    assert.throws(() => {
      h.activate();
      h.drag.finish(event({ buttons: 0 }));
    }, (actual) => actual === error);
    assert.equal(h.drag.active, false);
    assert.equal(h.drag.pointer, null);
    assert.equal(h.captures.size, 0);
    assert.equal(h.log.filter(([kind]) => kind === "end").length, 1);
  }
});
