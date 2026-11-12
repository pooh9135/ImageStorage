const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  screen,
} = require("electron");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash, randomUUID } = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { fileURLToPath, pathToFileURL } = require("node:url");
const sharp = require("sharp");
const { installRuntimeDiagnostics } = require("./diagnostics.cjs");
const { createStorageTools, savedBackupPaths, hasTransientSources } = require("./storage-tools.cjs");
const { createExtensionBridge, ensureBridgeConfiguration, bridgeError } = require("./extension-bridge.cjs");
const { parsePinterestBoardFile, MAX_BYTES: MAX_BOARD_FILE_BYTES } = require("./pinterest-board-file.cjs");

let mainWindow = null;
let extensionBackgroundMode = process.argv.includes("--imagestorage-extension");
let extensionBridge = null;
const extensionImports = new Map();
let extensionCommitQueue = Promise.resolve();
const analysisWindows = new Map();
let currentProjectPath = null;
let projectGeneration = 0;
let projectSaveQueue = Promise.resolve();
let closeApproved = false;
let closeRequestPending = false;
let closeRecoveryPending = false;
let closeFallbackTimer = null;
let editorCloseNoticePending = false;
let restoringBackup = false;
let recoveryWriteQueue = Promise.resolve();
let titlebarPointerTimer = null;
let titlebarVisible = false;
const MAX_IMAGE_BYTES = 120 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 30 * 1000;

// Native dialogs follow the language chosen in Settings. The renderer keeps it in localStorage,
// which every app window shares, so read it from any live window.
async function uiLanguage() {
  try {
    const source = [mainWindow, ...analysisWindows.values()].find((window) => window && !window.isDestroyed());
    const value = await source?.webContents.executeJavaScript('localStorage.getItem("imagestorage-language")', false);
    if (["en", "ja", "zh", "ko"].includes(value)) return value;
  } catch {
    // A window that is still loading cannot answer; English is the safe fallback.
  }
  return "en";
}

async function uiText() {
  const language = await uiLanguage();
  return (en, ja, zh, ko) => language === "ja" ? ja : language === "zh" ? zh : language === "ko" ? ko : en;
}

function isMainRenderer(event) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === mainWindow.webContents.mainFrame);
}

function invalidateExtensionImports() {
  extensionBridge?.invalidate();
  for (const pending of extensionImports.values()) { clearTimeout(pending.timer); pending.reject(bridgeError("app_closed", "ImageStorageの画面が閉じられました。")); }
  extensionImports.clear();
}

async function startExtensionBridge() {
  if (process.platform !== "win32") return;
  const directory = process.env.IMAGESTORAGE_EXTENSION_CONFIG_DIR || path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "ImageStorage", "BrowserBridge");
  const config = await ensureBridgeConfiguration(directory, { appPath: process.execPath, appArgs: app.isPackaged ? [] : [app.getAppPath()] });
  extensionBridge = createExtensionBridge({
    pipePath: `\\\\.\\pipe\\${config.pipeName}`, token: config.token,
    onImport: async (request, isCurrent) => {
      let image;
      try { image = await importImageUrl(request.imageUrl); }
      catch { throw bridgeError("download_failed", "画像を取得できませんでした。ブラウザーからの読み込みを試してください。"); }
      if (!isCurrent() || !mainWindow || mainWindow.isDestroyed()) throw bridgeError("stale_list", "保存先が変更されました。リストを選び直してください。");
      const commit = extensionCommitQueue.catch(() => {}).then(async () => {
        if (!isCurrent() || !mainWindow || mainWindow.isDestroyed()) throw bridgeError("stale_list", "保存先が変更されました。リストを選び直してください。");
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { extensionImports.delete(requestId); reject(bridgeError("unknown_result", "送信結果を確認できませんでした。ImageStorageの保存先リストを確認してください。")); }, 60000);
          extensionImports.set(requestId, { resolve, reject, timer, isCurrent, boardId: request.boardId });
          mainWindow.webContents.send("extension:import", { requestId, generation: request.generation, boardId: request.boardId, newBoardName: request.newBoardName, sourceUrl: request.sourceUrl, image: { ...image, originalImageUrl: request.originalImageUrl || undefined } });
        });
      });
      extensionCommitQueue = commit;
      const result = await commit;
      return { ...result, boardId: request.boardId };
    },
    onRemove: (request, isCurrent) => {
      const commit = extensionCommitQueue.catch(() => {}).then(() => {
        if (!isCurrent() || !mainWindow || mainWindow.isDestroyed()) throw bridgeError("stale_list", "保存先が変更されました。リストを選び直してください。");
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { extensionImports.delete(requestId); reject(bridgeError("unknown_result", "解除結果を確認できませんでした。ImageStorageのリストを確認してください。")); }, 60000);
          extensionImports.set(requestId, { resolve, reject, timer, isCurrent, boardId: request.boardId, removing: true, itemIds: request.targets.map(target => target.id) });
          mainWindow.webContents.send("extension:remove", { requestId, generation: request.generation, boardId: request.boardId, targets: request.targets });
        });
      });
      extensionCommitQueue = commit;
      return commit.then(result => ({ ...result, boardId: request.boardId, removed: true }));
    },
  });
  await extensionBridge.start();
}

ipcMain.on("extension:state", (event, state) => {
  if (isMainRenderer(event)) extensionBridge?.updateState(state);
});
ipcMain.on("extension:complete", async (event, result) => {
  if (!isMainRenderer(event) || typeof result?.requestId !== "string") return;
  const pending = extensionImports.get(result.requestId);
  if (!pending || pending.completing) return;
  pending.completing = true;
  clearTimeout(pending.timer);
  try {
    const validCount = pending.removing ? Number.isSafeInteger(result.count) && result.count >= 0 && result.count <= pending.itemIds.length : result.count === 1;
    if (!pending.isCurrent() || !validCount) throw bridgeError("stale_list", "画像を変更できませんでした。保存先を選び直してください。");
    if (restoringBackup || !validProjectSnapshot(result.snapshot) || !result.snapshot.boards.some((board) => board.id === pending.boardId)) {
      throw bridgeError("unknown_result", "保存内容を確認できませんでした。ImageStorageでリストを確認してください。");
    }
    if (pending.removing && result.snapshot.boards.find(board => board.id === pending.boardId).items.some(item => pending.itemIds.includes(item.id))) {
      throw bridgeError("unknown_result", "解除結果を確認できませんでした。ImageStorageでリストを確認してください。");
    }
    // Extension saves are explicit saves, including when autosave is disabled.
    // Acknowledge only after recovery storage has actually been written.
    const saved = await queueRecoverySnapshot(result.snapshot);
    if (!saved.saved) throw bridgeError("unknown_result", "ファイルへ保存できませんでした。ImageStorageでリストを確認してください。");
    pending.resolve({ count: result.count });
  } catch (error) {
    pending.reject(["stale_list", "unknown_result"].includes(error?.code) ? error : bridgeError("unknown_result", "保存結果を確認できませんでした。ImageStorageでリストを確認してください。"));
  } finally {
    if (extensionImports.get(result.requestId) === pending) extensionImports.delete(result.requestId);
  }
});
app.on("before-quit", () => { invalidateExtensionImports(); void extensionBridge?.close(); });
const TITLEBAR_REVEAL_HEIGHT = 8;
const TITLEBAR_VISIBLE_HEIGHT = 38;

function setTitlebarVisibility(nextVisible) {
  if (titlebarVisible === nextVisible) return;
  titlebarVisible = nextVisible;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("titlebar:visibility-change", nextVisible);
}

function getWindowPointerPosition(cursorPoint) {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() ||
      mainWindow.isMinimized() || mainWindow.webContents.isDestroyed()) return null;
  const cursor = cursorPoint ?? screen.getCursorScreenPoint();
  const bounds = mainWindow.getContentBounds();
  if (cursor.x < bounds.x || cursor.y < bounds.y ||
      cursor.x >= bounds.x + bounds.width || cursor.y >= bounds.y + bounds.height) return null;
  const zoom = mainWindow.webContents.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error("Cannot determine the window zoom factor");
  // Electron's screen coordinates and content bounds are DIPs. DOM bounds
  // use CSS pixels, so account for Chromium zoom without applying DPI twice.
  return { clientX: (cursor.x - bounds.x) / zoom, clientY: (cursor.y - bounds.y) / zoom };
}

function updateTitlebarVisibilityFromCursor() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("window:pointer-position", null);
    }
    setTitlebarVisibility(false);
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  try {
    mainWindow.webContents.send("window:pointer-position", getWindowPointerPosition(cursor));
  } catch {
    // Keep the last reliable position; a close decision requests a fresh one.
  }
  const bounds = mainWindow.getBounds();
  const revealHeight = titlebarVisible
    ? TITLEBAR_VISIBLE_HEIGHT
    : TITLEBAR_REVEAL_HEIGHT;
  const insideHorizontal =
    cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width;
  const insideRevealArea =
    cursor.y >= bounds.y && cursor.y < bounds.y + revealHeight;
  setTitlebarVisibility(insideHorizontal && insideRevealArea);
}

function startTitlebarPointerTracking() {
  if (titlebarPointerTimer) clearInterval(titlebarPointerTimer);
  updateTitlebarVisibilityFromCursor();
  titlebarPointerTimer = setInterval(updateTitlebarVisibilityFromCursor, 40);
}

function stopTitlebarPointerTracking() {
  if (titlebarPointerTimer) clearInterval(titlebarPointerTimer);
  titlebarPointerTimer = null;
  titlebarVisible = false;
}

app.setName("ImageStorage");
const legacyUserDataPath = path.join(app.getPath("appData"), "museboard");
const imageStorageUserDataPath = path.join(
  app.getPath("appData"),
  "ImageStorage",
);
const testUserDataPath = process.env.IMAGESTORAGE_TEST_USER_DATA;
app.setPath(
  "userData",
  testUserDataPath
    ? path.resolve(testUserDataPath)
    : fsSync.existsSync(legacyUserDataPath)
      ? legacyUserDataPath
      : imageStorageUserDataPath,
);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else installRuntimeDiagnostics({ app });
app.on("second-instance", (_event, commandLine = []) => {
  if (commandLine.includes("--imagestorage-extension")) return;
  extensionBackgroundMode = false;
  const target = mainWindow ?? [...analysisWindows.values()].find((window) => !window.isDestroyed());
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
});
const assetDirectory = path.join(app.getPath("userData"), "assets");
const recoveryDirectory = path.join(app.getPath("userData"), "recovery");
const autoSavePath = path.join(recoveryDirectory, "autosave.json");
const globalBackgroundPath = path.join(app.getPath("userData"), "global-background.json");
let globalBackgroundAssetReferences = { fileNames: new Set(), fallbackAssetIds: new Set() };
const assetCleanupStatePath = path.join(
  recoveryDirectory,
  "asset-cleanup-state.json",
);
const PORTABLE_PROJECT_MAGIC = Buffer.from("IMAGESTORAGE_PROJECT_V3\n");
const PORTABLE_PROJECT_LENGTH_BYTES = 8;
const MAX_PROJECT_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_PROJECT_ASSETS = 50000;
const DEFAULT_ASSET_CLEANUP_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const ASSET_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
let assetCleanupTimer = null;
let assetCleanupRunning = false;
let lastAssetCleanupAt = 0;

function cleanImageName(value, fallback = "reference-image") {
  const name = String(value || "")
    .split(/[?#]/, 1)[0]
    .replace(/[/\\]+$/, "");
  return path.basename(name) || fallback;
}

function bufferFromDataUrl(value) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/is.exec(value);
  if (!match) throw new Error("Invalid data URL");
  const buffer = match[2]
    ? Buffer.from(match[3], "base64")
    : Buffer.from(decodeURIComponent(match[3]), "utf8");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is too large");
  return buffer;
}

function colorDistance(a, b) {
  const red = a.r - b.r;
  const green = a.g - b.g;
  const blue = a.b - b.b;
  return red * red * 2 + green * green * 4 + blue * blue * 3;
}

function colorToHex(color) {
  return `#${[color.r, color.g, color.b]
    .map((value) =>
      Math.max(0, Math.min(255, Math.round(value)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")
    .toUpperCase()}`;
}

async function extractColorPalette(input, requestedColors = 6) {
  if (!Buffer.isBuffer(input) || input.length === 0) return [];
  const { data, info } = await sharp(input, {
    animated: false,
    failOn: "none",
    limitInputPixels: 320000000,
  })
    .rotate()
    .toColorspace("srgb")
    .resize({
      width: 96,
      height: 96,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map();
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const alpha = data[offset + 3];
    if (alpha < 96) continue;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const key = `${Math.round(red / 20)}:${Math.round(green / 20)}:${Math.round(
      blue / 20,
    )}`;
    const bucket = buckets.get(key) || {
      r: 0,
      g: 0,
      b: 0,
      count: 0,
    };
    bucket.r += red;
    bucket.g += green;
    bucket.b += blue;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  const colors = [...buckets.values()]
    .map((bucket) => ({
      r: bucket.r / bucket.count,
      g: bucket.g / bucket.count,
      b: bucket.b / bucket.count,
      count: bucket.count,
    }))
    .sort((a, b) => b.count - a.count);
  if (!colors.length) return [];

  const colorCount = Math.min(
    Math.max(1, requestedColors),
    colors.length,
  );
  const centers = [{ ...colors[0] }];
  while (centers.length < colorCount) {
    let best = null;
    let bestScore = -1;
    for (const color of colors.slice(0, 256)) {
      const distance = Math.min(
        ...centers.map((center) => colorDistance(color, center)),
      );
      const score = Math.sqrt(distance) * Math.log2(color.count + 2);
      if (score > bestScore) {
        best = color;
        bestScore = score;
      }
    }
    if (!best) break;
    centers.push({ ...best });
  }

  let populations = new Array(centers.length).fill(0);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const sums = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const color of colors) {
      let closestIndex = 0;
      let closestDistance = Number.POSITIVE_INFINITY;
      centers.forEach((center, index) => {
        const distance = colorDistance(color, center);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestIndex = index;
        }
      });
      sums[closestIndex].r += color.r * color.count;
      sums[closestIndex].g += color.g * color.count;
      sums[closestIndex].b += color.b * color.count;
      sums[closestIndex].count += color.count;
    }
    populations = sums.map((sum) => sum.count);
    sums.forEach((sum, index) => {
      if (!sum.count) return;
      centers[index] = {
        r: sum.r / sum.count,
        g: sum.g / sum.count,
        b: sum.b / sum.count,
        count: sum.count,
      };
    });
  }

  return centers
    .map((color, index) => ({ color, population: populations[index] || 0 }))
    .sort((a, b) => b.population - a.population)
    .map(({ color }) => colorToHex(color))
    .filter((hex, index, palette) => palette.indexOf(hex) === index);
}

async function ensureStorageDirectories() {
  await Promise.all([
    fs.mkdir(assetDirectory, { recursive: true }),
    fs.mkdir(recoveryDirectory, { recursive: true }),
  ]);
}

function orientedImageSize(metadata) {
  const width = Number(metadata?.width || 0);
  const height = Number(metadata?.height || 0);
  const swapsAxes = Number(metadata?.orientation || 1) >= 5;
  return swapsAxes
    ? { width: height, height: width }
    : { width, height };
}

async function readImageDimensions(source) {
  try {
    const size = orientedImageSize(
      await sharp(source, {
        animated: false,
        failOn: "none",
        limitInputPixels: 320000000,
      }).metadata(),
    );
    if (size.width && size.height) return size;
  } catch {
    // NativeImage provides a fast fallback for formats handled by Chromium.
  }

  const image = Buffer.isBuffer(source)
    ? nativeImage.createFromBuffer(source)
    : nativeImage.createFromPath(source);
  if (image.isEmpty()) throw new Error("Unsupported image data");
  return image.getSize();
}

async function stageImagePath(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error("The selected item is not a file");
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error("The image is larger than 120 MB");
  }

  await ensureStorageDirectories();
  const assetId = randomUUID();
  const originalExtension = path.extname(filePath).toLowerCase();
  const extension = /^\.[a-z0-9]{1,12}$/.test(originalExtension)
    ? originalExtension
    : ".img";
  const storedPath = path.join(
    assetDirectory,
    `original-${assetId}${extension}`,
  );
  await fs.copyFile(filePath, storedPath);
  const size = await readImageDimensions(storedPath);
  return {
    name: cleanImageName(filePath),
    src: pathToFileURL(storedPath).href,
    width: size.width,
    height: size.height,
    assetId,
    processing: true,
  };
}

