import { showInlinePicker } from "./inline-picker.js";
import { resolveLinkedImage } from "./linked-image.js";
import { collectPageImages } from "./batch-collector.js";
import { showBatchPicker } from "./batch-picker.js";
import { createBatchJobs } from "./batch-jobs.js";
import { showPinterestBoardExporter } from "./pinterest-board-export.js";
import { getPinterestBoardUrl } from "./pinterest-board-context.js";

const HOST = "com.imagestorage.connector";
const ROOT_MENU = "imagestorage-send";
const PICK_MENU = "imagestorage-pick";
const CREATE_MENU = "imagestorage-create";
const CONNECT_MENU = "imagestorage-connect";
const BATCH_MENU = "imagestorage-batch";
const EXPORT_BOARD_MENU = "imagestorage-export-board";
const MENU_LIMIT = 100;

export function createConnector(api) {
  let port = null, refreshing = null, refreshTimer = null, badgeTimer = null, menuQueue = Promise.resolve(), lastMenuSignature = "";
  let state = { ready: false, session: "", revision: 0, activeId: "", boards: [], error: "" };
  let menuContext = null, menuMembership = null, contextSequence = 0, membershipPending = null;
  let boardMenuPatterns = [], boardMenuSequence = 0;
  const menuPresentations = new Map();
  const pending = new Map();
  const imageSends = new Map();
  const imageResults = new Map();
  const imageWrites = new Map();
  const imageMutations = new Map();
  const storage = api.storage.session || api.storage.local;
  const firefox = typeof api.runtime.getBrowserInfo === "function";
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const uuid = () => crypto.randomUUID();
  const batches = createBatchJobs({ storage, refreshState, snapshot: () => state, sendImage });

  function updateBadge(text, title) {
    void api.action.setBadgeText({ text }).catch(() => {});
    void api.action.setBadgeBackgroundColor({ color: text === "!" ? "#8b4545" : "#41434a" }).catch(() => {});
    void api.action.setTitle({ title: title || "ImageStorageに画像を送る" }).catch(() => {});
  }
  function settle(id, error, result) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id); clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(result);
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { void refreshState(false).then(refreshMenuMembership).catch(() => {}); }, 150);
  }
  function connect() {
    if (port) return port;
    const connection = api.runtime.connectNative(HOST);
    port = connection;
    connection.onMessage.addListener((message) => {
      if (message.event === "state") {
        if (message.state?.session !== state.session || message.state?.revision !== state.revision) scheduleRefresh();
        return;
      }
      if (message.event === "disconnected") {
        for (const id of message.ids || []) settle(id, fail("unknown_result", "接続が切れました。ImageStorageで送信結果を確認してください。"));
        state = { ...state, ready: false, boards: [], error: "ImageStorageが閉じられました。" };
        void rebuildMenus(); return;
      }
      if (!message || typeof message.id !== "string") return;
      settle(message.id, message.ok ? null : fail(message.error?.code || "failed", message.error?.message || "送信できませんでした。"), message);
    });
    connection.onDisconnect.addListener(() => {
      const message = api.runtime.lastError?.message;
      if (port !== connection) return;
      port = null;
      for (const [id, request] of pending) settle(id, fail(request.action === "import" ? "unknown_result" : "not_installed", request.action === "import" ? "送信結果を確認できませんでした。ImageStorageの保存先を確認してください。" : "連携セットアップを実行し、ImageStorage 0.15.42以降を起動してください。"));
      state = { ...state, ready: false, boards: [], error: message ? "ブラウザー連携が未設定、または接続できません。" : "ImageStorageに接続できません。" };
      void rebuildMenus();
    });
    return connection;
  }
  function nativeRequest(action, payload = {}, launch = false) {
    return new Promise((resolve, reject) => {
      const id = uuid();
      const timer = setTimeout(() => settle(id, fail("unknown_result", "応答がありません。ImageStorageで送信結果を確認してください。")), 180000);
      pending.set(id, { resolve, reject, timer, action });
      try { connect().postMessage({ ...payload, id, action, launch }); }
      catch { settle(id, fail("not_installed", "連携セットアップを実行してください。")); }
    });
  }
  async function refreshState(launch = false) {
    if (refreshing) {
      try { await refreshing; } catch { /* An explicit user request can launch the app next. */ }
      if (!launch || state.ready) return state;
    }
    const work = async () => {
      try {
        for (let retry = 0; retry < 20; retry++) {
          let offset = 0, first = null, boards = [], consistent = true;
          do {
            const response = await nativeRequest("list", { offset }, launch);
            const page = response.state;
            if (!page || !Array.isArray(page.boards)) throw fail("invalid_response", "ImageStorageの応答が正しくありません。");
            if (!first) first = page;
            else if (first.session !== page.session || first.revision !== page.revision) { consistent = false; break; }
            boards = boards.concat(page.boards);
            if (boards.length > 10000) throw fail("too_many_lists", "保存リストの数が多すぎます。");
            const next = page.nextOffset;
            if (next !== null && (!Number.isSafeInteger(next) || next <= offset)) throw fail("invalid_response", "保存先一覧を取得できませんでした。");
            offset = next;
          } while (offset !== null);
          if (!consistent) continue;
          if (!first.ready && launch && retry < 19) { await new Promise((resolve) => setTimeout(resolve, 500)); continue; }
          state = { ...first, boards, error: first.ready ? "" : "ImageStorageを読み込み中です。もう一度接続してください。" };
          await rebuildMenus(); return state;
        }
        throw fail("busy", "リストが更新されています。もう一度接続してください。");
      } catch (error) {
        state = { ...state, ready: false, boards: [], error: error.message };
        await rebuildMenus(); throw error;
      }
    };
    refreshing = work();
    try { return await refreshing; } finally { refreshing = null; }
  }
  async function createMenu(properties) {
    if (firefox) { await api.contextMenus.create(properties); return; }
    await new Promise((resolve, reject) => {
      api.contextMenus.create(properties, () => { const error = api.runtime.lastError; if (error) reject(new Error(error.message)); else resolve(); });
    });
  }
  async function updateMenu(id, properties) {
    if (firefox) { await api.contextMenus.update(id, properties); return; }
    await new Promise((resolve, reject) => api.contextMenus.update(id, properties, () => {
      const error = api.runtime.lastError; if (error) reject(new Error(error.message)); else resolve();
    }));
  }
  async function tabBoardUrl(tab) {
    if (!Number.isInteger(tab?.id)) return "";
    try {
      const url = await api.tabs.sendMessage(tab.id, { action: "board:context" }, { frameId: 0 });
      return typeof url === "string" ? getPinterestBoardUrl(url) : "";
    } catch { return ""; }
  }
  function boardMenuVisibility() {
    return boardMenuPatterns.length ? { visible: true, documentUrlPatterns: boardMenuPatterns } : { visible: false };
  }
  async function refreshBoardMenu() {
    const sequence = ++boardMenuSequence;
    const tabs = await api.tabs.query({ active: true });
    const urls = [...new Set((await Promise.all(tabs.map(tabBoardUrl))).filter(Boolean))].sort();
    if (sequence !== boardMenuSequence) return;
    // Match the confirmed board documents, including links with a query string.
    // The browser filters the open page even while a tab update is in flight.
    const patterns = urls.flatMap(url => [url, `${url}?*`, url.slice(0, -1), `${url.slice(0, -1)}?*`]);
    if (patterns.join("\n") === boardMenuPatterns.join("\n")) return;
    boardMenuPatterns = patterns;
    menuQueue = menuQueue.catch(() => {}).then(async () => {
      if (!lastMenuSignature) return;
      await updateMenu(EXPORT_BOARD_MENU, boardMenuVisibility());
      await api.contextMenus.refresh?.();
    });
    await menuQueue;
  }
  function savedInMenu(boardId, snapshot = state) {
    return Boolean(menuContext && menuMembership?.context === menuContext && menuMembership.session === snapshot.session && menuMembership.revision === snapshot.revision && menuMembership.ids.has(boardId));
  }
  function boardMenuPresentation(board, snapshot = state) {
    const saved = savedInMenu(board.id, snapshot);
    const label = `${board.groupName ? board.groupName + " / " : ""}${board.name}${board.id === snapshot.activeId ? "（現在のリスト）" : ""}`;
    const removable = Boolean(snapshot.capabilities?.removeImage);
    return { type: "checkbox", checked: saved, enabled: !saved || removable, title: `${label.slice(0, 130)}${saved ? removable ? "（保存済み・クリックで解除）" : "（保存済み）" : ""}` };
  }
  function updateSavedMenus() {
    menuQueue = menuQueue.catch(() => {}).then(async () => {
      const snapshot = state;
      for (const board of snapshot.boards) {
        const id = `board|${snapshot.session}|${encodeURIComponent(board.id)}`, presentation = boardMenuPresentation(board, snapshot);
        const signature = JSON.stringify(presentation);
        if (menuPresentations.get(id) === signature) continue;
        try { await updateMenu(id, presentation); menuPresentations.set(id, signature); } catch { /* A list may have been removed. */ }
      }
      await api.contextMenus.refresh?.();
    });
    return menuQueue;
  }
  async function readMembership(image) {
    if (!state.ready || !state.capabilities?.savedStatus) return null;
    const lookup = { imageUrl: /^https?:/i.test(image?.imageUrl || "") ? image.imageUrl : "", sourceUrl: /^https?:/i.test(image?.sourceUrl || "") ? image.sourceUrl : "" };
    if (!lookup.imageUrl && !lookup.sourceUrl) return null;
    let offset = 0, first = null;
    const ids = new Set();
    do {
      const response = await nativeRequest("list", { lookup, offset }, false);
      const page = response.state;
      if (!page?.ready || !page.capabilities?.savedStatus || !Array.isArray(page.boards)) return null;
      if (!first) first = page;
      if (page.session !== first.session || page.revision !== first.revision) return null;
      for (const board of page.boards) if (board.containsImage === true) ids.add(board.id);
      if (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > 10000)) return null;
      offset = page.nextOffset;
    } while (offset !== null);
    return { session: first.session, revision: first.revision, ids };
  }
  async function synchronizeMembership(image) {
    const mutationVersion = imageMutations.get(image.id) || 0;
    const matches = await readMembership(image).catch(() => null);
    if (!matches || matches.session !== state.session || matches.revision !== state.revision) return null;
    const updated = await updatePendingImage(image.id, current => {
      // A lookup started before a save/remove must not overwrite its outcome,
      // and a late lookup must never recreate a closed picker.
      if ((imageMutations.get(image.id) || 0) !== mutationVersion || matches.session !== state.session || matches.revision !== state.revision || [...imageSends.keys()].some(key => key.startsWith(`${image.id}:`))) return;
      return { ...current, saved: [...matches.ids].map(id => JSON.stringify([matches.session, id])) };
    }).catch(() => null);
    if (updated && (imageMutations.get(image.id) || 0) === mutationVersion && ![...imageSends.keys()].some(key => key.startsWith(`${image.id}:`))) {
      for (const [key, result] of imageResults) if (key.startsWith(`${image.id}:`) && key !== `${image.id}:create` && result.status !== "unknown") imageResults.delete(key);
    }
    return updated ? matches : null;
  }
  function refreshMenuMembership() {
    const context = menuContext;
    if (membershipPending?.context === context && membershipPending.session === state.session && membershipPending.revision === state.revision) return membershipPending.promise;
    const sequence = ++contextSequence;
    const operation = { context, session: state.session, revision: state.revision };
    operation.promise = (async () => {
      if (!context || menuMembership?.context !== context || menuMembership.session !== state.session || menuMembership.revision !== state.revision) {
        menuMembership = null; await updateSavedMenus();
      }
      if (!context) return;
      try {
        const result = await readMembership(context);
        if (sequence !== contextSequence || context !== menuContext || !result || result.session !== state.session || result.revision !== state.revision) return;
        menuMembership = { ...result, context };
        await updateSavedMenus();
      } catch { /* Unknown status must never be displayed as saved. */ }
    })().finally(() => { if (membershipPending === operation) membershipPending = null; });
    membershipPending = operation;
    return operation.promise;
  }
  async function selectMenuImage(message, sender) {
    if (!Number.isInteger(sender.tab?.id) || !/^https?:/i.test(sender.url || "")) return { ok: false };
    const imageUrl = typeof message.imageUrl === "string" && message.imageUrl.length <= 16384 && /^https?:/i.test(message.imageUrl) ? message.imageUrl : "";
    const sourceUrl = typeof message.sourceUrl === "string" && message.sourceUrl.length <= 16384 && /^https?:/i.test(message.sourceUrl) ? message.sourceUrl : "";
    if (imageUrl && menuContext?.imageUrl === imageUrl && menuContext.sourceUrl === sourceUrl && menuContext.tabId === sender.tab.id && menuContext.frameId === sender.frameId && menuContext.documentId === sender.documentId) {
      if (menuMembership?.context === menuContext && menuMembership.session === state.session && menuMembership.revision === state.revision) return { ok: true };
    } else menuContext = imageUrl ? { imageUrl, sourceUrl, tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId } : null;
    await refreshMenuMembership();
    return { ok: true };
  }
  function rebuildMenus() {
    const snapshot = state;
    const signature = JSON.stringify([snapshot.ready, snapshot.session, snapshot.activeId, snapshot.capabilities, snapshot.boards]);
    menuQueue = menuQueue.catch(() => {}).then(async () => {
      if (signature === lastMenuSignature) return;
      await api.contextMenus.removeAll();
      menuPresentations.clear();
      await createMenu({ id: ROOT_MENU, title: "ImageStorageに保存…", contexts: ["image", "link"] });
      if (snapshot.ready) {
        for (let offset = 0; offset < snapshot.boards.length; offset += MENU_LIMIT) {
          let parentId = ROOT_MENU;
          if (offset) {
            parentId = `page|${snapshot.session}|${offset}`;
            await createMenu({ id: parentId, parentId: ROOT_MENU, title: `リスト ${offset + 1}〜${Math.min(offset + MENU_LIMIT, snapshot.boards.length)}`, contexts: ["image", "link"] });
          }
          for (const board of snapshot.boards.slice(offset, offset + MENU_LIMIT)) {
            const id = `board|${snapshot.session}|${encodeURIComponent(board.id)}`, presentation = boardMenuPresentation(board, snapshot);
            await createMenu({ id, parentId, ...presentation, contexts: ["image", "link"] });
            menuPresentations.set(id, JSON.stringify(presentation));
          }
        }
        if (!snapshot.boards.length) await createMenu({ id: "imagestorage-empty", parentId: ROOT_MENU, title: "保存先リストがありません", enabled: false, contexts: ["image", "link"] });
      } else {
        await createMenu({ id: CONNECT_MENU, parentId: ROOT_MENU, title: "ImageStorageを起動・接続…", contexts: ["image", "link"] });
      }
      await createMenu({ id: "imagestorage-separator", parentId: ROOT_MENU, type: "separator", contexts: ["image", "link"] });
      await createMenu({ id: BATCH_MENU, parentId: ROOT_MENU, title: "このページの画像をまとめて保存…", contexts: ["image", "link"] });
      await createMenu({ id: EXPORT_BOARD_MENU, parentId: ROOT_MENU, title: "Pinterestボードを書き出す…", contexts: ["image", "link"], ...boardMenuVisibility() });
      await createMenu({ id: CREATE_MENU, parentId: ROOT_MENU, title: "新規リストを作成…", contexts: ["image", "link"] });
      lastMenuSignature = signature;
    });
    return menuQueue;
  }
  async function rememberImage(info, tab) {
    let imageUrl = info.srcUrl;
    if (!imageUrl && /^https?:/i.test(info.linkUrl || "") && Number.isInteger(tab?.id)) {
      try {
        const results = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [info.frameId || 0] }, func: resolveLinkedImage, args: [info.linkUrl] });
        imageUrl = results[0]?.result?.imageUrl;
      } catch { throw fail("invalid_image", "このページの画像を取得できません。ページを再読み込みして、画像のある部分を右クリックしてください。"); }
    }
    if (typeof imageUrl !== "string" || !/^(?:https?:|data:image\/|blob:)/i.test(imageUrl)) throw fail("invalid_image", "このリンクの画像を見つけられませんでした。画像のある部分を右クリックしてください。");
    const sourceUrl = /^https?:/i.test(info.linkUrl || "") ? info.linkUrl : /^https?:/i.test(info.pageUrl || "") ? info.pageUrl : /^https?:/i.test(imageUrl) ? imageUrl : "";
    const item = { id: uuid(), imageUrl, sourceUrl, tabId: tab?.id, frameId: info.frameId || 0, created: Date.now(), error: "", pickerToken: uuid(), pickerDocumentId: "", saved: [], uncertain: [] };
    return item;
  }
  async function getImage(id) {
    if (typeof id !== "string" || !/^[a-z0-9-]{36}$/i.test(id)) return null;
    const key = `pending:${id}`, values = await storage.get(key), image = values[key];
    if (!image || Date.now() - image.created > 30 * 60 * 1000) { await storage.remove(key); return null; }
    return image;
  }
  function updatePendingImage(id, update) {
    // Serialize read/modify/write per picker. Chrome storage has no atomic
    // merge, and saves to different lists can finish in the same turn.
    const work = (imageWrites.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await getImage(id);
      if (!current) return null;
      const next = update(current);
      if (next === undefined) return null;
      if (next === null) await storage.remove(`pending:${id}`);
      else await storage.set({ [`pending:${id}`]: next });
      return next;
    });
    imageWrites.set(id, work);
    const cleanup = () => { if (imageWrites.get(id) === work) imageWrites.delete(id); };
    void work.then(cleanup, cleanup);
    return work;
  }
  async function beginImageMutation(id) {
    imageMutations.set(id, (imageMutations.get(id) || 0) + 1);
    const current = await getImage(id);
    if (!current) throw fail("expired", "画像を右クリックして保存先を開き直してください。");
  }
  async function openChooser(image) {
    try {
      const saved = await storage.get(null);
      const stale = Object.entries(saved).filter(([key, item]) => key.startsWith("pending:") && Date.now() - item.created > 30 * 60 * 1000).map(([key]) => key);
      if (stale.length) await storage.remove(stale);
      for (const key of stale) imageMutations.delete(key.slice("pending:".length));
      for (const [key, result] of imageResults) if (Date.now() - result.created > 30 * 60 * 1000) imageResults.delete(key);
      await storage.set({ [`pending:${image.id}`]: image });
      await storage.set({ toolbarRequest: image.id });
    } catch { throw fail("storage", "画像の送信情報を保持できませんでした。拡張機能を再読み込みしてください。"); }
    try {
      if (!Number.isInteger(image.tabId)) throw new Error("No source tab");
      const result = await api.scripting.executeScript({
        target: { tabId: image.tabId, frameIds: [0] },
        func: showInlinePicker,
        args: [{ id: image.id, token: image.pickerToken, imageUrl: image.imageUrl, sourceUrl: image.sourceUrl, error: image.error, mode: image.mode }],
      });
      if (result[0]?.result?.shown !== true) throw new Error("Picker unavailable");
    } catch {
      // Restricted browser pages cannot host content scripts. Keep selection in
      // the existing toolbar popup instead of opening another OS window.
      await storage.set({ toolbarRequest: image.id });
      updateBadge("!", "拡張機能のボタンを押して保存先を選んでください");
      try { await api.action.openPopup(); } catch { /* The toolbar button can open it manually. */ }
    }
  }
  async function readInBrowser(image) {
    if (!Number.isInteger(image.tabId)) throw fail("browser_only", "元のタブを開いたまま、画像を右クリックして送信し直してください。");
    const results = await api.scripting.executeScript({
      target: { tabId: image.tabId, frameIds: [image.frameId] },
      func: async (source, maximum) => {
        const url = new URL(source, location.href);
        if (!["https:", "http:", "data:", "blob:"].includes(url.protocol)) throw new Error("Unsupported image URL");
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
        try {
          const response = await fetch(url.href, { credentials: "include", signal: controller.signal });
          if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")) throw new Error("画像を読み込めませんでした。");
          const reader = response.body.getReader(), chunks = []; let size = 0;
          for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > maximum) { controller.abort(); throw new Error("ブラウザー経由の画像は8MB以下にしてください。"); } chunks.push(part.value); }
          const blob = new Blob(chunks, { type: response.headers.get("content-type").split(";")[0] });
          return await new Promise((resolve, reject) => { const file = new FileReader(); file.onload = () => resolve(file.result); file.onerror = () => reject(new Error("画像を読み込めませんでした。")); file.readAsDataURL(blob); });
        } finally { clearTimeout(timer); }
      },
      args: [image.imageUrl, 8 * 1024 * 1024],
    });
    const data = results[0]?.result;
    if (typeof data !== "string" || !data.startsWith("data:image/")) throw fail("browser_only", "ブラウザー内の画像を取得できませんでした。画像ファイルを保存して追加してください。");
    return data;
  }
  async function sendImage(image, boardId, session, newBoardName) {
    let imageUrl = image.imageUrl;
    if (/^blob:/i.test(imageUrl)) imageUrl = await readInBrowser(image);
    const send = (source) => nativeRequest("import", { imageUrl: source, sourceUrl: image.sourceUrl, ...(/^https?:/i.test(image.imageUrl) ? { originalImageUrl: image.imageUrl } : {}), ...(newBoardName === undefined ? { boardId } : { newBoardName }), session, importId: uuid() }, false);
    let response;
    try { response = await send(imageUrl); }
    catch (error) {
      if (error.code !== "download_failed" || !/^https?:/i.test(image.imageUrl)) throw error;
      response = await send(await readInBrowser(image));
    }
    const board = state.boards.find((entry) => entry.id === boardId);
    updateBadge("✓", `${newBoardName || board?.name || "保存先リスト"}${response?.result?.alreadySaved ? "には保存済みです" : "に画像を追加しました"}`);
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => updateBadge(""), 5000);
    scheduleRefresh();
    return { ok: true, boardId: response?.result?.boardId || boardId, ...(response?.result?.alreadySaved ? { alreadySaved: true } : {}) };
  }
  async function removeImage(image, boardId, session) {
    if (!state.capabilities?.removeImage) throw fail("update_required", "保存の解除にはImageStorage 0.15.47以降が必要です。旧版を終了し、新版を起動してください。");
    // Explicit desired state, never a server-side toggle: retrying a removal
    // must not re-add an image. No image download is needed to remove it.
    const response = await nativeRequest("import", { operation: "remove", imageUrl: image.imageUrl, sourceUrl: image.sourceUrl, boardId, session, importId: uuid() }, false);
    updateBadge("✓", `${state.boards.find(board => board.id === boardId)?.name || "保存先リスト"}から画像を外しました`);
    clearTimeout(badgeTimer); badgeTimer = setTimeout(() => updateBadge(""), 5000);
    scheduleRefresh();
    return { ok: true, boardId: response.result?.boardId || boardId, removed: true };
  }
  async function createStoredList(image, name, session) {
    if (image.mode !== "create") throw fail("invalid_request", "新規リストを作成…からやり直してください。");
    const key = `${image.id}:create`;
    const known = imageResults.get(key);
    if (known?.status === "saved") return known.result;
    if (known?.status === "unknown" || image.creationUncertain) throw fail("unknown_result", "作成結果を確認できません。ImageStorageのリストを確認してください。");
    if (image.createdBoard) return { ok: true, ...image.createdBoard };
    if (imageSends.has(key)) return imageSends.get(key);
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw fail("invalid_name", "リスト名は1〜120文字で入力してください。");
    if (state.ready && session && session !== state.session) throw fail("stale_list", "プロジェクトが変更されました。新規作成を開き直してください。");
    const work = (async () => {
      try {
        await beginImageMutation(image.id);
        // Opening the form only reads connection state. This explicit submit is
        // the first action allowed to start the app (in background mode).
        if (!state.ready) await refreshState(true);
        if (!state.ready) throw fail("not_running", "ImageStorageに接続できません。最新版の本体で連携を設定してください。");
        if (!state.capabilities?.createBoard) throw fail("update_required", "旧版のImageStorageに接続されています。旧版を終了し、0.15.45以降を一度起動してください。");
        const result = { ...await sendImage(image, undefined, state.session, name.trim()), name: name.trim() };
        imageResults.set(key, { status: "saved", created: Date.now(), result });
        try { await updatePendingImage(image.id, current => ({ ...current, createdBoard: { boardId: result.boardId, name: result.name } })); } catch { /* Confirmed creation remains in memory. */ }
        scheduleRefresh();
        return result;
      } catch (error) {
        if (error.code === "unknown_result") {
          imageResults.set(key, { status: "unknown", created: Date.now() });
          try { await updatePendingImage(image.id, current => ({ ...current, creationUncertain: true })); } catch { /* Retain the uncertainty in memory. */ }
        }
        throw error;
      }
    })();
    imageSends.set(key, work);
    try { return await work; } finally { imageSends.delete(key); }
  }
  async function sendStoredImage(image, boardId, session, removing = false) {
    if (typeof boardId !== "string" || typeof session !== "string") throw fail("invalid_destination", "保存先を選び直してください。");
    const destination = JSON.stringify([session, boardId]);
    const key = `${image.id}:${destination}`;
    const known = imageResults.get(key)?.status;
    if (image.uncertain?.includes(destination)) throw fail("unknown_result", "送信結果を確認できません。重複を避けるため、ImageStorageの保存先を確認してください。");
    if (!removing && known === "saved") return { ok: true, alreadySaved: true };
    if (removing && known === "removed") return { ok: true, removed: true };
    if (known === "unknown") throw fail("unknown_result", "ImageStorageの保存先で送信結果を確認してください。");
    if (!removing && image.saved?.includes(destination)) return { ok: true, alreadySaved: true };
    if (imageSends.has(key)) return imageSends.get(key);
    const work = (async () => {
      try {
        await beginImageMutation(image.id);
        const result = removing ? await removeImage(image, boardId, session) : await sendImage(image, boardId, session);
        imageResults.set(key, { status: removing ? "removed" : "saved", created: Date.now() });
        try { await updatePendingImage(image.id, current => ({ ...current, saved: removing ? (current.saved || []).filter(key => key !== destination) : [...new Set([...(current.saved || []), destination])] })); } catch { /* Import succeeded; retain the confirmation in memory. */ }
        return result;
      } catch (error) {
        if (error.code === "unknown_result") {
          imageResults.set(key, { status: "unknown", created: Date.now() });
          try { await updatePendingImage(image.id, current => ({ ...current, uncertain: [...new Set([...(current.uncertain || []), destination])] })); } catch { /* Keep the original unknown-result error. */ }
        }
        throw error;
      }
    })();
    imageSends.set(key, work);
    try { return await work; } finally { imageSends.delete(key); }
  }
  async function clicked(info, tab) {
    // The root is a native submenu. Only a destination or explicit creation
    // item performs an action; simply opening the submenu must not inject UI.
    if (info.menuItemId === CONNECT_MENU) {
      try { await refreshState(true); updateBadge("", "接続しました。画像をもう一度右クリックして保存先を選んでください。"); }
      catch (error) { updateBadge("!", error.message); }
      return;
    }
    if (info.menuItemId === EXPORT_BOARD_MENU) {
      try { await openBoardExporter(tab, info.pageUrl || tab?.url); }
      catch (error) { updateBadge("!", error.message); }
      return;
    }
    if (info.menuItemId === BATCH_MENU) {
      try { await openBatch(tab, info.frameId || 0, info.pageUrl || tab?.url); }
      catch (error) { updateBadge("!", error.message); }
      return;
    }
    if (![PICK_MENU, CREATE_MENU].includes(info.menuItemId) && !String(info.menuItemId).startsWith("board|")) return;
    let image, destination;
    const nativeDestination = String(info.menuItemId).startsWith("board|");
    // Native checkbox items toggle themselves before onClicked runs.
    if (nativeDestination) menuPresentations.delete(info.menuItemId);
    try {
      image = await rememberImage(info, tab);
      if (info.menuItemId === CREATE_MENU) { image.mode = "create"; await openChooser(image); return; }
      if (info.menuItemId === PICK_MENU) { await openChooser(image); return; }
      const [, session, encoded] = String(info.menuItemId).split("|");
      destination = JSON.stringify([session, decodeURIComponent(encoded)]);
      if (info.wasChecked === true) await removeImage(image, decodeURIComponent(encoded), session);
      else await sendImage(image, decodeURIComponent(encoded), session);
    } catch (error) {
      updateBadge("!", error.message);
      if (image && destination && error.code === "unknown_result") image.uncertain = [destination];
      if (image) { image.error = error.message; try { await openChooser(image); } catch { /* Error remains visible on the extension button. */ } }
    } finally {
      if (nativeDestination) {
        try { await refreshState(false); await refreshMenuMembership(); await updateSavedMenus(); } catch { /* A later reconnect refreshes the menu. */ }
      }
    }
  }
  async function pageMessage(message) {
    if (message?.action === "board:open" || message?.action === "board:available") {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      if (message.action === "board:available") return { ok: true, available: Boolean(await tabBoardUrl(tab)) };
      return openBoardExporter(tab);
    }
    if (message?.action === "batch:open") {
      const tabs = await api.tabs.query({ active: true, currentWindow: true });
      return openBatch(tabs[0], 0, tabs[0]?.url);
    }
    if (message?.action === "status") {
      try { await refreshState(message.launch === true); } catch { /* Show connection instructions. */ }
      const image = await getImage(message.id);
      const matches = image ? await synchronizeMembership(image) : null;
      return { ok: true, state: matches && matches.session === state.session && matches.revision === state.revision ? { ...state, boards: state.boards.map(board => ({ ...board, containsImage: matches.ids.has(board.id) })) } : state };
    }
    if (message?.action === "pending") {
      const id = message.id || (await storage.get("toolbarRequest")).toolbarRequest;
      return { ok: true, image: await getImage(id) };
    }
    if (message?.action === "cancel") { await updatePendingImage(message.id, () => null); return { ok: true }; }
    if (["send", "remove"].includes(message?.action)) {
      const image = await getImage(message.id);
      if (!image) throw fail("expired", "画像の送信情報が期限切れです。もう一度右クリックしてください。");
      return sendStoredImage(image, message.boardId, message.session, message.action === "remove");
    }
    if (message?.action === "create") {
      const image = await getImage(message.id);
      if (!image) throw fail("expired", "画像を右クリックして新規作成を開き直してください。");
      return createStoredList(image, message.name, message.session);
    }
    throw fail("unknown_action", "Unknown extension action");
  }
  async function inlineMessage(message, sender) {
    const image = await getImage(message.id);
    if (!image || image.pickerToken !== message.token || !Number.isInteger(image.tabId) || sender.tab?.id !== image.tabId || sender.frameId !== 0) throw fail("expired", "画像を右クリックして保存先を開き直してください。");
    if (image.pickerDocumentId && sender.documentId !== image.pickerDocumentId) throw fail("expired", "ページが変わりました。画像を右クリックし直してください。");
    if (!image.pickerDocumentId && sender.documentId) {
      const bound = await updatePendingImage(image.id, current => {
        if (current.pickerDocumentId && current.pickerDocumentId !== sender.documentId) throw fail("expired", "ページが変わりました。画像を右クリックし直してください。");
        return { ...current, pickerDocumentId: sender.documentId };
      });
      if (!bound) throw fail("expired", "画像を右クリックして保存先を開き直してください。");
    }
    if (message.action === "inline:status") {
      try { await refreshState(message.launch === true); } catch { /* Display the connection state within the page. */ }
      await synchronizeMembership(image);
      const current = await getImage(image.id);
      if (!current) throw fail("expired", "画像を右クリックして保存先を開き直してください。");
      const saved = new Set(current?.saved || []), uncertain = new Set(current?.uncertain || []);
      for (const [key, result] of imageResults) {
        if (!key.startsWith(`${image.id}:`) || key === `${image.id}:create`) continue;
        const destination = key.slice(image.id.length + 1);
        if (result.status === "removed") saved.delete(destination);
        else if (result.status === "saved") saved.add(destination);
        else if (result.status === "unknown") uncertain.add(destination);
      }
      const creation = imageResults.get(`${image.id}:create`);
      return { ok: true, state, saved: [...saved], uncertain: [...uncertain], createdBoard: creation?.status === "saved" ? creation.result : current?.createdBoard, creationUncertain: creation?.status === "unknown" || current?.creationUncertain };
    }
    if (message.action === "inline:send") return sendStoredImage(image, message.boardId, message.session);
    if (message.action === "inline:remove") return sendStoredImage(image, message.boardId, message.session, true);
    if (message.action === "inline:create") return createStoredList(image, message.name, message.session);
    if (message.action === "inline:cancel") { await updatePendingImage(image.id, () => null); return { ok: true }; }
    throw fail("unknown_action", "Unknown picker action");
  }
  async function scanBatch(record) {
    let result;
    try { result = await api.scripting.executeScript({ target: { tabId: record.tabId, frameIds: [record.frameId] }, func: collectPageImages }); }
    catch { throw fail("unsupported_page", "このページの画像を取得できません。通常のWebページで開き直してください。"); }
    await batches.merge(record.id, result[0]?.result);
  }
  async function openBoardExporter(tab, requestedUrl) {
    const boardUrl = await tabBoardUrl(tab);
    if (!boardUrl || (requestedUrl && getPinterestBoardUrl(requestedUrl) !== boardUrl)) throw fail("unsupported_page", "Pinterestで書き出したいボードを開いてください。");
    let result;
    try { result = await api.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, func: showPinterestBoardExporter, args: [{ boardUrl }] }); }
    catch { throw fail("unsupported_page", "このページでは書き出し画面を開けません。Pinterestのボードを開き直してください。"); }
    if (result[0]?.result?.shown !== true) throw fail("unsupported_page", result[0]?.result?.error || "Pinterestのボードを開いてください。");
    return { ok: true };
  }
  async function openBatch(tab, frameId, url) {
    const record = await batches.create(tab?.id, frameId, url);
    await scanBatch(record);
    try { await refreshState(false); } catch { /* Offer explicit connection in the panel. */ }
    try {
      const result = await api.scripting.executeScript({ target: { tabId: record.tabId, frameIds: [0] }, func: showBatchPicker, args: [{ id: record.id, token: record.token }] });
      if (result[0]?.result?.shown !== true) throw new Error("Picker unavailable");
    } catch { throw fail("unsupported_page", "このページでは一括保存を表示できません。通常のWebページで開いてください。"); }
    return { ok: true, id: record.id };
  }
  async function batchMessage(message, sender) {
    const record = await batches.authorize(message, sender);
    if (message.action === "batch:scan") await scanBatch(record);
    else if (message.action === "batch:connect") await refreshState(true);
    else if (message.action === "batch:start") return batches.start(record.id, message.selected, message.boardId, message.session);
    else if (message.action === "batch:stop") await batches.stop(record.id);
    else if (message.action !== "batch:status") throw fail("unknown_action", "Unknown batch action");
    return { ok: true, batch: await batches.status(record.id), state };
  }
  function start() {
    api.contextMenus.onClicked.addListener((info, tab) => { void clicked(info, tab); });
    api.contextMenus.onShown?.addListener(() => {
      void refreshBoardMenu().catch(() => {});
      void refreshState(false).then(refreshMenuMembership).then(() => api.contextMenus.refresh?.()).catch(() => {});
    });
    api.runtime.onMessage.addListener((message, sender, respond) => {
      if (sender.id !== api.runtime.id) return false;
      if (message?.action === "context:image") { void selectMenuImage(message, sender).then(respond, () => respond({ ok: false })); return true; }
      if (message?.action === "context:board-changed" && sender.frameId === 0 && sender.tab?.active) {
        void refreshBoardMenu().catch(() => {});
        return false;
      }
      const inline = typeof message?.action === "string" && message.action.startsWith("inline:");
      const batch = typeof message?.action === "string" && message.action.startsWith("batch:") && message.action !== "batch:open";
      if (!inline && !batch && (typeof sender.url !== "string" || !sender.url.startsWith(api.runtime.getURL("")))) return false;
      void (inline ? inlineMessage(message, sender) : batch ? batchMessage(message, sender) : pageMessage(message)).then(respond, (error) => respond({ ok: false, error: error.message, code: error.code || "failed" }));
      return true;
    });
    api.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "imagestorage-refresh") void refreshState(false).then(refreshMenuMembership).catch(() => {}); });
    api.tabs?.onActivated?.addListener(() => { menuContext = null; void refreshMenuMembership(); void refreshBoardMenu().catch(() => {}); });
    api.tabs?.onRemoved?.addListener(tabId => { void batches.stopForTab(tabId).catch(() => {}); void refreshBoardMenu().catch(() => {}); });
    api.tabs?.onUpdated?.addListener((tabId, change, tab) => {
      if (change.url || change.status === "loading") void batches.stopForTab(tabId).catch(() => {});
      if (tab?.active && (change.url || change.status === "complete")) void refreshBoardMenu().catch(() => {});
    });
    api.runtime.onInstalled?.addListener(() => { void refreshState(false).catch(() => {}); });
    api.runtime.onStartup?.addListener(() => { void refreshState(false).catch(() => {}); });
    void api.alarms.create("imagestorage-refresh", { periodInMinutes: 0.5 });
    void rebuildMenus().then(() => refreshState(false)).then(refreshMenuMembership).catch(() => {});
    void refreshBoardMenu().catch(() => {});
  }
  function stop() {
    clearTimeout(refreshTimer); clearTimeout(badgeTimer);
    const connection = port; port = null;
    connection?.disconnect();
    for (const id of pending.keys()) settle(id, fail("closed", "連携を終了しました。"));
  }
  return { start, stop, refreshState, clicked, pageMessage, rebuildMenus, snapshot: () => state };
}

const browserApi = globalThis.browser?.runtime?.getBrowserInfo ? globalThis.browser : globalThis.chrome || globalThis.browser;
if (browserApi?.runtime?.id) createConnector(browserApi).start();
