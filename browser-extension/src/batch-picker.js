// Serialized into the top frame, like the single-image picker.
export function showBatchPicker(config) {
  const api = globalThis.browser?.runtime?.getBrowserInfo ? globalThis.browser : globalThis.chrome || globalThis.browser;
  if (!api?.runtime?.sendMessage || !document.documentElement) return { shown: false };
  globalThis.__imageStorageBatchPicker?.close();
  const previousFocus = document.activeElement, selected = new Set(), cards = new Map();
  let closed = false, busy = false, sequence = 0, record = null, state = null, imageSignature = "", notice = "";
  const host = document.createElement("div"); host.id = "imagestorage-batch-picker"; host.setAttribute("popover", "manual");
  for (const [key, value] of Object.entries({ all: "initial", position: "fixed", inset: "auto", left: `${Math.max(8, (innerWidth - 760) / 2)}px`, top: "24px", margin: "0", padding: "0", border: "0", background: "transparent", "z-index": "2147483647", "color-scheme": "dark", direction: "ltr" })) host.style.setProperty(key, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { color-scheme:dark; font:12px/1.5 "Segoe UI","Yu Gothic UI",sans-serif; color:#ededed; }
    *,*::before,*::after { box-sizing:border-box; }
    .panel { width:min(760px,calc(100vw - 24px)); max-height:calc(100vh - 48px); display:flex; flex-direction:column; background:#242424; border:1px solid #414141; border-radius:4px; box-shadow:0 8px 30px #0008; overflow:hidden; color:#ededed; font:12px/1.5 "Segoe UI","Yu Gothic UI",sans-serif; text-align:left; }
    header { padding:10px 14px; display:flex; align-items:center; gap:12px; border-bottom:1px solid #ffffff14; flex-shrink:0; cursor:grab; touch-action:none; user-select:none; }
    h2 { flex:1; font-size:13px; margin:0; font-weight:600; }
    button,select,input { font:inherit; color:inherit; }
    button,select { border:1px solid #484848; border-radius:3px; background:#202020; padding:7px 10px; margin:0; }
    button { cursor:pointer; } button:hover:enabled { background:#343434; }
    button:disabled { opacity:.45; cursor:default; }
    button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid #b0b0b0; outline-offset:2px; }
    .close { border:0; background:transparent; padding:0; width:26px; height:26px; font-size:20px; color:#b5b5b5; }
    .toolbar { padding:12px 14px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; border-bottom:1px solid #ffffff0d; flex-shrink:0; }
    .toolbar label { display:flex; align-items:center; gap:8px; flex:1; min-width:180px; }
    select { flex:1; min-width:0; width:100%; max-width:360px; }
    .hint { margin:0; padding:0 14px 10px; font-size:11px; color:#a7a7a7; flex-shrink:0; }
    .selection { display:flex; gap:8px; align-items:center; padding:10px 14px; flex-shrink:0; }
    .selection span { flex:1; color:#b5b5b5; }
    .gallery { display:grid; grid-template-columns:repeat(auto-fill,minmax(125px,1fr)); gap:10px; padding:0 14px 14px; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; min-height:100px; }
    .image { display:flex; flex-direction:column; gap:5px; position:relative; min-width:0; padding:6px; border:1px solid #3b3b3b; border-radius:3px; background:#1b1b1b; cursor:pointer; }
    .image.selected { border-color:#a4a4a4; background:#323232; }
    .image.locked { cursor:default; }
    .image img { width:100%; height:110px; object-fit:contain; display:block; background:#151515; pointer-events:none; }
    .image input { position:absolute; top:10px; left:10px; margin:0; width:16px; height:16px; accent-color:#d4d4d4; }
    .image span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; }
    .image small { color:#a7a7a7; font-size:10px; }
    .image .error { color:#d6aaa3; white-space:normal; overflow-wrap:anywhere; }
    .empty { grid-column:1/-1; padding:20px 0; color:#aaa; }
    footer { display:flex; align-items:center; gap:8px; padding:12px 14px; border-top:1px solid #ffffff14; flex-shrink:0; }
    .status { flex:1; margin:0; color:#b8b8b8; font-size:11px; overflow-wrap:anywhere; }
    .save { background:#0c0c0c; min-width:130px; }
    [hidden] { display:none!important; }
    @media(max-height:420px) { .hint { display:none; } .toolbar,.selection,footer { padding:6px 12px; } }
  `;
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const panel = element("section", "panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "画像をまとめて保存");
  const header = element("header"), title = element("h2", "", "画像をまとめて保存"), closeButton = element("button", "close", "×"); closeButton.type = "button"; closeButton.setAttribute("aria-label", "閉じる");
  header.append(title, closeButton);
  const toolbar = element("div", "toolbar"), destinationLabel = element("label", "", "保存先"), destination = element("select"); destination.setAttribute("aria-label", "保存先リスト");
  const connect = element("button", "connect", "起動・再接続"), scan = element("button", "scan", "画像を更新");
  destinationLabel.append(destination); toolbar.append(destinationLabel, connect, scan);
  const hint = element("p", "hint", "このページで読み込み済みの画像から選べます。ページをスクロールして「画像を更新」で追加できます（最大200枚）。");
  const selection = element("div", "selection"), count = element("span"), all = element("button", "all", "すべて選択"), clear = element("button", "clear", "選択を解除"); selection.append(count, all, clear);
  const gallery = element("div", "gallery"); gallery.setAttribute("aria-label", "保存する画像");
  const footer = element("footer"), status = element("p", "status"), stop = element("button", "stop", "停止"), save = element("button", "save", "選んだ画像を保存"); status.setAttribute("role", "status"); stop.hidden = true;
  stop.title = "処理中の1枚が完了したら停止します。"; footer.append(status, stop, save);
  panel.append(header, toolbar, hint, selection, gallery, footer); root.append(style, panel); document.documentElement.append(host);
  try { host.showPopover(); } catch { /* Fixed positioning supports older hosts. */ }
  const ask = async (action, payload = {}) => {
    const result = await api.runtime.sendMessage({ action: `batch:${action}`, id: config.id, token: config.token, ...payload });
    if (!result?.ok) throw new Error(result?.error || "一括保存に接続できませんでした。");
    return result;
  };
  const selectable = image => ["idle", "failed", "cancelled"].includes(image.status);
  function render() {
    if (closed) return;
    const running = record?.running, disabled = busy || running;
    const boardSignature = JSON.stringify([state?.session, state?.boards, record?.boardId]);
    if (destination.dataset.signature !== boardSignature) {
      const previous = destination.value; destination.replaceChildren();
      for (const board of state?.boards || []) { const option = element("option", "", `${board.groupName ? board.groupName + " / " : ""}${board.name}`); option.value = board.id; destination.append(option); }
      const preferred = record?.boardId || previous || state?.activeId;
      if ([...destination.options].some(option => option.value === preferred)) destination.value = preferred;
      destination.dataset.signature = boardSignature;
    }
    destination.disabled = disabled || Boolean(record?.boardId);
    destination.title = record?.boardId ? "保存先を変更する場合は、一括保存を開き直してください。" : "";
    connect.hidden = Boolean(state?.ready); connect.disabled = disabled;
    scan.disabled = disabled; all.disabled = disabled; clear.disabled = disabled;
    const images = record?.images || [];
    for (const image of images) if (["saved", "existing", "unknown"].includes(image.status)) selected.delete(image.id);
    count.textContent = `${images.length}枚中 ${selected.size}枚を選択${record?.limited ? "（一覧の上限に達しました）" : ""}`;
    const signature = JSON.stringify([images, [...selected], disabled]);
    if (signature !== imageSignature) {
      gallery.querySelector(".empty")?.remove();
      for (const image of images) {
        const chosen = selected.has(image.id), locked = !selectable(image);
        if (!cards.has(image.id)) {
          const item = element("label", "image"), input = element("input"), preview = element("img"), caption = element("span"), result = element("small");
          input.type = "checkbox"; input.dataset.imageId = image.id;
          input.addEventListener("change", () => { if (input.checked) selected.add(image.id); else selected.delete(image.id); render(); });
          preview.src = image.imageUrl; preview.alt = ""; preview.referrerPolicy = "no-referrer"; preview.draggable = false; preview.loading = "lazy";
          item.append(preview, input, caption, result); gallery.append(item); cards.set(image.id, { item, input, caption, result });
        }
        const { item, input, caption, result } = cards.get(image.id);
        item.className = `image${chosen ? " selected" : ""}${locked ? " locked" : ""}`;
        item.title = image.error || image.sourceUrl;
        input.checked = chosen || ["saved", "existing"].includes(image.status); input.disabled = disabled || locked;
        input.setAttribute("aria-label", image.alt || `${image.width} × ${image.height}の画像`);
        caption.textContent = image.alt || `${image.width} × ${image.height}`;
        result.className = image.error ? "error" : "";
        result.textContent = image.error || ({ idle: chosen ? "選択中" : "未選択", queued: "送信待ち", sending: "保存中…", saved: "保存しました", existing: "保存済み", cancelled: "未送信", failed: "保存失敗", unknown: "結果を本体で確認" }[image.status] || "");
      }
      if (!images.length) gallery.append(element("p", "empty", "読み込み済みの画像が見つかりません。ページをスクロールしてから画像を更新してください。"));
      imageSignature = signature;
    }
    const saved = images.filter(image => image.status === "saved").length, existing = images.filter(image => image.status === "existing").length, failed = images.filter(image => ["failed", "unknown"].includes(image.status)).length;
    status.textContent = notice || (running ? `保存中：成功 ${saved}枚・保存済み ${existing}枚・失敗／要確認 ${failed}枚` : record?.boardId ? `成功 ${saved}枚・保存済み ${existing}枚・失敗／要確認 ${failed}枚。未送信の画像は選んで再開できます。` : "保存する画像と保存先を選んでください。");
    stop.hidden = !running; stop.disabled = busy || record?.stopRequested;
    stop.textContent = record?.stopRequested ? "停止中…" : "停止";
    save.disabled = disabled || !selected.size || !destination.value || !state?.ready;
    save.textContent = running ? "保存中…" : `選んだ${selected.size}枚を保存`;
  }
  async function load() {
    const current = ++sequence;
    try { const result = await ask("status"); if (!closed && current === sequence) { record = result.batch; state = result.state; render(); } }
    catch (error) { if (!closed && current === sequence) { notice = error.message; render(); } }
  }
  async function action(name, payload = {}) {
    if (busy) return;
    busy = true; ++sequence; notice = ""; render();
    try { await ask(name, payload); }
    catch (error) { notice = error.message; }
    finally { busy = false; if (!closed) await load(); }
  }
  all.addEventListener("click", () => { for (const image of record?.images || []) if (selectable(image)) selected.add(image.id); render(); });
  clear.addEventListener("click", () => { selected.clear(); render(); });
  scan.addEventListener("click", () => { void action("scan"); });
  connect.addEventListener("click", () => { void action("connect"); });
  save.addEventListener("click", () => { if (!save.disabled) void action("start", { selected: [...selected], boardId: destination.value, session: state.session }); });
  stop.addEventListener("click", () => { void action("stop"); });
  let dragging = null;
  const clamp = () => { const box = host.getBoundingClientRect(); host.style.setProperty("left", `${Math.max(8, Math.min(innerWidth - box.width - 8, box.left))}px`, "important"); host.style.setProperty("top", `${Math.max(8, Math.min(innerHeight - box.height - 8, box.top))}px`, "important"); };
  header.addEventListener("pointerdown", event => { if (event.button !== 0 || event.target.closest("button")) return; const box = host.getBoundingClientRect(); dragging = { x: event.clientX - box.left, y: event.clientY - box.top }; header.setPointerCapture(event.pointerId); event.preventDefault(); });
  header.addEventListener("pointermove", event => { if (!dragging) return; host.style.setProperty("left", `${event.clientX - dragging.x}px`, "important"); host.style.setProperty("top", `${event.clientY - dragging.y}px`, "important"); clamp(); });
  header.addEventListener("pointerup", () => { dragging = null; }); header.addEventListener("lostpointercapture", () => { dragging = null; });
  const keydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
  function close() {
    if (closed) return;
    closed = true; ++sequence; clearInterval(timer); window.removeEventListener("resize", clamp); window.removeEventListener("pagehide", close); root.removeEventListener("keydown", keydown);
    void ask("stop").catch(() => {}); host.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (globalThis.__imageStorageBatchPicker?.id === config.id) delete globalThis.__imageStorageBatchPicker;
  }
  closeButton.addEventListener("click", close); root.addEventListener("keydown", keydown); window.addEventListener("resize", clamp); window.addEventListener("pagehide", close);
  const timer = setInterval(() => { if (!busy) void load(); }, 700);
  globalThis.__imageStorageBatchPicker = { id: config.id, close };
  render(); void load(); closeButton.focus({ preventScroll: true });
  return { shown: true };
}