async function stageImagePaths(filePaths) {
  const paths = Array.isArray(filePaths)
    ? filePaths.filter((entry) => typeof entry === "string" && entry.trim())
    : [];
  const settled = await Promise.allSettled(
    paths.map((filePath) => stageImagePath(filePath)),
  );
  return {
    canceled: false,
    images: settled.flatMap((entry) =>
      entry.status === "fulfilled" ? [entry.value] : [],
    ),
    errors: settled.flatMap((entry, index) => {
      if (entry.status === "fulfilled") return [];
      return [
        {
          name: path.basename(paths[index]),
          message:
            entry.reason instanceof Error
              ? entry.reason.message
              : "Unsupported image",
        },
      ];
    }),
  };
}

async function persistImageBuffer(input, name, requestedAssetId) {
  if (!Buffer.isBuffer(input) || input.length === 0) {
    throw new Error("The image is empty");
  }
  if (input.length > MAX_IMAGE_BYTES) {
    throw new Error("The image is larger than 120 MB");
  }

  await ensureStorageDirectories();
  const assetId =
    typeof requestedAssetId === "string" &&
    /^[a-zA-Z0-9-]{8,80}$/.test(requestedAssetId)
      ? requestedAssetId
      : randomUUID();

  try {
    const image = sharp(input, {
      animated: false,
      failOn: "none",
      limitInputPixels: 320000000,
    });
    const metadata = await image.metadata();
    const size = orientedImageSize(metadata);
    if (!size.width || !size.height) throw new Error("Unknown image size");

    const originalExtensions = {
      jpeg: ".jpg",
      png: ".png",
      webp: ".webp",
      gif: ".gif",
      avif: ".avif",
    };
    const originalExtension = originalExtensions[metadata.format];
    let fullImage = input;
    let imageExtension = originalExtension;
    if (!imageExtension) {
      fullImage = await sharp(input, {
        animated: false,
        failOn: "none",
        limitInputPixels: 320000000,
      })
        .rotate()
        .toColorspace("srgb")
        .png({ compressionLevel: 6 })
        .toBuffer();
      imageExtension = ".png";
    }

    const thumbnail = await sharp(input, {
      animated: false,
      failOn: "none",
      limitInputPixels: 320000000,
    })
      .rotate()
      .toColorspace("srgb")
      .resize({
        width: 360,
        height: 360,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78, alphaQuality: 82, effort: 0 })
      .toBuffer();
    const imagePath = path.join(
      assetDirectory,
      `image-${assetId}${imageExtension}`,
    );
    const thumbnailPath = path.join(
      assetDirectory,
      `thumbnail-${assetId}.webp`,
    );
    await Promise.all([
      fs.writeFile(imagePath, fullImage),
      fs.writeFile(thumbnailPath, thumbnail),
    ]);
    const palette = await extractColorPalette(thumbnail).catch(() => []);
    return {
      name: cleanImageName(name),
      src: pathToFileURL(imagePath).href,
      thumbnailSrc: pathToFileURL(thumbnailPath).href,
      width: size.width,
      height: size.height,
      palette,
      assetId,
      processing: false,
    };
  } catch (sharpError) {
    const electronImage = nativeImage.createFromBuffer(input);
    if (electronImage.isEmpty()) throw sharpError;
    const size = electronImage.getSize();
    const png = electronImage.toPNG();
    const thumbnail = electronImage
      .resize({
        width: Math.min(360, size.width),
        quality: "good",
      })
      .toPNG();
    const imagePath = path.join(assetDirectory, `image-${assetId}.png`);
    const thumbnailPath = path.join(
      assetDirectory,
      `thumbnail-${assetId}.png`,
    );
    await Promise.all([
      fs.writeFile(imagePath, png),
      fs.writeFile(thumbnailPath, thumbnail),
    ]);
    const palette = await extractColorPalette(thumbnail).catch(() => []);
    return {
      name: cleanImageName(name),
      src: pathToFileURL(imagePath).href,
      thumbnailSrc: pathToFileURL(thumbnailPath).href,
      width: size.width,
      height: size.height,
      palette,
      assetId,
      processing: false,
    };
  }
}

async function optimizeStoredImage(entry) {
  const source = String(entry?.source || "");
  const input = await readImageSource(source);
  return persistImageBuffer(input, entry?.name, entry?.assetId);
}

function validProjectSnapshot(data) {
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string";
  const identifier = (value) => text(value) && value.trim().length > 0;
  const number = (value) => typeof value === "number" && Number.isFinite(value);
  const positive = (value) => number(value) && value > 0;
  const optional = (value, key, validate) => value[key] === undefined || validate(value[key]);
  const texts = (value) => Array.isArray(value) && value.every(text);
  const geometry = (value) => object(value) && number(value.x) && number(value.y) && positive(value.w) && positive(value.h);
  const presets = new Set([
    "none", "thirds", "diagonals", "golden", "golden-wide", "golden-tall",
    "center", "center-frame", "perspective",
  ]);
  const validAnalysis = (value) => object(value) && presets.has(value.preset) &&
    typeof value.gridVisible === "boolean" && optional(value, "guideColor", text) &&
    Array.isArray(value.strokes) && value.strokes.every((stroke) =>
      object(stroke) && identifier(stroke.id) && ["line", "freehand"].includes(stroke.kind) &&
      text(stroke.color) && positive(stroke.width) && optional(stroke, "pressureMinimum", number) &&
      Array.isArray(stroke.points) && stroke.points.length > 0 && stroke.points.every((point) =>
        object(point) && number(point.x) && number(point.y) && optional(point, "pressure", number),
      ),
    );

  if (!object(data) || data.format !== "museboard" || !identifier(data.activeId) ||
      !Array.isArray(data.boards) || data.boards.length === 0) return false;
  const boardIds = new Set();
  return data.boards.every((board) => {
    if (!object(board) || !identifier(board.id) || boardIds.has(board.id) || !text(board.name) ||
        !object(board.viewport) || !number(board.viewport.x) || !number(board.viewport.y) ||
        !positive(board.viewport.scale) || !Array.isArray(board.items)) return false;
    boardIds.add(board.id);
    if (!["accent", "updated", "groupName", "backgroundColor", "backgroundImageSrc",
      "backgroundImageThumbnailSrc", "backgroundImageAssetId", "headerImageSrc",
      "headerImageThumbnailSrc", "headerImageAssetId"].every((key) => optional(board, key, text)) ||
        !["gridVisible", "snapEnabled"].every((key) => optional(board, key, (value) => typeof value === "boolean")) ||
        !["gridSize", "headerImageWidth", "headerImageHeight", "headerImageScale"].every((key) => optional(board, key, positive)) ||
        !["headerImagePositionX", "headerImagePositionY"].every((key) => optional(board, key, number)) ||
        !optional(board, "backgroundFit", (value) => ["cover", "contain", "tile"].includes(value))) return false;
    const itemIds = new Set();
    if (!board.items.every((item) => {
      if (!geometry(item) || !identifier(item.id) || itemIds.has(item.id) ||
          !["image", "note"].includes(item.type) || !number(item.z)) return false;
      itemIds.add(item.id);
      return (item.type !== "image" || identifier(item.src)) &&
        ["src", "thumbnailSrc", "caption", "text", "color", "assetId", "fontFamily", "creator",
          "sourceUrl", "referenceNote"].every((key) => optional(item, key, text)) &&
        ["palette", "tags"].every((key) => optional(item, key, texts)) &&
        ["processing", "favorite", "flipHorizontal", "grayscale"].every((key) => optional(item, key, (value) => typeof value === "boolean")) &&
        optional(item, "rotation", number) && optional(item, "fontSize", positive) &&
        optional(item, "analysis", validAnalysis);
    })) return false;
    return optional(board, "frames", (frames) => Array.isArray(frames) && frames.every((frame) =>
      geometry(frame) && identifier(frame.id) && text(frame.name) && texts(frame.itemIds),
    ));
  });
}

async function writeJsonAtomically(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, contents, "utf8");
  try {
    await replaceFileSafely(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function saveRecoverySnapshot(data) {
  if (!validProjectSnapshot(data)) {
    return { saved: false, error: "Invalid autosave data" };
  }
  if (hasTransientSources(data)) {
    return { saved: false, error: "Image storage is incomplete. Retry importing the image before saving." };
  }
  try {
    await ensureStorageDirectories();
    const contents = JSON.stringify({
      ...data,
      version: 2,
      savedAt: new Date().toISOString(),
    });
    for (let index = 3; index >= 2; index -= 1) {
      const previousPath = path.join(
        recoveryDirectory,
        `autosave.backup-${index - 1}.json`,
      );
      const nextPath = path.join(
        recoveryDirectory,
        `autosave.backup-${index}.json`,
      );
      if (fsSync.existsSync(previousPath)) {
        await fs.copyFile(previousPath, nextPath);
      }
    }
    if (fsSync.existsSync(autoSavePath)) {
      await fs.copyFile(
        autoSavePath,
        path.join(recoveryDirectory, "autosave.backup-1.json"),
      );
    }
    await writeJsonAtomically(autoSavePath, contents);
    scheduleAssetCleanup();
    return { saved: true, error: null };
  } catch (error) {
    return {
      saved: false,
      error: error instanceof Error ? error.message : "Autosave failed",
    };
  }
}

function queueRecoverySnapshot(data) {
  const nextSave = recoveryWriteQueue.then(() => saveRecoverySnapshot(data));
  recoveryWriteQueue = nextSave.catch(() => {});
  return nextSave;
}

function normalizeGlobalBackgroundReference(reference) {
  if (reference == null) return {};
  if (typeof reference !== "object" || Array.isArray(reference)) {
    throw new Error("Invalid global background reference");
  }
  const normalized = {};
  for (const key of ["backgroundImageSrc", "backgroundImageThumbnailSrc", "backgroundImageAssetId"]) {
    const value = reference[key];
    if (value == null) continue;
    if (typeof value !== "string") throw new Error("Invalid global background reference");
    if (value.trim()) normalized[key] = value.trim();
  }
  return normalized;
}

function collectGlobalBackgroundReference(reference, references) {
  collectReferencedAssetFiles({
    format: "museboard",
    activeId: "global-background",
    boards: [{ id: "global-background", name: "", viewport: { x: 0, y: 0, scale: 1 }, items: [], ...reference }],
  }, references);
}

function queueGlobalBackground(reference) {
  let normalized;
  try {
    normalized = normalizeGlobalBackgroundReference(reference);
  } catch (error) {
    return Promise.resolve({ saved: false, error: error.message });
  }
  // Protect the latest choice immediately, including while an atomic write is pending.
  globalBackgroundAssetReferences = { fileNames: new Set(), fallbackAssetIds: new Set() };
  collectGlobalBackgroundReference(normalized, globalBackgroundAssetReferences);
  const nextSave = recoveryWriteQueue.then(async () => {
    try {
      await writeJsonAtomically(globalBackgroundPath, JSON.stringify({ version: 1, reference: normalized }));
      return { saved: true };
    } catch (error) {
      return { saved: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  // Share the existing write drain without creating an autosave or changing its setting.
  recoveryWriteQueue = nextSave.catch(() => {});
  return nextSave;
}

async function drainPendingWrites() {
  // An autosave can join the queue while an earlier write is completing.
  // Recheck both queue tails before allowing the process to terminate.
  for (;;) {
    const projectWrites = projectSaveQueue;
    const recoveryWrites = recoveryWriteQueue;
    await Promise.all([projectWrites, recoveryWrites]);
    if (
      projectWrites === projectSaveQueue &&
      recoveryWrites === recoveryWriteQueue
    ) return;
  }
}

function recoverySnapshotPaths() {
  return [
    autoSavePath,
    `${autoSavePath}.previous`,
    path.join(recoveryDirectory, "autosave.backup-1.json"),
    path.join(recoveryDirectory, "autosave.backup-2.json"),
    path.join(recoveryDirectory, "autosave.backup-3.json"),
  ];
}

async function loadRecoverySnapshot() {
  for (const candidate of recoverySnapshotPaths()) {
    try {
      const data = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (validProjectSnapshot(data)) {
        return {
          found: true,
          recoveredFromBackup: candidate !== autoSavePath,
          data,
        };
      }
    } catch {
      // Continue to the next recovery generation.
    }
  }
  return { found: false, recoveredFromBackup: false, data: null };
}

function assetIdFromFileName(fileName) {
  return /^(?:original|image|thumbnail)-([a-zA-Z0-9-]{8,80})\.[a-z0-9]{1,12}$/i.exec(
    fileName,
  )?.[1];
}

function assetIdFromSource(source) {
  try {
    const value = String(source || "");
    const sourcePath = /^file:/i.test(value) ? fileURLToPath(value) : value;
    return assetIdFromFileName(path.basename(sourcePath));
  } catch {
    return undefined;
  }
}

function collectReferencedAssetFiles(snapshot, references) {
  if (!validProjectSnapshot(snapshot)) return;
  const collectReference = (source, thumbnailSource, assetId) => {
    const localAssetIds = new Set();
    for (const value of [source, thumbnailSource]) {
      const sourceAssetId = assetIdFromSource(value);
      if (!sourceAssetId) continue;
      localAssetIds.add(sourceAssetId);
      try {
        const sourcePath = /^file:/i.test(String(value || ""))
          ? fileURLToPath(value)
          : String(value || "");
        references.fileNames.add(path.basename(sourcePath));
      } catch {
        // The asset ID still provides conservative fallback protection.
      }
    }
    if (
      typeof assetId === "string" &&
      /^[a-zA-Z0-9-]{8,80}$/.test(assetId) &&
      !localAssetIds.has(assetId)
    ) {
      references.fallbackAssetIds.add(assetId);
    }
  };
  for (const board of snapshot.boards) {
    if (!Array.isArray(board?.items)) continue;
    for (const item of board.items) {
      if (item?.type !== "image") continue;
      collectReference(item.src, item.thumbnailSrc, item.assetId);
    }
    collectReference(
      board.backgroundImageSrc,
      board.backgroundImageThumbnailSrc,
      board.backgroundImageAssetId,
    );
    collectReference(
      board.headerImageSrc,
      board.headerImageThumbnailSrc,
      board.headerImageAssetId,
    );
  }
}

async function readCleanupState() {
  try {
    const state = JSON.parse(await fs.readFile(assetCleanupStatePath, "utf8"));
    if (state?.version === 1 && state.candidates) return state;
  } catch {
    // A missing or damaged cleanup index is safely rebuilt.
  }
  return { version: 1, candidates: {} };
}

async function collectRecoveryAssetReferences() {
  const references = {
    fileNames: new Set(),
    fallbackAssetIds: new Set(),
    snapshotCount: 0,
  };
  for (const recoveryPath of await savedBackupPaths(recoveryDirectory, recoverySnapshotPaths())) {
    try {
      const snapshot = JSON.parse(await fs.readFile(recoveryPath, "utf8"));
      if (validProjectSnapshot(snapshot)) {
        references.snapshotCount += 1;
        collectReferencedAssetFiles(snapshot, references);
      } else references.unreadableSnapshots = true;
    } catch (error) {
      if (error?.code !== "ENOENT") references.unreadableSnapshots = true;
    }
  }
  let unreadableBackground = false;
  for (const candidate of [globalBackgroundPath, `${globalBackgroundPath}.previous`]) {
    try {
      const stored = JSON.parse(await fs.readFile(candidate, "utf8"));
      if (stored?.version !== 1 || !Object.hasOwn(stored, "reference")) {
        throw new Error("Invalid global background sidecar");
      }
      collectGlobalBackgroundReference(normalizeGlobalBackgroundReference(stored.reference), references);
      unreadableBackground = false;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") unreadableBackground = true;
    }
  }
  references.globalBackgroundUnreadable = unreadableBackground;
  for (const fileName of globalBackgroundAssetReferences.fileNames) references.fileNames.add(fileName);
  for (const assetId of globalBackgroundAssetReferences.fallbackAssetIds) references.fallbackAssetIds.add(assetId);
  return references;
}

async function cleanupUnusedAssets() {
  // Undo/Redo and unsaved editor/list-manager drafts can own assets absent
  // from recovery files. Only collect before a renderer session starts.
  if (mainWindow || analysisWindows.size) {
    return { deletedFiles: 0, reclaimedBytes: 0, skipped: true, reason: "active-session" };
  }
  if (assetCleanupRunning) {
    return { deletedFiles: 0, reclaimedBytes: 0, skipped: true };
  }
  assetCleanupRunning = true;
  try {
    await ensureStorageDirectories();
    const [references, cleanupState, directoryEntries] = await Promise.all([
      collectRecoveryAssetReferences(),
      readCleanupState(),
      fs.readdir(assetDirectory, { withFileTypes: true }),
    ]);
    if (!references.snapshotCount || references.globalBackgroundUnreadable || references.unreadableSnapshots) {
      lastAssetCleanupAt = Date.now();
      return {
        deletedFiles: 0,
        reclaimedBytes: 0,
        skipped: true,
        reason: references.unreadableSnapshots ? "unreadable-backup" : references.globalBackgroundUnreadable ? "unreadable-global-background" : "no-valid-recovery-snapshot",
      };
    }
    const assetFiles = [];
    for (const entry of directoryEntries) {
      if (!entry.isFile()) continue;
      const assetId = assetIdFromFileName(entry.name);
      if (!assetId) continue;
      assetFiles.push({
        assetId,
        fileName: entry.name,
        filePath: path.join(assetDirectory, entry.name),
      });
    }

    const now = Date.now();
    const requestedGrace = Number(
      process.env.IMAGESTORAGE_CLEANUP_GRACE_MS,
    );
    const gracePeriod = Number.isFinite(requestedGrace)
      ? Math.max(0, requestedGrace)
      : DEFAULT_ASSET_CLEANUP_GRACE_MS;
    let deletedFiles = 0;
    let reclaimedBytes = 0;

    for (const asset of assetFiles) {
      if (
        references.fileNames.has(asset.fileName) ||
        references.fallbackAssetIds.has(asset.assetId) ||
        globalBackgroundAssetReferences.fileNames.has(asset.fileName) ||
        globalBackgroundAssetReferences.fallbackAssetIds.has(asset.assetId)
      ) {
        delete cleanupState.candidates[asset.fileName];
        continue;
      }
      const firstUnreferenced = Number(
        cleanupState.candidates[asset.fileName],
      );
      if (!Number.isFinite(firstUnreferenced)) {
        cleanupState.candidates[asset.fileName] = now;
      }
      const candidateSince = Number(
        cleanupState.candidates[asset.fileName],
      );
      if (now - candidateSince < gracePeriod) continue;

      try {
        const stats = await fs.stat(asset.filePath);
        // A choice can arrive over IPC while the filesystem operation is awaiting.
        if (globalBackgroundAssetReferences.fileNames.has(asset.fileName) ||
            globalBackgroundAssetReferences.fallbackAssetIds.has(asset.assetId)) {
          delete cleanupState.candidates[asset.fileName];
          continue;
        }
        await fs.rm(asset.filePath, { force: true });
        deletedFiles += 1;
        reclaimedBytes += stats.size;
        delete cleanupState.candidates[asset.fileName];
      } catch {
        // A locked file is retried on the next cleanup pass.
      }
    }

    const availableFileNames = new Set(
      assetFiles.map((asset) => asset.fileName),
    );
    for (const fileName of Object.keys(cleanupState.candidates)) {
      if (!availableFileNames.has(fileName)) {
        delete cleanupState.candidates[fileName];
      }
    }
    await writeJsonAtomically(
      assetCleanupStatePath,
      JSON.stringify(cleanupState),
    );
    lastAssetCleanupAt = now;
    return { deletedFiles, reclaimedBytes, skipped: false };
  } finally {
    assetCleanupRunning = false;
  }
}

function scheduleAssetCleanup(delay = 1500) {
  if (assetCleanupTimer || assetCleanupRunning) return;
  const interval =
    process.env.IMAGESTORAGE_CLEANUP_GRACE_MS !== undefined
      ? 0
      : ASSET_CLEANUP_INTERVAL_MS;
  const waitTime = Math.max(
    delay,
    interval - Math.max(0, Date.now() - lastAssetCleanupAt),
  );
  assetCleanupTimer = setTimeout(() => {
    assetCleanupTimer = null;
    void cleanupUnusedAssets();
  }, waitTime);
  assetCleanupTimer.unref?.();
}

function parseHtmlAttributes(tag) {
  const attributes = {};
  const attributePattern =
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of tag.matchAll(attributePattern)) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function findPageImageUrl(html, pageUrl) {
  const candidates = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseHtmlAttributes(tag);
    const key = (attributes.property || attributes.name || "").toLowerCase();
    if (
      [
        "og:image",
        "og:image:url",
        "og:image:secure_url",
        "twitter:image",
        "twitter:image:src",
      ].includes(key) &&
      attributes.content
    ) {
      candidates.push(attributes.content);
    }
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = parseHtmlAttributes(tag);
    if (
      /\b(?:image_src|apple-touch-icon|icon)\b/i.test(attributes.rel || "") &&
      attributes.href
    ) {
      candidates.push(attributes.href);
    }
  }

  for (const candidate of candidates) {
    try {
      return new URL(decodeHtmlEntities(candidate), pageUrl).href;
    } catch {
      // Continue through malformed metadata until a usable image URL is found.
    }
  }
  return null;
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 ImageStorage/0.7",
      },
    });
    if (!response.ok) {
      throw new Error(`The server returned ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > MAX_IMAGE_BYTES) throw new Error("Image is too large");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is too large");
    return { buffer, response };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("The image download timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getPinterestOriginalUrl(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "i.pinimg.com" ||
    url.username || url.password || url.port
  ) return null;
  const match = /^\/[1-9]\d*x\/((?:[a-f0-9]{2}\/){3}[a-f0-9]{32}\.(?:jpe?g|png|webp|gif|avif))$/i.exec(url.pathname);
  return match ? `https://i.pinimg.com/originals/${match[1]}` : null;
}

async function fetchImageForImport(url) {
  const originalUrl = getPinterestOriginalUrl(url);
  if (originalUrl) {
    try {
      const original = await fetchBuffer(originalUrl);
      await readImageDimensions(original.buffer);
      return original;
    } catch {
      // Some pins do not expose an original. Keep the working dropped image
      // available when the larger file is missing or is not readable image data.
    }
  }
  return fetchBuffer(url);
}

async function importImageUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) throw new Error("No URL was provided");

  if (/^data:/i.test(value)) {
    return persistImageBuffer(bufferFromDataUrl(value), "pasted-image");
  }

  if (/^file:/i.test(value)) {
    const filePath = fileURLToPath(value);
    return persistImageBuffer(
      await fs.readFile(filePath),
      path.basename(filePath),
    );
  }

  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return persistImageBuffer(await fs.readFile(value), path.basename(value));
  }

  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP, HTTPS, file, and data URLs are supported");
  }

  const first = await fetchImageForImport(url.href);
  try {
    return await persistImageBuffer(
      first.buffer,
      cleanImageName(first.response.url, "downloaded-image"),
    );
  } catch (directImageError) {
    const contentType = first.response.headers.get("content-type") || "";
    const looksLikeHtml =
      /text\/html|application\/xhtml\+xml/i.test(contentType) ||
      /^\s*(?:<!doctype\s+html|<html\b)/i.test(
        first.buffer.subarray(0, 512).toString("utf8"),
      );
    if (!looksLikeHtml) throw directImageError;

    const pageImageUrl = findPageImageUrl(
      first.buffer.toString("utf8"),
      first.response.url,
    );
    if (!pageImageUrl) {
      throw new Error("This page does not expose a preview image");
    }
    const pageImage = await fetchImageForImport(pageImageUrl);
    return persistImageBuffer(
      pageImage.buffer,
      cleanImageName(pageImage.response.url, "page-image"),
    );
  }
}

