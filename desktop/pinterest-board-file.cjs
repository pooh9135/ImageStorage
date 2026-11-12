const FORMAT = "imagestorage-pinterest-board";
const MAX_PINS = 5000;
const MAX_BYTES = 8 * 1024 * 1024;
const pinterestHost = value => /^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2})$/i.test(value);
function webUrl(value, image = false, pin = false) {
  if (typeof value !== "string" || value.length > 16384) throw new Error("画像URLまたは出典URLが正しくありません。");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (image ? url.hostname !== "i.pinimg.com" : !pinterestHost(url.hostname)) || (pin && !/^\/pin\/\d+\/?$/.test(url.pathname))) throw new Error("Pinterestの画像・出典URLだけを読み込めます。");
  url.hash = "";
  return url.href;
}
function parsePinterestBoardFile(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("ボードファイルは8MB以下にしてください。");
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { throw new Error("JSON形式のボードファイルを読み込めませんでした。"); }
  if (data?.format !== FORMAT || ![1, 2].includes(data.version) || !data.board || typeof data.board.name !== "string" || !data.board.name.trim() || data.board.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.board.name)) throw new Error("ImageStorage用のボードファイルではありません。拡張機能から書き出し直してください。");
  const url = webUrl(data.board.url);
  if (!Array.isArray(data.pins) || !data.pins.length || data.pins.length > MAX_PINS) throw new Error("1〜5,000枚の画像を含むボードファイルを選択してください。");
  const seen = new Set(), pins = [];
  for (const pin of data.pins) {
    if (!pin || typeof pin !== "object") throw new Error("ボード内の画像情報が正しくありません。");
    const imageUrl = webUrl(pin.imageUrl, true), pinUrl = webUrl(pin.pinUrl, false, true);
    const identity = data.version === 2 ? `pin:${new URL(pinUrl).pathname.split("/")[2]}` : new URL(imageUrl).pathname.match(/\/([a-f0-9]{32})\.(?:jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase() || imageUrl;
    if (seen.has(identity)) continue;
    seen.add(identity);
    pins.push({ imageUrl, pinUrl, title: typeof pin.title === "string" ? pin.title.slice(0, 180) : "", width: Number.isFinite(pin.width) ? Math.max(0, pin.width) : 0, height: Number.isFinite(pin.height) ? Math.max(0, pin.height) : 0 });
  }
  return { format: FORMAT, version: data.version, board: { name: data.board.name.trim(), url }, pins, duplicates: data.pins.length - pins.length };
}
module.exports = { FORMAT, MAX_PINS, MAX_BYTES, parsePinterestBoardFile };
