export type ImageDropResult = {
  files: File[];
  url?: string;
  error?: "browser-only" | "empty";
};

const imageDropTypes = new Set([
  "files", "text/uri-list", "text/plain", "text/html",
  "text/x-moz-url", "text/x-moz-url-data",
]);

export function hasImageDropData(data: Pick<DataTransfer, "types">): boolean {
  const types = Array.from(data.types, (type) => type.toLowerCase());
  return !types.includes("text/x-imagestorage-board") &&
    types.some((type) => imageDropTypes.has(type));
}

export function getImageDropEffect(data: Pick<DataTransfer, "effectAllowed">): DataTransfer["dropEffect"] {
  // Browser links can permit only "link". Forcing "copy" cancels the drop
  // before onDrop runs. Never report "move": importing must keep the source.
  switch (data.effectAllowed) {
    case "link":
    case "linkMove":
      return "link";
    case "none":
    case "move":
      return "none";
    default:
      return "copy";
  }
}

function readableUrl(value: string, base?: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) return;
  if (/^[a-z]:[\\/]/i.test(trimmed) || /^\\\\[^\\]+\\[^\\]+/.test(trimmed)) {
    return trimmed;
  }
  if (/^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(trimmed)) return trimmed;
  try {
    const parsed = base ? new URL(trimmed, base) : new URL(trimmed);
    if (["http:", "https:", "file:"].includes(parsed.protocol)) return parsed.href;
  } catch {
    // A drag payload may contain a caption, relative path, or malformed URL.
  }
}

function baseUrl(value: string): string | undefined {
  const url = readableUrl(value);
  return url && /^(?:https?|file):/i.test(url) ? url : undefined;
}

export function readImageDrop(data: Pick<DataTransfer, "files" | "getData">): ImageDropResult {
  const droppedFiles = Array.from(data.files);
  // Browser link drags can arrive as virtual Internet Shortcut files alongside
  // the real image HTML/URL. These files contain a link, not image pixels.
  const shortcutsOnly = droppedFiles.length > 0 &&
    droppedFiles.every((file) => /\.(?:url|webloc)$/i.test(file.name));
  if (droppedFiles.length && !shortcutsOnly) return { files: droppedFiles };
  const files: File[] = [];

  const read = (type: string) => {
    try {
      return data.getData(type).trim();
    } catch {
      return "";
    }
  };
  const uriLines = read("text/uri-list").split(/\r?\n/)
    .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const firefoxUrls = [read("text/x-moz-url-data"), read("text/x-moz-url")]
    .map((value) => value.split(/\r?\n/, 1)[0].trim());
  const plainValue = read("text/plain");
  const plain = /\s/.test(plainValue) &&
    !/^(?:[a-z]:[\\/]|\\\\|file:|data:image\/)/i.test(plainValue) ? "" : plainValue;
  const candidates = [...firefoxUrls, ...uriLines, plain];
  const html = read("text/html");
  let browserOnlyImage = false;

  if (html && typeof document !== "undefined") {
    // Template contents stay inert: never attach, adopt, or render dropped HTML.
    const template = document.createElement("template");
    template.innerHTML = html;
    const header = html.slice(0, html.indexOf("<") === -1 ? html.length : html.indexOf("<"));
    const sourceUrl = header.match(/(?:^|[\r\n])SourceURL:\s*([^\r\n]+)/i)?.[1];
    const fallbackBase = (sourceUrl && baseUrl(sourceUrl)) ||
      [...uriLines, ...firefoxUrls].map(baseUrl).find(Boolean);
    const htmlBase = template.content.querySelector("base[href]")?.getAttribute("href");
    const resolvedBase = (htmlBase && readableUrl(htmlBase, fallbackBase)) || fallbackBase;
    const imageBase = resolvedBase && baseUrl(resolvedBase);

    for (const image of Array.from(template.content.querySelectorAll("img"))) {
      for (const attribute of ["src", "data-src"]) {
        const value = image.getAttribute(attribute)?.trim() || "";
        const url = readableUrl(value, imageBase);
        if (url) return { files, url };
        if (/^blob:/i.test(value)) browserOnlyImage = true;
      }
    }
    // A linked page is not a substitute for a browser-private image source.
    if (browserOnlyImage) return { files, error: "browser-only" };
  }

  for (const candidate of candidates) {
    // A text/plain payload must itself be a URL/path, not HTML or a caption.
    const url = readableUrl(candidate);
    if (url) return { files, url };
  }
  return {
    files,
    error: candidates.some((value) => /^blob:/i.test(value)) ? "browser-only" : "empty",
  };
}