async function readImageSource(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) throw new Error("No image source was provided");
  if (/^data:/i.test(value)) return bufferFromDataUrl(value);
  if (/^file:/i.test(value)) return fs.readFile(fileURLToPath(value));
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return fs.readFile(value);
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported image source");
  }
  return (await fetchBuffer(url.href)).buffer;
}

function safeProjectAssetExtension(value, fallback = ".bin") {
  const rawValue = String(value || "").toLowerCase();
  const extension = rawValue.startsWith(".")
    ? rawValue
    : path.extname(rawValue);
  return /^\.[a-z0-9]{1,12}$/.test(extension) ? extension : fallback;
}

function dataUrlExtension(value) {
  const mime = /^data:([^;,]+)/i.exec(value)?.[1]?.toLowerCase();
  return (
    {
      "image/avif": ".avif",
      "image/gif": ".gif",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/svg+xml": ".svg",
      "image/webp": ".webp",
    }[mime] || ".bin"
  );
}

function localProjectSourcePath(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return null;
  try {
    if (/^file:/i.test(value)) return fileURLToPath(value);
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
      return value;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(value)) {
      const rendererIndexUrl = pathToFileURL(
        path.join(__dirname, "..", "desktop-dist", "index.html"),
      );
      return fileURLToPath(new URL(value, rendererIndexUrl));
    }
  } catch {
    return null;
  }
  return null;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fsSync.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

