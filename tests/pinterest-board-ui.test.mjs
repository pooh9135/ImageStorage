import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);
const { parsePinterestBoardFile } = require("../desktop/pinterest-board-file.cjs");
async function run(helper, prefix, extraArgs = [], timeout = 55000) {
  await fs.mkdir("work", { recursive: true });
  const output = await fs.mkdtemp(path.resolve(`work/${prefix}-`)), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.MUSEBOARD_DEV_SERVER_URL;
  let failure;
  try { await promisify(execFile)(require("electron"), [path.resolve(helper), `--board-file-test-dir=${output}`, ...extraArgs], { env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }); }
  catch (error) { failure = error; }
  const result = JSON.parse(await fs.readFile(path.join(output, "result.json"), "utf8"));
  assert.equal(result.ok, true, result.error); assert.equal(failure, undefined);
  return { output, result };
}
test("board export captures virtualized pins and writes a compatible file without network APIs", { timeout: 130000 }, async () => {
  const { output, result } = await run("tests/helpers/pinterest-board-export-bootstrap.cjs", "pinterest-board-export-ui", [], 125000);
  assert.equal(result.cases.length, 23);
  const file = parsePinterestBoardFile(await fs.readFile(path.join(output, "exported-board.json"), "utf8"));
  assert.equal(file.board.name, "テスト:資料"); assert.equal(file.pins.length, 3);
  const complete = parsePinterestBoardFile(await fs.readFile(path.join(output, "whole-board.json"), "utf8"));
  assert.equal(complete.pins.length, 5); assert.equal(complete.version, 2);
  console.log(`Board export UI evidence: ${output}`);
});

for (const group of ["export", "guard"]) test(`board one-click autoload ${group} works without manual scrolling or API requests`, { timeout: 70000 }, async () => {
  const { output, result } = await run("tests/helpers/pinterest-board-autoload-bootstrap.cjs", `pinterest-board-autoload-${group}`, [`--board-autoload-group=${group}`], 65000);
  assert.equal(result.cases.length, group === "export" ? 3 : 4); assert.equal(result.apiRequests, 0); assert.equal(result.visibleWindows, 0);
  console.log(`Board autoload ${group} UI evidence: ${output}`);
});
test("board-file import in the real isolated app preserves bytes, supports retry and cancellation", { timeout: 60000 }, async () => {
  const { output, result } = await run("tests/helpers/pinterest-board-import-bootstrap.cjs", "pinterest-board-import-ui");
  assert.equal(result.cases.length, 7); assert.equal(result.visibleWindows, 0);
  console.log(`Board import UI evidence: ${output}`);
});
