export const HEADER_IMAGE_FIELDS = [
  "headerImageSrc", "headerImageThumbnailSrc", "headerImageAssetId",
  "headerImageWidth", "headerImageHeight", "headerImagePositionX",
  "headerImagePositionY", "headerImageScale",
] as const;

export type ListManagerMetadata = {
  name: string;
  groupName?: string;
  headerImageSrc?: string;
  headerImageThumbnailSrc?: string;
  headerImageAssetId?: string;
  headerImageWidth?: number;
  headerImageHeight?: number;
  headerImagePositionX?: number;
  headerImagePositionY?: number;
  headerImageScale?: number;
};

export type ListManagerDropTarget = { boardId: string; edge: "before" | "after" };

export function getListManagerDropTarget(
  rows: { id: string; top: number; bottom: number }[],
  sourceId: string,
  x: number,
  y: number,
  bounds: { left: number; right: number; top: number; bottom: number },
  previousTarget: ListManagerDropTarget | null = null,
): ListManagerDropTarget | null {
  const sourceIndex = rows.findIndex((row) => row.id === sourceId);
  // Keep a small vertical apron at the scrolling edges; horizontal exits cancel the target.
  if (sourceIndex < 0 || x < bounds.left || x > bounds.right || y < bounds.top - 24 || y > bounds.bottom + 24) return null;
  const pointerY = Math.max(bounds.top, Math.min(bounds.bottom, y));
  const remaining = rows.filter((row) => row.id !== sourceId);
  if (!remaining.length) return null;
  const centers = remaining.map((row) => (row.top + row.bottom) / 2);
  let insertion = centers.findIndex((center) => pointerY < center);
  if (insertion < 0) insertion = remaining.length;

  // Use one canonical slot and an 8px dead band around its boundaries. Small pointer
  // movements must not bounce a whole row between "before" and "after".
  const previousIndex = previousTarget ? remaining.findIndex((row) => row.id === previousTarget.boardId) : -1;
  if (previousIndex >= 0) {
    const previousInsertion = previousIndex + (previousTarget!.edge === "after" ? 1 : 0);
    if (insertion > previousInsertion && pointerY < centers[previousInsertion] + 8) insertion = previousInsertion;
    if (insertion < previousInsertion && pointerY > centers[previousInsertion - 1] - 8) insertion = previousInsertion;
  }
  if (insertion === sourceIndex) return null;
  return insertion === 0
    ? { boardId: remaining[0].id, edge: "before" }
    : { boardId: remaining[insertion - 1].id, edge: "after" };
}

export function clearListHeader<T extends ListManagerMetadata>(board: T): T {
  return { ...board, ...Object.fromEntries(HEADER_IMAGE_FIELDS.map((field) => [field, undefined])) };
}

/** Apply only edited metadata, preserving image imports and other work completed while the dialog was open. */
export function mergeListManagerEntry<T extends ListManagerMetadata & { updated: string }>(
  draft: T,
  original: T | undefined,
  current: T | undefined,
  fallbackName: string,
): T {
  const name = draft.name.trim() || fallbackName;
  const groupName = draft.groupName?.trim() || undefined;
  if (!original || !current) return { ...draft, name, groupName };

  const patch: Partial<ListManagerMetadata> = {};
  if (name !== original.name) patch.name = name;
  if (groupName !== (original.groupName?.trim() || undefined)) patch.groupName = groupName;
  // Replacing/removing an image replaces its entire crop; moving an existing image keeps updated asset URLs.
  const imageChanged = draft.headerImageSrc !== original.headerImageSrc;
  for (const field of HEADER_IMAGE_FIELDS) {
    if (imageChanged || draft[field] !== original[field]) Object.assign(patch, { [field]: draft[field] });
  }
  const changed = (Object.keys(patch) as (keyof ListManagerMetadata)[]).some((field) => patch[field] !== current[field]);
  return changed ? { ...current, ...patch, updated: "just now" } : current;
}
