import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the ImageStorage default workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>ImageStorage — Visual Reference Canvas<\/title>/i);
  assert.match(html, /aria-label="Saved boards"/);
  assert.match(html, /title="default"/);
  assert.match(html, /Welcome to ImageStorage/);
  assert.match(html, /study composition with thirds and golden ratio guides/);
  assert.match(html, /Import Pinterest boards from files/);
  const listThumbnails = [...html.matchAll(/class="mini-tile image">(<img[^>]*>)/g)];
  assert.ok(listThumbnails.length > 0, "The default list has an image thumbnail");
  for (const [, thumbnail] of listThumbnails) {
    assert.match(thumbnail, /draggable="false"/, "Saved-list thumbnails must not initiate native dragging");
  }
  assert.doesNotMatch(html, /class="(?:sidebar-command|saved-list-heading|list-manager-open)(?:\s|")/);
  assert.doesNotMatch(html, /class="sidebar-settings-(?:row|tab|close)(?:\s|")/, "Settings has no permanent sidebar row before opening it");
  assert.match(html, /class="rail-library"/, "Library remains accessible from the sidebar footer");
  assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
});

test("temporary settings uses card dimensions below saved lists and keeps its close button", async () => {
  const [page, listsCss] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/zen-lists.css", import.meta.url), "utf8"),
  ]);
  const listsStart = page.indexOf("{filteredBoards.map(");
  const settingsStart = page.indexOf("{settingsTabOpen && (");
  const dragSpace = page.indexOf('className="sidebar-window-drag-space"', settingsStart);
  assert.ok(listsStart > 0 && settingsStart > listsStart && dragSpace > settingsStart,
    "Settings follows all normal cards");
  const settingsMarkup = page.slice(settingsStart, dragSpace);
  assert.match(settingsMarkup, /sidebar-settings-close/);
  assert.doesNotMatch(settingsMarkup, /data-board-id|className="board-row/,
    "The temporary settings card is separate from normal saved lists");
  assert.equal((settingsMarkup.match(/sidebar-settings-row/g) || []).length, 1);
  const sharedCard = listsCss.match(/([^{}]*\.sidebar-settings-row[^{}]*)\{([^}]+)\}/);
  assert.ok(sharedCard, "Settings card styles exist");
  assert.match(sharedCard[1], /\.board-row/, "Saved lists and settings share their card dimensions");
  assert.match(sharedCard[2], /aspect-ratio:\s*2\.1\s*\/\s*1\s*;/);
  assert.match(sharedCard[2], /width:\s*100%\s*;/);
  assert.doesNotMatch(sharedCard[2], /(?:height|min-height|flex-basis):\s*36px/);
});

