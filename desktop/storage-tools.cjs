const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const message = (error) => error instanceof Error ? error.message : String(error);

function hasTransientSources(project) {
  const transient = (value) => typeof value === "string" && /^blob:/i.test(value.trim());
  return project.boards.some((board) =>
    [board.headerImageSrc, board.headerImageThumbnailSrc, board.backgroundImageSrc,
      board.backgroundImageThumbnailSrc].some(transient) ||
    board.items.some((item) => item.type === "image" && [item.src, item.thumbnailSrc].some(transient)),
  );
}

async function savedBackupPaths(directory, rotatingPaths) {
  const snapshots = path.join(directory, "snapshots");
  let entries;
  try { entries = await fs.readdir(snapshots, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return [...rotatingPaths]; throw error; }
  return [...rotatingPaths, ...entries.filter((entry) => entry.isFile() &&
    /^backup-[\w-]+\.json$/.test(entry.name)).map((entry) => path.join(snapshots, entry.name))];
}

function safeImageName(value, fallback) {
  let name = String(value || fallback).replace(/\.[a-zA-Z0-9]{1,12}$/, "")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, "_").replace(/[. ]+$/g, "").trim();
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  return Array.from(name).slice(0, 100).join("");
}

function createStorageTools({ recoveryDirectory, recoverySnapshotPaths, validProjectSnapshot,
  writeJsonAtomically, readImageSource, localProjectSourcePath, sha256File, sharp, maxImageBytes }) {
  const validate = (data) => {
    if (!validProjectSnapshot(data)) throw new Error("Invalid project data");
    if (hasTransientSources(data)) throw new Error("Image storage is incomplete. Retry importing the image first.");
  };
  const paths = () => savedBackupPaths(recoveryDirectory, recoverySnapshotPaths());
  const idFor = (file) => path.relative(recoveryDirectory, file).replaceAll("\\", "/");

  async function listBackups() {
    const backups = [], errors = [];
    for (const file of await paths()) {
      try {
        const bytes = await fs.readFile(file);
        const data = JSON.parse(bytes.toString("utf8"));
        validate(data);
        const stats = await fs.stat(file);
        backups.push({ id: idFor(file), digest: digest(bytes), savedAt: data.savedAt || stats.mtime.toISOString(),
          kind: file.includes(`${path.sep}snapshots${path.sep}`) ? (data.backupReason === "before-restore" ? "before-restore" : "manual") : "automatic",
          boards: data.boards.length, images: data.boards.reduce((sum, board) => sum + board.items.filter((item) => item.type === "image").length, 0),
          bytes: stats.size });
      } catch (error) {
        if (error.code !== "ENOENT") errors.push({ name: idFor(file), message: message(error) });
      }
    }
    backups.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    return { backups, errors };
  }

  async function createBackup(data, reason = "manual") {
    validate(data);
    const now = new Date().toISOString();
    const file = path.join(recoveryDirectory, "snapshots", `backup-${now.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
    await writeJsonAtomically(file, JSON.stringify({ ...data, savedAt: now, backupReason: reason }));
    return { id: idFor(file) };
  }

  async function readBackup(token) {
    if (!token || typeof token.id !== "string" || !/^[a-f0-9]{64}$/.test(token.digest || "")) throw new Error("Invalid backup selection");
    // Resolve only enumerated files, never an arbitrary path supplied over IPC.
    const file = (await paths()).find((candidate) => idFor(candidate) === token.id);
    if (!file) throw new Error("Backup not found. Refresh the list.");
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== token.digest) throw new Error("Backup changed. Refresh the list and select it again.");
    const data = JSON.parse(bytes.toString("utf8"));
    validate(data);
    const sources = new Set(data.boards.flatMap((board) => [board.headerImageSrc, board.backgroundImageSrc,
      ...board.items.filter((item) => item.type === "image").map((item) => item.src)]).filter(Boolean));
    for (const source of sources) {
      const local = localProjectSourcePath(source);
      if (local) {
        try { await fs.access(local); }
        catch { throw new Error(`Backup image is missing: ${path.basename(local)}`); }
      }
    }
    delete data.backupReason;
    return data;
  }

  async function readOriginal(source) {
    const local = localProjectSourcePath(source);
    if (local) {
      if ((await fs.stat(local)).size > maxImageBytes) throw new Error("Image exceeds the size limit");
      return fs.readFile(local);
    }
    const bytes = await readImageSource(source);
    if (bytes.length > maxImageBytes) throw new Error("Image exceeds the size limit");
    return bytes;
  }

  async function findDuplicates(data) {
    validate(data);
    const cache = new Map(), groups = new Map(), errors = [];
    let scanned = 0;
    for (const board of data.boards) {
      for (const item of board.items) {
        if (item.type !== "image") continue;
        const occurrence = { boardId: board.id, boardName: board.name, itemId: item.id, name: item.caption || "image" };
        try {
          if (!cache.has(item.src)) {
            const local = localProjectSourcePath(item.src);
            cache.set(item.src, local ? await sha256File(local) : digest(await readOriginal(item.src)));
          }
          const hash = cache.get(item.src);
          if (!groups.has(hash)) groups.set(hash, []);
          groups.get(hash).push(occurrence);
          scanned += 1;
        } catch (error) { errors.push({ ...occurrence, message: message(error) }); }
      }
    }
    return { scanned, groups: [...groups].filter(([, items]) => items.length > 1).map(([hash, items]) => ({ hash, items })), errors };
  }

  async function exportImages(data, boardId, directory) {
    validate(data);
    const board = data.boards.find((entry) => entry.id === boardId);
    if (!board) throw new Error("List not found");
    if (!(await fs.stat(directory)).isDirectory()) throw new Error("The destination is not a folder");
    const files = [], errors = [];
    for (const item of board.items) {
      if (item.type !== "image") continue;
      const name = item.caption || "image";
      try {
        const bytes = await readOriginal(item.src);
        const { format } = await sharp(bytes, { animated: true }).metadata();
        const extension = { jpeg: ".jpg", png: ".png", webp: ".webp", gif: ".gif", avif: ".avif", heif: ".heif", tiff: ".tiff", svg: ".svg", jp2: ".jp2" }[format];
        if (!extension) throw new Error("Unsupported original image format");
        const base = safeImageName(name, "image");
        for (let suffix = 1; ; suffix += 1) {
          const filename = `${base}${suffix === 1 ? "" : ` (${suffix})`}${extension}`;
          const target = path.join(directory, filename);
          let handle;
          try { handle = await fs.open(target, "wx"); }
          catch (error) { if (error.code === "EEXIST") continue; throw error; }
          try {
            await handle.writeFile(bytes);
            await handle.close();
            files.push(filename);
          } catch (error) {
            await handle.close().catch(() => {});
            await fs.rm(target, { force: true }).catch(() => {});
            throw error;
          }
          break;
        }
      } catch (error) { errors.push({ name, message: message(error) }); }
    }
    return { canceled: false, directory, exported: files.length, files, errors };
  }
  return { listBackups, createBackup, readBackup, findDuplicates, exportImages };
}

module.exports = { createStorageTools, savedBackupPaths, hasTransientSources, safeImageName };