async function materializeProjectPayload(source, temporaryDirectory, name) {
  const localPath = localProjectSourcePath(source);
  if (localPath) {
    const stats = await fs.stat(localPath);
    if (!stats.isFile() || stats.size <= 0) {
      throw new Error("A project image is missing");
    }
    if (stats.size > MAX_IMAGE_BYTES) {
      throw new Error("A project image is larger than 120 MB");
    }
    return {
      sourcePath: localPath,
      extension: safeProjectAssetExtension(localPath),
      length: stats.size,
      sha256: await sha256File(localPath),
    };
  }

  if (/^blob:/i.test(String(source || ""))) {
    throw new Error("An image is still being processed. Please save again.");
  }

  const input = await readImageSource(source);
  const extension = /^data:/i.test(String(source || ""))
    ? dataUrlExtension(source)
    : safeProjectAssetExtension(String(source || "").split(/[?#]/, 1)[0]);
  const temporaryPath = path.join(
    temporaryDirectory,
    `${name}${extension}`,
  );
  await fs.writeFile(temporaryPath, input);
  return {
    sourcePath: temporaryPath,
    extension,
    length: input.length,
    sha256: createHash("sha256").update(input).digest("hex"),
  };
}

async function preparePortableProject(data) {
  if (!validProjectSnapshot(data)) {
    throw new Error("Invalid ImageStorage project");
  }
  await ensureStorageDirectories();
  const temporaryDirectory = path.join(
    recoveryDirectory,
    `project-export-${process.pid}-${randomUUID()}`,
  );
  await fs.mkdir(temporaryDirectory, { recursive: true });

  const project = structuredClone(data);
  const assets = [];
  const payloads = [];
  const sourceCache = new Map();

  const archiveReference = async (
    owner,
    sourceField,
    thumbnailField,
    assetIdField,
  ) => {
    const source = owner?.[sourceField];
    if (typeof source !== "string" || !source.trim()) return;
    const sourceKey = `${String(owner[assetIdField] || "")}\n${source}`;
    let archiveAsset = sourceCache.get(sourceKey);
    if (!archiveAsset) {
      if (assets.length >= MAX_PROJECT_ASSETS) {
        throw new Error("This project contains too many images");
      }
      const archiveId = randomUUID();
      const image = await materializeProjectPayload(
        source,
        temporaryDirectory,
        `${archiveId}-image`,
      );
      let thumbnail = null;
      const thumbnailSource = owner[thumbnailField];
      if (typeof thumbnailSource === "string" && thumbnailSource.trim()) {
        try {
          thumbnail = await materializeProjectPayload(
            thumbnailSource,
            temporaryDirectory,
            `${archiveId}-thumbnail`,
          );
        } catch {
          // The full image remains portable when a cached thumbnail is gone.
        }
      }
      archiveAsset = {
        id: archiveId,
        image: {
          extension: image.extension,
          length: image.length,
          sha256: image.sha256,
        },
        thumbnail: thumbnail
          ? {
              extension: thumbnail.extension,
              length: thumbnail.length,
              sha256: thumbnail.sha256,
            }
          : null,
      };
      assets.push(archiveAsset);
      payloads.push(image);
      if (thumbnail) payloads.push(thumbnail);
      sourceCache.set(sourceKey, archiveAsset);
    }
    owner[assetIdField] = archiveAsset.id;
    owner[sourceField] = `imagestorage-asset:${archiveAsset.id}:image`;
    owner[thumbnailField] = archiveAsset.thumbnail
      ? `imagestorage-asset:${archiveAsset.id}:thumbnail`
      : undefined;
  };

  try {
    for (const board of project.boards) {
      if (!Array.isArray(board?.items)) continue;
      for (const item of board.items) {
        if (item?.type !== "image") continue;
        if (typeof item.src !== "string" || !item.src.trim()) {
          throw new Error("A project image has no source");
        }

        const sourceKey = `${String(item.assetId || "")}\n${item.src}`;
        let archiveAsset = sourceCache.get(sourceKey);
        if (!archiveAsset) {
          if (assets.length >= MAX_PROJECT_ASSETS) {
            throw new Error("This project contains too many images");
          }
          const archiveId = randomUUID();
          const image = await materializeProjectPayload(
            item.src,
            temporaryDirectory,
            `${archiveId}-image`,
          );
          let thumbnail = null;
          if (
            typeof item.thumbnailSrc === "string" &&
            item.thumbnailSrc.trim()
          ) {
            try {
              thumbnail = await materializeProjectPayload(
                item.thumbnailSrc,
                temporaryDirectory,
                `${archiveId}-thumbnail`,
              );
            } catch {
              // The full image remains portable when a cached thumbnail is gone.
            }
          }

          archiveAsset = {
            id: archiveId,
            image: {
              extension: image.extension,
              length: image.length,
              sha256: image.sha256,
            },
            thumbnail: thumbnail
              ? {
                  extension: thumbnail.extension,
                  length: thumbnail.length,
                  sha256: thumbnail.sha256,
                }
              : null,
          };
          assets.push(archiveAsset);
          payloads.push(image);
          if (thumbnail) payloads.push(thumbnail);
          sourceCache.set(sourceKey, archiveAsset);
        }

        item.assetId = archiveAsset.id;
        item.src = `imagestorage-asset:${archiveAsset.id}:image`;
        item.thumbnailSrc = archiveAsset.thumbnail
          ? `imagestorage-asset:${archiveAsset.id}:thumbnail`
          : undefined;
        item.processing = false;
      }
      await archiveReference(
        board,
        "backgroundImageSrc",
        "backgroundImageThumbnailSrc",
        "backgroundImageAssetId",
      );
      await archiveReference(
        board,
        "headerImageSrc",
        "headerImageThumbnailSrc",
        "headerImageAssetId",
      );
    }

    return {
      temporaryDirectory,
      payloads,
      manifest: {
        format: "imagestorage-portable",
        version: 3,
        createdAt: new Date().toISOString(),
        project: {
          ...project,
          version: 3,
          savedAt: new Date().toISOString(),
        },
        assets,
      },
    };
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function replaceFileSafely(temporaryPath, targetPath) {
  const previousPath = `${targetPath}.previous`;
  await fs.rm(previousPath, { force: true });
  const targetExists = fsSync.existsSync(targetPath);
  if (targetExists) await fs.rename(targetPath, previousPath);
  try {
    await fs.rename(temporaryPath, targetPath);
    if (targetExists) await fs.rm(previousPath, { force: true });
  } catch (error) {
    if (targetExists && fsSync.existsSync(previousPath)) {
      await fs.rename(previousPath, targetPath).catch(() => {});
    }
    throw error;
  }
}

async function writePortableProject(filePath, data) {
  const prepared = await preparePortableProject(data);
  const manifestBuffer = Buffer.from(
    JSON.stringify(prepared.manifest),
    "utf8",
  );
  if (manifestBuffer.length > MAX_PROJECT_MANIFEST_BYTES) {
    await fs.rm(prepared.temporaryDirectory, {
      recursive: true,
      force: true,
    });
    throw new Error("The project manifest is too large");
  }

  const manifestLength = Buffer.alloc(PORTABLE_PROJECT_LENGTH_BYTES);
  manifestLength.writeBigUInt64BE(BigInt(manifestBuffer.length));
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      temporaryPath,
      Buffer.concat([
        PORTABLE_PROJECT_MAGIC,
        manifestLength,
        manifestBuffer,
      ]),
    );
    for (const payload of prepared.payloads) {
      await pipeline(
        fsSync.createReadStream(payload.sourcePath),
        fsSync.createWriteStream(temporaryPath, { flags: "a" }),
      );
    }
    await replaceFileSafely(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    await fs
      .rm(prepared.temporaryDirectory, { recursive: true, force: true })
      .catch(() => {});
  }
}

async function readExactly(fileHandle, length, position) {
  const output = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await fileHandle.read(
      output,
      offset,
      length - offset,
      position + offset,
    );
    if (!result.bytesRead) throw new Error("Unexpected end of project file");
    offset += result.bytesRead;
  }
  return output;
}

function validatePortablePayload(value, role) {
  const length = Number(value?.length);
  if (
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    length > MAX_IMAGE_BYTES
  ) {
    throw new Error(`Invalid ${role} payload`);
  }
  const sha256 = String(value?.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error(`Invalid ${role} checksum`);
  }
  return {
    length,
    extension: safeProjectAssetExtension(value?.extension),
    sha256,
  };
}

async function copyProjectPayload(
  projectPath,
  start,
  payload,
  targetPath,
) {
  const temporaryPath = `${targetPath}.${process.pid}.tmp`;
  try {
    await pipeline(
      fsSync.createReadStream(projectPath, {
        start,
        end: start + payload.length - 1,
      }),
      fsSync.createWriteStream(temporaryPath, { flags: "wx" }),
    );
    const actualChecksum = await sha256File(temporaryPath);
    if (actualChecksum !== payload.sha256) {
      throw new Error("A project image failed its integrity check");
    }
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function readPortableProject(filePath) {
  const fileHandle = await fs.open(filePath, "r");
  let manifest;
  let payloadOffset;
  let fileSize;
  try {
    const stats = await fileHandle.stat();
    fileSize = stats.size;
    const minimumSize =
      PORTABLE_PROJECT_MAGIC.length + PORTABLE_PROJECT_LENGTH_BYTES;
    if (fileSize < minimumSize) return null;
    const magic = await readExactly(
      fileHandle,
      PORTABLE_PROJECT_MAGIC.length,
      0,
    );
    if (!magic.equals(PORTABLE_PROJECT_MAGIC)) return null;
    const lengthBuffer = await readExactly(
      fileHandle,
      PORTABLE_PROJECT_LENGTH_BYTES,
      PORTABLE_PROJECT_MAGIC.length,
    );
    const manifestLengthBigInt = lengthBuffer.readBigUInt64BE();
    if (
      manifestLengthBigInt <= 0 ||
      manifestLengthBigInt > BigInt(MAX_PROJECT_MANIFEST_BYTES)
    ) {
      throw new Error("Invalid project manifest size");
    }
    const manifestLength = Number(manifestLengthBigInt);
    payloadOffset = minimumSize + manifestLength;
    if (payloadOffset > fileSize) {
      throw new Error("Invalid project manifest");
    }
    manifest = JSON.parse(
      (
        await readExactly(fileHandle, manifestLength, minimumSize)
      ).toString("utf8"),
    );
  } finally {
    await fileHandle.close();
  }

  if (
    manifest?.format !== "imagestorage-portable" ||
    manifest.version !== 3 ||
    !validProjectSnapshot(manifest.project) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length > MAX_PROJECT_ASSETS
  ) {
    throw new Error("Invalid portable ImageStorage project");
  }

  const archiveIds = new Set();
  const normalizedAssets = manifest.assets.map((asset) => {
    if (
      typeof asset?.id !== "string" ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(asset.id) ||
      archiveIds.has(asset.id)
    ) {
      throw new Error("Invalid project asset identifier");
    }
    archiveIds.add(asset.id);
    return {
      archiveId: asset.id,
      image: validatePortablePayload(asset.image, "image"),
      thumbnail: asset.thumbnail
        ? validatePortablePayload(asset.thumbnail, "thumbnail")
        : null,
    };
  });

  const expectedSize = normalizedAssets.reduce(
    (total, asset) =>
      total + asset.image.length + (asset.thumbnail?.length || 0),
    payloadOffset,
  );
  if (expectedSize !== fileSize) {
    throw new Error("The portable project is incomplete");
  }

  await ensureStorageDirectories();
  const extractedPaths = [];
  const extractedAssets = new Map();
  let offset = payloadOffset;
  try {
    for (const asset of normalizedAssets) {
      const assetId = randomUUID();
      const imagePath = path.join(
        assetDirectory,
        `image-${assetId}${asset.image.extension}`,
      );
      await copyProjectPayload(filePath, offset, asset.image, imagePath);
      offset += asset.image.length;
      extractedPaths.push(imagePath);

      let thumbnailPath = null;
      if (asset.thumbnail) {
        thumbnailPath = path.join(
          assetDirectory,
          `thumbnail-${assetId}${asset.thumbnail.extension}`,
        );
        await copyProjectPayload(
          filePath,
          offset,
          asset.thumbnail,
          thumbnailPath,
        );
        offset += asset.thumbnail.length;
        extractedPaths.push(thumbnailPath);
      }
      extractedAssets.set(asset.archiveId, {
        assetId,
        src: pathToFileURL(imagePath).href,
        thumbnailSrc: thumbnailPath
          ? pathToFileURL(thumbnailPath).href
          : undefined,
      });
    }

    const project = structuredClone(manifest.project);
    for (const board of project.boards) {
      if (!Array.isArray(board?.items)) continue;
      for (const item of board.items) {
        if (item?.type !== "image") continue;
        const extracted = extractedAssets.get(item.assetId);
        if (!extracted) throw new Error("A project image is missing");
        item.assetId = extracted.assetId;
        item.src = extracted.src;
        item.thumbnailSrc = extracted.thumbnailSrc;
        item.processing = false;
      }
      for (const [sourceField, thumbnailField, assetIdField] of [
        ["backgroundImageSrc", "backgroundImageThumbnailSrc", "backgroundImageAssetId"],
        ["headerImageSrc", "headerImageThumbnailSrc", "headerImageAssetId"],
      ]) {
        if (!board[sourceField]) continue;
        const extracted = extractedAssets.get(board[assetIdField]);
        if (!extracted) throw new Error("A project board image is missing");
        board[assetIdField] = extracted.assetId;
        board[sourceField] = extracted.src;
        board[thumbnailField] = extracted.thumbnailSrc;
      }
    }
    return project;
  } catch (error) {
    await Promise.all(
      extractedPaths.map((extractedPath) =>
        fs.rm(extractedPath, { force: true }).catch(() => {}),
      ),
    );
    throw error;
  }
}

async function loadProjectFile(filePath) {
  const portableProject = await readPortableProject(filePath);
  if (portableProject) return portableProject;
  const data = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (!validProjectSnapshot(data)) {
    throw new Error("Invalid ImageStorage project");
  }
  return data;
}

function getMainWindowMaterial() {
  if (process.platform !== "win32") return "none";
  const [major, , build] = os.release().split(".").map(Number);
  if (major < 10 || !Number.isFinite(build) || build < 22621) return "none";
  if (nativeTheme.shouldUseHighContrastColors || nativeTheme.prefersReducedTransparency) {
    return "none";
  }
  return "acrylic";
}

function createWindow() {
  const windowMaterial = getMainWindowMaterial();
  const requestedWindowSize =
    /^(\d+)x(\d+)$/.exec(process.env.IMAGESTORAGE_TEST_WINDOW_SIZE || "");
  const minimumWidth = requestedWindowSize ? 320 : 760;
  const minimumHeight = requestedWindowSize ? 240 : 560;
  const initialWidth = requestedWindowSize
    ? Math.max(minimumWidth, Number(requestedWindowSize[1]))
    : 1440;
  const initialHeight = requestedWindowSize
    ? Math.max(minimumHeight, Number(requestedWindowSize[2]))
    : 900;
  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: minimumWidth,
    minHeight: minimumHeight,
    show: false,
    frame: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: windowMaterial === "acrylic" ? "#00000000" : "#202020",
    ...(windowMaterial === "acrylic" ? { backgroundMaterial: "acrylic" } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      additionalArguments: [
        `--imagestorage-window-material=${windowMaterial}`,
        `--imagestorage-preferred-languages=${app.getPreferredSystemLanguages().join(",")}`,
      ],
    },
  });

  const ensureUsableWindowSize = () => {
    if (
      !mainWindow ||
      mainWindow.isMaximized() ||
      mainWindow.isFullScreen() ||
      mainWindow.isMinimized()
    ) {
      return;
    }
    const [width, height] = mainWindow.getSize();
    const nextWidth = Math.max(minimumWidth, width);
    const nextHeight = Math.max(minimumHeight, height);
    if (nextWidth !== width || nextHeight !== height) {
      mainWindow.setSize(nextWidth, nextHeight);
    }
  };

  mainWindow.setMinimumSize(minimumWidth, minimumHeight);
  mainWindow.on("resize", ensureUsableWindowSize);

  mainWindow.on("close", (event) => {
    if (closeApproved) return;
    event.preventDefault();
    if (restoringBackup) return;
    const editor = [...analysisWindows.values()].find((window) => !window.isDestroyed());
    if (editor) {
      if (editor.isMinimized()) editor.restore();
      editor.show();
      editor.focus();
      if (!editorCloseNoticePending) {
        editorCloseNoticePending = true;
        void dialog.showMessageBox(editor, {
          type: "info", title: "ImageStorage",
          message: "画像編集画面を先に保存または閉じてください。",
          detail: "Save or close the image editor before closing ImageStorage.",
        }).finally(() => { editorCloseNoticePending = false; });
      }
      return;
    }
    if (closeRequestPending) return;
    closeRequestPending = true;
    mainWindow.webContents.send("app:request-close");
    closeFallbackTimer = setTimeout(async () => {
      closeFallbackTimer = null;
      closeRecoveryPending = true;
      await drainPendingWrites();
      closeApproved = true;
      closeRequestPending = false;
      mainWindow?.close();
      closeRecoveryPending = false;
    }, 2500);
  });
  mainWindow.on("closed", () => {
    invalidateExtensionImports();
    stopTitlebarPointerTracking();
    if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
    closeFallbackTimer = null;
    closeApproved = false;
    closeRequestPending = false;
    closeRecoveryPending = false;
    mainWindow = null;
  });
  mainWindow.webContents.on("render-process-gone", () => { restoringBackup = false; invalidateExtensionImports(); });
  mainWindow.webContents.on("did-start-loading", invalidateExtensionImports);

  mainWindow.once("ready-to-show", () => {
    ensureUsableWindowSize();
    if (!extensionBackgroundMode) mainWindow.show();
    startTitlebarPointerTracking();
  });
  mainWindow.webContents.once("did-finish-load", () => {
    if (process.env.IMAGESTORAGE_TEST_REVEAL_TITLEBAR === "1") {
      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(
          "document.querySelector('.native-titlebar')?.classList.add('is-visible')",
        );
      }, 500);
    }
    if (process.env.IMAGESTORAGE_TEST_COLLAPSE_SIDEBAR === "1") {
      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(
          "if (!document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')) document.querySelector('.sidebar-toggle-button')?.click()",
        );
      }, 300);
    }
    if (process.env.IMAGESTORAGE_TEST_EXPAND_SIDEBAR === "1") {
      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(
          "if (document.querySelector('.app-shell')?.classList.contains('is-sidebar-collapsed')) document.querySelector('.sidebar-toggle-button')?.click()",
        );
      }, 300);
    }
    if (process.env.IMAGESTORAGE_TEST_HOVER_BOTTOM_LEFT === "1") {
      setTimeout(() => {
        mainWindow.webContents.sendInputEvent({
          type: "mouseMove",
          x: 2,
          y: initialHeight - 2,
        });
      }, 700);
    }
    if (process.env.IMAGESTORAGE_TEST_LAYOUT_RESULT) {
      setTimeout(async () => {
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const shell = document.querySelector('.app-shell');
            const toggle = document.querySelector('.sidebar-toggle-button');
            if (shell?.classList.contains('is-sidebar-collapsed')) {
              toggle?.click();
              await new Promise((resolve) => setTimeout(resolve, 240));
            }
            const canvas = document.querySelector('.canvas');
            canvas?.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true,
              button: 0,
              buttons: 1,
              clientX: 620,
              clientY: 410,
            }));
            window.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              buttons: 1,
              clientX: 260,
              clientY: 410,
            }));
            window.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true,
              button: 0,
              buttons: 0,
              clientX: 260,
              clientY: 410,
            }));
            await new Promise((resolve) => setTimeout(resolve, 80));
            canvas?.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true,
              button: 0,
              buttons: 1,
              pointerId: 17,
              clientX: 620,
              clientY: 410,
            }));
            const pointerActionStarted = document.body.classList.contains(
              'is-manipulating'
            );
            window.dispatchEvent(new PointerEvent('pointercancel', {
              bubbles: true,
              pointerId: 17,
              clientX: 620,
              clientY: 410,
            }));
            await new Promise((resolve) => setTimeout(resolve, 30));
            const pointerActionCleared = !document.body.classList.contains(
              'is-manipulating'
            );
            const readRects = () => Array.from(
              document.querySelectorAll('.canvas-item')
            ).map((item) => {
              const rect = item.getBoundingClientRect();
              return {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              };
            });
            const before = readRects();
            const canvasLeftBefore = canvas?.getBoundingClientRect().left;
            const sidebar = document.querySelector('.sidebar');
            const sidebarPinnedRect = sidebar?.getBoundingClientRect();
            const sidebarPinnedBounds = sidebarPinnedRect
              ? {
                  left: sidebarPinnedRect.left,
                  top: sidebarPinnedRect.top,
                  width: sidebarPinnedRect.width,
                  height: sidebarPinnedRect.height,
                }
              : null;
            const togglePinnedRect = toggle?.getBoundingClientRect();
            const sidebarPinnedStyle = sidebar
              ? getComputedStyle(sidebar)
              : null;
            const sidebarPinnedRightBorder = Number.parseFloat(
              sidebarPinnedStyle?.borderRightWidth || '0'
            );
            const sidebarPinnedBottomBorder = Number.parseFloat(
              sidebarPinnedStyle?.borderBottomWidth || '0'
            );
            const togglePinnedBounds = togglePinnedRect
              ? {
                  left: togglePinnedRect.left,
                  top: togglePinnedRect.top,
                  width: togglePinnedRect.width,
                  height: togglePinnedRect.height,
                }
              : null;
            const togglePinnedAlignedToSidebarRight = Boolean(
              sidebarPinnedRect &&
              togglePinnedRect &&
              Math.abs(
                sidebarPinnedRect.right -
                togglePinnedRect.right -
                sidebarPinnedRightBorder
              ) < 0.01
            );
            const togglePinnedAlignedToSidebarBottom = Boolean(
              sidebarPinnedRect &&
              togglePinnedRect &&
              Math.abs(
                sidebarPinnedRect.bottom -
                togglePinnedRect.bottom -
                sidebarPinnedBottomBorder
              ) < 0.01
            );
            const togglePinnedInsideSidebarElement =
              toggle?.parentElement === sidebar;
            const togglePinnedInsideSidebar = Boolean(
              sidebarPinnedRect &&
              togglePinnedRect &&
              togglePinnedRect.left >= sidebarPinnedRect.left &&
              togglePinnedRect.top >= sidebarPinnedRect.top &&
              togglePinnedRect.right <= sidebarPinnedRect.right + 0.01 &&
              togglePinnedRect.bottom <= sidebarPinnedRect.bottom + 0.01
            );
            const toggleShowsPinnedState = Boolean(
              toggle?.classList.contains('is-pinned') &&
              !toggle.querySelector('.sidebar-pin-slash')
            );
            toggle?.click();
            await new Promise((resolve) => setTimeout(resolve, 240));
            const after = readRects();
            const canvasLeftAfter = canvas?.getBoundingClientRect().left;
            const workspace = document.querySelector('.workspace');
            const workspaceWidthCollapsed = workspace?.getBoundingClientRect().width;
            shell?.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              pointerId: 31,
              clientX: 60,
              clientY: 220,
            }));
            await new Promise((resolve) => setTimeout(resolve, 100));
            const workspaceWidthDuringSidebarPeek =
              workspace?.getBoundingClientRect().width;
            const sidebarRectDuringPeek = sidebar?.getBoundingClientRect();
            const sidebarPeekVisible = Boolean(
              shell?.classList.contains('is-sidebar-peeking') &&
              sidebarRectDuringPeek &&
              sidebarRectDuringPeek.width > 0 &&
              getComputedStyle(sidebar).opacity === '1'
            );
            const sidebarPeekStraight =
              getComputedStyle(sidebar).transform === 'none';
            const guide = document.querySelector('.content-bounds-guide');
            const guideRect = guide?.getBoundingClientRect();
            const titlebar = document.querySelector('.native-titlebar');
            const titlebarDrag = document.querySelector(
              '.native-titlebar-drag'
            );
            const titlebarControls = document.querySelector(
              '.native-window-controls'
            );
            titlebar?.classList.remove('is-visible');
            const titlebarPointerEventsHidden = getComputedStyle(titlebar)
              .pointerEvents;
            const titlebarControlsPointerEventsHidden = getComputedStyle(
              titlebarControls
            ).pointerEvents;
            const titlebarRectBefore = titlebar?.getBoundingClientRect();
            for (let index = 0; index < 40; index += 1) {
              titlebar?.classList.toggle('is-visible', index % 2 === 0);
              void titlebar?.offsetWidth;
            }
            titlebar?.classList.add('is-visible');
            await new Promise((resolve) => setTimeout(resolve, 100));
            const titlebarRectAfter = titlebar?.getBoundingClientRect();
            const titlebarControlsPointerEventsVisible = getComputedStyle(
              titlebarControls
            ).pointerEvents;
            const titlebarVisibleAtTop =
              titlebar?.classList.contains('is-visible');
            titlebar?.classList.remove('is-visible');
            await new Promise((resolve) => setTimeout(resolve, 100));
            const titlebarHiddenAfterLeave =
              !titlebar?.classList.contains('is-visible');
            const zoomTargetBefore =
              document.querySelector('.canvas-item')?.getBoundingClientRect();
            const zoomClientX = zoomTargetBefore
              ? zoomTargetBefore.left + zoomTargetBefore.width / 2
              : 500;
            const zoomClientY = zoomTargetBefore
              ? zoomTargetBefore.top + zoomTargetBefore.height / 2
              : 400;
            canvas?.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: zoomClientX,
              clientY: zoomClientY,
              deltaY: -120,
            }));
            await new Promise((resolve) => setTimeout(resolve, 80));
            const zoomTargetAfter =
              document.querySelector('.canvas-item')?.getBoundingClientRect();
            const zoomAnchorStable = Boolean(
              zoomTargetBefore &&
              zoomTargetAfter &&
              Math.abs(
                zoomClientX -
                (zoomTargetAfter.left + zoomTargetAfter.width / 2)
              ) < 0.15 &&
              Math.abs(
                zoomClientY -
                (zoomTargetAfter.top + zoomTargetAfter.height / 2)
              ) < 0.15
            );
            document.querySelector('.canvas-item.note textarea')?.focus();
            await new Promise((resolve) => setTimeout(resolve, 60));
            const colorPickerRect = document
              .querySelector('.color-picker')
              ?.getBoundingClientRect();
            const canvasRect = canvas?.getBoundingClientRect();
            const colorPickerAtBottom = Boolean(
              colorPickerRect &&
              canvasRect &&
              colorPickerRect.top > canvasRect.top + canvasRect.height / 2 &&
              colorPickerRect.bottom <= canvasRect.bottom &&
              colorPickerRect.left >= canvasRect.left &&
              colorPickerRect.right <= canvasRect.right
            );
            return {
              collapsed: shell?.classList.contains('is-sidebar-collapsed'),
              before,
              after,
              canvasLeftBefore,
              canvasLeftAfter,
              positionsStable:
                before.length === after.length &&
                before.every((rect, index) =>
                  Math.abs(rect.left - after[index].left) < 0.01 &&
                  Math.abs(rect.top - after[index].top) < 0.01
                ),
              guideVisible: Boolean(
                guideRect && guideRect.width > 0 && guideRect.height > 0
              ),
              canvasExpandedToLeftEdge:
                canvasLeftBefore > 0 && Math.abs(canvasLeftAfter) < 0.01,
              sidebarPeekVisible,
              sidebarPeekStraight,
              sidebarPinnedBounds,
              togglePinnedBounds,
              togglePinnedAlignedToSidebarRight,
              togglePinnedAlignedToSidebarBottom,
              togglePinnedInsideSidebarElement,
              togglePinnedInsideSidebar,
              toggleShowsPinnedState,
              workspaceVisibleDuringSidebarPeek: Boolean(
                workspaceWidthDuringSidebarPeek &&
                workspaceWidthDuringSidebarPeek > 0
              ),
              workspaceWidthStableDuringSidebarPeek: Boolean(
                workspaceWidthCollapsed &&
                workspaceWidthDuringSidebarPeek &&
                Math.abs(
                  workspaceWidthCollapsed - workspaceWidthDuringSidebarPeek
                ) < 0.01
              ),
              titlebarVisibleAtTop,
              titlebarHiddenAfterLeave,
              titlebarBrandingRemoved: Boolean(
                titlebarDrag &&
                !titlebarDrag.querySelector('.native-app-mark') &&
                !titlebarDrag.textContent?.trim()
              ),
              colorPickerAtBottom,
              zoomAnchorStable,
              pointerActionStarted,
              pointerActionCleared,
              titlebarGeometryStable: Boolean(
                titlebarRectBefore &&
                titlebarRectAfter &&
                Math.abs(titlebarRectBefore.top - titlebarRectAfter.top) < 0.01 &&
                Math.abs(titlebarRectBefore.left - titlebarRectAfter.left) < 0.01 &&
                Math.abs(titlebarRectBefore.width - titlebarRectAfter.width) < 0.01 &&
                Math.abs(titlebarRectBefore.height - titlebarRectAfter.height) < 0.01
              ),
              titlebarPointerEventsHidden,
              titlebarControlsPointerEventsHidden,
              titlebarControlsPointerEventsVisible,
              titlebarRegion: getComputedStyle(titlebar)
                .getPropertyValue('-webkit-app-region'),
              zoomCenterBefore: {
                x: zoomClientX,
                y: zoomClientY,
              },
              zoomCenterAfter: zoomTargetAfter
                ? {
                    x: zoomTargetAfter.left + zoomTargetAfter.width / 2,
                    y: zoomTargetAfter.top + zoomTargetAfter.height / 2,
                  }
                : null,
              titlebarDragRegion: getComputedStyle(titlebarDrag)
                .getPropertyValue('-webkit-app-region'),
              titlebarControlsRegion: getComputedStyle(titlebarControls)
                .getPropertyValue('-webkit-app-region'),
            };
          })()
        `);
        const workspaceWidthBeforeNativePeek =
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('.workspace')?.getBoundingClientRect().width || 0",
          );
        mainWindow.webContents.sendInputEvent({
          type: "mouseMove",
          x: 60,
          y: 220,
        });
        await new Promise((resolve) => setTimeout(resolve, 160));
        const nativeSidebarPeekResult =
          await mainWindow.webContents.executeJavaScript(`
            (() => {
              const shell = document.querySelector('.app-shell');
              const sidebar = document.querySelector('.sidebar');
              const workspace = document.querySelector('.workspace');
              const toggle = document.querySelector('.sidebar-toggle-button');
              const sidebarRect = sidebar?.getBoundingClientRect();
              const toggleRect = toggle?.getBoundingClientRect();
              const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
              const sidebarRightBorder = Number.parseFloat(
                sidebarStyle?.borderRightWidth || '0'
              );
              const sidebarBottomBorder = Number.parseFloat(
                sidebarStyle?.borderBottomWidth || '0'
              );
              const workspaceWidth = workspace?.getBoundingClientRect().width || 0;
              return {
                sidebarPeekVisible: Boolean(
                  shell?.classList.contains('is-sidebar-peeking') &&
                  sidebarRect &&
                  sidebarRect.width > 0 &&
                  getComputedStyle(sidebar).opacity === '1'
                ),
                sidebarPeekStraight:
                  getComputedStyle(sidebar).transform === 'none',
                workspaceVisibleDuringSidebarPeek: workspaceWidth > 0,
                workspaceWidthStableDuringSidebarPeek:
                  Math.abs(${workspaceWidthBeforeNativePeek} - workspaceWidth) < 0.01,
                sidebarPeekBounds: sidebarRect
                  ? {
                      left: sidebarRect.left,
                      top: sidebarRect.top,
                      width: sidebarRect.width,
                      height: sidebarRect.height,
                    }
                  : null,
                togglePeekBounds: toggleRect
                  ? {
                      left: toggleRect.left,
                      top: toggleRect.top,
                      width: toggleRect.width,
                      height: toggleRect.height,
                    }
                  : null,
                togglePeekAlignedToSidebarRight: Boolean(
                  sidebarRect &&
                  toggleRect &&
                  Math.abs(
                    sidebarRect.right -
                    toggleRect.right -
                    sidebarRightBorder
                  ) < 0.01
                ),
                togglePeekAlignedToSidebarBottom: Boolean(
                  sidebarRect &&
                  toggleRect &&
                  Math.abs(
                    sidebarRect.bottom -
                    toggleRect.bottom -
                    sidebarBottomBorder
                  ) < 0.01
                ),
                togglePeekInsideSidebarElement:
                  toggle?.parentElement === sidebar,
                togglePeekInsideSidebar: Boolean(
                  sidebarRect &&
                  toggleRect &&
                  toggleRect.left >= sidebarRect.left &&
                  toggleRect.top >= sidebarRect.top &&
                  toggleRect.right <= sidebarRect.right + 0.01 &&
                  toggleRect.bottom <= sidebarRect.bottom + 0.01
                ),
                toggleShowsUnpinnedState:
                  toggle?.classList.contains('is-unpinned') &&
                  Boolean(toggle.querySelector('.sidebar-pin-slash')),
              };
            })()
          `);
        Object.assign(result, nativeSidebarPeekResult);
        result.sidebarPeekMatchesPinnedSize = Boolean(
          result.sidebarPinnedBounds &&
            result.sidebarPeekBounds &&
            Math.abs(
              result.sidebarPinnedBounds.width - result.sidebarPeekBounds.width,
            ) < 0.01 &&
            Math.abs(
              result.sidebarPinnedBounds.height - result.sidebarPeekBounds.height,
            ) < 0.01,
        );
        result.sidebarTogglePositionsMatch = Boolean(
          result.togglePinnedBounds &&
            result.togglePeekBounds &&
            Math.abs(
              result.togglePinnedBounds.left - result.togglePeekBounds.left,
            ) < 0.01 &&
            Math.abs(
              result.togglePinnedBounds.top - result.togglePeekBounds.top,
            ) < 0.01 &&
            Math.abs(
              result.togglePinnedBounds.width - result.togglePeekBounds.width,
            ) < 0.01 &&
            Math.abs(
              result.togglePinnedBounds.height - result.togglePeekBounds.height,
            ) < 0.01,
        );
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const shell = document.querySelector('.app-shell');
            if (shell?.classList.contains('is-sidebar-collapsed')) {
              document.querySelector('.sidebar-toggle-button')?.click();
            }
          })()
        `);
        await new Promise((resolve) => setTimeout(resolve, 200));
        const originalWindowBounds = mainWindow.getBounds();
        const sidebarPinResizeChecks = [];
        for (const [width, height] of [
          [1000, 700],
          [720, 520],
          [520, 400],
        ]) {
          mainWindow.setSize(width, height);
          await new Promise((resolve) => setTimeout(resolve, 180));
          sidebarPinResizeChecks.push(
            await mainWindow.webContents.executeJavaScript(`
              (() => {
                const sidebar = document.querySelector('.sidebar');
                const toggle = document.querySelector('.sidebar-toggle-button');
                const sidebarRect = sidebar?.getBoundingClientRect();
                const toggleRect = toggle?.getBoundingClientRect();
                const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
                const sidebarRightBorder = Number.parseFloat(
                  sidebarStyle?.borderRightWidth || '0'
                );
                const sidebarBottomBorder = Number.parseFloat(
                  sidebarStyle?.borderBottomWidth || '0'
                );
                return Boolean(
                  sidebar &&
                  toggle?.parentElement === sidebar &&
                  sidebarRect &&
                  toggleRect &&
                  Math.abs(
                    sidebarRect.right -
                    toggleRect.right -
                    sidebarRightBorder
                  ) < 0.01 &&
                  Math.abs(
                    sidebarRect.bottom -
                    toggleRect.bottom -
                    sidebarBottomBorder
                  ) < 0.01 &&
                  toggleRect.left >= sidebarRect.left &&
                  toggleRect.top >= sidebarRect.top
                );
              })()
            `),
          );
        }
        mainWindow.setBounds(originalWindowBounds);
        await new Promise((resolve) => setTimeout(resolve, 180));
        result.sidebarPinResizeChecks = sidebarPinResizeChecks;
        result.sidebarPinStableAcrossResize =
          sidebarPinResizeChecks.every(Boolean);
        await fs.writeFile(
          process.env.IMAGESTORAGE_TEST_LAYOUT_RESULT,
          JSON.stringify(result),
          "utf8",
        );
      }, 650);
    }
    if (process.env.IMAGESTORAGE_TEST_SELECTION_RESULT) {
      setTimeout(async () => {
        const result = await mainWindow.webContents.executeJavaScript(`
          (async () => {
            const wait = (milliseconds) => new Promise(
              (resolve) => setTimeout(resolve, milliseconds)
            );
            const canvas = document.querySelector('.canvas');
            const world = document.querySelector('.canvas-world');
            const initialItems = Array.from(
              document.querySelectorAll('.canvas-item')
            );
            if (!canvas || !world || initialItems.length < 2) {
              return { ok: false, reason: 'Missing canvas test fixtures' };
            }

            const itemRects = initialItems.map((item) =>
              item.getBoundingClientRect()
            );
            const canvasRect = canvas.getBoundingClientRect();
            const startX = Math.max(
              canvasRect.left + 2,
              Math.min(...itemRects.map((rect) => rect.left)) - 12
            );
            const startY = Math.max(
              canvasRect.top + 2,
              Math.min(...itemRects.map((rect) => rect.top)) - 12
            );
            const endX = Math.min(
              canvasRect.right - 2,
              Math.max(...itemRects.map((rect) => rect.right)) + 12
            );
            const endY = Math.min(
              canvasRect.bottom - 2,
              Math.max(...itemRects.map((rect) => rect.bottom)) + 12
            );
            const worldTransformBeforeSelection = getComputedStyle(world).transform;
            const noteForFocus = document.querySelector(
              '.canvas-item.note textarea'
            );
            noteForFocus?.focus();
            const noteFocusedBeforeBlankClick = document.activeElement === noteForFocus;

            canvas.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerId: 81,
              pointerType: 'mouse',
              button: 0,
              buttons: 1,
              clientX: startX,
              clientY: startY
            }));
            const noteBlurredByBlankClick =
              noteFocusedBeforeBlankClick && document.activeElement !== noteForFocus;
            window.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              pointerId: 81,
              pointerType: 'mouse',
              buttons: 1,
              clientX: endX,
              clientY: endY
            }));
            await wait(80);
            const marqueeVisibleDuringDrag = Boolean(
              document.querySelector('.selection-marquee')
            );
            window.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true,
              pointerId: 81,
              pointerType: 'mouse',
              button: 0,
              buttons: 0,
              clientX: endX,
              clientY: endY
            }));
            await wait(100);
            const worldTransformAfterSelection = getComputedStyle(world).transform;

            const selectedItems = Array.from(
              document.querySelectorAll('.canvas-item.selected')
            );
            const selectedIds = selectedItems.map((item) => item.dataset.itemId);
            const positionsBeforeMove = new Map(
              selectedItems.map((item) => [
                item.dataset.itemId,
                {
                  left: Number.parseFloat(item.style.left),
                  top: Number.parseFloat(item.style.top)
                }
              ])
            );
            const image = selectedItems.find((item) =>
              item.classList.contains('image')
            );
            if (!image) {
              return { ok: false, reason: 'Range did not select an image' };
            }
            const imageRect = image.getBoundingClientRect();
            const dragStartX = imageRect.left + imageRect.width / 2;
            const dragStartY = imageRect.top + imageRect.height / 2;
            image.dispatchEvent(new PointerEvent('pointerdown', {
              bubbles: true,
              cancelable: true,
              pointerId: 82,
              pointerType: 'mouse',
              button: 0,
              buttons: 1,
              clientX: dragStartX,
              clientY: dragStartY
            }));
            window.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true,
              pointerId: 82,
              pointerType: 'mouse',
              buttons: 1,
              clientX: dragStartX + 36,
              clientY: dragStartY + 24
            }));
            window.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true,
              pointerId: 82,
              pointerType: 'mouse',
              button: 0,
              buttons: 0,
              clientX: dragStartX + 36,
              clientY: dragStartY + 24
            }));
            await wait(120);

            const positionsAfterMove = new Map(
              Array.from(document.querySelectorAll('.canvas-item.selected')).map(
                (item) => [
                  item.dataset.itemId,
                  {
                    left: Number.parseFloat(item.style.left),
                    top: Number.parseFloat(item.style.top)
                  }
                ]
              )
            );
            const moveDeltas = selectedIds.map((id) => {
              const before = positionsBeforeMove.get(id);
              const after = positionsAfterMove.get(id);
              return before && after
                ? { x: after.left - before.left, y: after.top - before.top }
                : null;
            });
            const firstDelta = moveDeltas[0];
            const selectedItemsMovedTogether = Boolean(
              firstDelta &&
              moveDeltas.every(
                (delta) =>
                  delta &&
                  Math.abs(delta.x - firstDelta.x) < 0.05 &&
                  Math.abs(delta.y - firstDelta.y) < 0.05
              )
            );
            const handleBeforeZoom = document.querySelector('.resize-handle');
            const handleSizeBeforeZoom = handleBeforeZoom
              ? handleBeforeZoom.getBoundingClientRect().width
              : 0;
            const scaleBeforeZoom = Number(world.dataset.viewportScale || 0);
            canvas.dispatchEvent(new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              deltaY: -1200,
              clientX: canvasRect.left + canvasRect.width / 2,
              clientY: canvasRect.top + canvasRect.height / 2
            }));
            await wait(180);

            const scaleAfterZoom = Number(world.dataset.viewportScale || 0);
            const handleAfterZoom = document.querySelector('.resize-handle');
            const handleSizeAfterZoom = handleAfterZoom
              ? handleAfterZoom.getBoundingClientRect().width
              : 0;
            const selectedImage = document.querySelector(
              '.canvas-item.image.selected'
            );
            const selectedImageRect = selectedImage?.getBoundingClientRect();
            const northwestHandle = selectedImage?.querySelector('.resize-nw');
            const northwestRect = northwestHandle?.getBoundingClientRect();
            const outlineWidth = selectedImage
              ? Number.parseFloat(
                  getComputedStyle(selectedImage, '::after').borderTopWidth
                )
              : 0;
            const note = document.querySelector('.canvas-item.note textarea');
            const noteFontSize = note
              ? Number.parseFloat(getComputedStyle(note).fontSize)
              : 0;
            const worldMatrix = new DOMMatrix(getComputedStyle(world).transform);

            return {
              ok: true,
              selectedCount: selectedItems.length,
              marqueeVisibleDuringDrag,
              marqueeHiddenAfterRelease: !document.querySelector(
                '.selection-marquee'
              ),
              noteSpellcheckDisabled: noteForFocus?.spellcheck === false,
              noteBlurredByBlankClick,
              ordinaryLeftDragDidNotPan:
                worldTransformAfterSelection === worldTransformBeforeSelection,
              selectedItemsMovedTogether,
              movedByExpectedDistance: Boolean(
                firstDelta &&
                Math.abs(firstDelta.x - 36) < 0.1 &&
                Math.abs(firstDelta.y - 24) < 0.1
              ),
              scaleBeforeZoom,
              scaleAfterZoom,
              zoomExceededPreviousLimit: scaleAfterZoom > 3.5,
              handleSizeBeforeZoom,
              handleSizeAfterZoom,
              handleSizeStayedConstant:
                Math.abs(handleSizeAfterZoom - handleSizeBeforeZoom) < 0.05,
              outlineStayedOnePixel: Math.abs(outlineWidth - 1) < 0.05,
              selectionFrameAligned: Boolean(
                selectedImageRect &&
                northwestRect &&
                Math.abs(
                  northwestRect.left + northwestRect.width / 2 -
                  selectedImageRect.left
                ) < 0.1 &&
                Math.abs(
                  northwestRect.top + northwestRect.height / 2 -
                  selectedImageRect.top
                ) < 0.1
              ),
              noteTextRenderedAtFinalSize:
                Math.abs(noteFontSize / scaleAfterZoom - 12) < 0.05,
              worldHasNoScaleTransform:
                Math.abs(worldMatrix.a - 1) < 0.0001 &&
                Math.abs(worldMatrix.d - 1) < 0.0001
            };
          })()
        `);
        await fs.writeFile(
          process.env.IMAGESTORAGE_TEST_SELECTION_RESULT,
          JSON.stringify(result),
          "utf8",
        );
      }, 650);
    }
    if (process.env.IMAGESTORAGE_TEST_OPEN_CONTEXT_MENU === "1") {
      setTimeout(() => {
        void mainWindow.webContents.executeJavaScript(`
          (() => {
            const item = document.querySelector('.canvas-item.image');
            if (!item) return;
            const rect = item.getBoundingClientRect();
            item.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2
            }));
          })()
        `);
      }, 600);
    }
    if (process.env.IMAGESTORAGE_TEST_UI_QA === "1") {
      setTimeout(async () => {
        await mainWindow.webContents.executeJavaScript(`
          document.querySelector('.native-language-button')?.click();
          document.querySelector('.rail-tool.grid-tool')?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 120));
        await mainWindow.webContents.executeJavaScript(`
          document.querySelectorAll('.board-row')[1]
            ?.querySelector('.remove-board')?.click();
        `);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const resultPath = process.env.IMAGESTORAGE_TEST_UI_RESULT;
        if (resultPath) {
          const result = await mainWindow.webContents.executeJavaScript(`
            (() => {
              const firstBoard = document.querySelectorAll('.board-row')[0];
              return {
              previewImages: firstBoard?.querySelectorAll(
                '.mini-tile.image'
              ).length || 0,
              previewNotes: firstBoard?.querySelectorAll(
                '.mini-tile.note'
              ).length || 0,
              overflowText: firstBoard?.querySelector(
                '.mini-preview-more'
              )?.textContent || '',
              confirmationVisible: Boolean(
                document.querySelector('.confirmation-dialog')
              ),
              language: document.documentElement.lang,
              helpInTitlebar: Boolean(
                document.querySelector('.native-project-actions .native-help-button')
              ),
              legacyAddButtons: document.querySelectorAll(
                '.rail-tool.primary, .rail-tool.url-tool, .rail-tool.help-tool'
              ).length
              };
            })()
          `);
          await fs.writeFile(resultPath, JSON.stringify(result), "utf8");
        }
      }, 650);
    }
    if (process.env.IMAGESTORAGE_TEST_BOARD_DROP_QA === "1") {
      setTimeout(async () => {
        await mainWindow.webContents.executeJavaScript(`
          (() => {
            const source = document.querySelector('.canvas-item.image img')?.src;
            const board = document.querySelectorAll('.board-row')[0];
            if (!source || !board) return;
            const transfer = new DataTransfer();
            transfer.setData('text/uri-list', source);
            board.dispatchEvent(new DragEvent('dragover', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
            board.dispatchEvent(new DragEvent('drop', {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer
            }));
          })()
        `);
        setTimeout(async () => {
          const resultPath = process.env.IMAGESTORAGE_TEST_BOARD_DROP_RESULT;
          if (!resultPath) return;
          const result = await mainWindow.webContents.executeJavaScript(`
            (() => {
              const images = Array.from(
                document.querySelectorAll('.canvas-item.image')
              );
              const rectangles = images.map((item) => ({
                x: Number.parseFloat(item.style.left),
                y: Number.parseFloat(item.style.top),
                w: Number.parseFloat(item.style.width),
                h: Number.parseFloat(item.style.height)
              }));
              const added = rectangles.at(-1);
              const overlaps = added
                ? rectangles.slice(0, -1).filter((item) =>
                    added.x < item.x + item.w &&
                    added.x + added.w > item.x &&
                    added.y < item.y + item.h &&
                    added.y + added.h > item.y
                  ).length
                : -1;
              return {
                imageCount: images.length,
                overlaps,
                activeBoardName: document.querySelector(
                  '.board-row.active .board-name-input'
                )?.value || ''
              };
            })()
          `);
          await fs.writeFile(resultPath, JSON.stringify(result), "utf8");
        }, 1250);
      }, 450);
    }
    if (process.env.IMAGESTORAGE_TEST_FEATURES_RESULT) {
      setTimeout(async () => {
        try {
          const result = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
              document.querySelector('.settings-tool')?.click();
              await wait(80);
              const settings = document.querySelector('.settings-dialog');
              const settingsRect = settings?.getBoundingClientRect();
              const languageSelect = Array.from(settings?.querySelectorAll('select') || [])
                .find((select) => Array.from(select.options).some((option) => option.value === 'ko'));
              const languageOptions = languageSelect
                ? Array.from(languageSelect.options).map((option) => option.value)
                : [];
              settings?.querySelector('header > button')?.click();
              await wait(60);

              const canvas = document.querySelector('.canvas');
              const canvasButtons = [
                document.querySelector('.rail-grid-toggle'),
                document.querySelector('.rail-snap-toggle'),
              ];
              canvasButtons[0]?.click();
              canvasButtons[1]?.click();
              await wait(40);
              const itemRects = Array.from(document.querySelectorAll('.canvas-item'))
                .map((item) => item.getBoundingClientRect());
              const canvasRect = canvas?.getBoundingClientRect();
              if (canvas && canvasRect && itemRects.length >= 2) {
                const left = Math.max(canvasRect.left + 3, Math.min(...itemRects.map((rect) => rect.left)) - 20);
                const top = Math.max(canvasRect.top + 36, Math.min(...itemRects.map((rect) => rect.top)) - 20);
                const right = Math.min(canvasRect.right - 3, Math.max(...itemRects.map((rect) => rect.right)) + 20);
                const bottom = Math.min(canvasRect.bottom - 3, Math.max(...itemRects.map((rect) => rect.bottom)) + 20);
                canvas.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, button: 0, buttons: 1, pointerId: 81,
                  clientX: left, clientY: top,
                }));
                window.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, buttons: 1, pointerId: 81,
                  clientX: right, clientY: bottom,
                }));
                window.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, button: 0, buttons: 0, pointerId: 81,
                  clientX: right, clientY: bottom,
                }));
                await wait(60);
                document.querySelector('.create-frame-button')?.click();
              }
              await wait(60);
              const frame = document.querySelector('.canvas-frame');
              const frameSurface = document.querySelector('.canvas-frame-drag-surface');
              const frameBefore = frame?.getBoundingClientRect();
              const membersBefore = Array.from(document.querySelectorAll('.canvas-item'))
                .map((item) => ({ id: item.dataset.itemId, rect: item.getBoundingClientRect() }));
              if (frameSurface && frameBefore) {
                const startX = frameBefore.left + 8;
                const startY = frameBefore.top + 8;
                frameSurface.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, button: 0, buttons: 1, pointerId: 82,
                  clientX: startX, clientY: startY,
                }));
                window.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, buttons: 1, pointerId: 82,
                  clientX: startX + 64, clientY: startY + 42,
                }));
                window.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, button: 0, buttons: 0, pointerId: 82,
                  clientX: startX + 64, clientY: startY + 42,
                }));
              }
              await wait(60);
              const frameAfter = frame?.getBoundingClientRect();
              const frameDelta = frameBefore && frameAfter
                ? { x: frameAfter.left - frameBefore.left, y: frameAfter.top - frameBefore.top }
                : null;
              const frameMovesMembers = Boolean(
                frameDelta && Math.abs(frameDelta.x) > 1 &&
                membersBefore.every(({ id, rect }) => {
                  const after = document.querySelector('[data-item-id="' + id + '"]')?.getBoundingClientRect();
                  return after &&
                    Math.abs(after.left - rect.left - frameDelta.x) < 1 &&
                    Math.abs(after.top - rect.top - frameDelta.y) < 1;
                }),
              );
              const frameBackgroundColor = frame
                ? getComputedStyle(frame).backgroundColor
                : '';
              const frameLabelFontBeforeZoom = frame?.querySelector('input')
                ? getComputedStyle(frame.querySelector('input')).fontSize
                : '';
              const firstImage = document.querySelector('.canvas-item.image');
              const imageRect = firstImage?.getBoundingClientRect();
              if (firstImage && imageRect) {
                firstImage.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, button: 0, buttons: 1, pointerId: 83,
                  clientX: imageRect.left + imageRect.width / 2,
                  clientY: imageRect.top + imageRect.height / 2,
                }));
                window.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, button: 0, buttons: 0, pointerId: 83,
                  clientX: imageRect.left + imageRect.width / 2,
                  clientY: imageRect.top + imageRect.height / 2,
                }));
              }
              await wait(60);
              const railTools = document.querySelector('.rail-tools');
              const listActionsInRail = Boolean(
                railTools?.querySelector('.rail-list-group[data-tooltip]') &&
                railTools?.querySelector('.rail-library[data-tooltip]') &&
                railTools?.querySelector('.rail-grid-toggle[data-tooltip]') &&
                railTools?.querySelector('.rail-snap-toggle[data-tooltip]'),
              );
              const quickButtons = Array.from(document.querySelectorAll('.image-quick-tools button'));
              const imageQuickToolsVisible = quickButtons.length === 4;
              quickButtons[1]?.click();
              quickButtons[2]?.click();
              quickButtons[3]?.click();
              await wait(60);
              const selectedImageElement = firstImage?.querySelector('img');
              const quickImageActionsApplied = Boolean(
                quickButtons.slice(1).every((button) => button.classList.contains('active')) &&
                selectedImageElement?.style.transform.includes('scaleX(-1)') &&
                selectedImageElement?.style.filter === 'grayscale(1)',
              );
              quickButtons[0]?.click();
              await wait(50);
              const imageDetailsDialogVisible = Boolean(document.querySelector('.image-info-dialog'));
              document.querySelector('.image-info-dialog header > button')?.click();
              await wait(35);
              railTools?.querySelector('.rail-library')?.click();
              await wait(50);
              const libraryDialogVisible = Boolean(
                document.querySelector('.library-dialog') &&
                document.querySelector('.library-search-input'),
              );
              document.querySelector('.library-dialog header > button')?.click();
              await wait(35);
              window.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'd', ctrlKey: true,
              }));
              await wait(60);
              const imageNodes = Array.from(document.querySelectorAll('.canvas-item.image'));
              const imageRects = imageNodes.map((item) => item.getBoundingClientRect());
              if (canvas && canvasRect && imageRects.length >= 2) {
                const left = Math.max(canvasRect.left + 3, Math.min(...imageRects.map((rect) => rect.left)) - 5);
                const top = Math.max(canvasRect.top + 3, Math.min(...imageRects.map((rect) => rect.top)) - 5);
                const right = Math.min(canvasRect.right - 3, Math.max(...imageRects.map((rect) => rect.right)) + 5);
                const bottom = Math.min(canvasRect.bottom - 3, Math.max(...imageRects.map((rect) => rect.bottom)) + 5);
                canvas.dispatchEvent(new PointerEvent('pointerdown', {
                  bubbles: true, button: 0, buttons: 1, pointerId: 84,
                  clientX: left, clientY: top,
                }));
                window.dispatchEvent(new PointerEvent('pointermove', {
                  bubbles: true, buttons: 1, pointerId: 84,
                  clientX: right, clientY: bottom,
                }));
                window.dispatchEvent(new PointerEvent('pointerup', {
                  bubbles: true, button: 0, buttons: 0, pointerId: 84,
                  clientX: right, clientY: bottom,
                }));
              }
              await wait(60);
              const arrangeButton = document.querySelector('.image-arrange-button');
              const arrangeBefore = imageNodes.map((item) => item.getBoundingClientRect());
              arrangeButton?.click();
              await wait(30);
              document.querySelector('.image-arrange-menu button')?.click();
              await wait(70);
              const arrangeAfter = imageNodes.map((item) => item.getBoundingClientRect());
              const autoArrangeApplied = Boolean(
                arrangeBefore.length === arrangeAfter.length &&
                arrangeAfter.some((rect, index) =>
                  Math.abs(rect.left - arrangeBefore[index].left) > 1 ||
                  Math.abs(rect.top - arrangeBefore[index].top) > 1,
                ),
              );
              const paletteVisibleBeforeZoom = Boolean(document.querySelector('.image-palette'));
              if (canvas && canvasRect) {
                canvas.dispatchEvent(new WheelEvent('wheel', {
                  bubbles: true, cancelable: true, deltaY: -2400,
                  clientX: canvasRect.left + canvasRect.width / 2,
                  clientY: canvasRect.top + canvasRect.height / 2,
                }));
              }
              await wait(60);
              const paletteHiddenAfterZoom = !document.querySelector('.image-palette');
              const imageQuickToolsHiddenAfterZoom = !document.querySelector('.image-quick-tools');
              const frameLabelFontAfterZoom = frame?.querySelector('input')
                ? getComputedStyle(frame.querySelector('input')).fontSize
                : '';
              const frameLabelFontStable = Boolean(
                frameLabelFontBeforeZoom &&
                frameLabelFontBeforeZoom === frameLabelFontAfterZoom,
              );
              firstImage?.dispatchEvent(
                new MouseEvent('dblclick', { bubbles: true, button: 0 })
              );
              return {
                settingsVisible: Boolean(settingsRect && settingsRect.width > 0 && settingsRect.height > 0),
                settingsInsideViewport: Boolean(
                  settingsRect && settingsRect.left >= 0 && settingsRect.top >= 0 &&
                  settingsRect.right <= innerWidth && settingsRect.bottom <= innerHeight
                ),
                languageOptions,
                gridVisible: canvas?.classList.contains('is-grid-visible'),
                snapActive: canvasButtons[1]?.classList.contains('active'),
                frameCreated: Boolean(document.querySelector('.canvas-frame')),
                frameNameEditable: Boolean(document.querySelector('.canvas-frame-header input')),
                frameMovesMembers,
                frameBackgroundColor,
                frameLabelFontStable,
                frameLabelFontSize: frameLabelFontBeforeZoom,
                paletteVisibleBeforeZoom,
                paletteHiddenAfterZoom,
                imageQuickToolsHiddenAfterZoom,
                listActionsInRail,
                imageQuickToolsVisible,
                quickImageActionsApplied,
                imageDetailsDialogVisible,
                libraryDialogVisible,
                autoArrangeAvailable: Boolean(arrangeButton),
                autoArrangeApplied,
              };
            })()
          `);
          await new Promise((resolve) => setTimeout(resolve, 450));
          const analysisWindow = Array.from(analysisWindows.values()).find(
            (window) => window && !window.isDestroyed(),
          );
          result.analysisWindowOpened = Boolean(analysisWindow);
          result.analysisToolsVisible = analysisWindow
            ? await analysisWindow.webContents.executeJavaScript(
                "Boolean(document.querySelector('.analysis-window') && document.querySelector('.analysis-overlay') && document.querySelectorAll('.analysis-tool-row button').length === 2 && !document.querySelector('.analysis-suggest') && !document.querySelector('.analysis-clear') && !document.querySelector('.analysis-detection-actions'))",
              )
            : false;
          result.analysisAlwaysOnTopControlRemoved = analysisWindow
            ? await analysisWindow.webContents.executeJavaScript(
                "!document.querySelector('.analysis-tools button[aria-pressed]')",
              )
            : false;
          result.analysisSaveControl = analysisWindow
            ? await analysisWindow.webContents.executeJavaScript(
                "Boolean(document.querySelector('.analysis-save') && document.querySelector('.analysis-reset'))",
              )
            : false;
          result.analysisPresetThumbnailsDistinct = analysisWindow
            ? await analysisWindow.webContents.executeJavaScript(
                "(() => { const thumbnails = Array.from(document.querySelectorAll('.preset-thumbnail')); return thumbnails.length === 9 && new Set(thumbnails.map((thumbnail) => thumbnail.innerHTML)).size === 9; })()",
              )
            : false;
          if (analysisWindow) {
            const analysisScreenshotPath =
              process.env.IMAGESTORAGE_TEST_ANALYSIS_SCREENSHOT;
            if (!analysisWindow.isDestroyed() && analysisScreenshotPath) {
              const image = await analysisWindow.webContents.capturePage();
              await fs.writeFile(analysisScreenshotPath, image.toPNG());
            }
            await analysisWindow.webContents.executeJavaScript(
              "document.querySelector('.analysis-save')?.click()",
            );
            await new Promise((resolve) => setTimeout(resolve, 90));
          }
          result.analysisAppliedToCanvas = await mainWindow.webContents.executeJavaScript(
            "Boolean(document.querySelector('.canvas-image-analysis'))",
          );
          result.boardGrouping = await mainWindow.webContents.executeJavaScript(`
            (async () => {
              const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
              document.querySelector('.rail-tool.grid-tool')?.click();
              await wait(45);
              document.querySelector('.rail-list-group')?.click();
              await wait(45);
              const dialog = document.querySelector('.board-grouping-dialog');
              const nameInput = dialog?.querySelector('.board-group-name-field input');
              if (!dialog || !nameInput) return { dialogVisible: false, applied: false };
              const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setValue?.call(nameInput, 'QA grouped lists');
              nameInput.dispatchEvent(new Event('input', { bubbles: true }));
              await wait(30);
              const uncheckedBoard = Array.from(dialog.querySelectorAll('input[type="checkbox"]'))
                .find((input) => !input.checked);
              uncheckedBoard?.click();
              await wait(35);
              dialog.querySelector('.board-group-apply')?.click();
              await wait(55);
              return {
                dialogVisible: true,
                applied: Array.from(document.querySelectorAll('.board-group-heading'))
                  .some((heading) => heading.textContent?.includes('QA grouped lists')),
              };
            })()
          `);
          const canvasScreenshotPath =
            process.env.IMAGESTORAGE_TEST_CANVAS_SCREENSHOT;
          if (canvasScreenshotPath) {
            const image = await mainWindow.webContents.capturePage();
            await fs.writeFile(canvasScreenshotPath, image.toPNG());
          }
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('.settings-tool')?.click()",
          );
          await new Promise((resolve) => setTimeout(resolve, 80));
          const screenshotPath = process.env.IMAGESTORAGE_TEST_FEATURES_SCREENSHOT;
          if (screenshotPath) {
            const image = await mainWindow.webContents.capturePage();
            await fs.writeFile(screenshotPath, image.toPNG());
          }
          await fs.writeFile(
            process.env.IMAGESTORAGE_TEST_FEATURES_RESULT,
            JSON.stringify(result),
            "utf8",
          );
          analysisWindow?.destroy();
        } catch (error) {
          await fs.writeFile(
            process.env.IMAGESTORAGE_TEST_FEATURES_RESULT,
            JSON.stringify({ ok: false, message: error instanceof Error ? error.stack : String(error) }),
            "utf8",
          );
        } finally {
          app.quit();
        }
      }, 900);
    }

    const capturePath = process.env.MUSEBOARD_CAPTURE_PATH;
    if (capturePath) {
      setTimeout(async () => {
        if (process.env.IMAGESTORAGE_TEST_REVEAL_TITLEBAR === "1") {
          await mainWindow.webContents.executeJavaScript(
            "document.querySelector('.native-titlebar')?.classList.add('is-visible')",
          );
        }
        const image = await mainWindow.webContents.capturePage();
        await fs.writeFile(capturePath, image.toPNG());
        if (process.env.IMAGESTORAGE_TEST_QUIT_AFTER_CAPTURE === "1") {
          app.quit();
        }
      }, Number(process.env.IMAGESTORAGE_TEST_CAPTURE_DELAY || 1200));
    }

    const testImportValue = process.env.MUSEBOARD_TEST_IMPORT_VALUE;
    const testImportOutput = process.env.MUSEBOARD_TEST_IMPORT_OUTPUT;
    if (testImportValue && testImportOutput) {
      setTimeout(async () => {
        try {
          const imported = await importImageUrl(testImportValue);
          await fs.writeFile(
            testImportOutput,
            JSON.stringify({
              ok: true,
              name: imported.name,
              width: imported.width,
              height: imported.height,
              srcPrefix: imported.src.slice(0, 32),
              palette: imported.palette,
            }),
            "utf8",
          );
        } catch (error) {
          await fs.writeFile(
            testImportOutput,
            JSON.stringify({
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            }),
            "utf8",
          );
        } finally {
          if (process.env.MUSEBOARD_QUIT_AFTER_TEST === "1") app.quit();
        }
      }, 400);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow.webContents.getURL();
    if (url !== currentUrl) event.preventDefault();
  });

  const developmentUrl = process.env.MUSEBOARD_DEV_SERVER_URL;
  if (developmentUrl) {
    void mainWindow.loadURL(developmentUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "desktop-dist", "index.html"));
  }
}