test("keeps desktop persistence and distribution wiring in place", async () => {
  const [
    page,
    main,
    preload,
    titlebar,
    desktopCss,
    globalsCss,
    signedBuild,
    packageJson,
    desktopHtml,
    iconGenerator,
    imageAnalysis,
  ] =
    await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../desktop/main.cjs", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8"),
    readFile(
      new URL("../desktop/src/NativeTitlebar.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../desktop/src/desktop.css", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(
      new URL("../desktop/scripts/build-signed.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../desktop/index.html", import.meta.url), "utf8"),
    readFile(
      new URL("../desktop/scripts/create-icon.mjs", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../app/ImageAnalysisWindow.tsx", import.meta.url), "utf8"),
    ]);

  assert.match(page, /assetDropBoardId/);
  assert.match(page, /findOpenImagePosition/);
  assert.match(page, /\.filter\(\(item\) => item\.type === "image"/);
  assert.match(page, /imageItems\.slice\(0, 4\)/);
  assert.match(page, /confirmation-dialog/);
  assert.match(page, /content-bounds-guide/);
  assert.match(page, /const contentBounds = useMemo/);
  assert.match(page, /function isImageFillingCanvas/);
  assert.match(page, /paletteSuppressedItemId !== selectedItem\.id/);
  assert.match(page, /syncImagePaletteVisibility\(selectedItem, nextScale/);
  assert.doesNotMatch(page, /className="canvas-chrome"/);
  assert.doesNotMatch(page, /className="board-title-input"/);
  assert.match(page, /getCanvasSidebarOffset/);
  assert.match(page, /var\(--canvas-sidebar-offset, 0px\)/);
  assert.doesNotMatch(page, /className="rail-tool primary"/);
  assert.doesNotMatch(page, /className="rail-tool url-tool"/);
  assert.doesNotMatch(page, /className="rail-tool note-tool"/);
  assert.doesNotMatch(page, /className="rail-tool arrange-tool"/);
  assert.doesNotMatch(page, /className="rail-pin"/);
  assert.match(page, /className="rail-tool fit-tool"/);
  assert.doesNotMatch(page, /className="sidebar-new-list/);
  assert.match(page, /id: "new-list"[^\n]*onSelect: createBoard/);
  assert.match(page, /className="sidebar-create-menu"/);
  assert.match(page, /optimizeStagedImages/);
  assert.match(page, /autoSaveProject/);
  assert.match(page, /autoSaveEnabled/);
  assert.match(page, /skipRecovery: true/);
  assert.match(page, /onCloseRequest/);
  assert.match(main, /autosave\.backup-3\.json/);
  assert.match(main, /IMAGESTORAGE_PROJECT_V3/);
  assert.match(main, /writePortableProject/);
  assert.match(main, /readPortableProject/);
  assert.match(main, /cleanupUnusedAssets/);
  assert.match(main, /DEFAULT_ASSET_CLEANUP_GRACE_MS/);
  assert.match(main, /IMAGESTORAGE_TEST_LAYOUT_RESULT/);
  assert.match(main, /document\.querySelector\('\.rail-tool\.grid-tool'\)\?\.click\(\)/);
  assert.match(main, /assets", "icon\.png"/);
  assert.match(main, /titlebarBrandingRemoved/);
  assert.match(main, /listActionsInRail/);
  assert.match(main, /quickImageActionsApplied/);
  assert.match(main, /imageQuickToolsHiddenAfterZoom/);
  assert.match(main, /imageDetailsDialogVisible/);
  assert.match(main, /libraryDialogVisible/);
  assert.match(main, /autoArrangeAvailable/);
  assert.match(main, /autoArrangeApplied/);
  assert.match(main, /boardGrouping/);
  assert.match(main, /QA grouped lists/);
  assert.match(main, /colorPickerAtBottom/);
  assert.match(main, /canvasExpandedToLeftEdge/);
  assert.match(main, /sidebarPeekVisible/);
  assert.match(main, /sidebarPeekStraight/);
  assert.match(main, /sidebarPeekMatchesPinnedSize/);
  assert.match(main, /togglePinnedAlignedToSidebarRight/);
  assert.match(main, /togglePinnedAlignedToSidebarBottom/);
  assert.match(main, /togglePinnedInsideSidebarElement/);
  assert.match(main, /togglePeekAlignedToSidebarRight/);
  assert.match(main, /togglePeekAlignedToSidebarBottom/);
  assert.match(main, /togglePeekInsideSidebarElement/);
  assert.match(main, /togglePinnedInsideSidebar/);
  assert.match(main, /togglePeekInsideSidebar/);
  assert.match(main, /toggleShowsPinnedState/);
  assert.match(main, /toggleShowsUnpinnedState/);
  assert.match(main, /sidebarTogglePositionsMatch/);
  assert.match(main, /sidebarPinStableAcrossResize/);
  assert.match(main, /sidebarPinResizeChecks\.every\(Boolean\)/);
  assert.match(main, /workspaceVisibleDuringSidebarPeek/);
  assert.match(main, /workspaceWidthStableDuringSidebarPeek/);
  assert.match(main, /titlebarHiddenAfterLeave/);
  assert.match(main, /zoomAnchorStable/);
  assert.match(main, /pointerActionCleared/);
  assert.match(main, /writeJsonAtomically/);
  assert.match(main, /replaceFileSafely\(temporaryPath, filePath\)/);
  assert.match(main, /queueRecoverySnapshot/);
  assert.match(main, /queueRecoverySnapshot\(data\)/);
  assert.match(main, /!data\?\.skipRecovery/);
  assert.match(main, /function recoverySnapshotPaths\(\)/);
  assert.match(main, /\$\{autoSavePath\}\.previous/);
  assert.match(main, /IMAGE_FETCH_TIMEOUT_MS/);
  assert.match(main, /The image download timed out/);
  assert.match(main, /stageImagePaths/);
  assert.match(main, /thumbnail-\$\{assetId\}/);
  assert.match(preload, /image:stage-paths/);
  assert.match(preload, /window:close-ready/);
  assert.match(preload, /titlebar:visibility-change/);
  assert.match(preload, /window:get-titlebar-visibility/);
  assert.doesNotMatch(titlebar, /native-help-button/);
  assert.doesNotMatch(titlebar, /native-language-button/);
  assert.match(titlebar, /always-on-top-button/);
  assert.match(titlebar, /titlebarVisible/);
  assert.match(titlebar, /onTitlebarVisibilityChange/);
  assert.match(titlebar, /getTitlebarVisibility/);
  assert.match(titlebar, /className=\{`native-titlebar/);
  assert.match(
    titlebar,
    /className="native-titlebar-drag" aria-hidden="true"/,
  );
  assert.doesNotMatch(titlebar, /native-app-mark/);
  assert.doesNotMatch(titlebar, />IMAGESTORAGE</);
  assert.doesNotMatch(titlebar, /native-titlebar-reveal-zone/);
  assert.doesNotMatch(titlebar, /handleWindowResize/);
  assert.match(main, /screen\.getCursorScreenPoint\(\)/);
  assert.match(main, /TITLEBAR_REVEAL_HEIGHT = 8/);
  assert.match(main, /setInterval\(updateTitlebarVisibilityFromCursor, 40\)/);
  assert.match(main, /titlebar:visibility-change/);
  assert.match(desktopCss, /\.native-titlebar\.is-visible/);
  assert.match(
    desktopCss,
    /\.native-titlebar\.is-visible \.native-project-actions,[\s\S]*?pointer-events: auto/,
  );
  assert.match(desktopCss, /height: 32px/);
  assert.match(desktopCss, /transform: none/);
  assert.doesNotMatch(desktopCss, /translateY/);
  assert.match(desktopCss, /app-region: drag/);
  assert.match(desktopCss, /app-region: no-drag/);
  assert.match(desktopCss, /-webkit-app-region: no-drag/);
  assert.match(desktopCss, /-webkit-app-region: drag/);
  assert.doesNotMatch(desktopCss, /\.native-app-mark/);
  assert.match(
    desktopCss,
    /\.native-titlebar-drag\s*\{[^}]*height: 8px;[^}]*-webkit-app-region: drag/,
  );
  assert.match(main, /const minimumWidth = requestedWindowSize \? 320 : 760/);
  assert.match(main, /const minimumHeight = requestedWindowSize \? 240 : 560/);
  assert.match(main, /ensureUsableWindowSize\(\);/);
  assert.match(page, /window\.addEventListener\("pointercancel", stopPointerAction\)/);
  assert.match(page, /window\.addEventListener\("lostpointercapture", stopPointerAction\)/);
  assert.match(page, /window\.addEventListener\("blur", stopPointerAction\)/);
  assert.match(page, /const measureNoteHeight = useCallback/);
  assert.match(page, /textarea\[data-note-id\]/);
  assert.match(page, /data-note-id=\{item\.id\}/);
  assert.match(page, /document\.activeElement instanceof HTMLElement[\s\S]*?document\.activeElement\.blur\(\)/);
  assert.match(page, /spellCheck=\{false\}/);
  assert.match(page, /const \[selectedIds, setSelectedIds\] = useState<string\[\]>\(\[\]\)/);
  assert.match(page, /mode: "select"/);
  assert.match(page, /itemOrigins: activeBoard\.items/);
  assert.match(page, /className="selection-marquee"/);
  assert.match(page, /data-viewport-scale=\{activeBoard\.viewport\.scale\}/);
  assert.match(page, /data-canvas-scale=\{viewportScale\}/);
  assert.match(page, /fontFamily: settings\.noteFont/);
  assert.match(page, /fontSize: `\$\{settings\.noteFontSize \* viewportScale\}px`/);
  assert.match(page, /Math\.exp\(-event\.deltaY \* 0\.0013\)/);
  assert.doesNotMatch(page, /Math\.min\(3\.5/);
  assert.doesNotMatch(page, /transform: `translate\([\s\S]*?scale\(\$\{activeBoard\.viewport\.scale\}\)/);
  assert.match(page, /updateNoteText\(/);
  assert.match(page, /setPointerCapture\(event\.pointerId\)/);
  assert.match(page, /data-board-id=\{board\.id\}/);
  assert.match(page, /const \[sidebarPeekOpen, setSidebarPeekOpen\] = useState\(false\)/);
  assert.match(page, /handleSidebarPeekPointerMove/);
  assert.match(
    page,
    /window\.addEventListener\("pointermove", handleSidebarPeekPointerMove/,
  );
  assert.match(page, /onPointerEnter=\{showSidebarPeek\}/);
  assert.match(page, /onPointerLeave=\{hideSidebarPeek\}/);
  assert.match(page, /sidebarCollapsed \? "is-unpinned" : "is-pinned"/);
  assert.match(page, /<UiIcon name="sidebar" \/>/);
  assert.match(
    page,
    /<aside[\s\S]*?className="sidebar-navigation"[\s\S]*?className=\{`sidebar-toggle-button/,
  );
  const sidebarToggleMarkup = page.match(
    /<button\s+className=\{`sidebar-toggle-button[\s\S]*?<\/button>/,
  )?.[0];
  assert.ok(sidebarToggleMarkup);
  assert.doesNotMatch(sidebarToggleMarkup, /onPointerEnter|onPointerLeave/);
  assert.match(page, /inert=\{\(sidebarCollapsed && !sidebarPeekOpen\) \|\| modalInteractionBlocked\}/);
  assert.doesNotMatch(page, /sidebarCollapsed \? "›" : "‹"/);
  assert.match(page, /sidebarRef\.current\?\.getBoundingClientRect\(\)/);
  assert.match(page, /startupSettings\.startupSidebar === "closed"/);
  assert.doesNotMatch(page, /SIDEBAR_STATE_KEY/);
  assert.match(page, /sidebarPeekOpen \? "is-sidebar-peeking" : ""/);
  assert.match(page, /sidebar \$\{sidebarPeekOpen \? "is-peeking" : ""\}/);
  assert.doesNotMatch(page, /className="drag-dots"/);
  assert.doesNotMatch(page, /className="board-name-input"/);
  assert.match(page, /<span className="board-name-label">\{board\.name\}<\/span>/);
  assert.doesNotMatch(page, /className="(?:sidebar-command|saved-list-heading|list-manager-open)"/);
  const mainActions = page.match(/const mainActions: ChromeMenuItem\[\] = \[([\s\S]*?)\n  \];/)?.[1];
  assert.ok(mainActions, "The sidebar menu actions are available");
  assert.match(mainActions, /id: "manage-lists"[\s\S]*?onSelect: openListManager/);
  assert.doesNotMatch(mainActions, /id: "library"/, "Library is only in the footer, not duplicated in the menu");
  assert.match(mainActions, /id: "settings"[\s\S]*?onSelect: openSettingsPage/);
  assert.match(page, /\{settingsTabOpen && \(/);
  assert.match(page, /className=\{?`?"?sidebar-settings-row/);
  assert.match(page, /className="sidebar-settings-close"/);
  assert.match(page, /onContextMenu=\{\(event\) => \{[\s\S]*?openHeaderImageEditor\(board\)/);
  assert.match(globalsCss, /\.canvas-item\.note textarea[\s\S]*?overflow: hidden/);
  assert.match(globalsCss, /\.app-shell input,[\s\S]*?user-select: none/);
  assert.match(
    globalsCss,
    /\.app-shell \.sidebar \.sidebar-toggle-button[\s\S]*?right: 0[\s\S]*?bottom: 0[\s\S]*?left: auto/,
  );
  assert.match(globalsCss, /\.content-bounds-guide/);
  assert.match(
    globalsCss,
    /\.canvas-grid-layer[\s\S]*?linear-gradient\(to right[\s\S]*?linear-gradient\(to bottom/,
  );
  assert.match(
    globalsCss,
    /\.content-bounds-guide[\s\S]*?background-color: #1a1a1a[\s\S]*?box-shadow: none/,
  );
  assert.match(
    globalsCss,
    /\.canvas\.is-grid-visible \.content-bounds-guide[\s\S]*?linear-gradient\(to right[\s\S]*?linear-gradient\(to bottom[\s\S]*?var\(--content-grid-x\) var\(--content-grid-y\)/,
  );
  assert.match(globalsCss, /\.selection-marquee/);
  assert.match(globalsCss, /\.canvas-frame[\s\S]*?background-color: rgb\(32, 32, 32\)/);
  assert.match(
    globalsCss,
    /\.canvas\.is-grid-visible \.canvas-frame[\s\S]*?linear-gradient\(to right[\s\S]*?var\(--frame-grid-x\) var\(--frame-grid-y\)/,
  );
  assert.match(globalsCss, /\.canvas-frame-drag-surface[\s\S]*?pointer-events: auto/);
  assert.match(globalsCss, /\.canvas-frame-header[\s\S]*?top: -34px[\s\S]*?justify-content: center[\s\S]*?background: transparent/);
  assert.match(globalsCss, /\.canvas-frame-header input[\s\S]*?font-size: 24px[\s\S]*?text-align: center[\s\S]*?text-transform: uppercase/);
  assert.match(globalsCss, /\.canvas-item \.resize-handle[\s\S]*?width: 7px[\s\S]*?height: 7px/);
  assert.match(globalsCss, /\.canvas-item \.resize-nw[\s\S]*?top: -3\.5px[\s\S]*?left: -3\.5px/);
  assert.match(globalsCss, /\.rail-tool-divider[\s\S]*?background: #303236/);
  assert.match(
    globalsCss,
    /\.rail-tools\s*\{[\s\S]*?grid-template-columns: repeat\(4, 28px\);[\s\S]*?grid-template-rows: repeat\(2, 28px\);/,
  );
  assert.match(globalsCss, /\.rail-list-group\s*\{[\s\S]*?grid-row: 2;[\s\S]*?grid-column: 1;/);
  assert.match(globalsCss, /\.image-quick-tools[\s\S]*?background: rgba\(31, 31, 31, 0\.94\)/);
  assert.match(globalsCss, /\.library-dialog,[\s\S]*?\.image-info-dialog/);
  assert.match(globalsCss, /\.rail-tool\[data-tooltip\]::after/);
  assert.match(
    globalsCss,
    /\.sidebar \.board-row,[\s\S]*?\.sidebar \.board-button\s*\{[\s\S]*?cursor: default;/,
  );
  assert.match(globalsCss, /\.board-grouping-dialog/);
  assert.doesNotMatch(globalsCss, /\.canvas-world\s*\{[^}]*will-change:\s*transform/);
  assert.match(
    globalsCss,
    /\.selection-tools[\s\S]*?position: absolute[\s\S]*?bottom: 18px[\s\S]*?left: 50%[\s\S]*?max-width: calc\(100% - 24px\)[\s\S]*?translateX\(-50%\)/,
  );
  assert.doesNotMatch(
    globalsCss,
    /\.color-picker\s*\{\s*display:\s*none;/,
  );
  assert.match(
    globalsCss,
    /--canvas-sidebar-offset: var\(--active-sidebar-width\)/,
  );
  assert.match(
    globalsCss,
    /grid-template-columns: 0 minmax\(0, 1fr\) !important/,
  );
  assert.match(globalsCss, /\.sidebar\.is-peeking/);
  assert.match(globalsCss, /\.app-shell > \.workspace[\s\S]*?grid-column: 2/);
  assert.match(
    globalsCss,
    /\.sidebar\.is-peeking[\s\S]*?transform: none !important/,
  );
  assert.doesNotMatch(
    globalsCss,
    /\.is-sidebar-peeking \.sidebar-toggle-button[\s\S]*?left: calc/,
  );
  assert.match(
    globalsCss,
    /@media \(max-width: 900px\)[\s\S]*?\.sidebar\.is-peeking[\s\S]*?width: calc\(var\(--active-sidebar-width\) - 20px\)/,
  );
  assert.match(
    globalsCss,
    /@media \(max-width: 600px\)[\s\S]*?\.sidebar\.is-peeking[\s\S]*?width: var\(--active-sidebar-width\)/,
  );
  assert.match(signedBuild, /resolveSigningConfiguration/);
  assert.match(signedBuild, /verifyWindowsSignatures/);
  assert.match(packageJson, /desktop:build:signed/);
  assert.match(packageJson, /desktop:icons/);
  assert.match(packageJson, /desktop\/assets\/icon\.png/);
  assert.match(packageJson, /desktop:pack[\s\S]*?npm run desktop:icons/);
  const scripts = JSON.parse(packageJson).scripts;
  assert.equal(scripts["desktop:build"], "node desktop/scripts/build-signed.mjs");
  assert.equal(scripts["desktop:build:signed"], "node desktop/scripts/build-signed.mjs");
  assert.equal(scripts["desktop:build:store"], "node desktop/scripts/build-store.mjs");
  assert.match(scripts["desktop:build:unsigned"], /directories.output=work\/unsigned-release/);
  assert.match(packageJson, /"target": "portable"/);
  assert.match(packageJson, /"target": "nsis"/);
  assert.match(packageJson, /ImageStorage-\$\{version\}-Setup/);
  assert.match(desktopHtml, /rel="icon"[\s\S]*?imagestorage-logo\.png/);
  assert.match(iconGenerator, /imagestorage-monochrome-logo-v1\.png/);
  assert.match(iconGenerator, /const iconSizes = \[16, 24, 32, 48, 64, 128, 256\]/);
  assert.match(page, /className="settings-dialog settings-page"/);
  assert.match(page, /openImageAnalysis/);
  assert.match(page, /type LibraryFilter = "all" \| "favorite"/);
  assert.match(page, /tags\?: string\[\];/);
  assert.match(page, /creator\?: string;/);
  assert.match(page, /sourceUrl\?: string;/);
  assert.match(page, /referenceNote\?: string;/);
  assert.match(page, /favorite\?: boolean;/);
  assert.doesNotMatch(page, /採用候補/);
  assert.match(page, /flipHorizontal\?: boolean;/);
  assert.match(page, /grayscale\?: boolean;/);
  assert.match(page, /className="sidebar-navigation"/);
  assert.match(page, /id: "group-lists"[\s\S]*?onSelect: openBoardGrouping/);
  assert.match(page, /className="rail-library"/);
  assert.match(page, /className="board-grouping-dialog"/);
  assert.match(page, /applyBoardGrouping/);
  assert.match(page, /removeSelectedBoardsFromGroup/);
  assert.match(page, /className="library-dialog"/);
  assert.match(page, /className="image-info-dialog"/);
  assert.match(page, /className="image-quick-tools"/);
  assert.match(page, /paletteSuppressedItemId !== selectedItem\.id && \(/);
  assert.match(page, /arrangeSelectedImages/);
  assert.match(page, /getImageMediaStyle\(item, viewportScale, false\)/);
  assert.match(page, /createFrameFromSelection/);
  assert.match(page, /className="canvas-frame-drag-surface"/);
  assert.match(page, /snapEnabled/);
  assert.match(page, /id: "grid"[^\n]*checked: canvasSettings\.gridVisible[^\n]*updateCanvasSettings/);
  assert.match(page, /id: "snap"[^\n]*checked: canvasSettings\.snapEnabled[^\n]*updateCanvasSettings/);
  assert.doesNotMatch(page, /className="canvas-controls"/);
  assert.match(page, /headerImageSrc/);
  assert.match(page, /headerImageWidth\?: number;/);
  assert.match(page, /headerImageHeight\?: number;/);
  assert.match(page, /headerImagePositionX\?: number;/);
  assert.match(page, /headerImageScale\?: number;/);
  assert.doesNotMatch(page, /className="sidebar-header-image-button"/);
  assert.doesNotMatch(page, /sidebar-list-controls-panel/);
  assert.doesNotMatch(page, /listControlsCollapsed/);
  assert.match(page, /className="header-image-editor"/);
  assert.match(page, /Adjust list header/);
  assert.doesNotMatch(page, /className="header-image-back"/);
  assert.match(page, /className="header-image-editor-image-plane"/);
  assert.match(page, /src=\{headerImageDraft\.src\}/);
  assert.doesNotMatch(page, /src=\{headerImageDraft\.thumbnailSrc \|\| headerImageDraft\.src\}/);
  assert.match(page, /className="header-image-editor-crop-window"/);
  assert.doesNotMatch(page, /className="header-image-editor-backdrop-image"/);
  assert.doesNotMatch(page, /className="header-image-editor-crop-image"/);
  assert.match(page, /className="header-image-zoom-control"/);
  assert.match(page, /onPointerDown=\{startHeaderImageDrag\}/);
  assert.match(page, /updateHeaderImageDrag/);
  assert.match(page, /function getHeaderImageLayout/);
  assert.match(page, /const HEADER_IMAGE_DEFAULT_POSITION = 50/);
  assert.match(page, /const HEADER_IMAGE_SCALE_STEP = 0\.05/);
  assert.match(page, /const minPositionX = 50 \/ widthFactor/);
  assert.match(page, /const renderedWidth = width \* startingLayout\.widthPercent \/ 100/);
  assert.match(page, /constrainHeaderImageDraft\(current, scale\)/);
  assert.match(page, /headerImageWidth: appliedDraft\.imageWidth/);
  assert.match(page, /current\.src !== chosen\.src/);
  assert.match(page, /className="header-image-change"/);
  assert.match(page, /className="header-image-remove"/);
  assert.match(page, /画像一覧に戻す/);
  assert.match(page, /restoreHeaderImageList/);
  assert.match(page, /headerImageSrc: undefined/);
  assert.match(
    globalsCss,
    /\.header-image-editor-actions\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/,
  );
  assert.match(
    globalsCss,
    /\.header-image-editor-controls input\[type="range"\][\s\S]*?appearance: none;[\s\S]*?border-radius: 0;/,
  );
  assert.match(page, /backgroundImageSrc/);
  assert.match(
    globalsCss,
    /\.sidebar \.mini-preview\.has-header\s*\{[\s\S]*?display: block;[\s\S]*?gap: 0;/,
  );
  assert.match(
    globalsCss,
    /\.sidebar \.board-row\.has-header > \.mini-preview\.has-header \.mini-header-image\s*\{[\s\S]*?object-fit: fill;/,
  );
  assert.match(
    globalsCss,
    /\.sidebar \.board-row\.has-header\s*\{[\s\S]*?aspect-ratio: 2\.1 \/ 1;/,
  );
  assert.match(
    globalsCss,
    /\.header-image-editor-crop-window\s*\{[\s\S]*?0 0 0 9999px rgba\(0, 0, 0, 0\.58\);/,
  );
  assert.match(
    globalsCss,
    /\.header-image-editor > header > \.header-image-apply\s*\{[\s\S]*?border-radius: 4px;[\s\S]*?background: #080808;/,
  );
  assert.match(
    globalsCss,
    /\.sidebar \.board-row\.has-header > \.mini-preview\.has-header\s*\{[\s\S]*?inset: 0;/,
  );
  assert.match(globalsCss, /\.header-image-editor\s*\{/);
  assert.match(page, /value="zh"/);
  assert.match(page, /value="ko"/);
  assert.match(preload, /image-analysis:open/);
  assert.match(preload, /image-analysis:updated/);
  assert.match(main, /openImageAnalysisWindow/);
  assert.match(main, /image-analysis:get-init/);
  assert.match(main, /backgroundImageAssetId/);
  assert.match(main, /headerImageAssetId/);
  assert.match(imageAnalysis, /CompositionGuide/);
  assert.match(imageAnalysis, /kind: "freehand" \| "line"/);
  assert.match(imageAnalysis, /golden-wide/);
  assert.match(imageAnalysis, /guideColor/);
  assert.match(imageAnalysis, /event\.pressure/);
  assert.match(imageAnalysis, /analysis-save/);
  assert.match(imageAnalysis, /ref=\{imageFrameRef\}/);
  assert.match(imageAnalysis, /className="analysis-stage-shell"[\s\S]*?onPointerDown=\{handlePointerDown\}/);
  assert.doesNotMatch(imageAnalysis, /Math\.max\(0, Math\.min\(1000/);
  assert.match(globalsCss, /\.analysis-overlay\s*\{[\s\S]*?overflow: hidden;[\s\S]*?pointer-events: none;/);
  assert.match(globalsCss, /\.image-info-flags input\[type="checkbox"\][\s\S]*?flex: 0 0 16px;/);
  assert.match(imageAnalysis, /<CompositionGuide preset=\{preset\.id\} color="currentColor"/);
  assert.doesNotMatch(imageAnalysis, /detectPerspective/);
  assert.doesNotMatch(imageAnalysis, /detectVisualFlow/);
  assert.doesNotMatch(imageAnalysis, /analysis-detection-actions/);
  assert.match(page, /canvas-image-analysis/);
  assert.match(page, /\(event\.ctrlKey \|\| event\.metaKey\)\s*&&\s*event\.key\.toLowerCase\(\) === "z"\s*\)\s*\{[\s\S]*?if \(event\.shiftKey\) redoLastChange\(\);/);
  assert.doesNotMatch(imageAnalysis, /Suggest locally/);
  assert.doesNotMatch(imageAnalysis, /toggleAlwaysOnTop/);
  assert.match(main, /const fullImagePreserved = input\.equals/);
  assert.match(main, /IMAGESTORAGE_TEST_SELECTION_RESULT/);
  assert.match(main, /selectedItemsMovedTogether/);
  assert.match(main, /noteSpellcheckDisabled/);
  assert.match(main, /noteBlurredByBlankClick/);
  assert.match(main, /zoomExceededPreviousLimit/);
  assert.doesNotMatch(main, /width:\s*2800/);
  assert.doesNotMatch(main, /webp\(\{\s*quality:\s*89/);
});
