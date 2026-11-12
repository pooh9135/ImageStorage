export function batchImageKey(value) {
  try {
    const parsed = new URL(value);
    const hash = parsed.hostname === "i.pinimg.com" && parsed.pathname.match(/\/([a-f0-9]{32})\.(?:jpe?g|png|webp|gif|avif)$/i)?.[1];
    parsed.hash = "";
    return hash ? `pinimg:${hash.toLowerCase()}` : parsed.href;
  } catch { return ""; }
}

export function createBatchJobs({ storage, refreshState, snapshot, sendImage, uuid = () => crypto.randomUUID() }) {
  const writes = new Map(), runners = new Map(), starting = new Set();
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const key = id => `batch:${id}`;
  const validId = id => typeof id === "string" && /^[a-z0-9-]{36}$/i.test(id);
  const validUrl = (value, image = false) => {
    if (typeof value !== "string" || value.length > 16384) return false;
    try { const parsed = new URL(value); return !parsed.username && !parsed.password && (["http:", "https:"].includes(parsed.protocol) || (image && (parsed.protocol === "blob:" || /^data:image\//i.test(value)))); } catch { return false; }
  };
  async function read(id) {
    if (!validId(id)) return null;
    const record = (await storage.get(key(id)))[key(id)];
    return record && (runners.has(id) || Date.now() - record.updated < 30 * 60 * 1000) ? record : null;
  }
  function edit(id, update) {
    const work = (writes.get(id) || Promise.resolve()).catch(() => {}).then(async () => {
      const record = await read(id);
      if (!record) throw fail("expired", "一括保存を開き直してください。");
      const next = update(record);
      next.updated = Date.now();
      await storage.set({ [key(id)]: next });
      return next;
    });
    writes.set(id, work);
    const cleanup = () => { if (writes.get(id) === work) writes.delete(id); };
    void work.then(cleanup, cleanup);
    return work;
  }
  async function create(tabId, frameId, sourceUrl) {
    if (!Number.isInteger(tabId) || !validUrl(sourceUrl)) throw fail("unsupported_page", "通常のWebページで開いてください。");
    const stored = await storage.get(null);
    const expired = Object.entries(stored).filter(([name, record]) => name.startsWith("batch:") && !runners.has(record.id) && Date.now() - record.updated >= 30 * 60 * 1000).map(([name]) => name);
    if (expired.length) await storage.remove(expired);
    const record = { id: uuid(), token: uuid(), tabId, frameId, sourceUrl, documentId: "", updated: Date.now(), images: [], running: false, stopRequested: false, cancelVersion: 0, boardId: "", session: "", limited: false };
    await storage.set({ [key(record.id)]: record });
    return record;
  }
  async function authorize(message, sender) {
    if (sender.frameId !== 0 || !validUrl(sender.url)) throw fail("expired", "元のページで一括保存を開いてください。");
    return edit(message.id, record => {
      if (record.token !== message.token || record.tabId !== sender.tab?.id || (record.documentId && record.documentId !== sender.documentId)) throw fail("expired", "ページが変わりました。一括保存を開き直してください。");
      return { ...record, documentId: record.documentId || sender.documentId || "" };
    });
  }
  async function merge(id, collection) {
    if (!Array.isArray(collection?.images)) throw fail("invalid_images", "画像を読み取れませんでした。");
    return edit(id, record => {
      if (record.running) throw fail("busy", "保存が終わってから画像を更新してください。");
      const images = [...record.images], seen = new Set(images.map(image => batchImageKey(image.imageUrl)));
      let limited = Boolean(collection.limited);
      for (const candidate of collection.images.slice(0, 201)) {
        if (!validUrl(candidate.imageUrl, true) || !validUrl(candidate.sourceUrl)) continue;
        const identity = batchImageKey(candidate.imageUrl);
        if (seen.has(identity)) continue;
        if (images.length >= 200) { limited = true; break; }
        seen.add(identity);
        images.push({ id: uuid(), imageUrl: candidate.imageUrl, sourceUrl: candidate.sourceUrl, width: Number.isFinite(candidate.width) ? Math.max(0, candidate.width) : 0, height: Number.isFinite(candidate.height) ? Math.max(0, candidate.height) : 0, alt: typeof candidate.alt === "string" ? candidate.alt.slice(0, 180) : "", status: "idle", error: "" });
      }
      return { ...record, images, limited };
    });
  }
  async function status(id) {
    let record = await read(id);
    if (!record) throw fail("expired", "一括保存を開き直してください。");
    if (record.running && !runners.has(id) && !starting.has(id)) record = await edit(id, current => ({ ...current, running: false, stopRequested: true, images: current.images.map(image => image.status === "sending" ? { ...image, status: "unknown", error: "処理が中断されました。本体で保存結果を確認してください。" } : image.status === "queued" ? { ...image, status: "cancelled" } : image) }));
    const publicRecord = { ...record }; delete publicRecord.token; delete publicRecord.documentId;
    return publicRecord;
  }
  async function stop(id) {
    await edit(id, record => ({ ...record, stopRequested: true, cancelVersion: (record.cancelVersion || 0) + 1 }));
  }
  async function run(id) {
    try {
      for (;;) {
        const record = await read(id);
        if (!record?.running) return;
        const image = record.images.find(image => image.status === "queued");
        if (record.stopRequested || !image) break;
        const sending = await edit(id, current => current.stopRequested ? current : ({ ...current, images: current.images.map(entry => entry.id === image.id ? { ...entry, status: "sending" } : entry) }));
        if (sending.stopRequested) break;
        let status = "saved", error = "", terminal = false;
        try {
          const result = await sendImage({ ...image, tabId: record.tabId, frameId: record.frameId }, record.boardId, record.session);
          if (result.alreadySaved) status = "existing";
        } catch (failure) {
          status = failure.code === "unknown_result" ? "unknown" : "failed";
          error = failure.message || "保存できませんでした。";
          terminal = ["unknown_result", "stale_list", "not_running", "not_installed", "app_closed", "closed"].includes(failure.code);
        }
        await edit(id, current => ({ ...current, stopRequested: current.stopRequested || terminal, images: current.images.map(entry => entry.id === image.id ? { ...entry, status, error } : entry) }));
      }
    } finally {
      await edit(id, record => ({ ...record, running: false, images: record.images.map(image => image.status === "sending" ? { ...image, status: "unknown", error: "保存結果を本体で確認してください。" } : image.status === "queued" ? { ...image, status: "cancelled" } : image) }));
    }
  }
  async function start(id, selected, boardId, session) {
    if (!Array.isArray(selected) || selected.length < 1 || selected.length > 200 || new Set(selected).size !== selected.length) throw fail("invalid_selection", "保存する画像を選んでください（最大200枚）。");
    if (starting.has(id) || runners.has(id)) throw fail("busy", "一括保存中です。");
    starting.add(id);
    try {
    const initial = await read(id);
    if (!initial || selected.some(id => !initial.images.some(image => image.id === id && ["idle", "failed", "cancelled"].includes(image.status)))) throw fail("invalid_selection", "未保存の画像を選び直してください。");
    // Only an explicit Save can launch the app; discovery and polling never do.
    await refreshState(true);
    const state = snapshot();
    if (!state.ready || (session && session !== state.session) || !state.boards.some(board => board.id === boardId)) throw fail("stale_list", "保存先リストを選び直してください。");
    await edit(id, record => {
      if (record.running || runners.has(id)) throw fail("busy", "一括保存中です。");
      if (record.cancelVersion !== initial.cancelVersion) throw fail("cancelled", "保存を停止しました。");
      if (record.boardId && (record.boardId !== boardId || record.session !== state.session)) throw fail("stale_list", "別の保存先に送る場合は、一括保存を開き直してください。");
      if (selected.some(id => !record.images.some(image => image.id === id && ["idle", "failed", "cancelled"].includes(image.status)))) throw fail("invalid_selection", "未保存の画像を選び直してください。結果不明の画像は本体で確認してください。");
      return { ...record, running: true, stopRequested: false, boardId, session: state.session, images: record.images.map(image => selected.includes(image.id) ? { ...image, status: "queued", error: "" } : image) };
    });
    const work = run(id);
    runners.set(id, work);
    void work.catch(() => {}).finally(() => { if (runners.get(id) === work) runners.delete(id); });
    return { ok: true };
    } finally { starting.delete(id); }
  }
  async function stopForTab(tabId) {
    const records = await storage.get(null);
    await Promise.all(Object.entries(records).filter(([name, record]) => name.startsWith("batch:") && record.tabId === tabId && (record.running || starting.has(record.id))).map(([, record]) => stop(record.id).catch(() => {})));
  }
  return { create, read, authorize, merge, status, start, stop, stopForTab, idle: id => runners.get(id) || Promise.resolve() };
}
