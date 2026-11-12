import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const require = createRequire(import.meta.url);

test("inline picker UI in a hidden isolated Chromium renderer", { timeout: 60000 }, async () => {
  await fs.mkdir("work", { recursive: true });
  const output = await fs.mkdtemp(path.resolve("work/inline-picker-ui-"));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let executionError;
  try {
    await promisify(execFile)(require("electron"), [path.resolve("tests/helpers/inline-picker-bootstrap.cjs"), `--picker-test-dir=${output}`], { env, windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
  } catch (error) { executionError = error; }
  let result;
  try { result = JSON.parse(await fs.readFile(path.join(output, "result.json"), "utf8")); }
  catch { throw executionError || new Error("UI test did not produce a result"); }
  assert.equal(result.ok, true, result.error);
  assert.equal(result.cases.length, 42);
  assert.equal(executionError, undefined);
  console.log(`UI evidence: ${output}`);
});
