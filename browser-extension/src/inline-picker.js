// This function is serialized by scripting.executeScript. Keep its dependencies
// inside the function so it also works in Firefox's isolated content-script world.
export function showInlinePicker(config) {
  const api = globalThis.browser?.runtime?.getBrowserInfo ? globalThis.browser : globalThis.chrome || globalThis.browser;
  if (!api?.runtime?.sendMessage || !document.documentElement) return { shown: false };
  globalThis.__imageStoragePicker?.close(false);
  const previousFocus = document.activeElement;
  const creating = config.mode === "create";
  const host = document.createElement("div");
  host.id = "imagestorage-save-picker";
  host.setAttribute("popover", "manual");
  for (const [key, value] of Object.entries({ all: "initial", position: "fixed", inset: "auto", margin: "0", padding: "0", border: "0", background: "transparent", "z-index": "2147483647", "color-scheme": "dark", direction: "ltr" })) host.style.setProperty(key, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { font: 13px/1.4 "Segoe UI", "Yu Gothic UI", sans-serif; color: #ededed; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    .panel { display: flex; flex-direction: column; width: 276px; max-width: calc(100vw - 16px); max-height: min(470px, calc(100vh - 16px)); overflow: hidden; background: #262626; color: #ededed; border: 1px solid #414141; border-radius: 7px; box-shadow: 0 8px 26px #0007; font: 13px/1.4 "Segoe UI", "Yu Gothic UI", sans-serif; text-align: left; }
    button, input { font: inherit; color: inherit; }
    button { cursor: pointer; border: 0; margin: 0; }
    button:disabled { cursor: default; }
    button:focus-visible, input:focus-visible { outline: 2px solid #ababab; outline-offset: -3px; }
    header { display: flex; align-items: center; gap: 10px; padding: 7px 9px 7px 13px; min-height: 39px; border-bottom: 1px solid #ffffff14; flex-shrink: 0; cursor: grab; user-select: none; touch-action: none; }
    header.dragging { cursor: grabbing; }
    h2 { flex: 1; margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .01em; }
    .close { width: 26px; height: 26px; flex-shrink: 0; background: transparent; border-radius: 3px; color: #aaa; font-size: 20px; line-height: 1; padding: 0; }
    .close:hover { color: #fff; background: #ffffff12; }
    .lists { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #757575 transparent; padding: 3px 0; }
    .row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 40px; padding: 9px 14px; text-align: left; background: transparent; border-bottom: 1px solid #ffffff0a; }
    .row:hover:enabled { background: #ffffff0b; }
    .row[aria-pressed="true"] { color: #dedede; }
    .row:disabled:not([aria-pressed="true"]) { color: #929292; }
    .box { flex: 0 0 15px; width: 15px; height: 15px; border: 1.5px solid #7e7e7e; border-radius: 2px; display: grid; place-items: center; font-size: 12px; line-height: 1; font-weight: 600; }
    .row[aria-pressed="true"] .box { background: #d4d4d4; color: #202020; border-color: #d4d4d4; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name small { display: block; font-size: 10px; color: #989898; overflow: hidden; text-overflow: ellipsis; }
    .current { width: 5px; height: 5px; background: #acacac; border-radius: 50%; flex-shrink: 0; }
    .empty { padding: 18px 14px; margin: 0; color: #aaa; font-size: 12px; }
    .status { margin: 0; padding: 7px 13px; flex-shrink: 0; color: #b5b5b5; font-size: 11px; overflow-wrap: anywhere; max-height: 90px; overflow-y: auto; }
    .status:empty { display: none; }
    .connect { margin: 3px 12px 10px; padding: 7px 8px; border: 1px solid #4b4b4b; border-radius: 3px; background: #202020; font-size: 11px; }
    .connect:hover:enabled { background: #363636; }
    .connect[hidden] { display: none; }
    footer { display: flex; align-items: center; gap: 7px; padding: 8px 10px; border-top: 1px solid #ffffff17; background: #292929; flex-shrink: 0; }
    .search-icon { width: 12px; height: 12px; border: 1.5px solid #929292; border-radius: 50%; margin: 0 4px 3px 2px; position: relative; flex-shrink: 0; }
    .search-icon::after { content: ""; position: absolute; width: 5px; height: 1.5px; background: #929292; transform: rotate(45deg); top: 9px; left: 8px; }
    input { min-width: 0; width: 100%; border: 0; border-radius: 2px; padding: 4px 3px; background: transparent; font-size: 12px; }
    input::placeholder { color: #a2a2a2; opacity: 1; }
    .creation { display: grid; gap: 12px; padding: 15px 13px 10px; }
    .creation label { display: grid; gap: 7px; color: #b5b5b5; font-size: 11px; }
    .creation input { padding: 9px; background: #191919; border: 1px solid #494949; font-size: 13px; }
    .creation p { margin: 0; color: #aaa; font-size: 11px; line-height: 1.6; }
    .create-submit { background: #121212; border: 1px solid #4b4b4b; border-radius: 3px; padding: 9px; font-size: 12px; }
    .create-submit:hover:enabled { background: #333; }
    .create-submit:disabled { opacity: .55; }
    .creation[hidden], .lists[hidden], footer[hidden] { display: none; }
  `;
  const element = (tag, className, text) => {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  const panel = element("section", "panel");
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", creating ? "ImageStorageの新規リストを作成" : "ImageStorageの保存先を選択");
  const header = element("header"), heading = element("h2", "", creating ? "新規リストを作成" : "ImageStorageに保存"), closeButton = element("button", "close", "×");
  header.title = "ドラッグして移動";
  closeButton.type = "button"; closeButton.setAttribute("aria-label", "閉じる");
  header.append(heading, closeButton);
  const lists = element("div", "lists"); lists.setAttribute("aria-label", "保存先のリスト");
  const form = element("form", "creation"), nameLabel = element("label", "", "リスト名"), nameInput = element("input", "new-list-name"), createButton = element("button", "create-submit", "作成して保存");
  nameInput.type = "text"; nameInput.maxLength = 120; nameInput.required = true; nameInput.placeholder = "新しいリスト"; nameInput.autocomplete = "off";
  nameInput.setAttribute("aria-label", "新しいリストの名前");
  createButton.type = "submit"; createButton.disabled = true;
  nameLabel.append(nameInput); form.append(nameLabel, element("p", "", "右クリックした画像を、新しいリストに保存します。"), createButton);
  form.hidden = !creating; lists.hidden = creating;
  const status = element("p", "status", "保存先を読み込み中…"); status.setAttribute("role", "status");
  const connectButton = element("button", "connect", "ImageStorageを起動・再接続"); connectButton.type = "button"; connectButton.hidden = true;
  const footer = element("footer"), searchIcon = element("span", "search-icon"), search = element("input");
  searchIcon.setAttribute("aria-hidden", "true");
  search.type = "search"; search.placeholder = "リストを検索"; search.autocomplete = "off"; search.setAttribute("aria-label", "保存先リストを検索");
  footer.hidden = creating;
  footer.append(searchIcon, search); panel.append(header, form, lists, status, connectButton, footer);
  // Constructed sheets are scoped to the closed shadow root and also work on
  // sites that block inline <style> elements with their Content Security Policy.
  try { const sheet = new CSSStyleSheet(); sheet.replaceSync(style.textContent); root.adoptedStyleSheets = [sheet]; }
  catch { root.append(style); }
  root.append(panel);

  let closed = false, busy = false, refreshing = false, state = null, interval = null, positionFrame = null;
  let mutation = 0;
  let manualPosition = null, drag = null;
  let createdBoard = null, creationUncertain = false, composing = false;
  let saved = new Set(), uncertain = new Set(), lastRender = "", notice = config.error || "";
  const request = (action, details = {}) => api.runtime.sendMessage({ ...details, action: `inline:${action}`, id: config.id, token: config.token });
  const resultKey = (boardId) => JSON.stringify([state?.session, boardId]);
  const imageMatches = Array.from(document.images).filter((image) => image.currentSrc === config.imageUrl || image.src === config.imageUrl).filter((image) => {
    const rect = image.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
  });
  const anchor = imageMatches.find((image) => image.closest("a")?.href === config.sourceUrl) || imageMatches[0];
  const recordedPoint = globalThis.__imageStorageContextPosition?.point;
  const cursor = recordedPoint && [recordedPoint.x, recordedPoint.y, recordedPoint.at].every(Number.isFinite)
    && recordedPoint.at <= Date.now() && Date.now() - recordedPoint.at < 2 * 60 * 1000
    ? { x: recordedPoint.x, y: recordedPoint.y } : null;

  function position() {
    if (closed) return;
    const bounds = panel.getBoundingClientRect();
    const width = Math.max(1, document.documentElement.clientWidth || innerWidth), height = innerHeight;
    const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
    // Prefer the actual right-click, not the image's edge. Keep a fixed anchor
    // while typing or scrolling; only clamp it when the viewport is too small.
    const x = manualPosition?.x ?? cursor?.x ?? (rect ? rect.left + rect.width / 2 - bounds.width / 2 : (width - bounds.width) / 2);
    const y = manualPosition?.y ?? cursor?.y ?? (rect ? rect.top + rect.height / 2 - bounds.height / 2 : (height - bounds.height) / 2);
    const left = Math.max(8, Math.min(x, width - bounds.width - 8));
    const top = Math.max(8, Math.min(y, height - bounds.height - 8));
    if (manualPosition) manualPosition = { x: left, y: top };
    host.style.setProperty("left", `${left}px`, "important");
    host.style.setProperty("top", `${top}px`, "important");
  }
  function schedulePosition() {
    if (positionFrame !== null) return;
    positionFrame = requestAnimationFrame(() => { positionFrame = null; position(); });
  }
  function startDrag(event) {
    if (closed || drag || !event.isPrimary || event.button !== 0 || event.target.closest("button")) return;
    const bounds = panel.getBoundingClientRect();
    try { header.setPointerCapture(event.pointerId); } catch { return; }
    drag = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
    manualPosition = { x: bounds.left, y: bounds.top };
    header.classList.add("dragging");
    event.preventDefault(); event.stopPropagation();
  }
  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (event.pointerType === "mouse" && !(event.buttons & 1)) { finishDrag(event); return; }
    manualPosition = { x: event.clientX - drag.offsetX, y: event.clientY - drag.offsetY };
    position();
    event.preventDefault(); event.stopPropagation();
  }
  function finishDrag(event) {
    if (!drag || (typeof event?.pointerId === "number" && event.pointerId !== drag.pointerId)) return;
    const pointerId = drag.pointerId;
    drag = null; header.classList.remove("dragging");
    if (header.hasPointerCapture(pointerId)) header.releasePointerCapture(pointerId);
  }
  function close(restoreFocus = true) {
    if (closed) return;
    finishDrag();
    closed = true; clearInterval(interval); if (positionFrame !== null) cancelAnimationFrame(positionFrame);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", keyboard, true);
    window.removeEventListener("resize", schedulePosition);
    window.removeEventListener("scroll", schedulePosition, true);
    window.removeEventListener("pagehide", pagehide);
    window.removeEventListener("blur", finishDrag);
    host.remove();
    if (globalThis.__imageStoragePicker?.host === host) delete globalThis.__imageStoragePicker;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    void request("cancel").catch(() => {});
  }
  function outside(event) { if (!drag && !event.composedPath().includes(host)) close(false); }
  function pagehide() { close(false); }
  function keyboard(event) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!event.composedPath().includes(host)) return;
    // Keep typing and navigation inside the picker from triggering site shortcuts.
    event.stopPropagation();
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const buttons = Array.from(lists.querySelectorAll("button:enabled"));
    if (!buttons.length) return;
    event.preventDefault();
    const index = buttons.indexOf(root.activeElement);
    const next = index < 0 ? event.key === "ArrowDown" ? 0 : buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true }); buttons[next].scrollIntoView({ block: "nearest" });
  }
  function render() {
    if (closed) return;
    const query = search.value.trim().toLocaleLowerCase();
    const signature = JSON.stringify([state?.session, state?.revision, state?.activeId, state?.ready, state?.capabilities, state?.boards, query, busy, [...saved], [...uncertain]]);
    if (!creating && signature !== lastRender) {
      lastRender = signature;
      const scrollTop = lists.scrollTop, focusedId = root.activeElement?.getAttribute("data-board-id");
      lists.replaceChildren();
      const boards = (state?.boards || []).filter((board) => `${board.name} ${board.groupName || ""}`.toLocaleLowerCase().includes(query));
      for (const board of boards) {
        const key = resultKey(board.id), isSaved = saved.has(key), unknown = uncertain.has(key);
        const row = element("button", "row"), box = element("span", "box", isSaved ? "✓" : unknown ? "!" : ""), name = element("span", "name", board.name);
        row.type = "button"; row.disabled = busy || !state.ready || (isSaved && !state.capabilities?.removeImage) || unknown;
        row.setAttribute("data-board-id", board.id);
        row.setAttribute("aria-pressed", String(isSaved));
        row.setAttribute("aria-label", `${board.name}${isSaved ? state.capabilities?.removeImage ? "から画像を外す" : "に保存済み" : unknown ? "の送信結果を確認してください" : "に保存"}`);
        row.title = `${board.groupName ? board.groupName + " / " : ""}${board.name}${isSaved ? state.capabilities?.removeImage ? "（保存済み・クリックで解除）" : "（この画像を保存済み）" : ""}`;
        box.setAttribute("aria-hidden", "true");
        if (board.groupName) name.append(element("small", "", board.groupName));
        row.append(box, name);
        if (board.id === state.activeId) { const current = element("span", "current"); current.title = "現在のリスト"; row.append(current); }
        row.addEventListener("click", () => { void save(board); });
        lists.append(row);
      }
      if (!boards.length) lists.append(element("p", "empty", state?.ready ? "一致するリストがありません" : "接続するとリストが表示されます"));
      lists.scrollTop = scrollTop;
      if (focusedId) Array.from(lists.querySelectorAll("button")).find((button) => button.getAttribute("data-board-id") === focusedId)?.focus({ preventScroll: true });
    }
    status.textContent = notice;
    if (creating) {
      nameInput.disabled = busy || Boolean(createdBoard) || creationUncertain;
      createButton.disabled = busy || Boolean(state?.ready && !state.capabilities?.createBoard) || !nameInput.value.trim() || Boolean(createdBoard) || creationUncertain;
      createButton.textContent = busy ? "作成・保存中…" : createdBoard ? "保存しました" : "作成して保存";
      if (state?.ready && !state.capabilities?.createBoard) status.textContent = "旧版の本体に接続されています。旧版を終了し、ImageStorage 0.15.45以降を一度起動してください。";
      else if (creationUncertain) status.textContent = "作成結果を確認できません。ImageStorageのリストを確認してください。";
      else if (createdBoard) status.textContent = `${createdBoard.name}を作成して画像を保存しました`;
    }
    connectButton.hidden = Boolean(state?.ready); connectButton.disabled = busy || refreshing;
    position();
  }
  async function refresh(launch = false) {
    if (closed || busy || refreshing) return;
    const before = mutation;
    refreshing = true; connectButton.disabled = true;
    try {
      const result = await request("status", { launch });
      if (closed || before !== mutation) return;
      if (!result?.ok) throw new Error(result?.error || "保存先を読み込めませんでした。");
      const previouslyReady = state?.ready, previousSession = state?.session;
      state = result.state; saved = new Set(result.saved); uncertain = new Set(result.uncertain);
      if (result.createdBoard) createdBoard = result.createdBoard;
      if (result.creationUncertain) creationUncertain = true;
      if (!state?.ready) notice = creating ? "「作成して保存」を押すと、本体を画面を出さずに起動して保存します。" : state?.error || "ImageStorageを起動してください。";
      else if (!previouslyReady || previousSession !== state.session) notice = config.error || "";
    } catch (error) { if (!closed) { notice = error.message; state = { ...state, ready: false }; } }
    finally { refreshing = false; render(); }
  }
  async function save(board) {
    const key = resultKey(board.id), session = state?.session;
    const removing = saved.has(key);
    if (closed || busy || !state?.ready || (removing && !state.capabilities?.removeImage) || uncertain.has(key)) return;
    mutation++;
    busy = true; notice = `${board.name}${removing ? "から解除中…" : "に保存中…"}`; render();
    try {
      const result = await request(removing ? "remove" : "send", { boardId: board.id, session });
      if (closed) return;
      if (!result?.ok) {
        if (result?.code === "unknown_result") uncertain.add(key);
        throw new Error(result?.error || (removing ? "解除できませんでした。" : "保存できませんでした。"));
      }
      if (removing) saved.delete(key); else saved.add(key);
      notice = `${board.name}${removing ? "から画像を外しました" : "に保存しました"}`;
    } catch (error) { if (!closed) notice = error.message; }
    finally { busy = false; render(); }
  }
  async function createList() {
    const name = nameInput.value.trim();
    if (closed || busy || composing || createdBoard || creationUncertain || (state?.ready && !state.capabilities?.createBoard) || !name || name.length > 120) return;
    mutation++; busy = true; notice = "リストを作成して画像を保存中…"; render();
    try {
      const result = await request("create", { name, session: state?.ready ? state.session : undefined });
      if (closed) return;
      if (!result?.ok) {
        if (result?.code === "unknown_result") creationUncertain = true;
        throw new Error(result?.error || "リストを作成できませんでした。");
      }
      createdBoard = { boardId: result.boardId, name: result.name || name };
      notice = `${createdBoard.name}を作成して画像を保存しました`;
    } catch (error) { if (!closed) notice = error.message; }
    finally { busy = false; render(); }
  }
  closeButton.addEventListener("click", () => close());
  header.addEventListener("pointerdown", startDrag);
  header.addEventListener("pointermove", moveDrag);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) header.addEventListener(type, finishDrag);
  connectButton.addEventListener("click", () => { void refresh(true); });
  search.addEventListener("input", render);
  nameInput.addEventListener("input", render);
  nameInput.addEventListener("compositionstart", () => { composing = true; });
  nameInput.addEventListener("compositionend", () => { composing = false; });
  form.addEventListener("submit", (event) => { event.preventDefault(); void createList(); });
  // Stop page-level key listeners while preserving the input's native editing.
  for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, (event) => event.stopPropagation());
  document.documentElement.append(host);
  try { host.showPopover(); } catch { /* Fixed positioning still works without top-layer support. */ }
  globalThis.__imageStoragePicker = { close, host };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", keyboard, true);
  window.addEventListener("resize", schedulePosition);
  window.addEventListener("scroll", schedulePosition, true);
  window.addEventListener("pagehide", pagehide);
  window.addEventListener("blur", finishDrag);
  position(); (creating ? nameInput : search).focus({ preventScroll: true });
  void refresh(false);
  interval = setInterval(() => { void refresh(false); }, 5000);
  return { shown: true };
}