function loadRendererWindow(targetWindow, query = "") {
  const developmentUrl = process.env.MUSEBOARD_DEV_SERVER_URL;
  if (developmentUrl) {
    const url = new URL(developmentUrl);
    if (query) url.search = query;
    return targetWindow.loadURL(url.toString());
  }
  return targetWindow.loadFile(
    path.join(__dirname, "..", "desktop-dist", "index.html"),
    query ? { query: Object.fromEntries(new URLSearchParams(query)) } : undefined,
  );
}

function closeImageAnalysisWindows() {
  const windows = [...analysisWindows.values()];
  analysisWindows.clear();
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    // The project these edits belong to is being replaced, so there is nothing left to save into.
    window.__discardOnClose = true;
    window.close();
  }
}

function openImageAnalysisWindow(payload) {
  if (closeRequestPending || closeApproved || restoringBackup) return false;
  if (!payload || typeof payload.itemId !== "string" || typeof payload.src !== "string") {
    return false;
  }
  const existing = analysisWindows.get(payload.itemId);
  if (
    existing && !existing.isDestroyed() &&
    existing.__projectGeneration === projectGeneration
  ) {
    existing.__imageAnalysisPayload = payload;
    existing.show();
    existing.focus();
    existing.webContents.send("image-analysis:init", payload);
    return true;
  }
  const analysisWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 520,
    show: false,
    frame: false,
    icon: path.join(__dirname, "assets", "icon.png"),
    backgroundColor: "#1c1b22",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  analysisWindow.__imageAnalysisPayload = payload;
  analysisWindow.__projectGeneration = projectGeneration;
  analysisWindows.set(payload.itemId, analysisWindow);
  analysisWindow.once("ready-to-show", () => analysisWindow.show());
  analysisWindow.webContents.on("did-finish-load", () => {
    analysisWindow.webContents.send(
      "image-analysis:init",
      analysisWindow.__imageAnalysisPayload,
    );
  });
  // Closing with drawing that was never saved asks first, whichever way the window is closed.
  analysisWindow.on("close", (event) => {
    if (!analysisWindow.__dirty || analysisWindow.__discardOnClose) return;
    event.preventDefault();
    if (analysisWindow.__closePromptOpen) return;
    analysisWindow.__closePromptOpen = true;
    void (async () => {
      const t = await uiText();
      const { response } = await dialog.showMessageBox(analysisWindow, {
        type: "warning",
        title: "ImageStorage",
        message: t("Save your changes to this image?", "この画像への変更を保存しますか？", "要保存对此图像的更改吗？", "이 이미지의 변경 사항을 저장할까요?"),
        detail: t("Lines and guides you have not saved will be lost.", "保存していない線やガイドは失われます。", "未保存的线条和辅助线将会丢失。", "저장하지 않은 선과 가이드는 사라집니다."),
        buttons: [t("Save", "保存", "保存", "저장"), t("Don't save", "保存しない", "不保存", "저장 안 함"), t("Cancel", "キャンセル", "取消", "취소")],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      analysisWindow.__closePromptOpen = false;
      if (analysisWindow.isDestroyed()) return;
      if (response === 0) analysisWindow.webContents.send("image-analysis:save-request");
      else if (response === 1) {
        analysisWindow.__discardOnClose = true;
        analysisWindow.close();
      }
    })();
  });
  analysisWindow.on("closed", () => {
    if (analysisWindows.get(payload.itemId) === analysisWindow) {
      analysisWindows.delete(payload.itemId);
    }
  });
  analysisWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void loadRendererWindow(analysisWindow, "mode=image-analysis");
  return true;
}

ipcMain.handle("project:open", async () => {
  if (restoringBackup) return { canceled: true };
  const t = await uiText();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t("Open ImageStorage project", "ImageStorage プロジェクトを開く", "打开 ImageStorage 项目", "ImageStorage 프로젝트 열기"),
    filters: [
      {
        name: "ImageStorage Project",
        extensions: ["imagestorage", "museboard"],
      },
    ],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };

  try {
    const filePath = result.filePaths[0];
    const data = await loadProjectFile(filePath);
    projectGeneration += 1;
    closeImageAnalysisWindows();
    currentProjectPath = filePath.toLowerCase().endsWith(".imagestorage")
      ? filePath
      : null;
    return { canceled: false, name: path.basename(filePath), data };
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: t("Could not open project", "プロジェクトを開けませんでした", "无法打开项目", "프로젝트를 열 수 없습니다"),
      message: t("This file is not a valid ImageStorage project.", "このファイルは ImageStorage のプロジェクトとして読み込めません。",
        "此文件不是有效的 ImageStorage 项目。", "이 파일은 올바른 ImageStorage 프로젝트가 아닙니다."),
      detail: error instanceof Error ? error.message : "",
    });
    return { canceled: true };
  }
});

