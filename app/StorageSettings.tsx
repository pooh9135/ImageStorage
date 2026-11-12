"use client";

import { useRef, useState } from "react";

type Props = {
  boards: Array<{ id: string; name: string; items: Array<{ type: string }> }>;
  activeId: string;
  getSnapshot: () => MuseboardProjectData;
  text: (en: string, ja: string, zh: string, ko: string) => string;
  onBusyChange: (busy: boolean) => void;
};

export function StorageSettings({ boards, activeId, getSnapshot, text, onBusyChange }: Props) {
  const [selectedId, setSelectedId] = useState(activeId);
  const [backupList, setBackupList] = useState<BackupListResult | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateImagesResult | null>(null);
  const [exportResult, setExportResult] = useState<ExportListImagesResult | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const selectedBoard = boards.find((board) => board.id === selectedId) ?? boards[0];
  const desktop = typeof window !== "undefined" ? window.museboardDesktop : undefined;
  const available = Boolean(desktop?.listBackups);

  async function run(operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    onBusyChange(true);
    setError("");
    setNotice("");
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { busyRef.current = false; onBusyChange(false); }
  }

  async function refreshBackups() {
    if (!desktop) return;
    const result = await desktop.listBackups();
    if ("error" in result) throw new Error(result.error);
    setBackupList(result);
  }

  async function restore(entry: BackupEntry) {
    if (!desktop || !window.confirm(text(
      "Replace all current lists with this backup? The current state will be backed up first.",
      "すべてのリストをこのバックアップに戻しますか？ 復元前の状態も自動でバックアップします。",
      "用此备份替换所有当前列表？将先备份当前状态。", "모든 목록을 이 백업으로 복원할까요? 현재 상태를 먼저 백업합니다.",
    ))) return;
    await run(async () => {
      const result = await desktop.restoreBackup({ id: entry.id, digest: entry.digest }, getSnapshot());
      if ("error" in result) throw new Error(result.error);
      try {
        window.dispatchEvent(new CustomEvent("museboard:load-project", { detail: result.data }));
      } finally { desktop.completeBackupRestore(); }
      setDuplicates(null);
      setExportResult(null);
      setNotice(text("Backup restored.", "バックアップを復元しました。", "已恢复备份。", "백업을 복원했습니다."));
      await refreshBackups();
    });
  }

  return <div className="storage-settings">
    {!available && <p>{text("Available in the desktop app.", "デスクトップ版で使用できます。", "可在桌面应用中使用。", "데스크톱 앱에서 사용할 수 있습니다.")}</p>}
    {error && <p className="storage-error" role="alert">{error}</p>}
    {notice && <p className="storage-notice" role="status">{notice}</p>}

    <fieldset>
      <legend>{text("Export images", "リスト内の画像を出力", "导出图片", "이미지 내보내기")}</legend>
      <p>{text("Copy every image in a list at its original quality. Drawing guides and notes are not included.",
        "リスト内の全画像を、画質を変えずにコピーします。描画した線・ガイドや付箋は含みません。",
        "按原始质量复制列表中的所有图片，不包含绘图辅助线或便笺。", "목록의 모든 이미지를 원본 화질로 복사합니다. 그리기와 가이드, 메모는 포함하지 않습니다.")}</p>
      <label><span>{text("Saved list", "保存リスト", "保存的列表", "저장 목록")}</span>
        <select value={selectedBoard?.id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>
          {boards.map((board) => <option key={board.id} value={board.id}>{board.name} ({board.items.filter((item) => item.type === "image").length})</option>)}
        </select>
      </label>
      <button disabled={!available || !selectedBoard?.items.some((item) => item.type === "image")} onClick={() => void run(async () => {
        if (!desktop || !selectedBoard) return;
        const result = await desktop.exportListImages(getSnapshot(), selectedBoard.id);
        if ("error" in result) throw new Error(result.error);
        if (!result.canceled) setExportResult(result);
      })}>{text("Choose folder and export", "フォルダーを選んで出力", "选择文件夹并导出", "폴더를 선택하고 내보내기")}</button>
      {exportResult && <div className="storage-result" role="status">
        <p>{text(`Exported ${exportResult.exported} images.`, `${exportResult.exported}枚を出力しました。`, `已导出 ${exportResult.exported} 张图片。`, `${exportResult.exported}개 이미지를 내보냈습니다.`)}</p>
        <p className="storage-path">{exportResult.directory}</p>
        {!!exportResult.errors?.length && <details><summary>{text("Images that could not be exported", "出力できなかった画像", "无法导出的图片", "내보내지 못한 이미지")} ({exportResult.errors.length})</summary>
          <ul>{exportResult.errors.map((failure, index) => <li key={index}>{failure.name}: {failure.message}</li>)}</ul>
        </details>}
      </div>}
    </fieldset>

    <fieldset>
      <legend>{text("Backups", "バックアップ", "备份", "백업")}</legend>
      <p>{text("Review local recovery history or keep a checkpoint. Restore replaces all lists; application preferences are kept.",
        "このPCの自動保存履歴を確認したり、手動で履歴を残せます。復元は全リストが対象です。アプリの設定は維持します。",
        "查看本机自动保存记录或创建备份。恢复将替换所有列表，保留应用设置。", "이 PC의 자동 저장 기록을 확인하거나 백업을 만듭니다. 복원은 모든 목록에 적용되며 앱 설정은 유지됩니다.")}</p>
      <div className="storage-actions">
        <button disabled={!available} onClick={() => void run(refreshBackups)}>{text("Show / refresh backups", "一覧を表示・更新", "显示 / 刷新备份", "목록 표시 / 새로고침")}</button>
        <button disabled={!available} onClick={() => void run(async () => {
          if (!desktop) return;
          const result = await desktop.createBackup(getSnapshot());
          if ("error" in result) throw new Error(result.error);
          setNotice(text("Backup created.", "バックアップを作成しました。", "已创建备份。", "백업을 만들었습니다."));
          await refreshBackups();
        })}>{text("Create backup", "バックアップを作成", "创建备份", "백업 만들기")}</button>
      </div>
      {backupList && <div className="storage-result">
        {!backupList.backups.length && <p>{text("No backups yet.", "バックアップはまだありません。", "暂无备份。", "아직 백업이 없습니다.")}</p>}
        <ul className="storage-backups">{backupList.backups.map((entry) => <li key={entry.id}>
          <div><strong>{new Date(entry.savedAt).toLocaleString()}</strong><span>{entry.kind === "manual" ? text("Manual", "手動", "手动", "수동") : entry.kind === "before-restore" ? text("Before restore", "復元前", "恢复前", "복원 전") : text("Automatic", "自動保存", "自动保存", "자동 저장")}
            {` · ${entry.boards} `}{text("lists", "リスト", "列表", "목록")}{` · ${entry.images} `}{text("images", "画像", "图片", "이미지")}</span></div>
          <button onClick={() => void restore(entry)}>{text("Restore", "復元", "恢复", "복원")}</button>
        </li>)}</ul>
        {!!backupList.errors.length && <details><summary>{text("Unreadable backups", "読み込めないバックアップ", "无法读取的备份", "읽을 수 없는 백업")} ({backupList.errors.length})</summary>
          <ul>{backupList.errors.map((failure) => <li key={failure.name}>{failure.name}: {failure.message}</li>)}</ul>
        </details>}
      </div>}
    </fieldset>

    <fieldset>
      <legend>{text("Duplicate images", "重複画像の検出", "检测重复图片", "중복 이미지 검사")}</legend>
      <p>{text("Find identical image data across all lists. Images are not deleted or merged.",
        "全リストから、画像データが完全に同じものを探します。削除や統合は行いません。",
        "在所有列表中查找完全相同的图片数据，不删除或合并图片。", "모든 목록에서 완전히 동일한 이미지 데이터를 찾습니다. 삭제하거나 합치지 않습니다.")}</p>
      <button disabled={!available} onClick={() => void run(async () => {
        if (!desktop) return;
        const result = await desktop.findDuplicateImages(getSnapshot());
        if ("error" in result) throw new Error(result.error);
        setDuplicates(result);
      })}>{text("Scan all lists", "全リストを調べる", "扫描所有列表", "모든 목록 검사")}</button>
      {duplicates && <div className="storage-result" role="status">
        <p>{text(`${duplicates.scanned} images checked · ${duplicates.groups.length} duplicate groups`,
          `${duplicates.scanned}枚を確認 · 重複は${duplicates.groups.length}組`,
          `已检查 ${duplicates.scanned} 张 · ${duplicates.groups.length} 组重复`, `${duplicates.scanned}개 확인 · 중복 ${duplicates.groups.length}개 그룹`)}</p>
        {duplicates.groups.map((group, index) => <details key={group.hash}>
          <summary>{text("Group", "重複", "组", "그룹")} {index + 1} ({group.items.length})</summary>
          <ul>{group.items.map((item, occurrence) => <li key={occurrence}><strong>{item.boardName}</strong> · {item.name}</li>)}</ul>
        </details>)}
        {!!duplicates.errors.length && <details><summary>{text("Images that could not be checked", "確認できなかった画像", "无法检查的图片", "확인하지 못한 이미지")} ({duplicates.errors.length})</summary>
          <ul>{duplicates.errors.map((failure, index) => <li key={index}>{failure.boardName} · {failure.name}: {failure.message}</li>)}</ul>
        </details>}
      </div>}
    </fieldset>
  </div>;
}
