import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import diagnostics from "../desktop/diagnostics.cjs";

async function fixture(t, fileSystem) {
  const root = fileURLToPath(new URL("../work/diagnostics-tests/", import.meta.url));
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, "run-"));
  assert.equal(path.dirname(directory), path.resolve(root));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const app = Object.assign(new EventEmitter(), {
    getPath: () => directory, getVersion: () => "0.15.2", isPackaged: true,
  });
  const processObject = Object.assign(new EventEmitter(), {
    pid: 123, versions: { electron: "45.2.1", chrome: "154.0.0.0", node: "24.0.0" },
  });
  const paths = diagnostics.installRuntimeDiagnostics({ app, processObject, fileSystem });
  const read = async (target = paths.logPath) => (await fs.readFile(target, "utf8")).trim().split("\n").map(JSON.parse);
  return { app, processObject, ...paths, read };
}

test("diagnostics record runtime and failure metadata without private content", async (t) => {
  const state = await fixture(t);
  const contents = Object.assign(new EventEmitter(), { id: 4 });
  state.app.emit("web-contents-created", {}, contents);
  contents.emit("console-message", { level: "warning", message: "PRIVATE warning" });
  contents.emit("console-message", { level: "error", message: "PRIVATE image data", sourceId: "file:///PRIVATE/project" });
  state.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: -1, message: "PRIVATE body" });
  state.app.emit("child-process-gone", {}, { type: "GPU", reason: "oom", exitCode: 3, serviceName: "PRIVATE application" });
  state.app.emit("child-process-gone", {}, { type: "PRIVATE type", reason: "PRIVATE reason", exitCode: "PRIVATE code" });
  state.processObject.emit("uncaughtExceptionMonitor", { name: "TypeError", code: "EACCES", message: "PRIVATE path", stack: "PRIVATE stack" }, "unhandledRejection");
  state.processObject.emit("uncaughtExceptionMonitor", { name: "PRIVATE name", code: "PRIVATE code", message: "PRIVATE content" }, "PRIVATE origin");
  state.app.emit("quit", {}, 0);
  state.processObject.emit("exit", 0);
  const entries = await state.read();
  assert.equal(entries[0].event, "startup");
  assert.equal(entries[0].electron, "45.2.1");
  assert.equal(entries.filter((entry) => entry.event === "renderer-console-error").length, 1);
  assert.deepEqual(entries.find((entry) => entry.event === "renderer-gone").reason, "crashed");
  assert.equal(entries.find((entry) => entry.event === "main-exception").code, "EACCES");
  assert.equal(entries.at(-1).event, "process-exit");
  assert.equal(JSON.stringify(entries).includes("PRIVATE"), false);
  assert.equal(state.processObject.listenerCount("uncaughtException"), 0, "logging must preserve fatal exception handling");
  assert.equal(state.processObject.listenerCount("unhandledRejection"), 0);
});

test("console error storms are rate-limited and summarized without reading destroyed contents", async (t) => {
  const state = await fixture(t);
  const contents = new EventEmitter();
  let destroyed = false;
  Object.defineProperty(contents, "id", { get() { if (destroyed) throw new Error("Object has been destroyed"); return 7; } });
  state.app.emit("web-contents-created", {}, contents);
  for (let index = 0; index < 1000; index++) {
    contents.emit("console-message", {}, 3, `PRIVATE error ${index}`, 9, "PRIVATE URL");
  }
  destroyed = true;
  assert.doesNotThrow(() => state.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: -1 }));
  assert.doesNotThrow(() => contents.emit("destroyed"));
  const entries = await state.read();
  assert.equal(entries.filter((entry) => entry.event === "renderer-console-error").length, 5);
  assert.equal(entries.filter((entry) => entry.event === "renderer-console-limited").length, 1);
  assert.equal(entries.find((entry) => entry.event === "renderer-console-summary").count, 1000);
  assert.ok(entries.length <= 9);
  assert.equal(entries.find((entry) => entry.event === "renderer-gone").contentsId, 7);
  assert.equal(JSON.stringify(entries).includes("PRIVATE"), false);
});

test("diagnostics rotate to one bounded previous file", async (t) => {
  const state = await fixture(t);
  for (let index = 0; index < 2000; index++) {
    state.app.emit("child-process-gone", {}, { type: "Utility", reason: "crashed", exitCode: index });
  }
  assert.ok((await fs.stat(state.logPath)).size <= 128 * 1024);
  assert.ok((await fs.stat(state.previousPath)).size <= 128 * 1024);
  assert.equal((await state.read()).at(-1).exitCode, 1999);
  assert.ok((await state.read(state.previousPath)).length > 0);
  assert.equal((await fs.readdir(path.dirname(state.logPath))).length, 2);
});

test("diagnostic filesystem failures never escape into app event handling", async (t) => {
  const state = await fixture(t, { mkdirSync() { throw new Error("logging unavailable"); } });
  const contents = Object.assign(new EventEmitter(), { id: 1 });
  assert.doesNotThrow(() => {
    state.app.emit("web-contents-created", {}, contents);
    contents.emit("console-message", { level: "error", message: "PRIVATE" });
    state.app.emit("render-process-gone", {}, contents, { reason: "crashed", exitCode: 1 });
    state.processObject.emit("uncaughtExceptionMonitor", new Error("PRIVATE"), "uncaughtException");
    state.processObject.emit("exit", 1);
  });
});
