import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..", "..");
const sourcePath = path.join(
  projectDirectory,
  "design",
  "logo-concepts",
  "imagestorage-hand-code-logo.png",
);
const assetsDirectory = path.join(projectDirectory, "desktop", "assets");
const publicDirectory = path.join(projectDirectory, "desktop", "public");
const iconSizes = [16, 24, 32, 48, 64, 128, 256];

await Promise.all([
  mkdir(assetsDirectory, { recursive: true }),
  mkdir(publicDirectory, { recursive: true }),
]);

const resizeLogo = (size) => {
  const radius = size * 0.22;
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${radius}" fill="white"/></svg>`,
  );
  return sharp(sourcePath)
    .resize(size, size, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .composite([{ input: mask, blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
};

const [appIcon, titlebarLogo, ...icoImages] = await Promise.all([
  resizeLogo(512),
  resizeLogo(64),
  ...iconSizes.map((size) => resizeLogo(size)),
]);

const headerSize = 6;
const entrySize = 16;
let imageOffset = headerSize + entrySize * iconSizes.length;
const icoHeader = Buffer.alloc(headerSize);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(iconSizes.length, 4);

const icoEntries = iconSizes.map((size, index) => {
  const image = icoImages[index];
  const entry = Buffer.alloc(entrySize);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(imageOffset, 12);
  imageOffset += image.length;
  return entry;
});

await Promise.all([
  writeFile(path.join(assetsDirectory, "icon.png"), appIcon),
  writeFile(
    path.join(assetsDirectory, "icon.ico"),
    Buffer.concat([icoHeader, ...icoEntries, ...icoImages]),
  ),
  writeFile(path.join(publicDirectory, "imagestorage-logo.png"), titlebarLogo),
]);

console.log("Generated ImageStorage desktop icons from the selected logo.");
