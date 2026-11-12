const api = globalThis.browser?.runtime?.getBrowserInfo ? globalThis.browser : globalThis.chrome || globalThis.browser;
let requestId = new URL(location.href).searchParams.get("request");
const storageError = new URL(location.href).searchParams.get("error") === "storage";
const status = document.getElementById("status"), lists = document.getElementById("lists"), search = document.getElementById("search"), connect = document.getElementById("connect");
const exportBoard = document.getElementById("export-board");
const creationForm = document.getElementById("new-list-form"), nameInput = document.getElementById("new-list-name"), createButton = document.getElementById("create-list");
let state = null, image = null, busy = false;
let createdBoard = null, creationUncertain = false, composing = false;
const saved = new Set(), uncertain = new Set();
const send = (message) => api.runtime.sendMessage(message);

function render() {
  const creating = image?.mode === "create";
  creationForm.hidden = !creating; search.closest("label").hidden = creating; lists.hidden = creating;
  document.querySelector("h1").textContent = creating ? "新規リストを作成" : "保存先を選択";
  nameInput.disabled = busy || Boolean(createdBoard) || creationUncertain;
  createButton.disabled = busy || Boolean(state?.ready && !state.capabilities?.createBoard) || !nameInput.value.trim() || Boolean(createdBoard) || creationUncertain;
  createButton.textContent = busy ? "作成・保存中…" : createdBoard ? "保存しました" : "作成して保存";
  if (creating && state?.ready && !state.capabilities?.createBoard) status.textContent = "旧版の本体に接続されています。旧版を終了し、ImageStorage 0.15.45以降を一度起動してください。";
  else if (creating && creationUncertain) status.textContent = "作成結果を確認できません。ImageStorageのリストを確認してください。";
  else if (creating && createdBoard) status.textContent = `${createdBoard.name}を作成して画像を保存しました。`;
  lists.replaceChildren();
  const query = search.value.trim().toLocaleLowerCase();
  const boards = (state?.boards || []).filter((board) => `${board.name} ${board.groupName}`.toLocaleLowerCase().includes(query));
  for (const board of boards) {
    const key = JSON.stringify([state.session, board.id]);
    const alreadySaved = typeof board.containsImage === "boolean" ? board.containsImage : saved.has(key);
    const button = document.createElement("button"); button.className = "list"; button.type = "button"; button.disabled = busy || !image || !state.ready || (alreadySaved && !state.capabilities?.removeImage) || uncertain.has(key);
    button.title = alreadySaved && state.capabilities?.removeImage ? "クリックしてこのリストから画像を外す" : "";
    const name = document.createElement("span"); name.textContent = `${alreadySaved ? "✓ " : ""}${board.name}${alreadySaved ? "（保存済み）" : ""}`;
    if (board.groupName) { const group = document.createElement("small"); group.textContent = board.groupName; name.append(group); }
    button.append(name);
    if (board.id === state.activeId) { const active = document.createElement("em"); active.textContent = "現在のリスト"; button.append(active); }
    button.addEventListener("click", async () => {
      busy = true; render(); status.textContent = `${board.name}${alreadySaved ? "から解除中…" : "に画像を送信中…"}`;
      try {
        const result = await send({ action: alreadySaved ? "remove" : "send", id: requestId, boardId: board.id, session: state.session });
        if (!result?.ok) { if (result?.code === "unknown_result") uncertain.add(key); throw new Error(result?.error || "送信できませんでした。"); }
        if (alreadySaved) saved.delete(key); else saved.add(key);
        board.containsImage = !alreadySaved; status.textContent = `${board.name}${alreadySaved ? "から画像を外しました。" : "に画像を追加しました。"}`;
      } catch (error) { status.textContent = error.message; }
      finally { busy = false; render(); }
    });
    lists.append(button);
  }
  if (!boards.length) { const empty = document.createElement("p"); empty.textContent = state?.ready ? "一致する保存先がありません。" : "ImageStorageに接続すると、保存先が表示されます。"; lists.append(empty); }
  connect.disabled = busy;
}

async function refresh(launch) {
  connect.disabled = true;
  try {
    const result = await send({ action: "status", launch, id: requestId });
    state = result?.state;
    status.textContent = state?.ready ? image ? image.error || "送信先のリストを選んでください。" : "接続済みです。画像を右クリックして送信できます。" : state?.error || "ImageStorageに接続できません。";
    if (image?.mode === "create" && !state?.ready) status.textContent = "「作成して保存」を押すと、本体を画面を出さずに起動して保存します。";
    if (requestId && !image) status.textContent = "送信情報が期限切れ、または送信済みです。画像を右クリックし直してください。";
    if (storageError) status.textContent = "選択画面に画像を保持できませんでした。右クリックメニュー内のリスト名を直接選んで送信してください。";
  } catch { status.textContent = "拡張機能を読み込み直してください。"; }
  finally { connect.disabled = false; render(); }
}
search.addEventListener("input", render);
nameInput.addEventListener("input", render);
nameInput.addEventListener("compositionstart", () => { composing = true; });
nameInput.addEventListener("compositionend", () => { composing = false; });
creationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  if (busy || composing || createdBoard || creationUncertain || (state?.ready && !state.capabilities?.createBoard) || !name || name.length > 120) return;
  busy = true; status.textContent = "リストを作成して画像を保存中…"; render();
  try {
    const result = await send({ action: "create", id: requestId, name, session: state?.ready ? state.session : undefined });
    if (!result?.ok) { if (result?.code === "unknown_result") creationUncertain = true; throw new Error(result?.error || "リストを作成できませんでした。"); }
    createdBoard = { boardId: result.boardId, name: result.name || name };
  } catch (error) { status.textContent = error.message; }
  finally { busy = false; render(); }
});
connect.addEventListener("click", () => { void refresh(true); });
document.getElementById("cancel").addEventListener("click", async () => { if (requestId && image) await send({ action: "cancel", id: requestId }); window.close(); });
document.getElementById("open-batch").addEventListener("click", async (event) => {
  if (busy) return;
  const button = event.currentTarget;
  button.disabled = true;
  try { const result = await send({ action: "batch:open" }); if (!result?.ok) throw new Error(result?.error || "一括保存を開けませんでした。"); window.close(); }
  catch (error) { status.textContent = error.message; button.disabled = false; }
});
exportBoard.addEventListener("click", async event => {
  if (busy) return;
  const button = event.currentTarget; button.disabled = true;
  try { const result = await send({ action: "board:open" }); if (!result?.ok) throw new Error(result?.error || "ボードの書き出しを開けませんでした。"); window.close(); }
  catch (error) { status.textContent = error.message; button.disabled = false; }
});
void send({ action: "board:available" }).then(result => { exportBoard.hidden = result?.available !== true; }).catch(() => {});
{ const result = await send({ action: "pending", id: requestId }); image = result?.image || null; if (image) { requestId = image.id; createdBoard = image.createdBoard || null; creationUncertain = Boolean(image.creationUncertain); for (const key of image.saved || []) saved.add(key); for (const key of image.uncertain || []) uncertain.add(key); } }
if (image) document.getElementById("hint").textContent = "元のブラウザータブを開いたまま送信してください。";
await refresh(false);
if (image?.mode === "create") nameInput.focus();