async function saveProjectSnapshot(data, requestGeneration) {
  if (
    restoringBackup ||
    requestGeneration !== projectGeneration ||
    !validProjectSnapshot(data)
  ) {
    return { canceled: true };
  }

  let filePath = currentProjectPath;
  if (!filePath) {
    const t = await uiText();
    const result = await dialog.showSaveDialog(mainWindow, {
      title: t("Save ImageStorage project", "ImageStorage プロジェクトを保存", "保存 ImageStorage 项目", "ImageStorage 프로젝트 저장"),
      defaultPath: "Untitled.imagestorage",
      filters: [
        {
          name: "ImageStorage Project",
          extensions: ["imagestorage"],
        },
      ],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    filePath = result.filePath.endsWith(".imagestorage")
      ? result.filePath
      : `${result.filePath}.imagestorage`;
  }

  // An Open operation can finish while the save dialog is awaiting input.
  // The snapshot still belongs to the project that requested this save.
  if (requestGeneration !== projectGeneration) return { canceled: true };

  try {
    await writePortableProject(filePath, data);
    if (requestGeneration === projectGeneration) currentProjectPath = filePath;
    return { canceled: false, name: path.basename(filePath) };
  } catch (error) {
    const t = await uiText();
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: t("Could not save project", "プロジェクトを保存できませんでした", "无法保存项目", "프로젝트를 저장할 수 없습니다"),
      message: t("The portable project could not be created.", "プロジェクトファイルを作成できませんでした。",
        "无法创建项目文件。", "프로젝트 파일을 만들 수 없습니다."),
      detail: error instanceof Error ? error.message : "",
    });
    return { canceled: true };
  }
}

