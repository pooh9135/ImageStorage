function isPinterestHost(host) {
  return /^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2})$/i.test(host);
}

export function getPinterestBoardUrl(value) {
  let url;
  try { url = new URL(value); } catch { return ""; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !isPinterestHost(url.hostname)) return "";
  const pathname = url.pathname.replace(/\/$/, "");
  const parts = pathname.slice(1).split("/");
  if (parts.length < 2 || parts.length > 3 || pathname.includes("*") || /^(?:pin|search|ideas|today|settings|login|logout|home|shopping|explore|business|notifications)$/i.test(parts[0]) || parts.some(part => !part || part.startsWith("_") || /^(?:more_ideas|more-ideas)$/i.test(part))) return "";
  return `${url.origin}${pathname}/`;
}

function watchBoardContext() {
  if (window !== window.top || location.protocol !== "https:" || !isPinterestHost(location.hostname)) return;
  const api = globalThis.browser || globalThis.chrome;
  let lastBoard = "", evidence, scanTimer, stopTimer;
  function readBoardUrl() {
    const url = getPinterestBoardUrl(location.href);
    if (!url) return "";
    const heading = document.querySelector('[data-test-id^="board-header"] h1, [data-test-id="board-section-header"] h1');
    const marker = heading || document.querySelector('[data-test-id^="board-header"], [data-test-id="board-section-header"], [data-test-id="board-feed"], [data-test-id="board-pins"], [data-test-id="board-feed-container"], [data-test-id="board-count-info"], [data-test-id="board-pin-count"]');
    const name = heading?.textContent;
    const boardType = document.querySelector('meta[property="og:type"][content="pinterestapp:pinboard"]');
    const metadataUrl = document.querySelector('meta[property="og:url"]')?.content;
    const hasBoardMetadata = boardType && getPinterestBoardUrl(metadataUrl) === url;
    // During SPA navigation the previous board can still be on screen while
    // the new URL is loading. Do not treat its unchanged DOM as the new board.
    const stale = evidence && evidence.url !== url && evidence.marker.deref() === marker && evidence.name === name;
    if (!hasBoardMetadata && (!marker || stale || marker.closest('[hidden], [aria-hidden="true"]'))) return "";
    if (marker) evidence = { url, marker: new WeakRef(marker), name };
    return url;
  }

  const observer = new MutationObserver(() => { scanTimer ??= setTimeout(check, 50); });
  function stop() {
    observer.disconnect();
    clearTimeout(scanTimer);
    clearTimeout(stopTimer);
    scanTimer = undefined;
  }
  function check() {
    scanTimer = undefined;
    const board = readBoardUrl();
    if (board) stop();
    if (board === lastBoard) return;
    lastBoard = board;
    void api.runtime.sendMessage({ action: "context:board-changed" }).catch(() => {});
  }
  function watch() {
    stop();
    check();
    if (lastBoard || !getPinterestBoardUrl(location.href)) return;
    // Pinterest can render the board after navigation. Stop as soon as it is
    // identified, or after a bounded wait on pages that only look like boards.
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-test-id", "hidden", "aria-hidden", "content"] });
    stopTimer = setTimeout(stop, 15000);
  }
  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id === api.runtime.id && message?.action === "board:context") respond(readBoardUrl());
  });
  if (window.navigation) window.navigation.addEventListener("currententrychange", watch);
  else window.addEventListener("popstate", watch);
  window.addEventListener("pageshow", watch);
  window.addEventListener("pagehide", stop);
  watch();
}

export function pinterestBoardContextScript() {
  return `(() => {\n${isPinterestHost}\n${getPinterestBoardUrl}\n(${watchBoardContext})();\n})();\n`;
}
