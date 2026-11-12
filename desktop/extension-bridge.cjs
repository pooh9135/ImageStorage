const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual, createHash } = require("node:crypto");

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const PAGE_SIZE = 128;

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function createLineDecoder(onMessage, onError, maximum = MAX_MESSAGE_BYTES) {
  let buffered = Buffer.alloc(0), failed = false;
  return (chunk) => {
    if (failed) return;
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      const end = buffered.indexOf(10);
      if (end < 0) break;
      if (end > maximum) { failed = true; onError(bridgeError("too_large", "Message is too large")); return; }
      const line = buffered.subarray(0, end);
      buffered = buffered.subarray(end + 1);
      try { onMessage(JSON.parse(line.toString("utf8"))); }
      catch { failed = true; onError(bridgeError("invalid_message", "Invalid connector message")); return; }
    }
    if (buffered.length > maximum) { failed = true; onError(bridgeError("too_large", "Message is too large")); }
  };
}

async function ensureBridgeConfiguration(directory, application) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const connectionPath = path.join(directory, "connection.json");
  let config;
  try { config = JSON.parse(await fs.readFile(connectionPath, "utf8")); } catch { /* First launch. */ }
  if (!/^imagestorage-connector-[a-f0-9]{32}$/.test(config?.pipeName ?? "") || !/^[a-f0-9]{64}$/.test(config?.token ?? "")) {
    config = { pipeName: `imagestorage-connector-${randomBytes(16).toString("hex")}`, token: randomBytes(32).toString("hex") };
    await fs.writeFile(connectionPath, JSON.stringify(config), { mode: 0o600 });
  }
  const temporary = path.join(directory, `application-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, JSON.stringify(application), { mode: 0o600 });
  await fs.rename(temporary, path.join(directory, "application.json"));
  return config;
}

function safeSource(value, allowData = false) {
  if (typeof value !== "string" || !value.trim()) throw bridgeError("invalid_image", "画像のURLを取得できませんでした。");
  const input = value.trim();
  if (allowData && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[a-z0-9+/=\s]+$/i.test(input)) {
    if (Buffer.byteLength(input) > 12 * 1024 * 1024) throw bridgeError("too_large", "ブラウザーから送る画像は8MB以下にしてください。");
    return input;
  }
  if (input.length > 16384) throw bridgeError("invalid_image", "画像のURLが長すぎます。");
  let url;
  try { url = new URL(input); } catch { throw bridgeError("invalid_image", "画像のURLが正しくありません。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw bridgeError("invalid_image", "HTTP/HTTPSの画像を選択してください。");
  return url.href;
}

function imageIdentityKeys(input) {
  const { imageUrl, sourceUrl } = input || {};
  const keys = new Set();
  for (const [value, direct] of [[imageUrl, true], [sourceUrl, false]]) {
    if (typeof value !== "string" || value.length > 16384) continue;
    let url;
    try { url = new URL(value); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    const pin = /(?:^|\.)pinterest\.(?:com|jp|co\.uk|ca|de|fr|es|it|com\.au)$/.test(url.hostname) && /^\/pin\/(\d+)\/?$/.exec(url.pathname);
    if (pin) { keys.add(`pin:${pin[1]}`); continue; }
    const photo = url.hostname === "i.pinimg.com" && /^\/[^/]+\/(?:[a-f0-9]{2}\/){3}([a-f0-9]{32})\.(?:jpe?g|png|webp|gif|avif)$/i.exec(url.pathname);
    if (photo) { keys.add(`pinimg:${photo[1].toLowerCase()}`); continue; }
    // A generic source page can contain many unrelated images. Match that URL
    // only when it identifies an image file, or was recorded as the image URL.
    if (direct || /\.(?:jpe?g|png|webp|gif|avif|bmp|svg)$/i.test(url.pathname)) { url.hash = ""; keys.add(`url:${url.href}`); }
  }
  return [...keys];
}

function matchesImageIdentity(stored, selected) {
  const storedImages = stored.filter(key => !key.startsWith("pin:"));
  const selectedImages = selected.filter(key => !key.startsWith("pin:"));
  // A Pin can contain more than one image. Prefer known image identities;
  // use the Pin URL only for older records without an original image URL.
  if (storedImages.length && selectedImages.length) return selectedImages.some(key => storedImages.includes(key));
  return selected.some(key => stored.includes(key));
}

function createExtensionBridge({ pipePath, token, onImport, onRemove }) {
  if (typeof token !== "string" || token.length !== 64) throw new Error("Invalid connector token");
  const clients = new Set(), jobs = new Map();
  let closed = false, stateKey = "", imageIndex = new Map();
  let state = { ready: false, generation: -1, session: randomUUID(), revision: 0, activeId: "", boards: [] };
  const meta = () => ({ ready: state.ready, session: state.session, revision: state.revision, activeId: state.activeId, total: state.boards.length, capabilities: { createBoard: true, savedStatus: true, removeImage: typeof onRemove === "function" } });
  const containsImage = (boardId, query) => {
    const keys = imageIdentityKeys(query);
    return (imageIndex.get(boardId) || []).some(image => matchesImageIdentity(image.keys, keys));
  };
  const current = (session, boardId) => !closed && state.ready && state.session === session && state.boards.some((board) => board.id === boardId);
  const canCreate = (session, boardId) => !closed && state.ready && state.session === session && (state.boards.length < 10000 || state.boards.some((board) => board.id === boardId));
  function write(client, value) {
    if (client.socket.destroyed) return;
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > 950000 || client.socket.writableLength > 2 * 1024 * 1024) { client.socket.destroy(); return; }
    client.socket.write(`${text}\n`);
  }
  function updateState(input) {
    const ready = input?.ready === true;
    const generation = Number.isSafeInteger(input?.generation) ? input.generation : -1;
    const ids = new Set();
    const nextIndex = new Map();
    const boards = ready && Array.isArray(input.boards) ? input.boards.slice(0, 10000).flatMap((board) => {
      if (typeof board?.id !== "string" || !board.id || board.id.length > 128 || ids.has(board.id)) return [];
      ids.add(board.id);
      const images = (Array.isArray(board.imageSources) ? board.imageSources : []).map(image => ({ id: typeof image?.id === "string" ? image.id : "", imageUrl: typeof image?.imageUrl === "string" ? image.imageUrl : "", sourceUrl: typeof image?.sourceUrl === "string" ? image.sourceUrl : "", keys: imageIdentityKeys(image) }));
      nextIndex.set(board.id, images);
      return [{ id: board.id, name: String(board.name || "名称未設定").slice(0, 512), groupName: String(board.groupName || "").slice(0, 128) }];
    }) : [];
    const activeId = ids.has(input?.activeId) ? input.activeId : "";
    const key = JSON.stringify({ ready, generation, activeId, boards, images: [...nextIndex] });
    if (key === stateKey) return;
    if (generation !== state.generation || !ready || !state.ready) {
      state.session = randomUUID();
      jobs.clear();
    }
    stateKey = key;
    imageIndex = nextIndex;
    state = { ...state, ready, generation, activeId, boards, revision: state.revision + 1 };
    for (const client of clients) if (client.authenticated) write(client, { event: "state", state: meta() });
  }
  async function handle(client, message) {
    const id = typeof message?.id === "string" && message.id.length <= 100 ? message.id : "";
    try {
      const provided = Buffer.from(typeof message?.token === "string" ? message.token : "");
      const expected = Buffer.from(token);
      if (!id || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        write(client, { id, ok: false, error: { code: "unauthorized", message: "Connector authentication failed" } });
        client.socket.end(); return;
      }
      client.authenticated = true;
      if (message.action === "list") {
        const query = message.lookup ? {
          imageUrl: message.lookup.imageUrl ? safeSource(message.lookup.imageUrl) : "",
          sourceUrl: message.lookup.sourceUrl ? safeSource(message.lookup.sourceUrl) : "",
        } : null;
        const offset = Number.isSafeInteger(message.offset) && message.offset >= 0 ? message.offset : 0;
        const page = state.boards.slice(offset, offset + PAGE_SIZE).map(board => query ? { ...board, containsImage: containsImage(board.id, query) } : board);
        const response = { id, ok: true, state: { ...meta(), boards: page, nextOffset: null } };
        while (page.length > 1 && Buffer.byteLength(JSON.stringify(response)) > 900000) page.pop();
        response.state.nextOffset = offset + page.length < state.boards.length ? offset + page.length : null;
        write(client, response);
        return;
      }
      if (message.action !== "import") throw bridgeError("unknown_action", "Unknown connector action");
      // Keep the existing native-host mutation envelope. Older hosts forward
      // this field unchanged; the advertised capability gates removal in UI.
      if (message.operation !== undefined && !["save", "remove"].includes(message.operation)) throw bridgeError("invalid_message", "Unknown image operation");
      const removing = message.operation === "remove";
      if (removing && typeof onRemove !== "function") throw bridgeError("update_required", "保存の解除にはImageStorage 0.15.47以降が必要です。");
      if (!/^[a-z0-9-]{16,80}$/i.test(message.importId ?? "")) throw bridgeError("invalid_message", "Invalid import identifier");
      const creating = message.newBoardName !== undefined;
      if (creating && removing) throw bridgeError("invalid_message", "作成と解除を同時に指定できません。");
      let newBoardName;
      if (creating) {
        if (typeof message.newBoardName !== "string" || !message.newBoardName.trim() || message.newBoardName.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(message.newBoardName) || message.boardId !== undefined) throw bridgeError("invalid_name", "リスト名は1〜120文字で入力してください。");
        newBoardName = message.newBoardName.trim();
      }
      const boardId = creating ? `board-${message.importId}` : message.boardId;
      const isCurrent = () => creating ? canCreate(message.session, boardId) : current(message.session, boardId);
      if (!isCurrent()) throw bridgeError("stale_list", "保存先のリストが変更されたか、作成できるリスト数の上限です。保存先を確認してください。");
      const imageUrl = safeSource(message.imageUrl, true);
      const sourceUrl = message.sourceUrl ? safeSource(message.sourceUrl) : /^https?:/.test(imageUrl) ? imageUrl : "";
      const originalImageUrl = message.originalImageUrl ? safeSource(message.originalImageUrl) : /^https?:/.test(imageUrl) ? imageUrl : "";
      const request = { operation: removing ? "remove" : "save", imageUrl, sourceUrl, originalImageUrl, boardId, session: message.session, importId: message.importId, generation: state.generation, ...(creating ? { newBoardName } : {}) };
      const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
      for (const [key, job] of jobs) if (Date.now() - job.created > 10 * 60 * 1000 && job.finished) jobs.delete(key);
      let job = jobs.get(request.importId);
      if (job && job.fingerprint !== fingerprint) throw bridgeError("duplicate_id", "画像の送信IDが重複しました。もう一度送信してください。");
      if (!job) {
        const identity = imageIdentityKeys({ imageUrl: originalImageUrl, sourceUrl });
        const preceding = !creating && [...jobs.values()].filter(entry => !entry.finished && entry.boardId === boardId && matchesImageIdentity(entry.identity, identity));
        if (creating && state.boards.some((board) => board.id === boardId)) throw bridgeError("duplicate_id", "この作成処理はすでに反映されています。リストを確認してください。");
        if (jobs.size >= 1000 || [...jobs.values()].filter((entry) => !entry.finished).length >= 8) throw bridgeError("busy", "送信が混み合っています。しばらく待ってください。");
        job = { fingerprint, created: Date.now(), finished: false, boardId, identity };
        const run = async () => {
          // Serialize opposite operations on the same image, and wait for
          // durable acknowledgement before inspecting its new membership.
          if (preceding) await Promise.all(preceding.map(entry => entry.promise));
          if (!isCurrent()) throw bridgeError("stale_list", "保存先のリストが変更されました。");
          if (removing) {
            const targets = (imageIndex.get(boardId) || []).filter(image => matchesImageIdentity(image.keys, identity)).map(({ id, imageUrl, sourceUrl }) => ({ id, imageUrl, sourceUrl }));
            if (targets.some(target => !target.id)) throw bridgeError("stale_list", "画像の情報を更新中です。もう一度右クリックしてください。");
            return onRemove({ ...request, targets }, isCurrent);
          }
          if (!creating && containsImage(boardId, { imageUrl: originalImageUrl, sourceUrl })) return { boardId, count: 0, alreadySaved: true };
          return onImport(request, isCurrent);
        };
        job.promise = Promise.resolve().then(run);
        job.promise.then(() => { job.finished = true; }, () => { job.finished = true; });
        jobs.set(request.importId, job);
      }
      const result = await job.promise;
      write(client, { id, ok: true, result });
    } catch (error) {
      write(client, { id, ok: false, error: { code: error.code || "import_failed", message: error.message || "画像を送信できませんでした。" } });
    }
  }
  const server = net.createServer((socket) => {
    const client = { socket, authenticated: false };
    clients.add(client);
    socket.on("data", createLineDecoder((message) => { void handle(client, message); }, () => socket.destroy()));
    socket.on("error", () => {});
    socket.on("close", () => clients.delete(client));
  });
  return {
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ path: pipePath, readableAll: false, writableAll: false }, () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", () => {});
    },
    updateState,
    invalidate() { updateState({ ready: false, generation: -1, boards: [] }); },
    snapshot: meta,
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createExtensionBridge, createLineDecoder, ensureBridgeConfiguration, safeSource, bridgeError, imageIdentityKeys, MAX_MESSAGE_BYTES };