ipcMain.handle("project:save", (_event, data) => {
  if (closeRecoveryPending) return { canceled: true };
  const requestGeneration = projectGeneration;
  const nextSave = projectSaveQueue.then(() =>
    saveProjectSnapshot(data, requestGeneration),
  );
  // Serialize dialogs and complete writes, including replacement of .previous.
  // A failed request must not prevent the next save from being attempted.
  projectSaveQueue = nextSave.catch(() => {});
  return nextSave;
});

ipcMain.handle("project:load-autosave", async () => loadRecoverySnapshot());

ipcMain.handle("project:auto-save", async (_event, data) =>
  restoringBackup ? { saved: false, error: "Backup restoration is in progress" } : queueRecoverySnapshot(data),
);

const storageTools = createStorageTools({ recoveryDirectory, recoverySnapshotPaths, validProjectSnapshot,
  writeJsonAtomically, readImageSource, localProjectSourcePath, sha256File, sharp, maxImageBytes: MAX_IMAGE_BYTES });

async function storageRequest(event, operation) {
  try {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("This action is only available in the main window");
    if (restoringBackup || closeRequestPending) throw new Error("Another save or restore is in progress");
    return await operation();
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Storage operation failed" };
  }
}

function queueStorageWrite(operation) {
  // Main-window close already drains this queue, including folder exports.
  const next = projectSaveQueue.then(operation);
  projectSaveQueue = next.catch(() => {});
  return next;
}

