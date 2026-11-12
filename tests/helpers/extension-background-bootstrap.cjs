/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const output = process.env.IMAGESTORAGE_BACKGROUND_TEST_DIR;
if (!output || !process.env.IMAGESTORAGE_TEST_USER_DATA || !process.env.IMAGESTORAGE_EXTENSION_CONFIG_DIR) throw new Error("An isolated profile is required");
app.disableHardwareAcceleration();
app.getAppPath = () => __filename;
const showCalls = [];
app.on("browser-window-created", (_event, window) => {
  // Detect unwanted presentation without ever putting a QA window on the desktop.
  for (const name of ["show", "showInactive", "focus"]) window[name] = () => { showCalls.push(name); };
});
function finish(error) {
  const windows = BrowserWindow.getAllWindows();
  fs.writeFileSync(path.join(output, "runtime-result.json"), JSON.stringify({
    error, showCalls, visibleWindows: windows.filter(window => window.isVisible()).length,
    windows: windows.length, backgroundLaunch: process.argv.includes("--imagestorage-extension"),
  }));
  app.exit(error ? 1 : 0);
}
setTimeout(() => finish("QA deadline"), 45000);
setInterval(() => { if (fs.existsSync(path.join(output, "stop"))) finish(null); }, 100);
require("../../desktop/main.cjs");
