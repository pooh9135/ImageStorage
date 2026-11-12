// Keep right-click placement locally. A hovered image's URL is sent only to
// this extension so it can check saved-list membership in the local app.
(() => {
  if (globalThis.__imageStorageContextPosition) return;
  const state = { point: null, target: null };
  globalThis.__imageStorageContextPosition = state;
  const messageType = "imagestorage:context-position";
  const lifetime = 2 * 60 * 1000;
  let lastSelection = "", lastSent = 0;
  function announce(event, force = false) {
    if (!event.isTrusted) return;
    const target = event.composedPath().find(node => node instanceof Element) || event.target;
    const link = target?.closest?.("a[href]");
    const image = target?.closest?.("img");
    const context = { target, point: { x: event.clientX, y: event.clientY, at: Date.now() } };
    const linked = !image && link ? globalThis.__imageStorageResolveLinkedImage?.(link.href, context) : null;
    const raw = image ? image.currentSrc || image.src : linked?.imageUrl;
    const imageUrl = /^https?:/i.test(raw || "") ? raw : "";
    const sourceUrl = imageUrl ? (link?.href || location.href) : "";
    const signature = JSON.stringify([imageUrl, sourceUrl]);
    if (signature === lastSelection && (!force || Date.now() - lastSent < 500)) return;
    lastSelection = signature; lastSent = Date.now();
    const api = globalThis.browser?.runtime?.getBrowserInfo ? globalThis.browser : globalThis.chrome || globalThis.browser;
    try { void api?.runtime?.sendMessage({ action: "context:image", imageUrl, sourceUrl }).catch(() => {}); } catch { /* Extension may be updating. */ }
  }
  window.addEventListener("pointerover", event => announce(event), { capture: true, passive: true });
  window.addEventListener("focusin", event => announce(event), { capture: true, passive: true });
  window.addEventListener("pointerdown", event => { if (event.button === 2) announce(event, true); }, { capture: true, passive: true });

  function remember(x, y, at = Date.now(), target = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || state.point?.at > at) return;
    state.point = { x, y, at };
    state.target = target;
    if (window.parent !== window) {
      // Each parent maps its direct child's viewport into its own viewport.
      // Only coordinates cross frame boundaries, including cross-origin frames.
      window.parent.postMessage({ type: messageType, x, y, at, width: innerWidth, height: innerHeight }, "*");
    }
  }

  window.addEventListener("contextmenu", (event) => {
    if (!event.isTrusted) return;
    let x = event.clientX, y = event.clientY;
    if (event.button !== 2 && x === 0 && y === 0) {
      const rect = event.target?.getBoundingClientRect?.();
      if (rect) { x = rect.left + rect.width / 2; y = rect.top + rect.height / 2; }
    }
    remember(x, y, Date.now(), event.composedPath().find(node => node instanceof Element) || event.target);
    announce(event, true);
  }, { capture: true, passive: true });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!event.isTrusted || data?.type !== messageType || !event.source || event.source === window) return;
    if (![data.x, data.y, data.width, data.height, data.at].every(Number.isFinite)
      || data.width <= 0 || data.height <= 0 || data.x < 0 || data.y < 0
      || data.x > data.width || data.y > data.height || data.at > Date.now()
      || Date.now() - data.at > lifetime) return;
    const frame = Array.from(document.querySelectorAll("iframe, frame")).find((entry) => entry.contentWindow === event.source);
    if (!frame || !frame.offsetWidth || !frame.offsetHeight) return;
    const rect = frame.getBoundingClientRect();
    remember(
      rect.left + (frame.clientLeft + data.x / data.width * frame.clientWidth) * rect.width / frame.offsetWidth,
      rect.top + (frame.clientTop + data.y / data.height * frame.clientHeight) * rect.height / frame.offsetHeight,
      data.at,
    );
  });
  window.addEventListener("pagehide", () => { state.point = null; state.target = null; });
})();