ipcMain.handle("storage:list-backups", (event) => storageRequest(event, () => storageTools.listBackups()));
ipcMain.handle("storage:create-backup", (event, data) => storageRequest(event,
  () => queueStorageWrite(() => storageTools.createBackup(data))));
ipcMain.handle("storage:find-duplicates", (event, data) => storageRequest(event, () => storageTools.findDuplicates(data)));
ipcMain.handle("storage:export-list", (event, data, boardId) => storageRequest(event, () => queueStorageWrite(async () => {
  if (!validProjectSnapshot(data) || !data.boards.some((board) => board.id === boardId)) throw new Error("Invalid list selection");
  const t = await uiText();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t("Choose a folder to export images to", "画像の出力先フォルダーを選択", "选择图片导出文件夹", "이미지를 내보낼 폴더 선택"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  return storageTools.exportImages(data, boardId, result.filePaths[0]);
})));

ipcMain.handle("storage:restore-backup", (event, token, current) => storageRequest(event, async () => {
  if ([...analysisWindows.values()].some((window) => !window.isDestroyed())) {
    throw new Error("画像編集画面を先に保存または閉じてください。 / Save or close the image editor first.");
  }
  restoringBackup = true;
  try {
    const data = await storageTools.readBackup(token);
    await drainPendingWrites();
    // Failure to protect the current state must abort restoration.
    await storageTools.createBackup(current, "before-restore");
    const result = await queueRecoverySnapshot(data);
    if (!result.saved) throw new Error(result.error || "Could not save restored data");
    projectGeneration += 1;
    currentProjectPath = null;
    // Keep stale renderer autosaves blocked until it installs the restored boards.
    return { data };
  } catch (error) {
    restoringBackup = false;
    throw error;
  }
}));
ipcMain.on("storage:restore-complete", (event) => {
  if (event.sender === mainWindow?.webContents) restoringBackup = false;
});

ipcMain.handle("settings:save-global-background", (_event, reference) =>
  queueGlobalBackground(reference),
);

ipcMain.handle("pinterest-board:open", async event => {
  if (!isMainRenderer(event)) return { canceled: true };
  try {
    const t = await uiText();
    const result = await dialog.showOpenDialog(mainWindow, { title: t("Import board file", "ボードファイルを読み込む", "导入图板文件", "보드 파일 가져오기"), filters: [{ name: "ImageStorage Board", extensions: ["json"] }], properties: ["openFile"] });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const file = result.filePaths[0], stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > MAX_BOARD_FILE_BYTES) throw new Error("8MB以下のボードファイルを選択してください。");
    const boardFile = parsePinterestBoardFile(await fs.readFile(file, "utf8"));
    return { canceled: false, boardFile };
  } catch (error) { return { canceled: false, error: error instanceof Error ? error.message : "ボードファイルを読み込めませんでした。" }; }
});

ipcMain.handle("image:choose-files", async () => {
  const t = await uiText();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: t("Choose images", "画像を選択", "选择图片", "이미지 선택"),
    filters: [{ name: t("All files", "すべてのファイル", "所有文件", "모든 파일"), extensions: ["*"] }],
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return { canceled: true, images: [], errors: [] };
  return stageImagePaths(result.filePaths);
});

ipcMain.handle("image:stage-paths", async (_event, filePaths) =>
  stageImagePaths(filePaths),
);

ipcMain.handle("image:optimize-staged", async (_event, entries) => {
  const inputEntries = Array.isArray(entries) ? entries : [];
  const results = [];
  for (let index = 0; index < inputEntries.length; index += 2) {
    const batch = inputEntries.slice(index, index + 2);
    const settled = await Promise.allSettled(
      batch.map(async (entry) => ({
        id: String(entry?.id || ""),
        image: await optimizeStoredImage(entry),
      })),
    );
    settled.forEach((result, batchIndex) => {
      if (result.status === "fulfilled") {
        results.push({ ...result.value, error: null });
        return;
      }
      results.push({
        id: String(batch[batchIndex]?.id || ""),
        image: null,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : "Image optimization failed",
      });
    });
  }
  return { results };
});

ipcMain.handle("image:persist-source", async (_event, entry) => {
  try {
    const image = await optimizeStoredImage(entry);
    return { image, error: null };
  } catch (error) {
    return {
      image: null,
      error:
        error instanceof Error ? error.message : "Could not store the image",
    };
  }
});

ipcMain.handle("image:convert-files", async (_event, entries) => {
  const images = [];
  const errors = [];
  const inputEntries = Array.isArray(entries) ? entries : [];
  for (let index = 0; index < inputEntries.length; index += 2) {
    const batch = inputEntries.slice(index, index + 2);
    const settled = await Promise.allSettled(
      batch.map((entry) => {
        const name = cleanImageName(entry?.name);
        const input = Buffer.from(entry?.bytes || []);
        return persistImageBuffer(input, name, entry?.assetId);
      }),
    );
    settled.forEach((result, batchIndex) => {
      const entry = batch[batchIndex];
      const name = cleanImageName(entry?.name);
      if (result.status === "fulfilled") {
        images.push({
          ...result.value,
          clientId: String(entry?.id || ""),
        });
        return;
      }
      errors.push({
        name,
        message:
          result.reason instanceof Error
            ? result.reason.message
            : "Unsupported image",
      });
    });
  }
  return { canceled: false, images, errors };
});

ipcMain.handle("image:import-url", async (_event, url) => {
  try {
    const image = await importImageUrl(url);
    return { canceled: false, images: [image], errors: [] };
  } catch (error) {
    return {
      canceled: false,
      images: [],
      errors: [
        {
          name: cleanImageName(url, "URL"),
          message: error instanceof Error ? error.message : "Could not load URL",
        },
      ],
    };
  }
});

ipcMain.handle("image:extract-palette", async (_event, source) => {
  try {
    const colors = await extractColorPalette(await readImageSource(source));
    return { colors, error: null };
  } catch (error) {
    return {
      colors: [],
      error:
        error instanceof Error
          ? error.message
          : "Could not extract a color palette",
    };
  }
});

ipcMain.handle("image-analysis:open", (_event, payload) =>
  openImageAnalysisWindow(payload),
);
ipcMain.handle("image-analysis:get-init", (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow || targetWindow.__projectGeneration !== projectGeneration) return null;
  const payload = targetWindow.__imageAnalysisPayload;
  return payload && analysisWindows.get(payload.itemId) === targetWindow ? payload : null;
});
ipcMain.on("image-analysis:dirty", (event, dirty) => {
  const analysisWindow = [...analysisWindows.values()].find((window) => !window.isDestroyed() && window.webContents === event.sender);
  if (analysisWindow) analysisWindow.__dirty = dirty === true;
});

ipcMain.on("image-analysis:update", (event, payload) => {
  if (!payload || typeof payload.itemId !== "string") return;
  const analysisWindow = analysisWindows.get(payload.itemId);
  if (
    !analysisWindow || analysisWindow.isDestroyed() ||
    analysisWindow.__projectGeneration !== projectGeneration ||
    analysisWindow.webContents !== event.sender
  ) return;
  analysisWindow.__imageAnalysisPayload = {
    ...analysisWindow.__imageAnalysisPayload,
    analysis: payload.analysis,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("image-analysis:updated", payload);
  }
});

ipcMain.handle("window:toggle-always-on-top", (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow) return false;
  const next = !targetWindow.isAlwaysOnTop();
  targetWindow.setAlwaysOnTop(next, "floating");
  return next;
});
ipcMain.handle("window:get-titlebar-visibility", () => titlebarVisible);
ipcMain.handle("window:get-pointer-position", (event) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return null;
  return getWindowPointerPosition();
});

ipcMain.on("window:minimize", (event) =>
  BrowserWindow.fromWebContents(event.sender)?.minimize(),
);
ipcMain.on("window:toggle-maximize", (event) => {
  const targetWindow = BrowserWindow.fromWebContents(event.sender);
  if (!targetWindow) return;
  if (targetWindow.isMaximized()) targetWindow.unmaximize();
  else targetWindow.maximize();
});
ipcMain.on("window:close", (event) =>
  BrowserWindow.fromWebContents(event.sender)?.close(),
);
ipcMain.on("window:close-ready", async (_event, data) => {
  if (!closeRequestPending || closeRecoveryPending) return;
  closeRecoveryPending = true;
  // The timeout only covers a renderer that does not answer. Once it answers,
  // queued recovery writes must finish before the process can safely exit.
  if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
  closeFallbackTimer = null;
  try {
    if (!data?.skipRecovery) {
      const result = await queueRecoverySnapshot(data);
      if (!result?.saved) {
        throw new Error(result?.error || "Recovery snapshot could not be saved.");
      }
    }
    await drainPendingWrites();
    closeApproved = true;
    closeRequestPending = false;
    mainWindow?.close();
  } catch (error) {
    closeApproved = false;
    closeRequestPending = false;
    dialog.showErrorBox(
      "Could not save before closing",
      "ImageStorage is still open because the latest recovery snapshot could not be saved. " +
        "Save your project or free up disk space, then try closing again.\n\n" +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    closeRecoveryPending = false;
  }
});

async function runStorageQa(resultPath) {
  try {
    const sourcePath = path.join(
      __dirname,
      "..",
      "desktop-dist",
      "nocopyrightgirl-sakura.webp",
    );
    const input = await fs.readFile(sourcePath);
    const referencedImage = await persistImageBuffer(input, "referenced.webp");
    const fullImagePreserved = input.equals(
      await fs.readFile(fileURLToPath(referencedImage.src)),
    );
    const orphanImage = await persistImageBuffer(input, "orphan.webp");
    const redundantOriginalPath = path.join(
      assetDirectory,
      `original-${referencedImage.assetId}.webp`,
    );
    await fs.writeFile(redundantOriginalPath, input);
    const snapshot = {
      format: "museboard",
      version: 3,
      savedAt: new Date().toISOString(),
      activeId: "qa-board",
      boards: [
        {
          id: "qa-board",
          name: "Portable QA",
          viewport: { x: 0, y: 0, scale: 1 },
          backgroundImageSrc: referencedImage.src,
          backgroundImageThumbnailSrc: referencedImage.thumbnailSrc,
          backgroundImageAssetId: referencedImage.assetId,
          headerImageSrc: referencedImage.src,
          headerImageThumbnailSrc: referencedImage.thumbnailSrc,
          headerImageAssetId: referencedImage.assetId,
          items: [
            {
              id: "qa-image",
              type: "image",
              src: referencedImage.src,
              thumbnailSrc: referencedImage.thumbnailSrc,
              assetId: referencedImage.assetId,
              x: 0,
              y: 0,
              w: referencedImage.width,
              h: referencedImage.height,
              z: 1,
            },
            {
              id: "qa-bundled-image",
              type: "image",
              src: "./nocopyrightgirl-sakura.webp",
              x: referencedImage.width + 20,
              y: 0,
              w: referencedImage.width,
              h: referencedImage.height,
              z: 2,
            },
          ],
        },
      ],
    };
    const autosaveResult = await saveRecoverySnapshot(snapshot);
    await writeJsonAtomically(
      assetCleanupStatePath,
      JSON.stringify({
        version: 1,
        candidates: {
          [path.basename(fileURLToPath(orphanImage.src))]: 0,
          [path.basename(fileURLToPath(orphanImage.thumbnailSrc))]: 0,
          [path.basename(redundantOriginalPath)]: 0,
        },
      }),
    );
    const cleanupResult = await cleanupUnusedAssets();
    const referencedSurvivedCleanup = fsSync.existsSync(
      fileURLToPath(referencedImage.src),
    );

    const projectPath = path.join(app.getPath("userData"), "portable.qa.imagestorage");
    await writePortableProject(projectPath, snapshot);
    const referencedImagePath = fileURLToPath(referencedImage.src);
    const referencedThumbnailPath = fileURLToPath(
      referencedImage.thumbnailSrc,
    );
    const detachedImagePath = `${referencedImagePath}.detached`;
    const detachedThumbnailPath = `${referencedThumbnailPath}.detached`;
    await fs.rename(referencedImagePath, detachedImagePath);
    await fs.rename(referencedThumbnailPath, detachedThumbnailPath);
    let loadedProject;
    try {
      loadedProject = await loadProjectFile(projectPath);
    } finally {
      await fs.rename(detachedImagePath, referencedImagePath);
      await fs.rename(detachedThumbnailPath, referencedThumbnailPath);
    }
    const loadedImage = loadedProject.boards[0].items[0];
    const loadedBundledImage = loadedProject.boards[0].items[1];
    const legacyPath = path.join(app.getPath("userData"), "legacy.qa.museboard");
    await fs.writeFile(legacyPath, JSON.stringify(snapshot), "utf8");
    const legacyProject = await loadProjectFile(legacyPath);
    const truncatedPath = path.join(
      app.getPath("userData"),
      "truncated.qa.imagestorage",
    );
    await fs.copyFile(projectPath, truncatedPath);
    const truncatedStats = await fs.stat(truncatedPath);
    await fs.truncate(truncatedPath, truncatedStats.size - 10);
    let truncatedRejected = false;
    try {
      await loadProjectFile(truncatedPath);
    } catch {
      truncatedRejected = true;
    }
    const corruptedPath = path.join(
      app.getPath("userData"),
      "corrupted.qa.imagestorage",
    );
    await fs.copyFile(projectPath, corruptedPath);
    const corruptedHandle = await fs.open(corruptedPath, "r+");
    try {
      const corruptedStats = await corruptedHandle.stat();
      const lastByte = Buffer.alloc(1);
      await corruptedHandle.read(
        lastByte,
        0,
        1,
        corruptedStats.size - 1,
      );
      lastByte[0] ^= 0xff;
      await corruptedHandle.write(
        lastByte,
        0,
        1,
        corruptedStats.size - 1,
      );
    } finally {
      await corruptedHandle.close();
    }
    let corruptedRejected = false;
    try {
      await loadProjectFile(corruptedPath);
    } catch {
      corruptedRejected = true;
    }
    const packagePrefix = await fs.readFile(projectPath).then((buffer) =>
      buffer.subarray(0, PORTABLE_PROJECT_MAGIC.length),
    );

    await fs.writeFile(
      resultPath,
      JSON.stringify({
        ok: true,
        autosaveSaved: autosaveResult.saved,
        portableMagic: packagePrefix.equals(PORTABLE_PROJECT_MAGIC),
        portableBoardCount: loadedProject.boards.length,
        portableImageExists: fsSync.existsSync(
          fileURLToPath(loadedImage.src),
        ),
        fullImagePreserved,
        bundledImageExists: fsSync.existsSync(
          fileURLToPath(loadedBundledImage.src),
        ),
        portableAssetWasRemapped:
          loadedImage.assetId !== referencedImage.assetId,
        boardBackgroundWasRemapped:
          loadedProject.boards[0].backgroundImageAssetId === loadedImage.assetId &&
          fsSync.existsSync(fileURLToPath(loadedProject.boards[0].backgroundImageSrc)),
        boardHeaderWasRemapped:
          loadedProject.boards[0].headerImageAssetId === loadedImage.assetId &&
          fsSync.existsSync(fileURLToPath(loadedProject.boards[0].headerImageSrc)),
        legacyCompatible: legacyProject.activeId === snapshot.activeId,
        truncatedRejected,
        corruptedRejected,
        referencedSurvivedCleanup,
        openedWithoutOriginalSource: loadedImage.assetId !== referencedImage.assetId,
        orphanImageExists: fsSync.existsSync(fileURLToPath(orphanImage.src)),
        redundantOriginalExists: fsSync.existsSync(redundantOriginalPath),
        cleanupResult,
        projectBytes: (await fs.stat(projectPath)).size,
      }),
      "utf8",
    );
  } catch (error) {
    await fs.writeFile(
      resultPath,
      JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.stack : String(error),
      }),
      "utf8",
    );
  }
}

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const storageQaResult = process.env.IMAGESTORAGE_TEST_STORAGE_QA_RESULT;
  if (storageQaResult) {
    await runStorageQa(storageQaResult);
    app.quit();
    return;
  }
  await cleanupUnusedAssets().catch((error) => console.error("Asset cleanup skipped", error));
  await startExtensionBridge().catch((error) => console.error("Browser connector unavailable", error.message));
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
