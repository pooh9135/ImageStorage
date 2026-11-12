export type NoteSettings = {
  noteFont: string;
  noteFontSize: number;
};

export const DEFAULT_NOTE_SETTINGS: NoteSettings = {
  noteFont: 'Inter, "Noto Sans JP", "Segoe UI", sans-serif',
  noteFontSize: 12,
};

export function normalizeNoteSettings(input: unknown): NoteSettings {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    noteFont: typeof value.noteFont === "string" && value.noteFont.trim()
      ? value.noteFont.trim() : DEFAULT_NOTE_SETTINGS.noteFont,
    noteFontSize: typeof value.noteFontSize === "number" && Number.isFinite(value.noteFontSize)
      ? Math.max(9, Math.min(28, value.noteFontSize)) : DEFAULT_NOTE_SETTINGS.noteFontSize,
  };
}

export function applyNoteSettings<
  T extends { items: Array<{ type: string; fontFamily?: string; fontSize?: number }> },
>(boards: T[], settings: NoteSettings): T[] {
  const shared = normalizeNoteSettings(settings);
  let boardsChanged = false;
  const mirrored = boards.map((board) => {
    let itemsChanged = false;
    const items = board.items.map((item) => {
      if (item.type !== "note" ||
        (item.fontFamily === shared.noteFont && item.fontSize === shared.noteFontSize)) return item;
      itemsChanged = true;
      return { ...item, fontFamily: shared.noteFont, fontSize: shared.noteFontSize };
    });
    if (!itemsChanged) return board;
    boardsChanged = true;
    return { ...board, items };
  });
  return boardsChanged ? mirrored : boards;
}
