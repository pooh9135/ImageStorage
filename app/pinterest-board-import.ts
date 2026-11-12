export type BoardImportFailure = { pin: PinterestBoardPin; message: string };
export type BoardImportPreparation = { cancelled: boolean; images: PinterestBoardImage[]; errors: BoardImportFailure[] };

export async function preparePinterestBoardImport(
  pins: PinterestBoardPin[],
  importImage: (url: string) => Promise<ImageImportResult>,
  isCancelled: () => boolean,
  onProgress: (done: number, total: number) => void,
): Promise<BoardImportPreparation> {
  const images: PinterestBoardImage[] = [], errors: BoardImportFailure[] = [], downloaded = new Map<string, ImportedImageData>();
  for (const [index, pin] of pins.entries()) {
    if (isCancelled()) return { cancelled: true, images, errors };
    try {
      const cached = downloaded.get(pin.imageUrl);
      if (cached) { images.push({ pin, image: { ...cached, originalImageUrl: pin.imageUrl } }); onProgress(index + 1, pins.length); continue; }
      const result = await importImage(pin.imageUrl);
      if (isCancelled()) return { cancelled: true, images, errors };
      const image = result.images?.[0];
      if (result.canceled || result.images?.length !== 1 || !image?.src || !(image.width > 0) || !(image.height > 0)) throw new Error(result.errors?.[0]?.message || "画像を取得できませんでした。");
      downloaded.set(pin.imageUrl, image);
      images.push({ pin, image: { ...image, originalImageUrl: pin.imageUrl } });
    } catch (error) {
      if (isCancelled()) return { cancelled: true, images, errors };
      errors.push({ pin, message: error instanceof Error ? error.message : "画像を取得できませんでした。" });
    }
    onProgress(index + 1, pins.length);
  }
  return { cancelled: false, images, errors };
}

export function pinterestBoardItems(images: PinterestBoardImage[], makeId: () => string) {
  return images.map(({ pin, image }, index) => {
    const scale = Math.min(340 / image.width, 440 / image.height);
    return {
      id: makeId(), type: "image" as const, x: 24 + (index % 5) * 380, y: 24 + Math.floor(index / 5) * 480,
      w: image.width * scale, h: image.height * scale, z: index + 1,
      src: image.src, thumbnailSrc: image.thumbnailSrc, assetId: image.assetId, palette: image.palette,
      processing: image.processing, caption: pin.title || image.name.replace(/\.[a-z0-9_-]{1,12}$/i, "") || "Reference",
      sourceUrl: pin.pinUrl, originalImageUrl: pin.imageUrl,
    };
  });
}
