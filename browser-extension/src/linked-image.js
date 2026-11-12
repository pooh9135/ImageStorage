// Serialized into the frame where the user chose the context-menu command.
// Resolve only that link's visible image; never substitute the page's main image.
export function resolveLinkedImage(linkUrl, context = globalThis.__imageStorageContextPosition) {
  function url(value, image = false) {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const parsed = new URL(value, document.baseURI);
      if (parsed.username || parsed.password) return "";
      if (["http:", "https:"].includes(parsed.protocol) || (image && (parsed.protocol === "blob:" || /^data:image\//i.test(parsed.href)))) return parsed.href;
    } catch { /* Ignore unusable image and link URLs. */ }
    return "";
  }
  const expected = typeof linkUrl === "string" ? url(linkUrl) : "";
  if (!expected) return null;
  const point = context?.point && Number.isFinite(context.point.at) && context.point.at <= Date.now() && Date.now() - context.point.at < 120000 ? context.point : null;
  const target = point && context.target?.isConnected ? context.target.closest?.("a[href]") : null;
  const sameLink = element => element && url(element.href) === expected;
  const visible = element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return box.width > 8 && box.height > 8 && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight && style.display !== "none" && style.visibility !== "hidden";
  };
  const containsPoint = box => point && point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  const links = Array.from(document.querySelectorAll("a[href]")).filter(element => sameLink(element) && visible(element));
  // Keep the actual clicked node first, including links inside an open shadow root.
  if (sameLink(target) && visible(target)) { const index = links.indexOf(target); if (index >= 0) links.splice(index, 1); links.unshift(target); }
  else links.sort((a, b) => Number(containsPoint(b.getBoundingClientRect())) - Number(containsPoint(a.getBoundingClientRect())));
  const results = [];
  for (const link of links) {
    const linkBox = link.getBoundingClientRect();
    let scope = link;
    for (let depth = 0; scope && depth < 5 && scope !== document.body && scope !== document.documentElement; depth++, scope = scope.parentElement) {
      const candidates = Array.from(scope.querySelectorAll("img")).filter(image => {
        if (!visible(image) || !url(image.currentSrc || image.src, true)) return false;
        const owner = image.closest("a[href]");
        if (owner && !sameLink(owner)) return false;
        if (link.contains(image)) return true;
        // Some grids put a transparent link beside, rather than around, an image.
        // Require the image to sit mostly behind this link, not a neighbouring card.
        const box = image.getBoundingClientRect();
        const overlap = Math.max(0, Math.min(box.right, linkBox.right) - Math.max(box.left, linkBox.left)) * Math.max(0, Math.min(box.bottom, linkBox.bottom) - Math.max(box.top, linkBox.top));
        return overlap / (box.width * box.height) >= 0.5;
      });
      if (!candidates.length) continue;
      candidates.sort((a, b) => {
        const left = a.getBoundingClientRect(), right = b.getBoundingClientRect();
        return Number(containsPoint(right)) - Number(containsPoint(left)) || right.width * right.height - left.width * left.height;
      });
      const selected = candidates[0];
      const result = { imageUrl: url(selected.currentSrc || selected.src, true), sourceUrl: expected };
      if (link === target || containsPoint(linkBox)) return result;
      results.push(result);
      break;
    }
  }
  // Without a recent click (e.g. a page not yet reloaded after an extension
  // update), exact-link matching is safe only when it identifies one image.
  const unique = new Map(results.map(result => [result.imageUrl, result]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}
