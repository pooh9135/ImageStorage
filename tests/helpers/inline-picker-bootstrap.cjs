/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const output = process.argv.find(value => value.startsWith("--picker-test-dir="))?.slice("--picker-test-dir=".length);
const { app } = require("electron");
function fail(error) {
  if (output) fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ ok: false, cases: [], error: String(error.stack || error) }));
  app.exit(1);
}
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
if (output) fs.writeFileSync(path.join(output, "bootstrap.json"), JSON.stringify({ started: true, version: process.versions.electron }));
import(pathToFileURL(path.join(__dirname, "inline-picker-electron.mjs")).href).catch(fail);
