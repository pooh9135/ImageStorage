const fs = require("node:fs");
const path = require("node:path");

const EXIT_REASONS = new Set([
  "clean-exit", "abnormal-exit", "killed", "crashed", "oom",
  "launch-failed", "integrity-failure",
]);
const PROCESS_TYPES = new Set([
  "Browser", "Tab", "Utility", "Zygote", "Sandbox helper", "GPU", "Pepper Plugin", "Pepper Plugin Broker",
]);
const ERROR_NAMES = new Set([
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AggregateError",
]);
const ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "ENOMEM", "EIO", "EROFS", "EMFILE", "ENFILE", "EEXIST",
  "ETIMEDOUT", "ECONNRESET", "ERR_OUT_OF_RANGE", "ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE",
]);
const number = (value) => Number.isSafeInteger(value) ? value : null;
const version = (value) => /^[0-9][0-9a-z.+-]{0,63}$/i.test(String(value || "")) ? String(value) : "unknown";

// Local metadata only: never log console text, URLs, exception messages/stacks,
// project paths, image data, or IPC payloads. A native process crash may bypass
// JavaScript entirely; a missing exit record is not itself proof of a crash.
function installRuntimeDiagnostics({ app, processObject = process, fileSystem = fs }) {
  const directory = path.join(app.getPath("userData"), "diagnostics");
  const logPath = path.join(directory, "runtime.jsonl");
  const previousPath = path.join(directory, "runtime.previous.jsonl");
  const maxBytes = 128 * 1024;
  const consoleLimit = 5;
  const consoleWindows = new Map();
  const contentsIds = new WeakMap();
  const listen = (emitter, event, callback, once = false) => {
    emitter[once ? "once" : "on"](event, (...args) => {
      try { callback(...args); } catch {}
    });
  };

  const record = (event, details = {}) => {
    try {
      const line = JSON.stringify({
        time: new Date().toISOString(), pid: number(processObject.pid), event, ...details,
      }) + "\n";
      fileSystem.mkdirSync(directory, { recursive: true });
      let size = 0;
      try { size = fileSystem.statSync(logPath).size; } catch {}
      if (size + Buffer.byteLength(line) > maxBytes) {
        fileSystem.rmSync(previousPath, { force: true });
        fileSystem.renameSync(logPath, previousPath);
      }
      fileSystem.appendFileSync(logPath, line, "utf8");
    } catch {
      // Logging must never interfere with saving, window events, or shutdown.
    }
  };

  const finishConsoleBucket = (id) => {
    const bucket = consoleWindows.get(id);
    if (bucket?.count > consoleLimit) {
      record("renderer-console-summary", { contentsId: number(id), count: bucket.count });
    }
  };
  listen(app, "web-contents-created", (_event, contents) => {
    const contentsId = number(contents.id);
    contentsIds.set(contents, contentsId);
    listen(contents, "console-message", (details, legacyLevel) => {
      if (details?.level !== "error" && legacyLevel !== 3) return;
      const now = Date.now();
      let bucket = consoleWindows.get(contentsId);
      if (!bucket || now - bucket.start >= 60_000) {
        finishConsoleBucket(contentsId);
        bucket = { start: now, count: 0 };
        consoleWindows.set(contentsId, bucket);
      }
      bucket.count += 1;
      if (bucket.count <= consoleLimit) {
        record("renderer-console-error", { contentsId, count: bucket.count });
      } else if (bucket.count === consoleLimit + 1) {
        record("renderer-console-limited", { contentsId, limitPerMinute: consoleLimit });
      }
    });
    listen(contents, "destroyed", () => {
      finishConsoleBucket(contentsId);
      consoleWindows.delete(contentsId);
    }, true);
  });
  listen(app, "render-process-gone", (_event, contents, details) => record("renderer-gone", {
    contentsId: contentsIds.get(contents) ?? null,
    reason: EXIT_REASONS.has(details.reason) ? details.reason : "unknown",
    exitCode: number(details.exitCode),
  }));
  listen(app, "child-process-gone", (_event, details) => record("child-gone", {
    type: PROCESS_TYPES.has(details.type) ? details.type : "unknown",
    reason: EXIT_REASONS.has(details.reason) ? details.reason : "unknown",
    exitCode: number(details.exitCode),
  }));
  listen(app, "browser-window-created", (_event, window) => {
    const windowId = number(window.id);
    listen(window, "close", () => record("window-close-requested", { windowId }));
    listen(window, "closed", () => record("window-closed", { windowId }), true);
  });
  listen(app, "before-quit", () => record("before-quit"));
  listen(app, "will-quit", () => record("will-quit"));
  listen(app, "quit", (_event, exitCode) => record("app-quit", { exitCode: number(exitCode) }));
  // Monitoring preserves Node's default exception handling; do not swallow a
  // fatal exception or attempt to continue an uncertain application state.
  listen(processObject, "uncaughtExceptionMonitor", (error, origin) => record("main-exception", {
    name: ERROR_NAMES.has(error?.name) ? error.name : "Error",
    code: ERROR_CODES.has(error?.code) ? error.code : null,
    origin: origin === "unhandledRejection" ? "unhandledRejection" : "uncaughtException",
  }));
  listen(processObject, "exit", (exitCode) => {
    for (const id of consoleWindows.keys()) finishConsoleBucket(id);
    consoleWindows.clear();
    record("process-exit", { exitCode: number(exitCode) });
  }, true);
  record("startup", {
    appVersion: version(app.getVersion()),
    electron: version(processObject.versions?.electron),
    chromium: version(processObject.versions?.chrome),
    node: version(processObject.versions?.node),
    packaged: Boolean(app.isPackaged),
  });
  return { logPath, previousPath };
}

module.exports = { installRuntimeDiagnostics };
