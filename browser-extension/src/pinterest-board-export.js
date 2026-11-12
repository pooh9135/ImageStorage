// Runs in the active page's isolated world. No Pinterest API, image download,
// native-app connection is used. Automatic scrolling starts only on request.
export function showPinterestBoardExporter(config) {
  const pinterestHost = value => /^(?:(?:www|[a-z]{2})\.)?pinterest\.(?:com(?:\.[a-z]{2})?|co\.[a-z]{2}|[a-z]{2})$/i.test(value);
  let boardUrl;
  try {
    boardUrl = new URL(config.boardUrl);
    const parts = boardUrl.pathname.split("/").filter(Boolean);
    if (boardUrl.protocol !== "https:" || boardUrl.username || boardUrl.password || !pinterestHost(boardUrl.hostname) || parts.length < 2 || parts.length > 3 || /^(?:pin|search|ideas|today|settings|login|logout|home|shopping|explore|business|notifications)$/i.test(parts[0]) || parts.some(part => part.startsWith("_") || /^(?:more_ideas|more-ideas)$/i.test(part))) return { shown: false, error: "Pinterestで書き出したいボードを開いてください。" };
    boardUrl.search = ""; boardUrl.hash = "";
  } catch { return { shown: false, error: "Pinterestのボードを開いてください。" }; }
  globalThis.__imageStorageBoardExporter?.close();
  const pins = new Map(), excluded = new Set(), cards = new Map(), knownFeeds = new WeakSet(), ignoredImages = new WeakMap();
  let closed = false, collecting = true, scanTimer = null, reviewed = false, displayLimit = 60, limited = false, notice = "";
  let autoRunning = false, autoRunId = 0, expectedPins = null, captureMode = "manual-scroll", complete = false, finishReason = "manual";
  let autoCleanup = null, exportPending = false, scanReady = false, scanExpected = null;
  const previousFocus = document.activeElement;
  const host = document.createElement("div"); host.id = "imagestorage-board-exporter"; host.setAttribute("popover", "manual");
  for (const [name, value] of Object.entries({ all: "initial", position: "fixed", inset: "auto", top: "20px", right: "20px", margin: "0", border: "0", padding: "0", background: "transparent", "z-index": "2147483647", "color-scheme": "dark" })) host.style.setProperty(name, value, "important");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host{color:#ededed;color-scheme:dark;font:12px/1.5 "Segoe UI","Yu Gothic UI",sans-serif}*{box-sizing:border-box}.panel{display:flex;flex-direction:column;width:min(420px,calc(100vw - 24px));max-height:calc(100vh - 40px);background:#242424;border:1px solid #414141;border-radius:4px;box-shadow:0 8px 26px #0007;color:#ededed;font:12px/1.5 "Segoe UI","Yu Gothic UI",sans-serif;text-align:left;overflow:hidden}header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #ffffff14;cursor:grab;touch-action:none;user-select:none;flex-shrink:0}h2{font-size:13px;margin:0;flex:1;font-weight:600}button,input{font:inherit;color:inherit}button{background:#202020;border:1px solid #484848;border-radius:3px;padding:7px 10px;cursor:pointer}button:hover:enabled{background:#363636}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #aaa;outline-offset:2px}.close{border:0;background:transparent;color:#aaa;font-size:20px;padding:0;width:24px;height:24px}.body{padding:12px;display:grid;gap:10px;flex-shrink:0}.body label{display:grid;gap:6px;color:#b5b5b5}input[type=text]{width:100%;background:#181818;border:1px solid #484848;border-radius:3px;padding:8px}.count{font-size:15px;font-weight:600;color:#eee}.hint,.status{margin:0;color:#aaa;font-size:11px;overflow-wrap:anywhere}.actions,footer{display:flex;gap:8px;align-items:center}footer{padding:12px;border-top:1px solid #ffffff14;flex-shrink:0}.export{background:#0c0c0c;flex:1}.gallery{overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:0 12px 12px;min-height:0}.card{position:relative;display:grid;gap:4px;min-width:0;font-size:10px;color:#aaa}.card img{width:100%;height:100px;object-fit:contain;background:#191919}.card input{position:absolute;left:5px;top:5px;width:15px;height:15px;accent-color:#ccc}.card span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.more{grid-column:1/-1}.status{padding:0 12px 10px;flex-shrink:0}[hidden]{display:none!important}`;
  const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
  const panel = element("section", "panel"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Pinterestボードを書き出す");
  const header = element("header"), title = element("h2", "", "Pinterestボードを書き出す"), closeButton = element("button", "close", "×"); closeButton.setAttribute("aria-label", "閉じる"); header.append(title, closeButton);
  const body = element("div", "body"), label = element("label", "", "ボード名"), name = element("input"); name.type = "text"; name.maxLength = 120;
  name.value = (document.querySelector("h1")?.textContent?.trim() || document.title.replace(/\s*[|｜-]\s*Pinterest.*$/i, "").trim() || decodeURIComponent(boardUrl.pathname.split("/").filter(Boolean)[1])).slice(0, 120); label.append(name);
  const count = element("div", "count"), hint = element("p", "hint", "書き出すときに先頭から末尾まで自動で読み込みます。手でスクロールする必要はありません。"), actions = element("div", "actions"), auto = element("button", "auto", "ボード全体を収集"), toggle = element("button", "toggle", "収集を停止"), review = element("button", "review", "画像を確認"); actions.append(auto, toggle, review);
  body.append(label, count, hint, actions);
  const gallery = element("div", "gallery"); gallery.hidden = true;
  const status = element("p", "status"); status.setAttribute("role", "status");
  const footer = element("footer"), partialExport = element("button", "partial-export", "収集済みのみ"), exportButton = element("button", "export", "全体を収集して書き出す"); partialExport.title = "未読み込みの画像を含めず、現在収集した画像だけを書き出します。"; footer.append(partialExport, exportButton);
  panel.append(header, body, gallery, status, footer); root.append(style, panel); document.documentElement.append(host);
  try { host.showPopover(); } catch { /* Fixed positioning is the fallback. */ }
  const selectedPins = () => [...pins.values()].filter(pin => !excluded.has(pin.pinUrl));
  function render() {
    if (closed) return;
    const selected = pins.size - excluded.size;
    count.textContent = `${selected.toLocaleString()}枚を収集${expectedPins !== null ? ` / ボード ${expectedPins.toLocaleString()}件` : ""}${excluded.size ? `（除外 ${excluded.size}枚）` : ""}${collecting ? autoRunning ? "・全体を収集中" : "・収集中" : ""}`;
    exportButton.disabled = autoRunning || exportPending || !name.value.trim(); exportButton.textContent = exportPending ? "全体を読み込み中…" : "全体を収集して書き出す";
    partialExport.disabled = autoRunning || exportPending || !selected || !name.value.trim(); toggle.textContent = collecting ? "収集を停止" : "収集を再開";
    auto.textContent = autoRunning ? "全体収集を停止" : "ボード全体を収集";
    status.textContent = notice || (limited ? "収集上限の5,000枚に達しました。このファイルを書き出してから、対象を分けてください。" : "画像本体は、ImageStorageでこのファイルを読み込む際に取得します。");
    gallery.hidden = !reviewed; review.textContent = reviewed ? "一覧を閉じる" : "画像を確認";
    if (!reviewed) return;
    gallery.querySelector(".more")?.remove();
    for (const pin of [...pins.values()].slice(0, displayLimit)) {
      if (cards.has(pin.pinUrl)) continue;
      const card = element("label", "card"), image = element("img"), input = element("input"), caption = element("span", "", pin.title || pin.pinUrl);
      image.src = pin.imageUrl; image.alt = ""; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; image.draggable = false;
      input.type = "checkbox"; input.checked = !excluded.has(pin.pinUrl); input.setAttribute("aria-label", pin.title || pin.pinUrl);
      input.addEventListener("change", () => { if (input.checked) excluded.delete(pin.pinUrl); else excluded.add(pin.pinUrl); render(); });
      card.title = pin.pinUrl; card.append(image, input, caption); cards.set(pin.pinUrl, card); gallery.append(card);
    }
    if (pins.size > displayLimit) { const more = element("button", "more", `さらに表示（残り${pins.size - displayLimit}枚）`); more.addEventListener("click", () => { displayLimit += 60; render(); }); gallery.append(more); }
  }
  function currentBoard() {
    try { const current = new URL(location.href); return pinterestHost(current.hostname) && current.pathname.replace(/\/$/, "") === boardUrl.pathname.replace(/\/$/, ""); } catch { return false; }
  }
  function pinLink(value) {
    try { const url = new URL(value, boardUrl); if (url.protocol === "https:" && !url.username && !url.password && pinterestHost(url.hostname) && /^\/pin\/\d+\/?$/.test(url.pathname)) return `https://www.pinterest.com/pin/${url.pathname.split("/")[2]}/`; } catch { /* Not a Pin link. */ }
    return "";
  }
  const feedSelector = '[data-test-id="board-feed"], [data-test-id="board-pins"], [data-test-id="board-feed-container"]';
  const fallbackSelector = 'main [data-test-id="masonry-container"], [role="main"] [data-test-id="masonry-container"]';
  const forbidden = '[data-test-id*="promoted"], [data-test-id*="more-ideas"], [data-test-id*="recommend"], [data-test-id*="related"], [data-test-id*="avatar"], [data-ad-id], [aria-hidden="true"]';
  const recommendation = node => /^(?:more ideas|more like this|ideas you might love|このボードに似たアイデア|おすすめのアイデア|その他のアイデア)/i.test(node?.textContent?.trim() || "");
  function feeds() {
    const preferred = [...document.querySelectorAll(feedSelector)], masonry = [...document.querySelectorAll(fallbackSelector)];
    const candidates = preferred.length ? preferred : masonry.length ? masonry : [...document.querySelectorAll('main, [role="main"]')];
    return candidates.filter(feed => {
      if (feed.closest(forbidden)) return false;
      if (!preferred.length) {
        const preceding = [...document.querySelectorAll("h2,h3,h4,[role=heading]")].filter(node => node.compareDocumentPosition(feed) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
        if (recommendation(preceding)) return false;
      }
      knownFeeds.add(feed); return true;
    });
  }
  function boardCount() {
    const explicit = [...document.querySelectorAll('[data-test-id*="pin-count"], [data-test-id*="pinCount"], [data-test-id="board-count-info"]')];
    const heading = document.querySelector("h1");
    const nodes = [...explicit];
    for (let scope = heading?.parentElement, depth = 0; scope && depth < 3; scope = scope.parentElement, depth++) nodes.push(...scope.querySelectorAll("span,p,[aria-label]"));
    for (const node of nodes) {
      for (const raw of [node.textContent, node.getAttribute("aria-label")]) {
        const text = raw?.trim().normalize("NFKC") || "";
        if (text.length > 60) continue;
        const match = text.match(/^([\d,\s]+)\s*(?:pins?\b|(?:件の)?ピン)/i) || text.match(/^(?:pins?\b|ピン)\s*[:：]?\s*([\d,\s]+)\s*(?:件)?$/i);
        const value = match ? Number(match[1].replace(/[,\s]/g, "")) : NaN;
        if (Number.isSafeInteger(value) && value >= 0) return value;
      }
    }
    return null;
  }
  function owningFeed(node) {
    for (let current = node?.nodeType === 1 ? node : node?.parentElement; current; current = current.parentElement) if (knownFeeds.has(current)) return current;
    return null;
  }
  const imagesIn = node => node?.matches?.("img") ? [node] : [...(node?.querySelectorAll?.("img") || [])];
  const imageFingerprint = image => [image.getAttribute("src"), image.getAttribute("srcset"), image.closest("a[href]")?.getAttribute("href")].join("\n");
  function capture(rootNode, feed, detached = false) {
    const images = imagesIn(rootNode);
    const headings = [...feed.querySelectorAll("h1,h2,h3,h4,[role=heading]")];
    if (rootNode !== feed) headings.push(...(rootNode?.querySelectorAll?.("h1,h2,h3,h4,[role=heading]") || []));
    if (rootNode?.matches?.("h1,h2,h3,h4,[role=heading]")) headings.push(rootNode);
    const boundaries = headings.filter(recommendation);
    for (const image of images) {
      const fingerprint = imageFingerprint(image);
      if (image.closest(forbidden) || boundaries.some(boundary => { const position = boundary.compareDocumentPosition(image); return !(position & Node.DOCUMENT_POSITION_DISCONNECTED) && (position & Node.DOCUMENT_POSITION_FOLLOWING); })) { ignoredImages.set(image, fingerprint); continue; }
      if (detached && ignoredImages.get(image) === fingerprint) continue;
      if (!detached) ignoredImages.delete(image);
      const owner = image.closest("a[href]");
      if (owner && !pinLink(owner.href)) continue;
      const box = image.getBoundingClientRect();
      // Export metadata does not require image decoding. A removed/virtualized
      // card has no box, but still carries its Pin link and image source.
      if (box.width > 0 && box.height > 0 && Math.max(box.width, box.height) < 64) continue;
      const declaredWidth = Number(image.getAttribute("width")), declaredHeight = Number(image.getAttribute("height"));
      if (declaredWidth > 0 && declaredHeight > 0 && Math.max(declaredWidth, declaredHeight) < 64) continue;
      const sourceSet = (image.getAttribute("srcset") || "").split(",").map(entry => entry.trim().split(/\s+/)[0]);
      let imageUrl = "";
      // currentSrc may still describe the previous Pin when a card is reused.
      for (const value of [image.getAttribute("src"), ...sourceSet.reverse(), image.currentSrc, image.getAttribute("data-src")]) {
        try { const url = new URL(value || "", boardUrl); if (url.protocol === "https:" && url.hostname === "i.pinimg.com" && !url.username && !url.password && url.href.length <= 16384) { imageUrl = url.href; break; } } catch { /* Try the next source. */ }
      }
      if (!imageUrl) continue;
      let pinUrl = pinLink(owner?.href);
      if (!pinUrl) {
        let scope = image.parentElement;
        for (let depth = 0; scope && scope !== feed && depth < 4 && !pinUrl; depth++, scope = scope.parentElement) {
          const candidates = [...scope.querySelectorAll("a[href]")].filter(link => {
            if (!pinLink(link.href)) return false;
            if (detached || box.width === 0 || box.height === 0) return true;
            const rect = link.getBoundingClientRect();
            const overlap = Math.max(0, Math.min(box.right, rect.right) - Math.max(box.left, rect.left)) * Math.max(0, Math.min(box.bottom, rect.bottom) - Math.max(box.top, rect.top));
            return overlap / (box.width * box.height) >= 0.5;
          });
          const urls = new Set(candidates.map(link => pinLink(link.href))); if (urls.size === 1) pinUrl = [...urls][0];
        }
      }
      if (!pinUrl) continue;
      if (!pins.has(pinUrl) && pins.size >= 5000) { limited = true; continue; }
      const previous = pins.get(pinUrl);
      if (!previous || previous.imageUrl !== imageUrl) { scanReady = false; complete = false; }
      pins.set(pinUrl, { pinUrl, imageUrl, title: (image.alt || previous?.title || "").slice(0, 180), width: image.naturalWidth || declaredWidth || box.width || previous?.width || 0, height: image.naturalHeight || declaredHeight || box.height || previous?.height || 0 });
    }
  }
  function collect() {
    if (!collecting || closed) return;
    if (!currentBoard()) { collecting = false; autoRunning = false; autoRunId++; complete = false; scanReady = false; autoCleanup?.(); autoCleanup = null; observer.disconnect(); notice = "ページが切り替わったため収集を停止しました。収集済みの画像は元のボードのものです。"; render(); return; }
    const roots = feeds();
    if (!roots.length) { notice = "ボードの画像一覧を検出できません。ボードの画像が表示されてから収集を再開してください。"; render(); return; }
    if (notice.startsWith("ボードの画像一覧を検出できません。")) notice = "";
    const before = pins.size;
    expectedPins = boardCount();
    if (scanReady && scanExpected !== expectedPins) scanReady = false;
    if (complete && (expectedPins === null || expectedPins !== pins.size)) { complete = false; finishReason = "count-changed"; notice = "ボードの件数が変わりました。全体収集を再開して件数を確認してください。"; }
    for (const feed of roots) capture(feed, feed);
    if (pins.size !== before) { if (!autoRunning) notice = ""; complete = false; }
    render();
  }
  const schedule = () => { if (!collecting || closed) return; clearTimeout(scanTimer); scanTimer = setTimeout(collect, 100); };
  const observer = new MutationObserver(records => {
    if (!collecting || closed || !currentBoard()) { schedule(); return; }
    feeds();
    for (const record of records) {
      const feed = owningFeed(record.target);
      if (!feed) continue;
      const boundary = [...feed.querySelectorAll("h1,h2,h3,h4,[role=heading]")].find(recommendation);
      const previous = record.previousSibling;
      if (record.target.closest?.(forbidden) || (boundary && previous && feed.contains(previous) && (previous === boundary || (boundary.compareDocumentPosition(previous) & Node.DOCUMENT_POSITION_FOLLOWING)))) continue;
      if (record.type === "attributes") capture(record.target.closest?.('[data-test-id="pin"], [data-test-id="pinWrapper"]') || record.target.parentElement || record.target, feed, !record.target.isConnected);
      // Removed siblings no longer have comparable document positions. Preserve
      // the recommendation boundary carried by the mutation's ordered snapshot.
      for (const nodes of [record.addedNodes, record.removedNodes]) {
        let beyondRecommendations = false;
        for (const node of nodes) {
          if (beyondRecommendations) { for (const image of imagesIn(node)) ignoredImages.set(image, imageFingerprint(image)); continue; }
          capture(node, feed, !node.isConnected);
          beyondRecommendations = (node.matches?.("h1,h2,h3,h4,[role=heading]") && recommendation(node)) || [...(node.querySelectorAll?.("h1,h2,h3,h4,[role=heading]") || [])].some(recommendation);
        }
      }
    }
    schedule();
  });
  const observe = () => observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcset", "href"] });
  const stopAuto = message => { autoRunning = false; autoRunId++; complete = false; scanReady = false; finishReason = "stopped"; autoCleanup?.(); autoCleanup = null; if (message) notice = message; render(); };
  function scrollContainer(feed) {
    for (let node = feed; node && node !== document.body; node = node.parentElement) if (node.clientHeight > 0 && /(?:auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 3) return node;
    return document.scrollingElement || document.documentElement;
  }
  function scrollExtent(scroller, roots) {
    const top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top + scroller.clientTop;
    let limit = Math.max(0, scroller.scrollHeight - scroller.clientHeight), marker = false;
    const boundaries = [...document.querySelectorAll('h2,h3,h4,[role="heading"],[data-test-id*="more-ideas"],[data-test-id*="related-pins"],[data-test-id*="recommendations"]')];
    for (const boundary of boundaries) {
      if (!recommendation(boundary) && !boundary.matches('[data-test-id*="more-ideas"],[data-test-id*="related-pins"],[data-test-id*="recommendations"]')) continue;
      const rect = boundary.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || (scroller !== document.scrollingElement && !scroller.contains(boundary))) continue;
      if (!roots.some(feed => feed.contains(boundary) || (feed.closest('main,[role="main"]') === boundary.closest('main,[role="main"]') && (feed.compareDocumentPosition(boundary) & Node.DOCUMENT_POSITION_FOLLOWING)))) continue;
      limit = Math.min(limit, Math.max(0, rect.top - top + scroller.scrollTop - scroller.clientHeight + 24)); marker = true;
    }
    // A virtualized feed can have height:0 while its children overflow. Only an
    // explicit recommendation boundary may shorten the real scrollable range.
    return { limit, marker };
  }
  function isLoading(scroller, roots, limit) {
    const scopes = scroller === document.scrollingElement ? [...new Set(roots.map(feed => feed.closest('main,[role="main"]') || feed))] : [scroller];
    return scopes.some(scope => [scope, ...scope.querySelectorAll('[aria-busy="true"],[role="progressbar"],[data-test-id*="spinner"]')].some(node => {
      if (node.getAttribute("aria-busy") !== "true" && !node.matches('[role="progressbar"],[data-test-id*="spinner"]')) return false;
      const box = node.getBoundingClientRect(), offset = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
      return box.width > 0 && box.height > 0 && box.top - offset + scroller.scrollTop <= limit + scroller.clientHeight + 100;
    }));
  }
  async function collectAll() {
    if (autoRunning) { stopAuto("全体収集を停止しました。収集済みの画像は保持しています。"); return false; }
    if (!currentBoard()) { notice = "元のボードで書き出し画面を開き直してください。"; render(); return false; }
    collecting = true; observe(); collect();
    let roots = feeds(), scroller;
    const runId = ++autoRunId;
    const selectScroller = target => {
      autoCleanup?.(); scroller = target;
      const oldAnchor = target.style.getPropertyValue("overflow-anchor"), oldPriority = target.style.getPropertyPriority("overflow-anchor");
      target.style.setProperty("overflow-anchor", "none", "important");
      autoCleanup = () => { if (target.style.getPropertyValue("overflow-anchor") !== "none") return; if (oldAnchor) target.style.setProperty("overflow-anchor", oldAnchor, oldPriority); else target.style.removeProperty("overflow-anchor"); };
    };
    autoRunning = true; complete = false; scanReady = false; captureMode = "auto-scroll"; finishReason = "running";
    notice = "ボードの先頭から収集しています。追加の画像が読み込まれるまで待ちながら進みます。"; render();
    let stable = 0, pass = 0, probes = 0, lastCount = -1, lastLimit = -1, lastTop = -1, lastProgress = Date.now();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const scroll = async top => {
      if (Math.abs(scroller.scrollTop - top) < 1) return;
      const previousTop = scroller.scrollTop;
      const events = scroller === document.scrollingElement ? document : scroller;
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timeout); events.removeEventListener("scroll", finish); resolve(); };
        const timeout = setTimeout(finish, 1200);
        events.addEventListener("scroll", finish, { once: true });
        try { scroller.scrollTo({ top, behavior: "instant" }); } catch { scroller.scrollTop = top; }
      });
      // Give the virtualized grid time to commit the newly visible cards before
      // the next move. Otherwise browsers can coalesce two scroll positions.
      await wait(100);
      if (Math.abs(scroller.scrollTop - previousTop) > 3) lastProgress = Date.now();
    };
    try {
      for (let attempt = 0; !roots.length && attempt < 20; attempt++) {
        await wait(400); if (closed || !autoRunning || runId !== autoRunId) return false;
        collect(); roots = feeds();
      }
      if (!roots.length) { stopAuto("ボードの画像一覧を確認できません。書き出しは行っていません。"); return false; }
      selectScroller(scrollContainer(roots[0]));
      await scroll(0);
      while (!closed && autoRunning && runId === autoRunId) {
        await wait(pass ? 1000 : 600);
        if (closed || !autoRunning || runId !== autoRunId) return;
        collect(); roots = feeds();
        if (!autoRunning || !currentBoard() || !roots.length) { stopAuto("画像一覧を確認できないため停止しました。収集済みの画像は保持しています。"); return; }
        if (limited) { stopAuto("5,000枚の上限に達しました。全件の収集は完了していません。"); return; }
        const nextScroller = scrollContainer(roots[0]);
        if (nextScroller !== scroller) { selectScroller(nextScroller); stable = 0; lastTop = -1; await scroll(0); continue; }
        const { limit, marker } = scrollExtent(scroller, roots), top = scroller.scrollTop, bottom = top >= limit - 3;
        const loading = isLoading(scroller, roots, limit);
        if (pins.size !== lastCount || Math.abs(limit - lastLimit) > 3 || Math.abs(top - lastTop) > 3) { stable = 0; lastProgress = Date.now(); }
        else if (bottom && !loading) stable++;
        lastCount = pins.size; lastLimit = limit; lastTop = top;
        const countMatched = expectedPins !== null && pins.size === expectedPins;
        if (bottom && !loading && stable >= (countMatched ? 3 : marker ? 8 : 12)) {
          if (!marker && !countMatched && probes < 1 && limit > 0) { probes++; stable = 0; notice = "末尾の追加読み込みを再確認しています。"; render(); await scroll(Math.max(0, limit - 120)); await wait(250); if (closed || !autoRunning || runId !== autoRunId) return false; await scroll(limit); continue; }
          if (expectedPins !== null && pins.size < expectedPins && pass === 0) { pass++; stable = 0; probes = 0; lastProgress = Date.now(); await scroll(0); if (closed || !autoRunning || runId !== autoRunId) return false; notice = `収集 ${pins.size} / ボード ${expectedPins}件。先頭からゆっくり再確認しています。`; render(); continue; }
          autoRunning = false; complete = expectedPins !== null && pins.size === expectedPins;
          scanReady = pins.size > 0 && (expectedPins === null || complete); scanExpected = expectedPins;
          autoCleanup?.(); autoCleanup = null;
          finishReason = complete ? "count-matched" : expectedPins !== null ? "count-mismatch" : "end-reached";
          notice = complete ? `ボード表示の${expectedPins}件と収集件数が一致し、末尾まで確認しました。ファイルを書き出せます。` : expectedPins !== null ? `ボード表示 ${expectedPins}件に対し収集 ${pins.size}件です。件数が一致していません。画像一覧やセクションを確認してください。` : `末尾まで読み込みを確認しました（${pins.size}件）。総件数を取得できないため、ボードの表示件数と確認してください。`;
          if (!scanReady && expectedPins !== null) notice += " 全件の書き出しは行っていません。";
          render(); return scanReady;
        }
        if (Date.now() - lastProgress > 90000) { stopAuto("追加読み込みが進まないため停止しました。接続状態を確認して全体収集を再開してください。"); return; }
        if (!bottom) await scroll(Math.min(limit, scroller.scrollTop + Math.max(120, scroller.clientHeight * (pass ? 0.4 : 0.65))));
      }
    } catch { if (!closed && autoRunning && runId === autoRunId) stopAuto("全体収集中に問題が起きました。収集済みの画像は保持しています。"); }
    return false;
  }
  auto.addEventListener("click", () => { void collectAll(); });
  toggle.addEventListener("click", () => { if (autoRunning) stopAuto(); collecting = !collecting; if (collecting) { observe(); collect(); } else observer.disconnect(); render(); });
  review.addEventListener("click", () => { reviewed = !reviewed; render(); }); name.addEventListener("input", render);
  function writeFile() {
    if (closed || !name.value.trim() || !selectedPins().length) return;
    collect();
    const data = { format: "imagestorage-pinterest-board", version: 2, exportedAt: new Date().toISOString(), board: { name: name.value.trim(), url: boardUrl.href }, capture: { mode: captureMode, complete: complete && !excluded.size, expectedCount: expectedPins, reason: finishReason }, pins: selectedPins() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    if (blob.size > 8 * 1024 * 1024) { notice = "ファイルが大きすぎます。確認一覧で画像を減らしてください。"; render(); return; }
    const link = document.createElement("a"), objectUrl = URL.createObjectURL(blob);
    const base = data.board.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || "Pinterest-board";
    link.href = objectUrl; link.download = `${base}.imagestorage-board.json`; link.hidden = true; host.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    notice = `${data.pins.length}枚の画像情報を書き出しました。ImageStorageの「ボードファイルを読み込む」で選択してください。`; render();
  }
  exportButton.addEventListener("click", () => { void (async () => {
    if (exportButton.disabled || exportPending) return;
    exportPending = true; render();
    try { collect(); if (!scanReady && !await collectAll()) return; if (!closed && scanReady && !autoRunning) writeFile(); }
    finally { exportPending = false; render(); }
  })(); });
  partialExport.addEventListener("click", () => { if (!partialExport.disabled) writeFile(); });
  let dragging = null;
  const clamp = () => { const box = host.getBoundingClientRect(); host.style.setProperty("right", "auto", "important"); host.style.setProperty("left", `${Math.max(8, Math.min(innerWidth - box.width - 8, box.left))}px`, "important"); host.style.setProperty("top", `${Math.max(8, Math.min(innerHeight - box.height - 8, box.top))}px`, "important"); };
  header.addEventListener("pointerdown", event => { if (event.button !== 0 || event.target.closest("button")) return; const box = host.getBoundingClientRect(); dragging = { x: event.clientX - box.left, y: event.clientY - box.top }; header.setPointerCapture(event.pointerId); event.preventDefault(); });
  header.addEventListener("pointermove", event => { if (!dragging) return; host.style.setProperty("right", "auto", "important"); host.style.setProperty("left", `${event.clientX - dragging.x}px`, "important"); host.style.setProperty("top", `${event.clientY - dragging.y}px`, "important"); clamp(); });
  header.addEventListener("pointerup", () => { dragging = null; }); header.addEventListener("lostpointercapture", () => { dragging = null; });
  const keydown = event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } };
  const interrupt = event => {
    if (!autoRunning || !event.isTrusted || event.composedPath().includes(host)) return;
    if (event.type === "keydown" && !["PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp", " "].includes(event.key)) return;
    stopAuto("手動操作のため全体収集を停止しました。収集済みの画像は保持しています。");
  };
  function close() {
    if (closed) return; closed = true; autoRunning = false; autoRunId++; autoCleanup?.(); autoCleanup = null; observer.disconnect(); clearTimeout(scanTimer); clearInterval(timer);
    window.removeEventListener("wheel", interrupt, true); window.removeEventListener("pointerdown", interrupt, true); window.removeEventListener("keydown", interrupt, true);
    window.removeEventListener("resize", clamp); window.removeEventListener("pagehide", close); document.removeEventListener("load", schedule, true); root.removeEventListener("keydown", keydown); host.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (globalThis.__imageStorageBoardExporter?.close === close) delete globalThis.__imageStorageBoardExporter;
  }
  closeButton.addEventListener("click", close); root.addEventListener("keydown", keydown); window.addEventListener("resize", clamp); window.addEventListener("pagehide", close); document.addEventListener("load", schedule, true);
  window.addEventListener("wheel", interrupt, { capture: true, passive: true }); window.addEventListener("pointerdown", interrupt, true); window.addEventListener("keydown", interrupt, true);
  const timer = setInterval(collect, 700); globalThis.__imageStorageBoardExporter = { close }; observe(); collect(); closeButton.focus({ preventScroll: true });
  return { shown: true };
}
