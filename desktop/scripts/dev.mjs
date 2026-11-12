import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const isWindows = process.platform === "win32";
const executable = (name) =>
  path.join(
    projectRoot,
    "node_modules",
    ".bin",
    `${name}${isWindows ? ".cmd" : ""}`,
  );

const renderer = spawn(
  executable("vite"),
  ["--config", "vite.desktop.config.ts", "--port", "5174"],
  { cwd: projectRoot, stdio: "inherit", shell: isWindows },
);

async function waitForRenderer() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await new Promise((resolve) => {
      const request = http.get("http://127.0.0.1:5174", () => resolve(true));
      request.on("error", () => resolve(false));
      request.setTimeout(250, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Renderer did not start");
}

await waitForRenderer();

const electron = spawn(executable("electron"), ["."], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: isWindows,
  env: {
    ...process.env,
    MUSEBOARD_DEV_SERVER_URL: "http://127.0.0.1:5174",
  },
});

const shutdown = () => {
  if (!renderer.killed) renderer.kill();
  if (!electron.killed) electron.kill();
};

electron.on("exit", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
