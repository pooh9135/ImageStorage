export type CanvasSettings = {
  gridVisible: boolean;
  snapEnabled: boolean;
  gridSize: number;
  backgroundColor: string;
  backgroundFit: "cover" | "contain" | "tile";
  backgroundImageSrc?: string;
  backgroundImageThumbnailSrc?: string;
  backgroundImageAssetId?: string;
};

export const DEFAULT_CANVAS_SETTINGS: CanvasSettings = {
  gridVisible: false,
  snapEnabled: false,
  gridSize: 40,
  backgroundColor: "#171717",
  backgroundFit: "cover",
  // Explicit keys let a cleared shared background replace legacy board values.
  backgroundImageSrc: undefined,
  backgroundImageThumbnailSrc: undefined,
  backgroundImageAssetId: undefined,
};

function nonemptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

export function normalizeCanvasSettings(input: unknown): CanvasSettings {
  const value = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const color = nonemptyString(value.backgroundColor);
  return {
    gridVisible: typeof value.gridVisible === "boolean"
      ? value.gridVisible : DEFAULT_CANVAS_SETTINGS.gridVisible,
    snapEnabled: typeof value.snapEnabled === "boolean"
      ? value.snapEnabled : DEFAULT_CANVAS_SETTINGS.snapEnabled,
    gridSize: typeof value.gridSize === "number" && Number.isFinite(value.gridSize)
      ? Math.max(10, Math.min(120, value.gridSize)) : DEFAULT_CANVAS_SETTINGS.gridSize,
    backgroundColor: color && /^#[0-9a-f]{6}$/i.test(color)
      ? color.toLowerCase() : DEFAULT_CANVAS_SETTINGS.backgroundColor,
    backgroundFit: value.backgroundFit === "cover" || value.backgroundFit === "contain" || value.backgroundFit === "tile"
      ? value.backgroundFit : DEFAULT_CANVAS_SETTINGS.backgroundFit,
    backgroundImageSrc: nonemptyString(value.backgroundImageSrc),
    backgroundImageThumbnailSrc: nonemptyString(value.backgroundImageThumbnailSrc),
    backgroundImageAssetId: nonemptyString(value.backgroundImageAssetId),
  };
}

export function applyCanvasSettings<T extends object>(
  boards: T[],
  canvas: CanvasSettings,
): (T & CanvasSettings)[] {
  // Select only shared fields, including explicit clears; board content stays intact.
  const shared = normalizeCanvasSettings(canvas);
  return boards.map((board) => ({ ...board, ...shared }));
}
