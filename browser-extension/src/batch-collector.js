// Serialized into the source frame. Inspect loaded image elements only; do not
// scroll, open links, call site APIs, or fetch images during discovery.
export function collectPageImages() {
  const images = [], seen = new Set();
  let limited = false;
  const url = (value, image = false) => {
    if (typeof value !== "string" || value.length > 16384) return "";
    try {
      const parsed = new URL(value, document.baseURI);
      if (parsed.username || parsed.password) return "";
      return ["http:", "https:"].includes(parsed.protocol) || (image && (parsed.protocol === "blob:" || /^data:image\//i.test(parsed.href))) ? parsed.href : "";
    } catch { return ""; }
  };
  const roots = [document];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot && !element.id.startsWith("imagestorage-")) roots.push(element.shadowRoot);
    for (const image of root.querySelectorAll("img")) {
      const box = image.getBoundingClientRect(), style = getComputedStyle(image);
      if (!image.complete || !image.naturalWidth || !image.naturalHeight || box.width < 64 || box.height < 64 || Math.max(image.naturalWidth, image.naturalHeight) < 96 || style.display === "none" || style.visibility === "hidden" || image.closest('[aria-hidden="true"]')) continue;
      const imageUrl = url(image.currentSrc || image.src, true);
      if (!imageUrl) continue;
      const parsed = new URL(imageUrl);
      const hash = parsed.hostname === "i.pinimg.com" && parsed.pathname.match(/\/([a-f0-9]{32})\.(?:jpe?g|png|webp|gif|avif)$/i)?.[1];
      parsed.hash = "";
      const key = hash ? `pinimg:${hash.toLowerCase()}` : parsed.href;
      if (seen.has(key)) continue;
      let sourceUrl = url(image.closest("a[href]")?.href) || url(location.href);
      if (!image.closest("a[href]")) {
        // Pinterest grids can place a link over the image as a sibling.
        let scope = image.parentElement;
        for (let depth = 0; scope && depth < 3 && scope !== document.body; depth++, scope = scope.parentElement) {
          const links = [...scope.querySelectorAll("a[href]")].filter(link => {
            const rect = link.getBoundingClientRect();
            const overlap = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left)) * Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
            return url(link.href) && overlap / (box.width * box.height) >= 0.5;
          });
          const sources = new Set(links.map(link => url(link.href)));
          if (sources.size === 1) { sourceUrl = [...sources][0]; break; }
        }
      }
      if (images.length >= 200) { limited = true; continue; }
      seen.add(key);
      images.push({ imageUrl, sourceUrl, width: image.naturalWidth, height: image.naturalHeight, alt: (image.alt || "").slice(0, 180) });
    }
  }
  return { images, limited };
}
