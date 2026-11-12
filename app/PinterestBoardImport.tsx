"use client";

import { useEffect, useRef, useState } from "react";
import { preparePinterestBoardImport, type BoardImportPreparation } from "./pinterest-board-import";
import "./zen-board-import.css";

type Props = { data: PinterestBoardFile; onClose: () => void; onCommit: (name: string, images: PinterestBoardImage[]) => void };

export function PinterestBoardImport({ data, onClose, onCommit }: Props) {
  const [name, setName] = useState(data.board.name), [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: data.pins.length });
  const [result, setResult] = useState<BoardImportPreparation | null>(null), [error, setError] = useState("");
  const cancelled = useRef(false), busy = useRef(false);
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true; }; }, []);
  const close = () => { cancelled.current = true; onClose(); };
  function commit(images: PinterestBoardImage[]) {
    if (cancelled.current) return;
    try {
      const order = new Map(data.pins.map((pin, index) => [pin.pinUrl, index]));
      onCommit(name.trim(), [...images].sort((a, b) => (order.get(a.pin.pinUrl) ?? 0) - (order.get(b.pin.pinUrl) ?? 0)));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "リストを作成できませんでした。"); }
  }
  async function start(retry = false) {
    const desktop = window.museboardDesktop;
    if (busy.current || !desktop || !name.trim() || name.trim().length > 120) return;
    busy.current = true; setLoading(true); setError("");
    const pins = retry && result ? result.errors.map(entry => entry.pin) : data.pins;
    setProgress({ done: 0, total: pins.length });
    try {
      const prepared = await preparePinterestBoardImport(pins, url => desktop.importImageUrl(url), () => cancelled.current, (done, total) => setProgress({ done, total }));
      if (prepared.cancelled || cancelled.current) return;
      const combined = { ...prepared, images: [...(retry ? result?.images || [] : []), ...prepared.images] };
      setResult(combined);
      if (!combined.errors.length && combined.images.length) commit(combined.images);
    } catch (failure) { if (!cancelled.current) setError(failure instanceof Error ? failure.message : "画像を取得できませんでした。"); }
    finally { busy.current = false; if (!cancelled.current) setLoading(false); }
  }
  return <div className="pinterest-board-import-backdrop" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
    <section className="pinterest-board-import-dialog" role="dialog" aria-modal="true" aria-label="ボードファイルを読み込む">
      <header><h2>ボードファイルを読み込む</h2><button type="button" aria-label="閉じる" onClick={close}>×</button></header>
      <div className="pinterest-board-import-content">
        <label>作成するリスト名<input maxLength={120} value={name} disabled={loading} onChange={event => setName(event.target.value)} /></label>
        <p>{data.pins.length.toLocaleString()}枚の画像情報{data.duplicates ? `（重複 ${data.duplicates}件を除外済み）` : ""}</p>
        <p className="pinterest-board-import-hint">画像を取得して、新しい保存リストを作成します。取得できた元画像のデータを保存します。</p>
        {loading && <div role="status" aria-live="polite"><progress max={progress.total} value={progress.done} /><p>{progress.done} / {progress.total}枚を処理中…</p></div>}
        {result && !loading && <div className="pinterest-board-import-results" role="status">
          <p>取得成功 {result.images.length}枚・失敗 {result.errors.length}枚</p>
          {result.errors.length > 0 && <><p>失敗した画像を再試行するか、取得できた画像でリストを作成できます。</p><ul>{result.errors.slice(0, 8).map((entry, index) => <li key={entry.pin.pinUrl}>{entry.pin.title || `画像${index + 1}`}: {entry.message}</li>)}</ul>{result.errors.length > 8 && <p>ほか{result.errors.length - 8}件</p>}</>}
        </div>}
        {error && <p className="pinterest-board-import-error" role="alert">{error}</p>}
      </div>
      <footer>
        <button type="button" onClick={close}>{loading ? "中止" : "キャンセル"}</button>
        {!loading && result?.errors.length ? <button type="button" onClick={() => void start(true)}>失敗した画像を再試行</button> : null}
        <button type="button" className="pinterest-board-import-primary" disabled={loading || !name.trim() || (Boolean(result?.errors.length) && !result?.images.length)} onClick={() => result?.images.length && result.errors.length ? commit(result.images) : void start()}>
          {loading ? "取得中…" : result?.errors.length ? `取得できた${result.images.length}枚で作成` : "取り込む"}
        </button>
      </footer>
    </section>
  </div>;
}
