"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from "react";
import { AnalysisMarks, migrateBoardAnalysisGuides, type ImageAnalysisState } from "./ImageAnalysisWindow";
import { UiIcon } from "./UiIcon";
import { CommandPalette, type CommandItem } from "./CommandPalette";
import { ChromeMenu, type ChromeMenuItem } from "./ChromeMenu";
import { StorageSettings } from "./StorageSettings";
import { PinterestBoardImport } from "./PinterestBoardImport";
import { pinterestBoardItems } from "./pinterest-board-import";
import { useDialogFocus } from "./useDialogFocus";
import { DEFAULT_CANVAS_SETTINGS, normalizeCanvasSettings, applyCanvasSettings, type CanvasSettings } from "./canvas-settings";
import { DEFAULT_NOTE_SETTINGS, normalizeNoteSettings, applyNoteSettings } from "./note-settings";
import { getImageDropEffect, hasImageDropData, readImageDrop } from "./image-drop";
import { clearListHeader, mergeListManagerEntry, getListManagerDropTarget } from "./list-manager";
import { createListManagerAutoScroll } from "./list-manager-autoscroll";
import { createListManagerPointerDrag } from "./list-manager-pointer-drag";

type Viewport = { x: number; y: number; scale: number };

type CanvasItem = {
  id: string;
  type: "image" | "note";
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  rotation?: number;
  src?: string;
  thumbnailSrc?: string;
  caption?: string;
  text?: string;
  color?: string;
  palette?: string[];
  assetId?: string;
  processing?: boolean;
  fontFamily?: string;
  fontSize?: number;
  analysis?: ImageAnalysisState;
  tags?: string[];
  creator?: string;
  sourceUrl?: string;
  originalImageUrl?: string;
  referenceNote?: string;
  favorite?: boolean;
  flipHorizontal?: boolean;
  grayscale?: boolean;
};

type CanvasFrame = {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  itemIds: string[];
};

type Board = {
  id: string;
  name: string;
  accent: string;
  updated: string;
  viewport: Viewport;
  items: CanvasItem[];
  frames?: CanvasFrame[];
  gridVisible?: boolean;
  snapEnabled?: boolean;
  gridSize?: number;
  backgroundColor?: string;
  backgroundImageSrc?: string;
  backgroundImageThumbnailSrc?: string;
  backgroundImageAssetId?: string;
  backgroundFit?: "cover" | "contain" | "tile";
  groupName?: string;
  headerImageSrc?: string;
  headerImageThumbnailSrc?: string;
  headerImageAssetId?: string;
  headerImageWidth?: number;
  headerImageHeight?: number;
  headerImagePositionX?: number;
  headerImagePositionY?: number;
  headerImageScale?: number;
};

type HeaderImageDraft = {
  boardId: string;
  managerSession?: number;
  src: string;
  thumbnailSrc?: string;
  assetId?: string;
  imageWidth: number;
  imageHeight: number;
  positionX: number;
  positionY: number;
  scale: number;
};

type HeaderImageDrag = {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPositionX: number;
  startPositionY: number;
  captureTarget: HTMLElement;
};

type PreparedImage = {
  originalImageUrl?: string;
  name: string;
  src: string;
  thumbnailSrc?: string;
  width: number;
  height: number;
  palette?: string[];
  assetId?: string;
  processing?: boolean;
};

type BoardDropTarget = {
  boardId: string;
  edge: "before" | "after";
};

type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type ItemContextMenu = {
  itemId: string;
  x: number;
  y: number;
};

type SelectionMarquee = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type UndoSnapshot = {
  boards: Board[];
  activeId: string;
};

type LibraryFilter = "all" | "favorite";

type ImageInfoDraft = {
  boardId: string;
  itemId: string;
  tagsText: string;
  creator: string;
  sourceUrl: string;
  referenceNote: string;
  favorite: boolean;
};

type PointerAction =
  | {
      mode: "pan";
      boardId: string;
      startClientX: number;
      startClientY: number;
      pointerId: number;
      startX: number;
      startY: number;
    }
  | {
      mode: "select";
      boardId: string;
      startClientX: number;
      startClientY: number;
      pointerId: number;
      canvasLeft: number;
      canvasTop: number;
      viewportX: number;
      viewportY: number;
      sidebarOffset: number;
      scale: number;
      initialSelectedIds: string[];
    }
  | {
      mode: "drag";
      boardId: string;
      itemId: string;
      startClientX: number;
      startClientY: number;
      pointerId: number;
      scale: number;
      itemOrigins: Array<{ id: string; x: number; y: number }>;
      snapEnabled: boolean;
      gridSize: number;
      anchorStartX: number;
      anchorStartY: number;
    }
  | {
      mode: "frame-drag";
      boardId: string;
      frameId: string;
      startClientX: number;
      startClientY: number;
      pointerId: number;
      scale: number;
      frameOrigin: { x: number; y: number };
      itemOrigins: Array<{ id: string; x: number; y: number }>;
      snapEnabled: boolean;
      gridSize: number;
    }
  | {
      mode: "resize";
      boardId: string;
      itemId: string;
      startClientX: number;
      startClientY: number;
      pointerId: number;
      startX: number;
      startY: number;
      startW: number;
      startH: number;
      scale: number;
      resizeHandle?: ResizeHandle;
    };

const STORAGE_KEY = "museboard-v1";
const ACTIVE_KEY = "museboard-active-v1";
const ALIGNED_LAYOUT_KEY = "museboard-aligned-layout-v2";
const STARTER_VERSION_KEY = "imagestorage-starter-version";
const LANGUAGE_KEY = "imagestorage-language";
const SETTINGS_KEY = "imagestorage-settings-v1";
const STARTER_VERSION = "2";
const SIDEBAR_PEEK_REVEAL_WIDTH = 28;
const SIDEBAR_PEEK_KEEP_MARGIN = 32;
const SIDEBAR_PEEK_HIDE_DELAY = 400;

type SidebarPeekPointer = { clientX: number; clientY: number };

function isWithinSidebarPeek(
  pointer: SidebarPeekPointer,
  bounds: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
) {
  return pointer.clientX >= Math.max(0, bounds.left - SIDEBAR_PEEK_KEEP_MARGIN) &&
    pointer.clientX <= bounds.right + SIDEBAR_PEEK_KEEP_MARGIN &&
    pointer.clientY >= Math.max(0, bounds.top - SIDEBAR_PEEK_KEEP_MARGIN) &&
    pointer.clientY <= bounds.bottom + SIDEBAR_PEEK_KEEP_MARGIN;
}

const UI_LANGUAGES = ["en", "ja", "zh", "ko"] as const;
type UiLanguage = (typeof UI_LANGUAGES)[number];
type AppSettings = {
  language: UiLanguage;
  reopenPreviousBoard: boolean;
  startupSidebar: "pinned" | "closed";
  edgeToEdge: boolean;
  canvas?: CanvasSettings;
  noteFont: string;
  noteFontSize: number;
  noteColor: string;
  autoSaveEnabled: boolean;
  autoSaveDelayMs: number;
};

const DEFAULT_SETTINGS: AppSettings = {
  language: "en",
  reopenPreviousBoard: true,
  startupSidebar: "pinned",
  edgeToEdge: false,
  canvas: DEFAULT_CANVAS_SETTINGS,
  ...DEFAULT_NOTE_SETTINGS,
  noteColor: "#f4d98b",
  autoSaveEnabled: true,
  autoSaveDelayMs: 1000,
};

function defaultSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  const preferredLanguages = window.museboardDesktop?.preferredLanguages ?? [];
  for (const locale of preferredLanguages) {
    const primary = locale.toLowerCase().split(/[-_]/)[0];
    const language = UI_LANGUAGES.find((entry) => entry === primary);
    if (language) return { ...DEFAULT_SETTINGS, language };
  }
  return DEFAULT_SETTINGS;
}

function readSettings(): AppSettings {
  const defaults = defaultSettings();
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") as Partial<AppSettings>;
    const legacyLanguage = localStorage.getItem(LANGUAGE_KEY);
    const language = UI_LANGUAGES.find((entry) => entry === stored.language)
      ?? UI_LANGUAGES.find((entry) => entry === legacyLanguage)
      ?? defaults.language;
    return { ...defaults, ...stored, ...normalizeNoteSettings(stored), language, edgeToEdge: stored.edgeToEdge === true,
      canvas: stored.canvas ? normalizeCanvasSettings(stored.canvas) : undefined } as AppSettings;
  } catch {
    return defaults;
  }
}

function translated(
  language: UiLanguage,
  values: { en: string; ja: string; zh: string; ko: string },
) {
  return values[language];
}

const STARTER_GUIDE_COPY = {
  ja: "ImageStorageへようこそ\n\n" +
    "画像とメモを自由に並べて、出典も残せる資料ボードを作れます。\n" +
    "画像の色をパレットにし、三分割や黄金比のガイドで構図を読み解けます。\n" +
    "拡張機能でWeb画像をリストに直接保存でき、Pinterestのボードもファイルから一括で取り込めます。\n\n" +
    "イラスト：ノーコピーライトガール（春）",
  en: "Welcome to ImageStorage\n\n" +
    "Build reference boards with images, source links, and notes.\n" +
    "Extract color palettes and study composition with thirds and golden ratio guides.\n" +
    "Send web images to lists with the extension. Import Pinterest boards from files.\n\n" +
    "Artwork by NoCopyrightGirl / Haru",
  zh: "欢迎使用 ImageStorage\n\n" +
    "自由排列图片和笔记，创建能记录出处的创作参考板。\n" +
    "从图片中提取配色，用三分法和黄金比例辅助线分析构图。\n" +
    "通过浏览器扩展将网页图片存入列表，也能从文件批量导入 Pinterest 图板。\n\n" +
    "插画作者为 NoCopyrightGirl / Haru",
  ko: "ImageStorage에 오신 것을 환영합니다\n\n" +
    "이미지와 메모를 자유롭게 배치해 출처까지 담은 자료 보드를 만들 수 있습니다.\n" +
    "이미지에서 색을 추출하고 삼분할·황금비 가이드로 구도를 분석할 수 있습니다.\n" +
    "확장 기능으로 웹 이미지를 목록에 저장하고 Pinterest 보드는 파일로 가져올 수 있습니다.\n\n" +
    "일러스트는 NoCopyrightGirl / Haru 작품입니다.",
} satisfies Record<UiLanguage, string>;

const LEGACY_JAPANESE_STARTER_COPY = "ImageStorageへようこそ\n\n" +
  "画像・URLを自由なキャンバスに集め、移動、比率固定の拡大縮小、回転ができます。\n" +
  "保存リストへ画像やリンクを直接ドロップして整理できます。\n" +
  "付箋へメモを残し、画像から6色のパレットを抽出できます。\n" +
  "変更は自動保存され、右クリックで複製・前後移動・削除、Ctrl+Zで元に戻せます。";

const LEGACY_STARTER_GUIDES = [
  { id: "default-note-ja", language: "ja", text: LEGACY_JAPANESE_STARTER_COPY },
  {
    id: "default-note-ja", language: "ja",
    text: LEGACY_JAPANESE_STARTER_COPY + "\n\nイラスト：ノーコピーライトガール（春）",
  },
  {
    id: "default-note-en", language: "en",
    text: "Welcome to ImageStorage\n\n" +
      "Collect images and URLs on an infinite canvas. Move, resize with locked proportions, and rotate them.\n" +
      "Drop images or links directly onto a saved list to organize them.\n" +
      "Add sticky notes and extract a six-color palette from any image.\n" +
      "Changes are saved automatically. Right-click to duplicate, reorder, rotate, or delete. Press Ctrl+Z to undo.\n\n" +
      "Artwork: NoCopyrightGirl / Haru",
  },
  {
    id: "default-guide", language: "ja",
    text: "ImageStorageへようこそ\n\n画像をキャンバスにドラッグして追加できます。\n" +
      "左下の「＋」から保存リストを作れます。\n画像を右クリックすると編集メニューが開きます。\n\n" +
      "変更は自動で保存されます。\nイラスト：ノーコピーライトガール（春）",
  },
  {
    id: "default-guide", language: "en",
    text: "Welcome to ImageStorage\n\nDrop images onto the canvas to add them.\n" +
      "Use + in the sidebar to create a saved list.\nRight-click an image for editing options.\n\n" +
      "Changes are saved automatically.\nArtwork by NoCopyrightGirl / Haru",
  },
  {
    id: "default-guide", language: "zh",
    text: "欢迎使用 ImageStorage\n\n将图片拖到画布上即可添加。\n" +
      "点击侧栏中的「＋」创建保存列表。\n右键点击图片可打开编辑菜单。\n\n" +
      "更改会自动保存。\n插画作者为 NoCopyrightGirl / Haru",
  },
  {
    id: "default-guide", language: "ko",
    text: "ImageStorage에 오신 것을 환영합니다\n\n이미지를 캔버스로 끌어다 놓아 추가하세요.\n" +
      "사이드바의 ‘＋’를 눌러 저장 목록을 만드세요.\n이미지를 우클릭하면 편집 메뉴가 열립니다.\n\n" +
      "변경 사항은 자동으로 저장됩니다.\n일러스트는 NoCopyrightGirl / Haru 작품입니다.",
  },
] as const;

function migrateStarterGuides(boards: Board[]): Board[] {
  const starter = boards.find((board) => board.id === "default");
  if (!starter) return boards;

  // Match the complete original text so edited notes keep the user's wording.
  const items = starter.items.map((item) => {
    if (item.type !== "note") return item;
    const previous = LEGACY_STARTER_GUIDES.find((guide) => guide.id === item.id && guide.text === item.text);
    return previous ? { ...item, text: STARTER_GUIDE_COPY[previous.language] } : item;
  });
  if (items.every((item, index) => item === starter.items[index])) return boards;
  return boards.map((board) => board === starter ? { ...starter, items } : board);
}

function createStarterBoard(language: UiLanguage): Board {
  return {
    id: "default",
    name: "default",
    accent: "#a9b7c6",
    updated: "just now",
    viewport: { x: 30, y: 44, scale: 0.85 },
    items: [
      {
        id: "default-artwork",
        type: "image",
        x: 0,
        y: 0,
        w: 240,
        h: 332.23,
        z: 1,
        src: "./nocopyrightgirl-sakura.webp",
        caption: "ILLUSTRATION / NO COPYRIGHT GIRL (HARU)",
        palette: [
          "#F7F5F4",
          "#2E4446",
          "#E895AA",
          "#D5B6BA",
          "#0AA5AD",
          "#844451",
        ],
      },
      {
        id: "default-guide",
        type: "note",
        x: 264,
        y: 0,
        w: 318,
        h: 218,
        z: 2,
        color: "#f4d98b",
        text: STARTER_GUIDE_COPY[language],
      },
    ],
  };
}

const noteColors = ["#f4d98b", "#b8d8c0", "#b9d8ec", "#deb9db", "#efb6a5"];
const imageResizeHandles: ResizeHandle[] = [
  "nw",
  "n",
  "ne",
  "e",
  "se",
  "s",
  "sw",
  "w",
];

function isLegacyUntitledStarter(boards: Board[]) {
  if (boards.length !== 1) return false;
  const [board] = boards;
  if (board.name.trim().toLowerCase() !== "untitled board") return false;
  if (board.items.length !== 1) return false;
  const [item] = board.items;
  return item.type === "note" && item.text?.trim() === "New note";
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

const HEADER_IMAGE_ASPECT_RATIO = 2.1;
const HEADER_IMAGE_DEFAULT_POSITION = 50;
const HEADER_IMAGE_MIN_SCALE = 1;
const HEADER_IMAGE_MAX_SCALE = 3;
const HEADER_IMAGE_SCALE_STEP = 0.05;

function getHeaderImageLayout(
  imageWidth: number,
  imageHeight: number,
  scale: number,
  positionX: number,
  positionY: number,
) {
  const safeWidth = Number.isFinite(imageWidth) && imageWidth > 0
    ? imageWidth
    : HEADER_IMAGE_ASPECT_RATIO;
  const safeHeight = Number.isFinite(imageHeight) && imageHeight > 0
    ? imageHeight
    : 1;
  const safeScale = clamp(scale, HEADER_IMAGE_MIN_SCALE, HEADER_IMAGE_MAX_SCALE);
  const imageAspectRatio = safeWidth / safeHeight;
  const coverWidthFactor = Math.max(1, imageAspectRatio / HEADER_IMAGE_ASPECT_RATIO);
  const coverHeightFactor = Math.max(1, HEADER_IMAGE_ASPECT_RATIO / imageAspectRatio);
  const widthFactor = coverWidthFactor * safeScale;
  const heightFactor = coverHeightFactor * safeScale;
  const minPositionX = 50 / widthFactor;
  const maxPositionX = 100 - minPositionX;
  const minPositionY = 50 / heightFactor;
  const maxPositionY = 100 - minPositionY;

  return {
    scale: safeScale,
    widthPercent: widthFactor * 100,
    heightPercent: heightFactor * 100,
    positionX: clamp(positionX, minPositionX, maxPositionX),
    positionY: clamp(positionY, minPositionY, maxPositionY),
  };
}

function constrainHeaderImageDraft(draft: HeaderImageDraft, scale = draft.scale) {
  const layout = getHeaderImageLayout(
    draft.imageWidth,
    draft.imageHeight,
    scale,
    draft.positionX,
    draft.positionY,
  );
  return {
    ...draft,
    scale: layout.scale,
    positionX: layout.positionX,
    positionY: layout.positionY,
  };
}

function normalizeRotation(value = 0) {
  return ((value % 360) + 360) % 360;
}

function isImageFillingCanvas(
  item: CanvasItem | undefined,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
) {
  if (
    item?.type !== "image" ||
    canvasWidth <= 0 ||
    canvasHeight <= 0
  ) {
    return false;
  }
  return (
    item.w * scale >= canvasWidth * 0.92 ||
    item.h * scale >= canvasHeight * 0.92
  );
}

function getImageMediaStyle(
  item: CanvasItem,
  viewportScale: number,
  includeImageFilter = true,
): CSSProperties {
  const rotation = normalizeRotation(item.rotation);
  const quarterTurn = rotation % 180 !== 0;
  return {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: (quarterTurn ? item.h : item.w) * viewportScale,
    height: (quarterTurn ? item.w : item.h) * viewportScale,
    transform: `translate(-50%, -50%) rotate(${rotation}deg) scaleX(${item.flipHorizontal ? -1 : 1})`,
    filter: includeImageFilter && item.grayscale ? "grayscale(1)" : undefined,
  };
}

function arrangeBoardItems(board: Board): Board {
  const startX = 64;
  const startY = 62;
  const columnWidth = 300;
  const columnGap = 32;
  const rowGap = 32;
  const ordered = [...board.items].sort((a, b) => a.z - b.z);
  const placements = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  let rowY = startY;

  for (let rowStart = 0; rowStart < ordered.length; rowStart += 3) {
    const row = ordered.slice(rowStart, rowStart + 3);
    const dimensions = row.map((item) => {
      if (item.type === "note") return { w: 260, h: 180 };
      const ratio = item.w / Math.max(item.h, 1);
      const w = ratio < 0.78 ? 235 : 300;
      return { w, h: clamp(w / ratio, 178, 390) };
    });
    const rowHeight = Math.max(...dimensions.map((entry) => entry.h));

    row.forEach((item, column) => {
      const size = dimensions[column];
      placements.set(item.id, {
        x:
          startX +
          column * (columnWidth + columnGap) +
          (columnWidth - size.w) / 2,
        y: rowY,
        w: size.w,
        h: size.h,
      });
    });
    rowY += rowHeight + rowGap;
  }

  return {
    ...board,
    updated: "just now",
    viewport: { x: 68, y: 54, scale: 0.88 },
    items: board.items.map((item) => ({
      ...item,
      ...placements.get(item.id),
      rotation: 0,
    })),
  };
}

function findOpenImagePosition(
  items: CanvasItem[],
  width: number,
  height: number,
  centerX: number,
  centerY: number,
) {
  const gap = 30;
  const stepX = Math.max(width, 360) + gap;
  const stepY = Math.max(height, 300) + gap;
  const originX = centerX - width / 2;
  const originY = centerY - height / 2;
  const isOpen = (x: number, y: number) =>
    items.every(
      (item) =>
        x + width + gap <= item.x ||
        x >= item.x + item.w + gap ||
        y + height + gap <= item.y ||
        y >= item.y + item.h + gap,
    );

  if (isOpen(originX, originY)) return { x: originX, y: originY };

  for (let ring = 1; ring <= 24; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.max(Math.abs(column), Math.abs(row)) !== ring) continue;
        const x = originX + column * stepX;
        const y = originY + row * stepY;
        if (isOpen(x, y)) return { x, y };
      }
    }
  }

  return {
    x: originX + items.length * gap,
    y: originY + items.length * gap,
  };
}

async function prepareImagePreview(file: File) {
  const source = URL.createObjectURL(file);
  const loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => {
      URL.revokeObjectURL(source);
      reject(new Error("Unsupported image data"));
    };
    image.src = source;
  });

  return {
    name: file.name || "reference-image",
    src: source,
    width: loaded.naturalWidth,
    height: loaded.naturalHeight,
    processing: true,
  };
}

function MiniPreview({ board }: { board: Board }) {
  if (board.headerImageSrc) {
    const layout = getHeaderImageLayout(
      board.headerImageWidth ?? 0,
      board.headerImageHeight ?? 0,
      board.headerImageScale ?? HEADER_IMAGE_MIN_SCALE,
      board.headerImagePositionX ?? HEADER_IMAGE_DEFAULT_POSITION,
      board.headerImagePositionY ?? HEADER_IMAGE_DEFAULT_POSITION,
    );
    return (
      <span className="mini-preview has-header" aria-hidden="true">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="mini-header-image"
          src={board.headerImageThumbnailSrc || board.headerImageSrc}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          style={{
            left: "50%",
            top: "50%",
            width: `${layout.widthPercent}%`,
            height: `${layout.heightPercent}%`,
            transform: `translate(-${layout.positionX}%, -${layout.positionY}%)`,
          }}
        />
      </span>
    );
  }
  const imageItems = board.items
    .filter((item) => item.type === "image" && item.src)
    .sort((a, b) => a.z - b.z);
  const previewItems = imageItems.slice(0, 4);
  const remainingCount = Math.max(0, imageItems.length - previewItems.length);
  return (
    <span
      className={`mini-preview ${previewItems.length ? "" : "empty"}`}
      aria-hidden="true"
    >
      {previewItems.map((item) => (
        <span key={item.id} className="mini-tile image">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.thumbnailSrc || item.src}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
          />
        </span>
      ))}
      {remainingCount > 0 && (
        <span className="mini-preview-more">+{remainingCount}</span>
      )}
    </span>
  );
}

export default function Home() {
  const [settings, setSettings] = useState<AppSettings>(readSettings);
  const [starterBoards] = useState(() => [createStarterBoard(settings.language)]);
  const [boards, setBoards] = useState<Board[]>(starterBoards);
  const [activeId, setActiveId] = useState(starterBoards[0].id);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionMarquee, setSelectionMarquee] =
    useState<SelectionMarquee | null>(null);
  const [search, setSearch] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTabOpen, setSettingsTabOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState(0);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [sidebarMenu, setSidebarMenu] = useState<"main" | "create" | null>(null);
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [showListManager, setShowListManager] = useState(false);
  const [listManagerDraft, setListManagerDraft] = useState<Board[]>([]);
  const [listManagerDraggedId, setListManagerDraggedId] = useState<string | null>(null);
  const [listManagerDropTarget, setListManagerDropTarget] = useState<BoardDropTarget | null>(null);
  const [pendingDeleteBoardId, setPendingDeleteBoardId] = useState<
    string | null
  >(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarPeekOpen, setSidebarPeekOpen] = useState(false);
  const [assetDropBoardId, setAssetDropBoardId] = useState<string | null>(null);
  const [itemContextMenu, setItemContextMenu] =
    useState<ItemContextMenu | null>(null);
  const [paletteLoadingId, setPaletteLoadingId] = useState<string | null>(null);
  const [copiedColor, setCopiedColor] = useState<string | null>(null);
  const [paletteSuppressedItemId, setPaletteSuppressedItemId] = useState<
    string | null
  >(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>("all");
  const [libraryTag, setLibraryTag] = useState<string | null>(null);
  const [showBoardGrouping, setShowBoardGrouping] = useState(false);
  const [boardGroupNameDraft, setBoardGroupNameDraft] = useState("");
  const [boardGroupSelection, setBoardGroupSelection] = useState<string[]>([]);
  const [imageInfoDraft, setImageInfoDraft] = useState<ImageInfoDraft | null>(null);
  const [headerImageDraft, setHeaderImageDraft] = useState<HeaderImageDraft | null>(null);
  const [headerImageError, setHeaderImageError] = useState<string | null>(null);
  const [showArrangeMenu, setShowArrangeMenu] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [boardFileImport, setBoardFileImport] = useState<PinterestBoardFile | null>(null);
  const boardFileGenerationRef = useRef(0);
  const boardFileChoosingRef = useRef(false);
  const modalInteractionBlocked = Boolean(
    boardFileImport || storageBusy || showLibrary || showBoardGrouping || showListManager || showShortcuts ||
    imageInfoDraft || headerImageDraft || pendingDeleteBoardId || showCommandPalette || sidebarMenu,
  );
  const canvasShortcutsBlocked = showSettings || modalInteractionBlocked;
  useDialogFocus(
    boardFileImport ? ".pinterest-board-import-dialog" : pendingDeleteBoardId ? ".confirmation-dialog" : headerImageDraft ? ".header-image-editor" :
    showListManager ? ".list-manager-dialog" : imageInfoDraft ? ".image-info-dialog" : showBoardGrouping ? ".board-grouping-dialog" :
    showLibrary ? ".library-dialog" : showShortcuts ? ".shortcuts-popover" : null,
  );

  const canvasRef = useRef<HTMLDivElement>(null);
  const canvasWorldRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const actionRef = useRef<PointerAction | null>(null);
  const spacePressedRef = useRef(false);
  const boardsRef = useRef<Board[]>(boards);
  const activeIdRef = useRef(activeId);
  const projectGenerationRef = useRef(0);
  const extensionImportsRef = useRef(new Map<string, { generation: number; boardId: string; itemIds: string[]; removing?: boolean; count?: number; processed?: boolean; failed?: boolean; undoSnapshot?: UndoSnapshot }>());
  const undoStackRef = useRef<UndoSnapshot[]>([]);
  const redoStackRef = useRef<UndoSnapshot[]>([]);
  const groupSnapshotRecordedRef = useRef(false);
  const assetMigrationStartedRef = useRef(false);
  const headerImageDragRef = useRef<HeaderImageDrag | null>(null);
  const headerImageRequestRef = useRef(0);
  const listManagerSessionRef = useRef(0);
  const listManagerBaseRef = useRef<Board[]>([]);
  const listManagerDragRef = useRef<string | null>(null);
  const listManagerDropTargetRef = useRef<BoardDropTarget | null>(null);
  const listManagerPointerDragRef = useRef<ReturnType<typeof createListManagerPointerDrag> | null>(null);
  const listManagerGhostRef = useRef<HTMLDivElement | null>(null);
  const listManagerIndicatorRef = useRef<HTMLDivElement | null>(null);
  const listManagerPreviewDragRef = useRef<string | null>(null);
  const listManagerContentRef = useRef<HTMLDivElement>(null);
  const listManagerAutoScrollRef = useRef<ReturnType<typeof createListManagerAutoScroll> | null>(null);
  const sidebarPeekTimerRef = useRef<number | null>(null);
  const sidebarPeekPointerRef = useRef<SidebarPeekPointer | null>(null);
  const sidebarPeekNativePointerRef = useRef<SidebarPeekPointer | null | undefined>(undefined);
  const sidebarPeekDecisionRef = useRef(0);
  const initialSettingsRef = useRef(settings);
  const settingsRef = useRef(settings);
  const backgroundRequestRef = useRef(0);
  const settingsPageRef = useRef<HTMLElement>(null);

  const endListManagerDrag = useCallback(() => {
    listManagerPointerDragRef.current?.cancel();
    listManagerAutoScrollRef.current?.stop();
    listManagerGhostRef.current?.remove();
    listManagerGhostRef.current = null;
    listManagerIndicatorRef.current?.remove();
    listManagerIndicatorRef.current = null;
    listManagerDragRef.current = null;
    listManagerDropTargetRef.current = null;
    setListManagerDraggedId(null);
    setListManagerDropTarget(null);
  }, []);

  const closeListManager = useCallback(() => {
    endListManagerDrag();
    listManagerPreviewDragRef.current = null;
    listManagerSessionRef.current += 1;
    headerImageRequestRef.current += 1;
    listManagerBaseRef.current = [];
    setShowListManager(false);
    setListManagerDraft([]);
    setPendingDeleteBoardId(null);
    setHeaderImageError(null);
    setHeaderImageDraft((current) => current?.managerSession !== undefined ? null : current);
  }, [endListManagerDrag]);

  const getListManagerDragTarget = useCallback((x: number, y: number) => {
    const content = listManagerContentRef.current;
    const sourceId = listManagerDragRef.current;
    if (!content || !sourceId) return null;
    const rows = Array.from(content.querySelectorAll<HTMLElement>(".list-manager-row")).map((row) => {
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.boardId!, top: rect.top, bottom: rect.bottom };
    });
    return getListManagerDropTarget(rows, sourceId, x, y, content.getBoundingClientRect(), listManagerDropTargetRef.current);
  }, []);

  const updateListManagerDragTarget = useCallback((x: number, y: number) => {
    const target = getListManagerDragTarget(x, y);
    listManagerDropTargetRef.current = target;
    const content = listManagerContentRef.current;
    const indicator = listManagerIndicatorRef.current;
    if (indicator && content) {
      const row = target && Array.from(content.querySelectorAll<HTMLElement>(".list-manager-row")).find((element) => element.dataset.boardId === target.boardId);
      indicator.hidden = !row;
      if (row && target) {
        const rect = row.getBoundingClientRect();
        const bounds = content.getBoundingClientRect();
        const edge = target.edge === "before" ? rect.top - 6 : rect.bottom + 4;
        const top = Math.max(bounds.top + 1, Math.min(bounds.bottom - 3, edge));
        indicator.style.transform = `translate(${rect.left}px, ${top}px)`;
        indicator.style.width = `${rect.width}px`;
      }
    }
    setListManagerDropTarget((current) => current?.boardId === target?.boardId && current?.edge === target?.edge ? current : target);
  }, [getListManagerDragTarget]);

  const commitListManagerDrop = useCallback((sourceId: string) => {
    // Commit exactly the slot used by the insertion indicator, only once on pointer-up.
    const target = listManagerDropTargetRef.current;
    if (!target) return;
    setListManagerDraft((current) => {
      const source = current.find((board) => board.id === sourceId);
      if (!source || sourceId === target.boardId || !current.some((board) => board.id === target.boardId)) return current;
      const next = current.filter((board) => board.id !== sourceId);
      const index = next.findIndex((board) => board.id === target.boardId);
      next.splice(index + (target.edge === "after" ? 1 : 0), 0, source);
      return next;
    });
  }, []);

  useEffect(() => {
    const content = listManagerContentRef.current;
    if (!showListManager || headerImageDraft || pendingDeleteBoardId || !content) return;
    const scroll = createListManagerAutoScroll(content, () => Boolean(listManagerDragRef.current), updateListManagerDragTarget);
    listManagerAutoScrollRef.current = scroll;
    const drag = createListManagerPointerDrag({
      onStart: (sourceId) => {
        listManagerDragRef.current = sourceId;
        listManagerPreviewDragRef.current = sourceId;
        setListManagerDraggedId(sourceId);
        // A small pointer-following preview replaces the browser's native drag image.
        const row = Array.from(content.querySelectorAll<HTMLElement>(".list-manager-row")).find((element) => element.dataset.boardId === sourceId);
        const ghost = document.createElement("div");
        ghost.className = "list-manager-drag-ghost";
        ghost.setAttribute("aria-hidden", "true");
        const preview = row?.querySelector(".mini-preview");
        if (preview) ghost.append(preview.cloneNode(true));
        const label = document.createElement("span");
        label.textContent = row?.querySelector<HTMLInputElement>(".list-manager-name")?.value ?? "";
        ghost.append(label);
        document.body.append(ghost);
        listManagerGhostRef.current = ghost;
        const indicator = document.createElement("div");
        indicator.className = "list-manager-drop-indicator";
        indicator.setAttribute("aria-hidden", "true");
        indicator.hidden = true;
        document.body.append(indicator);
        listManagerIndicatorRef.current = indicator;
      },
      onMove: (x, y) => {
        if (listManagerGhostRef.current) listManagerGhostRef.current.style.transform = `translate(${x + 14}px, ${y + 14}px)`;
        updateListManagerDragTarget(x, y);
        scroll.update(x, y);
      },
      onDrop: commitListManagerDrop,
      onEnd: endListManagerDrag,
    });
    listManagerPointerDragRef.current = drag;
    const track = (event: globalThis.PointerEvent) => {
      if (drag.move(event)) { event.preventDefault(); event.stopPropagation(); }
    };
    const finish = (event: globalThis.PointerEvent) => {
      if (drag.finish(event)) { event.preventDefault(); event.stopPropagation(); }
    };
    const cancelPointer = (event: globalThis.PointerEvent) => drag.lostCapture(event);
    const lostCapture = (event: globalThis.PointerEvent) => {
      // Touch/pen can transfer implicit capture from a preview button to its row.
      // Losing the old button's capture must not cancel the new row capture.
      if ((event.target as HTMLElement | null)?.dataset?.boardId === listManagerDragRef.current) drag.lostCapture(event);
    };
    const key = (event: KeyboardEvent) => {
      if (!drag.active) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); drag.cancel(); }
      else if (event.key === "Tab") { event.preventDefault(); event.stopPropagation(); }
    };
    const refresh = () => {
      if (drag.active && drag.pointer) updateListManagerDragTarget(drag.pointer.x, drag.pointer.y);
    };
    const hide = () => { if (document.hidden) drag.cancel(); };
    window.addEventListener("pointermove", track, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancelPointer, true);
    window.addEventListener("blur", drag.cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", drag.cancel);
    document.addEventListener("visibilitychange", hide);
    content.addEventListener("lostpointercapture", lostCapture, true);
    content.addEventListener("scroll", refresh);
    return () => {
      drag.cancel();
      endListManagerDrag();
      listManagerPointerDragRef.current = null;
      listManagerAutoScrollRef.current = null;
      window.removeEventListener("pointermove", track, true);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancelPointer, true);
      window.removeEventListener("blur", drag.cancel);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", drag.cancel);
      document.removeEventListener("visibilitychange", hide);
      content.removeEventListener("lostpointercapture", lostCapture, true);
      content.removeEventListener("scroll", refresh);
    };
  }, [showListManager, headerImageDraft, pendingDeleteBoardId, updateListManagerDragTarget, commitListManagerDrop, endListManagerDrag]);

  const openSettingsPage = useCallback(() => {
    setSettingsTabOpen(true);
    setShowSettings(true);
  }, []);

  const closeSettingsPage = useCallback(() => {
    setShowSettings(false);
    setSettingsTabOpen(false);
    window.requestAnimationFrame(() => {
      const activeList = document.querySelector<HTMLElement>(".board-row.active .board-button");
      const target = activeList && !activeList.closest("[inert], [hidden]")
        ? activeList
        : document.querySelector<HTMLElement>(".workspace:not([hidden])");
      target?.focus({ preventScroll: true });
    });
  }, []);

  useEffect(() => {
    if (!showSettings) return;
    const frame = window.requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>(".sidebar-settings-row")?.scrollIntoView({ block: "nearest" });
      settingsPageRef.current?.querySelector<HTMLElement>(
        '.settings-categories button[aria-current="page"]',
      )?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [showSettings]);

  const canvasSettings = settings.canvas ?? DEFAULT_CANVAS_SETTINGS;
  const storedActiveBoard = boards.find((board) => board.id === activeId) ?? boards[0];
  const activeBoard = useMemo(
    () => storedActiveBoard ? { ...storedActiveBoard, ...canvasSettings } : storedActiveBoard,
    [storedActiveBoard, canvasSettings],
  );
  const updateCanvasSettings = useCallback((patch: Partial<CanvasSettings>) => {
    if (Object.prototype.hasOwnProperty.call(patch, "backgroundImageSrc")) backgroundRequestRef.current += 1;
    setSettings((current) => ({
      ...current,
      canvas: normalizeCanvasSettings({ ...(current.canvas ?? DEFAULT_CANVAS_SETTINGS), ...patch }),
    }));
  }, []);
  const activeWorkspace = workspaceFilter && boards.some((board) => board.groupName?.trim() === workspaceFilter)
    ? workspaceFilter : null;
  const selectedId = selectedIds.at(-1) ?? null;
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const language = settings.language;
  const text = useCallback(
    (en: string, ja: string, zh: string, ko: string) =>
      translated(language, { en, ja, zh, ko }),
    [language],
  );
  const headerImageLayout = headerImageDraft
    ? getHeaderImageLayout(
        headerImageDraft.imageWidth,
        headerImageDraft.imageHeight,
        headerImageDraft.scale,
        headerImageDraft.positionX,
        headerImageDraft.positionY,
      )
    : null;
  const pendingDeleteBoard = pendingDeleteBoardId
    ? (showListManager ? listManagerDraft : boards).find((board) => board.id === pendingDeleteBoardId)
    : undefined;
  const selectedItem = activeBoard?.items.find(
    (item) => item.id === selectedId,
  );
  const selectedImageItems = useMemo(
    () =>
      activeBoard?.items.filter(
        (item) => item.type === "image" && selectedIdSet.has(item.id),
      ) ?? [],
    [activeBoard?.items, selectedIdSet],
  );
  const contextMenuItem = itemContextMenu
    ? activeBoard?.items.find((item) => item.id === itemContextMenu.itemId)
    : undefined;
  const imageInfoItem = imageInfoDraft
    ? boards
        .find((board) => board.id === imageInfoDraft.boardId)
        ?.items.find((item) => item.id === imageInfoDraft.itemId)
    : undefined;
  const contentBounds = useMemo(() => {
    if (!activeBoard?.items.length) return null;
    const minX = Math.min(...activeBoard.items.map((item) => item.x));
    const minY = Math.min(...activeBoard.items.map((item) => item.y));
    const maxX = Math.max(
      ...activeBoard.items.map((item) => item.x + item.w),
    );
    const maxY = Math.max(
      ...activeBoard.items.map((item) => item.y + item.h),
    );
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }, [activeBoard]);
  const getCanvasSidebarOffset = useCallback(() => {
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const worldRect = canvasWorldRef.current?.getBoundingClientRect();
    if (!canvasRect || !worldRect || !activeBoard) return 0;
    return worldRect.left - canvasRect.left - activeBoard.viewport.x;
  }, [activeBoard]);
  const syncImagePaletteVisibility = useCallback(
    (
      item: CanvasItem | undefined,
      scale: number,
      bounds?: { width: number; height: number },
    ) => {
      const canvasBounds = bounds ?? canvasRef.current?.getBoundingClientRect();
      setPaletteSuppressedItemId(
        canvasBounds &&
          isImageFillingCanvas(
            item,
            scale,
            canvasBounds.width,
            canvasBounds.height,
          )
          ? item?.id ?? null
          : null,
      );
    },
    [],
  );

  const filteredBoards = useMemo(() => {
    const query = search.trim().toLowerCase();
    const workspaceBoards = activeWorkspace
      ? boards.filter((board) => board.groupName?.trim() === activeWorkspace) : boards;
    const filtered = query
      ? workspaceBoards.filter((board) =>
          `${board.groupName || ""} ${board.name}`.toLowerCase().includes(query),
        )
      : workspaceBoards;
    return filtered;
  }, [boards, search, activeWorkspace]);

  const boardGroups = useMemo(
    () =>
      Array.from(
        new Set(
          boards
            .map((board) => board.groupName?.trim())
            .filter((groupName): groupName is string => Boolean(groupName)),
        ),
      ).sort((first, second) => first.localeCompare(second)),
    [boards],
  );

  const projectImages = useMemo(
    () =>
      boards.flatMap((board) =>
        board.items
          .filter((item) => item.type === "image")
          .map((item) => ({ board, item })),
      ),
    [boards],
  );
  const libraryTags = useMemo(
    () =>
      Array.from(
        new Set(projectImages.flatMap(({ item }) => item.tags ?? [])),
      ).sort((first, second) => first.localeCompare(second)),
    [projectImages],
  );
  const libraryImages = useMemo(() => {
    const query = libraryQuery.trim().toLocaleLowerCase();
    return projectImages.filter(({ board, item }) => {
      if (libraryFilter === "favorite" && !item.favorite) return false;
      if (libraryTag && !(item.tags ?? []).includes(libraryTag)) return false;
      if (!query) return true;
      return [
        board.name,
        item.caption,
        item.creator,
        item.sourceUrl,
        item.referenceNote,
        ...(item.tags ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(query);
    });
  }, [libraryFilter, libraryQuery, libraryTag, projectImages]);

  useEffect(() => {
    boardsRef.current = boards;
  }, [boards]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    if (!hydrated) return;
    const save = window.museboardDesktop?.saveGlobalBackground;
    if (!save) return;
    let canceled = false;
    void save({
      backgroundImageSrc: canvasSettings.backgroundImageSrc,
      backgroundImageThumbnailSrc: canvasSettings.backgroundImageThumbnailSrc,
      backgroundImageAssetId: canvasSettings.backgroundImageAssetId,
    }).then((result) => {
      if (!canceled && !result.saved) setImportNotice("Could not save the shared background reference");
    }).catch(() => {
      if (!canceled) setImportNotice("Could not save the shared background reference");
    });
    return () => { canceled = true; };
  }, [hydrated, canvasSettings.backgroundImageSrc, canvasSettings.backgroundImageThumbnailSrc, canvasSettings.backgroundImageAssetId]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    document.documentElement.lang = language;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    localStorage.setItem(LANGUAGE_KEY, language);
  }, [language, settings]);

  useEffect(() => {
    const handleLanguageChange = (event: Event) => {
      const nextLanguage = (
        event as CustomEvent<{ language?: UiLanguage }>
      ).detail?.language;
      if (!nextLanguage || !["en", "ja", "zh", "ko"].includes(nextLanguage)) return;
      setSettings((current) => ({ ...current, language: nextLanguage }));
      document.documentElement.lang = nextLanguage;
    };
    const handleHelpToggle = () => {
      setShowShortcuts((current) => !current);
    };
    window.addEventListener(
      "imagestorage:language-change",
      handleLanguageChange,
    );
    window.addEventListener("imagestorage:toggle-help", handleHelpToggle);
    return () => {
      window.removeEventListener(
        "imagestorage:language-change",
        handleLanguageChange,
      );
      window.removeEventListener("imagestorage:toggle-help", handleHelpToggle);
    };
  }, []);

  const recordUndoSnapshot = useCallback((snapshot?: UndoSnapshot) => {
    undoStackRef.current.push({
      boards: structuredClone(snapshot?.boards ?? boardsRef.current),
      activeId: snapshot?.activeId ?? activeIdRef.current,
    });
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
    redoStackRef.current = [];
    setHistoryAvailability({ undo: true, redo: false });
  }, []);

  const undoLastChange = useCallback(() => {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push({
      boards: structuredClone(boardsRef.current),
      activeId: activeIdRef.current,
    });
    if (redoStackRef.current.length > 60) redoStackRef.current.shift();
    setHistoryAvailability({ undo: undoStackRef.current.length > 0, redo: true });
    boardsRef.current = previous.boards;
    setBoards(previous.boards);
    setActiveId(previous.activeId);
    setWorkspaceFilter((current) => previous.boards.find((board) => board.id === previous.activeId)?.groupName?.trim() === current ? current : null);
    setSelectedIds([]);
    setSelectionMarquee(null);
    setItemContextMenu(null);
  }, []);

  const redoLastChange = useCallback(() => {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push({
      boards: structuredClone(boardsRef.current),
      activeId: activeIdRef.current,
    });
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
    boardsRef.current = next.boards;
    setHistoryAvailability({ undo: true, redo: redoStackRef.current.length > 0 });
    setBoards(next.boards);
    setActiveId(next.activeId);
    setWorkspaceFilter((current) => next.boards.find((board) => board.id === next.activeId)?.groupName?.trim() === current ? current : null);
    setSelectedIds([]);
    setSelectionMarquee(null);
    setItemContextMenu(null);
  }, []);

  useEffect(() => {
    let canceled = false;
    const hydrate = async () => {
      let previousActiveId = activeIdRef.current;
      try {
        const restored = await window.museboardDesktop?.loadAutosave?.();
        if (
          restored?.found &&
          restored.data &&
          Array.isArray(restored.data.boards) &&
          restored.data.boards.length
        ) {
          const restoredBoards = migrateStarterGuides(
            migrateBoardAnalysisGuides(restored.data.boards as Board[]),
          );
          const restoredActiveId = restoredBoards.some(
            (board) => board.id === restored.data?.activeId,
          )
            ? restored.data.activeId
            : restoredBoards[0].id;
          if (!canceled) {
            previousActiveId = restoredActiveId;
            setBoards(restoredBoards);
            boardsRef.current = restoredBoards;
            setActiveId(restoredActiveId);
            if (restored.recoveredFromBackup) {
              setImportNotice("Recovered from an automatic backup");
            }
          }
        } else {
          const saved = localStorage.getItem(STORAGE_KEY);
          const savedActiveId = localStorage.getItem(ACTIVE_KEY);
          const alreadyAligned =
            localStorage.getItem(ALIGNED_LAYOUT_KEY) === "complete";
          const starterIsCurrent =
            localStorage.getItem(STARTER_VERSION_KEY) === STARTER_VERSION;
          if (saved) {
            const parsed = JSON.parse(saved) as Board[];
            if (Array.isArray(parsed) && parsed.length) {
              const upgradeLegacyStarter =
                !starterIsCurrent && isLegacyUntitledStarter(parsed);
              const loadedBoards = upgradeLegacyStarter
                ? starterBoards
                : alreadyAligned
                  ? parsed
                  : parsed.map(arrangeBoardItems);
              const nextBoards = migrateStarterGuides(migrateBoardAnalysisGuides(loadedBoards));
              if (!canceled) {
                setBoards(nextBoards);
                boardsRef.current = nextBoards;
                if (upgradeLegacyStarter) {
                  previousActiveId = starterBoards[0].id;
                  setActiveId(starterBoards[0].id);
                } else if (
                  savedActiveId &&
                  nextBoards.some((board) => board.id === savedActiveId)
                ) {
                  previousActiveId = savedActiveId;
                  setActiveId(savedActiveId);
                }
              }
            }
          } else if (!canceled) {
            setBoards(starterBoards);
            boardsRef.current = starterBoards;
            setActiveId(starterBoards[0].id);
          }
          if (!alreadyAligned) {
            localStorage.setItem(ALIGNED_LAYOUT_KEY, "complete");
          }
        }
        localStorage.setItem(STARTER_VERSION_KEY, STARTER_VERSION);
        if (!canceled) {
          const startupSettings = initialSettingsRef.current;
          // Migrate once from the last used list, before the startup-list preference is applied.
          const previousBoard = boardsRef.current.find((board) => board.id === previousActiveId) ?? boardsRef.current[0];
          setSettings((current) => current.canvas ? current : { ...current, canvas: normalizeCanvasSettings(previousBoard) });
          if (!startupSettings.reopenPreviousBoard && boardsRef.current[0]) {
            setActiveId(boardsRef.current[0].id);
          }
          setSidebarCollapsed(startupSettings.startupSidebar === "closed");
          setSidebarPeekOpen(false);
        }
      } catch {
        // A clean starter board remains available if recovery data cannot be read.
      } finally {
        if (!canceled) setHydrated(true);
      }
    };
    void hydrate();
    return () => {
      canceled = true;
    };
  }, [starterBoards]);

  useEffect(() => {
    if (!hydrated) return;
    const snapshot = {
      format: "museboard" as const,
      version: 2,
      savedAt: new Date().toISOString(),
      activeId,
      boards: applyNoteSettings(applyCanvasSettings(boards, canvasSettings), settings),
    };
    if (!settings.autoSaveEnabled) return;
    try {
      const compactBoards = JSON.stringify(snapshot.boards);
      if (compactBoards.length < 4_000_000) {
        localStorage.setItem(STORAGE_KEY, compactBoards);
      }
      localStorage.setItem(ACTIVE_KEY, activeId);
    } catch {
      // The file-based autosave remains available if browser storage is full.
    }
    const desktop = window.museboardDesktop;
    if (!desktop?.autoSaveProject) return;
    const generation = projectGenerationRef.current;
    window.dispatchEvent(
      new CustomEvent("imagestorage:autosave-status", {
        detail: { status: "saving" },
      }),
    );
    const timer = window.setTimeout(() => {
      // A restored/opened project can replace the refs before React cleans up
      // this effect. Never let its old debounce overwrite the new recovery.
      if (generation !== projectGenerationRef.current) return;
      void desktop.autoSaveProject(snapshot).then((result) => {
        window.dispatchEvent(
          new CustomEvent("imagestorage:autosave-status", {
            detail: {
              status: result.saved ? "saved" : "error",
              error: result.error,
            },
          }),
        );
      });
    }, settings.autoSaveDelayMs);
    return () => window.clearTimeout(timer);
  }, [activeId, boards, hydrated, settings, canvasSettings]);

  useEffect(() => {
    const desktop = window.museboardDesktop;
    if (!desktop?.onCloseRequest || !desktop.completeClose) return;
    return desktop.onCloseRequest(() => {
      if (!settingsRef.current.autoSaveEnabled) {
        desktop.completeClose({ skipRecovery: true });
        return;
      }
      desktop.completeClose({
        format: "museboard",
        version: 2,
        savedAt: new Date().toISOString(),
        activeId: activeIdRef.current,
        boards: applyNoteSettings(applyCanvasSettings(boardsRef.current, settingsRef.current.canvas ?? DEFAULT_CANVAS_SETTINGS), settingsRef.current),
      });
    });
  }, []);

  useEffect(() => {
    if (!importNotice) return;
    const timer = window.setTimeout(() => setImportNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [importNotice]);

  useEffect(() => {
    const handleProjectLoad = (event: Event) => {
      const project = (
        event as CustomEvent<{
          format?: string;
          activeId?: string;
          boards?: Board[];
        }>
      ).detail;
      if (
        project?.format !== "museboard" ||
        !Array.isArray(project.boards) ||
        project.boards.length === 0 ||
        typeof project.activeId !== "string"
      ) {
        return;
      }
      const nextActiveId = project.boards.some(
        (board) => board.id === project.activeId,
      )
        ? project.activeId
        : project.boards[0].id;
      projectGenerationRef.current += 1;
      const nextBoards = migrateBoardAnalysisGuides(project.boards);
      setBoards(nextBoards);
      boardsRef.current = nextBoards;
      undoStackRef.current = [];
      redoStackRef.current = [];
      setHistoryAvailability({ undo: false, redo: false });
      setWorkspaceFilter(null);
      setCollapsedGroups(new Set());
      activeIdRef.current = nextActiveId;
      setActiveId(nextActiveId);
      setSelectedIds([]);
      setSelectionMarquee(null);
      setItemContextMenu(null);
      closeListManager();
      setHeaderImageDraft(null);
    };

    window.addEventListener("museboard:load-project", handleProjectLoad);
    return () =>
      window.removeEventListener("museboard:load-project", handleProjectLoad);
  }, [closeListManager]);

  useEffect(() => {
    const handleProjectSave = async () => {
      const result = await window.museboardDesktop?.saveProject({
        format: "museboard",
        version: 2,
        savedAt: new Date().toISOString(),
        activeId,
        boards: applyNoteSettings(applyCanvasSettings(boards, canvasSettings), settings),
      });
      if (result && !result.canceled) {
        window.dispatchEvent(
          new CustomEvent("museboard:project-saved", {
            detail: { name: result.name },
          }),
        );
      }
    };

    window.addEventListener("museboard:save-request", handleProjectSave);
    return () =>
      window.removeEventListener("museboard:save-request", handleProjectSave);
  }, [activeId, boards, canvasSettings, settings]);

  const updateBoard = useCallback(
    (boardId: string, updater: (board: Board) => Board) => {
      setBoards((current) =>
        current.map((board) => (board.id === boardId ? updater(board) : board)),
      );
    },
    [],
  );

  const updateActiveBoard = useCallback(
    (updater: (board: Board) => Board) => updateBoard(activeId, updater),
    [activeId, updateBoard],
  );

  const measureNoteHeight = useCallback((textarea: HTMLTextAreaElement) => {
    const previousHeight = textarea.style.height;
    textarea.style.height = "0px";
    const viewportScale = Math.max(
      Number.EPSILON,
      Number(textarea.dataset.canvasScale) || 1,
    );
    const height = Math.max(
      172,
      Math.ceil(textarea.scrollHeight / viewportScale),
    );
    textarea.style.height = previousHeight;
    return height;
  }, []);

  const updateNoteText = useCallback(
    (itemId: string, text: string, textarea: HTMLTextAreaElement) => {
      const requiredHeight = measureNoteHeight(textarea);
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: board.items.map((entry) =>
          entry.id === itemId
            ? {
                ...entry,
                text,
                h: Math.max(entry.h, requiredHeight),
              }
            : entry,
        ),
      }));
    },
    [measureNoteHeight, updateActiveBoard],
  );

  useEffect(() => {
    // Hidden textareas cannot be measured; reflow after returning from Settings.
    if (!activeBoard || showSettings) return;
    const frame = window.requestAnimationFrame(() => {
      const requiredHeights = new Map<string, number>();
      document
        .querySelectorAll<HTMLTextAreaElement>("textarea[data-note-id]")
        .forEach((textarea) => {
          const itemId = textarea.dataset.noteId;
          if (itemId) requiredHeights.set(itemId, measureNoteHeight(textarea));
        });
      if (!requiredHeights.size) return;
      updateActiveBoard((board) => {
        let changed = false;
        const items = board.items.map((item) => {
          const requiredHeight = requiredHeights.get(item.id);
          if (
            item.type !== "note" ||
            !requiredHeight ||
            requiredHeight <= item.h
          ) {
            return item;
          }
          changed = true;
          return { ...item, h: requiredHeight };
        });
        return changed ? { ...board, items } : board;
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeBoard, measureNoteHeight, updateActiveBoard, showSettings, settings.noteFont, settings.noteFontSize]);

  useEffect(() => {
    const desktop = window.museboardDesktop;
    if (
      !hydrated ||
      assetMigrationStartedRef.current ||
      !desktop?.persistImageSource
    ) {
      return;
    }
    assetMigrationStartedRef.current = true;
    const generation = projectGenerationRef.current;
    const candidates = boardsRef.current.flatMap((board) =>
      board.items
        .filter(
          (item) =>
            item.type === "image" &&
            !item.assetId &&
            Boolean(item.src) &&
            /^(?:data:image\/|https?:)/i.test(item.src || ""),
        )
        .map((item) => ({ boardId: board.id, item })),
    );
    const migrateLegacyImages = async () => {
      for (const candidate of candidates) {
        if (generation !== projectGenerationRef.current) return;
        const result = await desktop.persistImageSource({
          source: candidate.item.src || "",
          name: candidate.item.caption || "reference-image",
        });
        if (generation !== projectGenerationRef.current) return;
        const image = result.image;
        if (!image) continue;
        updateBoard(candidate.boardId, (board) => ({
          ...board,
          items: board.items.map((item) =>
            item.id === candidate.item.id && item.src === candidate.item.src
              ? {
                  ...item,
                  src: image.src,
                  thumbnailSrc: image.thumbnailSrc,
                  palette: image.palette,
                  assetId: image.assetId,
                  processing: false,
                }
              : item,
          ),
        }));
      }
    };
    void migrateLegacyImages();
  }, [hydrated, updateBoard]);

  const clearSidebarPeekTimer = useCallback(() => {
    sidebarPeekDecisionRef.current += 1;
    if (sidebarPeekTimerRef.current === null) return;
    window.clearTimeout(sidebarPeekTimerRef.current);
    sidebarPeekTimerRef.current = null;
  }, []);

  useEffect(() => {
    return window.museboardDesktop?.onImageAnalysisUpdate?.(({ itemId, analysis }) => {
      const current = boardsRef.current;
      if (!current.some((board) => board.items.some((item) =>
        item.type === "image" && item.id === itemId && JSON.stringify(item.analysis) !== JSON.stringify(analysis),
      ))) return;
      recordUndoSnapshot();
      const next = current.map((board) => ({
          ...board,
          items: board.items.map((item) =>
            item.type === "image" && item.id === itemId ? { ...item, analysis } : item,
          ),
        }));
      boardsRef.current = next;
      setBoards(next);
    });
  }, [recordUndoSnapshot]);

  const showSidebarPeek = useCallback(() => {
    if (!sidebarCollapsed) return;
    clearSidebarPeekTimer();
    setSidebarPeekOpen(true);
  }, [clearSidebarPeekTimer, sidebarCollapsed]);

  const hideSidebarPeek = useCallback(() => {
    if (!sidebarCollapsed || sidebarMenu || sidebarPeekTimerRef.current !== null) return;
    const decision = ++sidebarPeekDecisionRef.current;
    sidebarPeekTimerRef.current = window.setTimeout(async () => {
      let nativePointer = sidebarPeekNativePointerRef.current;
      const desktop = window.museboardDesktop;
      if (desktop?.getWindowPointerPosition) {
        try {
          nativePointer = await desktop.getWindowPointerPosition();
        } catch {
          // An unverified pointer position must not dismiss the list.
          if (decision === sidebarPeekDecisionRef.current) sidebarPeekTimerRef.current = null;
          return;
        }
      }
      // Re-entering the pane cancels even a close already waiting for IPC.
      if (decision !== sidebarPeekDecisionRef.current) return;
      sidebarPeekTimerRef.current = null;
      const sidebar = sidebarRef.current;
      const bounds = sidebar?.getBoundingClientRect();
      if (nativePointer !== undefined) {
        sidebarPeekNativePointerRef.current = nativePointer;
        if (nativePointer && bounds && isWithinSidebarPeek(nativePointer, bounds)) return;
      } else {
        // Browser-only fallback. Desktop closure uses the OS cursor instead
        // of :hover or events that native window regions can suppress.
        if (sidebar?.matches(":hover")) return;
        const pointer = sidebarPeekPointerRef.current;
        if (pointer && bounds && isWithinSidebarPeek(pointer, bounds)) return;
      }
      setSidebarPeekOpen(false);
    }, SIDEBAR_PEEK_HIDE_DELAY);
  }, [sidebarCollapsed, sidebarMenu]);

  const handleSidebarPeekWindowLeave = useCallback(() => {
    sidebarPeekPointerRef.current = null;
    hideSidebarPeek();
  }, [hideSidebarPeek]);

  useEffect(() => {
    if (sidebarMenu) clearSidebarPeekTimer();
  }, [clearSidebarPeekTimer, sidebarMenu]);

  useEffect(
    () => () => {
      clearSidebarPeekTimer();
    },
    [clearSidebarPeekTimer],
  );

  const handleSidebarPeekPointerMove = useCallback(
    (event: Pick<PointerEvent, "clientX" | "clientY" | "target">) => {
      if (!sidebarCollapsed) return;
      sidebarPeekPointerRef.current = { clientX: event.clientX, clientY: event.clientY };
      const sidebarBounds = sidebarRef.current?.getBoundingClientRect();
      const target = event.target instanceof Element ? event.target : null;
      const isAtLeftEdge = event.clientX >= 0 &&
        event.clientX <= SIDEBAR_PEEK_REVEAL_WIDTH && event.clientY >= 8;
      const isOverToggle = Boolean(target?.closest(".sidebar-toggle-button"));
      const isOverSidebar = Boolean(target && sidebarRef.current?.contains(target));
      const isOverMenu = Boolean(target?.closest(".chrome-menu"));
      const isInsideSidebar = Boolean(
        (sidebarPeekOpen || sidebarRef.current?.classList.contains("is-peeking")) &&
          sidebarBounds &&
          isWithinSidebarPeek(event, sidebarBounds),
      );

      if (isAtLeftEdge || isOverToggle || isOverSidebar || isOverMenu || isInsideSidebar) {
        showSidebarPeek();
      } else {
        hideSidebarPeek();
      }
    },
    [
      hideSidebarPeek,
      showSidebarPeek,
      sidebarCollapsed,
      sidebarPeekOpen,
    ],
  );

  const handleSidebarPeekNativePointer = useCallback((position: SidebarPeekPointer | null) => {
    sidebarPeekNativePointerRef.current = position;
    const open = sidebarPeekOpen || sidebarRef.current?.classList.contains("is-peeking");
    if (position) {
      if (open || (position.clientX <= SIDEBAR_PEEK_REVEAL_WIDTH && position.clientY >= 8)) {
        handleSidebarPeekPointerMove({ ...position, target: null });
      }
    } else if (open) {
      hideSidebarPeek();
    }
  }, [handleSidebarPeekPointerMove, hideSidebarPeek, sidebarPeekOpen]);

  useEffect(() => {
    const desktop = window.museboardDesktop;
    if (!sidebarCollapsed || !desktop?.onWindowPointerPosition || !desktop.getWindowPointerPosition) return;
    let canceled = false;
    let receivedUpdate = false;
    const remove = desktop.onWindowPointerPosition((position) => {
      receivedUpdate = true;
      if (!canceled) handleSidebarPeekNativePointer(position);
    });
    void desktop.getWindowPointerPosition().then((position) => {
      if (!canceled && !receivedUpdate) handleSidebarPeekNativePointer(position);
    }).catch(() => {
      // The periodic native updates can establish the position later.
    });
    return () => {
      canceled = true;
      remove();
      sidebarPeekNativePointerRef.current = undefined;
    };
  }, [handleSidebarPeekNativePointer, sidebarCollapsed]);

  useEffect(() => {
    if (!sidebarCollapsed) return;
    window.addEventListener("pointermove", handleSidebarPeekPointerMove, {
      passive: true,
    });
    document.documentElement.addEventListener(
      "pointerleave",
      handleSidebarPeekWindowLeave,
    );
    return () => {
      window.removeEventListener("pointermove", handleSidebarPeekPointerMove);
      document.documentElement.removeEventListener(
        "pointerleave",
        handleSidebarPeekWindowLeave,
      );
    };
  }, [handleSidebarPeekPointerMove, handleSidebarPeekWindowLeave, sidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    clearSidebarPeekTimer();
    sidebarPeekPointerRef.current = null;
    sidebarPeekNativePointerRef.current = undefined;
    setSidebarPeekOpen(false);
    setSidebarCollapsed((collapsed) => !collapsed);
  }, [clearSidebarPeekTimer]);

  const deleteItem = useCallback(
    (itemId: string) => {
      recordUndoSnapshot();
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: board.items.filter((item) => item.id !== itemId),
        frames: (board.frames || [])
          .map((frame) => ({ ...frame, itemIds: frame.itemIds.filter((id) => id !== itemId) }))
          .filter((frame) => frame.itemIds.length > 0),
      }));
      setSelectedIds((current) => current.filter((id) => id !== itemId));
      setItemContextMenu(null);
    },
    [recordUndoSnapshot, updateActiveBoard],
  );

  const deleteSelected = useCallback(() => {
    if (!selectedIds.length) return;
    const deletingIds = new Set(selectedIds);
    recordUndoSnapshot();
    updateActiveBoard((board) => ({
      ...board,
      updated: "just now",
      items: board.items.filter((item) => !deletingIds.has(item.id)),
      frames: (board.frames || [])
        .map((frame) => ({
          ...frame,
          itemIds: frame.itemIds.filter((id) => !deletingIds.has(id)),
        }))
        .filter((frame) => frame.itemIds.length > 0),
    }));
    setSelectedIds([]);
    setItemContextMenu(null);
  }, [recordUndoSnapshot, selectedIds, updateActiveBoard]);

  const duplicateItem = useCallback(
    (itemId: string) => {
      const sourceItem = boardsRef.current.find((board) => board.id === activeIdRef.current)?.items.find((item) => item.id === itemId);
      if (!sourceItem) return;
      const duplicatedId = makeId(sourceItem.type);
      recordUndoSnapshot();
      updateActiveBoard((board) => {
        const source = board.items.find((item) => item.id === itemId);
        if (!source) return board;
        const topZ = Math.max(0, ...board.items.map((item) => item.z)) + 1;
        return {
          ...board,
          updated: "just now",
          items: [
            ...board.items,
            {
              ...source,
              id: duplicatedId,
              x: source.x + 28,
              y: source.y + 28,
              z: topZ,
            },
          ],
        };
      });
      setSelectedIds([duplicatedId]);
      setItemContextMenu(null);
    },
    [recordUndoSnapshot, updateActiveBoard],
  );

  const moveItemLayer = useCallback(
    (itemId: string, direction: "front" | "back") => {
      recordUndoSnapshot();
      updateActiveBoard((board) => {
        const layer =
          direction === "front"
            ? Math.max(0, ...board.items.map((item) => item.z)) + 1
            : Math.min(0, ...board.items.map((item) => item.z)) - 1;
        return {
          ...board,
          updated: "just now",
          items: board.items.map((item) =>
            item.id === itemId ? { ...item, z: layer } : item,
          ),
        };
      });
      setItemContextMenu(null);
    },
    [recordUndoSnapshot, updateActiveBoard],
  );

  const rotateImage = useCallback(
    (itemId: string, direction: -90 | 90) => {
      recordUndoSnapshot();
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: board.items.map((item) => {
          if (item.id !== itemId || item.type !== "image") return item;
          const centerX = item.x + item.w / 2;
          const centerY = item.y + item.h / 2;
          const nextWidth = item.h;
          const nextHeight = item.w;
          return {
            ...item,
            x: centerX - nextWidth / 2,
            y: centerY - nextHeight / 2,
            w: nextWidth,
            h: nextHeight,
            rotation: normalizeRotation((item.rotation ?? 0) + direction),
          };
        }),
      }));
      setItemContextMenu(null);
    },
    [recordUndoSnapshot, updateActiveBoard],
  );

  const updateImageProperties = useCallback(
    (itemId: string, properties: Partial<CanvasItem>) => {
      recordUndoSnapshot();
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: board.items.map((item) =>
          item.id === itemId && item.type === "image"
            ? { ...item, ...properties }
            : item,
        ),
      }));
      setItemContextMenu(null);
    },
    [recordUndoSnapshot, updateActiveBoard],
  );

  const openImageInfo = useCallback(
    (item: CanvasItem) => {
      if (!activeBoard || item.type !== "image") return;
      setImageInfoDraft({
        boardId: activeBoard.id,
        itemId: item.id,
        tagsText: (item.tags ?? []).join(", "),
        creator: item.creator ?? "",
        sourceUrl: item.sourceUrl ?? "",
        referenceNote: item.referenceNote ?? "",
        favorite: Boolean(item.favorite),
      });
      setItemContextMenu(null);
    },
    [activeBoard],
  );

  const saveImageInfo = useCallback(() => {
    const draft = imageInfoDraft;
    if (!draft) return;
    const tags = Array.from(
      new Set(
        draft.tagsText
          .split(/[，,、\n]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ).slice(0, 32);
    recordUndoSnapshot();
    updateBoard(draft.boardId, (board) => ({
      ...board,
      updated: "just now",
      items: board.items.map((item) =>
        item.id === draft.itemId && item.type === "image"
          ? {
              ...item,
              tags,
              creator: draft.creator.trim(),
              sourceUrl: draft.sourceUrl.trim(),
              referenceNote: draft.referenceNote.trim(),
              favorite: draft.favorite,
            }
          : item,
      ),
    }));
    setImageInfoDraft(null);
  }, [imageInfoDraft, recordUndoSnapshot, updateBoard]);

  const arrangeSelectedImages = useCallback(
    (mode: "grid" | "row" | "column") => {
      if (!activeBoard || selectedImageItems.length < 2) return;
      const ordered = [...selectedImageItems].sort((first, second) => first.z - second.z);
      const gap = activeBoard.snapEnabled ? activeBoard.gridSize || 40 : 28;
      const minX = Math.min(...ordered.map((item) => item.x));
      const minY = Math.min(...ordered.map((item) => item.y));
      const maxWidth = Math.max(...ordered.map((item) => item.w));
      const maxHeight = Math.max(...ordered.map((item) => item.h));
      const columns = mode === "grid" ? Math.ceil(Math.sqrt(ordered.length)) : mode === "row" ? ordered.length : 1;
      const positions = new Map<string, { x: number; y: number }>();
      let rowX = minX;
      let columnY = minY;
      ordered.forEach((item, index) => {
        let x = minX;
        let y = minY;
        if (mode === "grid") {
          x += (index % columns) * (maxWidth + gap);
          y += Math.floor(index / columns) * (maxHeight + gap);
        } else if (mode === "row") {
          x = rowX;
          rowX += item.w + gap;
        } else {
          y = columnY;
          columnY += item.h + gap;
        }
        if (activeBoard.snapEnabled) {
          const gridSize = activeBoard.gridSize || 40;
          x = Math.round(x / gridSize) * gridSize;
          y = Math.round(y / gridSize) * gridSize;
        }
        positions.set(item.id, { x, y });
      });
      recordUndoSnapshot();
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: board.items.map((item) => {
          const position = positions.get(item.id);
          return position ? { ...item, ...position } : item;
        }),
      }));
      setShowArrangeMenu(false);
    },
    [activeBoard, recordUndoSnapshot, selectedImageItems, updateActiveBoard],
  );

  const focusLibraryImage = useCallback(
    (boardId: string, itemId: string) => {
      const targetBoard = boardsRef.current.find((board) => board.id === boardId);
      const target = targetBoard?.items.find((item) => item.id === itemId);
      if (!targetBoard || !target) return;
      setActiveId(boardId);
      setWorkspaceFilter(null);
      setCollapsedGroups((current) => { const next = new Set(current); next.delete(targetBoard.groupName || ""); return next; });
      setSelectedIds([itemId]);
      setItemContextMenu(null);
      setShowLibrary(false);
      setShowSettings(false);
      window.requestAnimationFrame(() => {
        const canvasRect = canvasRef.current?.getBoundingClientRect();
        if (!canvasRect) return;
        updateBoard(boardId, (board) => {
          const item = board.items.find((entry) => entry.id === itemId);
          if (!item) return board;
          return {
            ...board,
            viewport: {
              ...board.viewport,
              x: canvasRect.width / 2 - (item.x + item.w / 2) * board.viewport.scale,
              y: canvasRect.height / 2 - (item.y + item.h / 2) * board.viewport.scale,
            },
          };
        });
      });
    },
    [updateBoard],
  );

  const openImageAnalysis = useCallback(
    (item: CanvasItem) => {
      if (item.type !== "image" || !item.src) return;
      const quarterTurn = normalizeRotation(item.rotation) % 180 !== 0;
      void window.museboardDesktop?.openImageAnalysis?.({
        itemId: item.id,
        src: item.src,
        caption: item.caption,
        width: quarterTurn ? item.h : item.w,
        height: quarterTurn ? item.w : item.h,
        analysis: item.analysis,
      });
      setItemContextMenu(null);
    },
    [],
  );

  const createFrameFromSelection = useCallback(() => {
    if (!activeBoard || selectedIds.length < 2) return;
    const selected = activeBoard.items.filter((item) => selectedIdSet.has(item.id));
    if (selected.length < 2) return;
    recordUndoSnapshot();
    const padding = 28;
    const minX = Math.min(...selected.map((item) => item.x));
    const minY = Math.min(...selected.map((item) => item.y));
    const maxX = Math.max(...selected.map((item) => item.x + item.w));
    const maxY = Math.max(...selected.map((item) => item.y + item.h));
    const frame: CanvasFrame = {
      id: makeId("frame"),
      name: text("Group", "グループ", "分组", "그룹"),
      x: minX - padding,
      y: minY - padding - 24,
      w: maxX - minX + padding * 2,
      h: maxY - minY + padding * 2 + 24,
      itemIds: selected.map((item) => item.id),
    };
    updateActiveBoard((board) => ({
      ...board,
      updated: "just now",
      frames: [...(board.frames || []), frame],
    }));
  }, [activeBoard, recordUndoSnapshot, selectedIdSet, selectedIds.length, text, updateActiveBoard]);

  const removeFrame = useCallback((frameId: string) => {
    recordUndoSnapshot();
    updateActiveBoard((board) => ({
      ...board,
      frames: (board.frames || []).filter((frame) => frame.id !== frameId),
    }));
  }, [recordUndoSnapshot, updateActiveBoard]);

  const startFrameAction = (
    event: ReactPointerEvent,
    frame: CanvasFrame,
  ) => {
    if (event.button !== 0 || !activeBoard) return;
    event.preventDefault();
    event.stopPropagation();
    recordUndoSnapshot();
    const memberIds = new Set(frame.itemIds);
    actionRef.current = {
      mode: "frame-drag",
      boardId: activeBoard.id,
      frameId: frame.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerId: event.pointerId,
      scale: activeBoard.viewport.scale,
      frameOrigin: { x: frame.x, y: frame.y },
      itemOrigins: activeBoard.items
        .filter((item) => memberIds.has(item.id))
        .map((item) => ({ id: item.id, x: item.x, y: item.y })),
      snapEnabled: Boolean(activeBoard.snapEnabled),
      gridSize: activeBoard.gridSize || 40,
    };
    setSelectedIds(frame.itemIds.filter((id) => activeBoard.items.some((item) => item.id === id)));
    document.body.classList.add("is-manipulating");
  };

  const pickBoardVisual = useCallback(async () => {
    const generation = projectGenerationRef.current;
    const request = ++backgroundRequestRef.current;
    const desktop = window.museboardDesktop;
    if (!desktop?.chooseImageFiles) return;
    const result = await desktop.chooseImageFiles();
    if (generation !== projectGenerationRef.current || request !== backgroundRequestRef.current) return;
    const chosen = result.images[0];
    if (!chosen) return;
    const applyImage = (image: PreparedImage, expectedSource?: string) => {
      setSettings((current) => {
        if (generation !== projectGenerationRef.current || request !== backgroundRequestRef.current ||
          (expectedSource && current.canvas?.backgroundImageSrc !== expectedSource)) return current;
        return { ...current, canvas: normalizeCanvasSettings({
          ...(current.canvas ?? DEFAULT_CANVAS_SETTINGS),
          backgroundImageSrc: image.src,
          backgroundImageThumbnailSrc: image.thumbnailSrc,
          backgroundImageAssetId: image.assetId,
        }) };
      });
    };
    applyImage(chosen);
    if (chosen.processing && desktop.optimizeStagedImages) {
      const optimized = await desktop.optimizeStagedImages([
        { id: "board-background", source: chosen.src, name: chosen.name, assetId: chosen.assetId },
      ]);
      const image = optimized.results[0]?.image;
      if (image) applyImage(image, chosen.src);
    }
  }, []);

  const cancelHeaderImageEditor = useCallback(() => {
    headerImageRequestRef.current += 1;
    headerImageDragRef.current = null;
    setHeaderImageError(null);
    setHeaderImageDraft(null);
  }, []);

  const chooseHeaderImage = useCallback(async (boardId: string, managerSession?: number) => {
    const generation = projectGenerationRef.current;
    const request = ++headerImageRequestRef.current;
    const isCurrent = () => generation === projectGenerationRef.current && request === headerImageRequestRef.current &&
      (managerSession === undefined || managerSession === listManagerSessionRef.current);
    const desktop = window.museboardDesktop;
    if (!desktop?.chooseImageFiles) return;
    setHeaderImageError(null);
    try {
      const result = await desktop.chooseImageFiles();
      if (!isCurrent()) return;
      const chosen = result.images[0];
      if (!chosen) {
        if (result.errors?.length) setHeaderImageError(text("Could not read the header image.", "ヘッダー画像を読み込めませんでした。", "无法读取标题图片。", "헤더 이미지를 읽을 수 없습니다."));
        return;
      }
      setHeaderImageDraft(constrainHeaderImageDraft({
        boardId,
        managerSession,
        src: chosen.src,
        thumbnailSrc: chosen.thumbnailSrc,
        assetId: chosen.assetId,
        imageWidth: chosen.width,
        imageHeight: chosen.height,
        positionX: HEADER_IMAGE_DEFAULT_POSITION,
        positionY: HEADER_IMAGE_DEFAULT_POSITION,
        scale: HEADER_IMAGE_MIN_SCALE,
      }));
      if (chosen.processing && desktop.optimizeStagedImages) {
        const optimized = await desktop.optimizeStagedImages([
          { id: `board-header-${boardId}`, source: chosen.src, name: chosen.name, assetId: chosen.assetId },
        ]);
        const image = optimized.results[0]?.image;
        if (image && isCurrent()) {
          setHeaderImageDraft((current) => {
            if (!current || current.boardId !== boardId || current.src !== chosen.src || current.managerSession !== managerSession) return current;
            return constrainHeaderImageDraft({
              ...current,
              src: image.src,
              thumbnailSrc: image.thumbnailSrc,
              assetId: image.assetId,
              imageWidth: image.width,
              imageHeight: image.height,
            });
          });
        }
      }
    } catch {
      if (isCurrent()) setHeaderImageError(text("Could not load the header image. Please choose it again.", "ヘッダー画像を読み込めませんでした。もう一度選択してください。", "无法加载标题图片，请重新选择。", "헤더 이미지를 불러올 수 없습니다. 다시 선택해 주세요."));
    }
  }, [text]);

  const openHeaderImageEditor = useCallback((board: Board, managerSession?: number) => {
    headerImageRequestRef.current += 1;
    setHeaderImageError(null);
    if (managerSession === undefined) {
      setActiveId(board.id);
      setSelectedIds([]);
      setSelectionMarquee(null);
    }
    if (!board.headerImageSrc) {
      void chooseHeaderImage(board.id, managerSession);
      return;
    }
    const draft = {
      boardId: board.id,
      managerSession,
      src: board.headerImageSrc,
      thumbnailSrc: board.headerImageThumbnailSrc,
      assetId: board.headerImageAssetId,
      imageWidth: board.headerImageWidth ?? 0,
      imageHeight: board.headerImageHeight ?? 0,
      positionX: clamp(
        board.headerImagePositionX ?? HEADER_IMAGE_DEFAULT_POSITION,
        0,
        100,
      ),
      positionY: clamp(
        board.headerImagePositionY ?? HEADER_IMAGE_DEFAULT_POSITION,
        0,
        100,
      ),
      scale: clamp(
        board.headerImageScale ?? HEADER_IMAGE_MIN_SCALE,
        HEADER_IMAGE_MIN_SCALE,
        HEADER_IMAGE_MAX_SCALE,
      ),
    };
    setHeaderImageDraft(
      draft.imageWidth > 0 && draft.imageHeight > 0
        ? constrainHeaderImageDraft(draft)
        : draft,
    );
  }, [chooseHeaderImage]);

  const startHeaderImageDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !headerImageDraft) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer cancellation clears the temporary drag state.
    }
    headerImageDragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPositionX: headerImageDraft.positionX,
      startPositionY: headerImageDraft.positionY,
      captureTarget: event.currentTarget,
    };
  };

  const updateHeaderImageDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = headerImageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const cropWindow = event.currentTarget.querySelector<HTMLElement>(
      ".header-image-editor-crop-window",
    );
    const width = Math.max(cropWindow?.clientWidth ?? event.currentTarget.clientWidth, 1);
    const height = Math.max(cropWindow?.clientHeight ?? event.currentTarget.clientHeight, 1);
    setHeaderImageDraft((current) => {
      if (!current) return current;
      const startingLayout = getHeaderImageLayout(
        current.imageWidth,
        current.imageHeight,
        current.scale,
        drag.startPositionX,
        drag.startPositionY,
      );
      const renderedWidth = width * startingLayout.widthPercent / 100;
      const renderedHeight = height * startingLayout.heightPercent / 100;
      const nextLayout = getHeaderImageLayout(
        current.imageWidth,
        current.imageHeight,
        current.scale,
        drag.startPositionX - ((event.clientX - drag.startClientX) / renderedWidth) * 100,
        drag.startPositionY - ((event.clientY - drag.startClientY) / renderedHeight) * 100,
      );
      return {
        ...current,
        positionX: nextLayout.positionX,
        positionY: nextLayout.positionY,
      };
    });
  };

  const finishHeaderImageDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = headerImageDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try {
      drag.captureTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Capture may already be released by the browser.
    }
    headerImageDragRef.current = null;
  };

  const applyHeaderImage = useCallback(() => {
    if (!headerImageDraft) return;
    if (headerImageDraft.managerSession !== undefined && headerImageDraft.managerSession !== listManagerSessionRef.current) return;
    const appliedDraft = constrainHeaderImageDraft(headerImageDraft);
    const apply = (board: Board): Board => ({
      ...board,
      headerImageSrc: appliedDraft.src,
      headerImageThumbnailSrc: appliedDraft.thumbnailSrc,
      headerImageAssetId: appliedDraft.assetId,
      headerImageWidth: appliedDraft.imageWidth,
      headerImageHeight: appliedDraft.imageHeight,
      headerImagePositionX: appliedDraft.positionX,
      headerImagePositionY: appliedDraft.positionY,
      headerImageScale: appliedDraft.scale,
      updated: "just now",
    });
    if (appliedDraft.managerSession !== undefined) {
      setListManagerDraft((current) => current.map((board) => board.id === appliedDraft.boardId ? apply(board) : board));
    } else {
      recordUndoSnapshot();
      updateBoard(appliedDraft.boardId, apply);
    }
    cancelHeaderImageEditor();
  }, [headerImageDraft, recordUndoSnapshot, updateBoard, cancelHeaderImageEditor]);

  const restoreHeaderImageList = useCallback(() => {
    if (!headerImageDraft) return;
    if (headerImageDraft.managerSession !== undefined) {
      if (headerImageDraft.managerSession !== listManagerSessionRef.current) return;
      setListManagerDraft((current) => current.map((board) => board.id === headerImageDraft.boardId ? clearListHeader(board) : board));
      cancelHeaderImageEditor();
      return;
    }
    recordUndoSnapshot();
    updateBoard(headerImageDraft.boardId, (board) => ({
      ...board,
      headerImageSrc: undefined,
      headerImageThumbnailSrc: undefined,
      headerImageAssetId: undefined,
      headerImageWidth: undefined,
      headerImageHeight: undefined,
      headerImagePositionX: undefined,
      headerImagePositionY: undefined,
      headerImageScale: undefined,
      updated: "just now",
    }));
    cancelHeaderImageEditor();
  }, [headerImageDraft, recordUndoSnapshot, updateBoard, cancelHeaderImageEditor]);

  const openProjectFromSettings = useCallback(async () => {
    const result = await window.museboardDesktop?.openProject();
    if (!result || result.canceled || !result.data) return;
    window.dispatchEvent(new CustomEvent("museboard:load-project", { detail: result.data }));
    setShowSettings(false);
  }, []);

  const resetSettings = useCallback(() => {
    backgroundRequestRef.current += 1;
    const defaults = defaultSettings();
    setSettings(defaults);
    setSidebarCollapsed(defaults.startupSidebar === "closed");
  }, []);

  const copyPaletteColor = useCallback(async (color: string) => {
    try {
      await navigator.clipboard.writeText(color);
    } catch {
      const field = document.createElement("textarea");
      field.value = color;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    setCopiedColor(color);
    setImportNotice(text(`${color} copied`, `${color} をコピーしました`, `已复制 ${color}`, `${color} 복사됨`));
    window.setTimeout(
      () => setCopiedColor((current) => (current === color ? null : current)),
      1600,
    );
  }, [text]);

  const openItemContextMenu = (
    event: ReactMouseEvent,
    item: CanvasItem,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const menuHeight = item.type === "image" ? 350 : 245;
    const menuTop = (canvasRef.current?.getBoundingClientRect().top ?? 0) + 8;
    syncImagePaletteVisibility(item, activeBoard.viewport.scale);
    setSelectedIds([item.id]);
    setItemContextMenu({
      itemId: item.id,
      x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 196)),
      y: clamp(
        event.clientY,
        menuTop,
        Math.max(menuTop, window.innerHeight - menuHeight - 8),
      ),
    });
  };

  const addSticky = useCallback(
    (worldX?: number, worldY?: number) => {
      if (!activeBoard) return;
      recordUndoSnapshot();
      const rect = canvasRef.current?.getBoundingClientRect();
      const viewport = activeBoard.viewport;
      const sidebarOffset = getCanvasSidebarOffset();
      const x =
        worldX ??
        ((rect?.width ?? 900) / 2 - viewport.x - sidebarOffset) /
          viewport.scale -
          125;
      const y =
        worldY ??
        ((rect?.height ?? 650) / 2 - viewport.y) / viewport.scale - 85;
      const id = makeId("note");
      const topZ = Math.max(0, ...activeBoard.items.map((item) => item.z)) + 1;
      updateActiveBoard((board) => ({
        ...board,
        updated: "just now",
        items: [
          ...board.items,
          {
            id,
            type: "note",
            x,
            y,
            w: 250,
            h: 172,
            z: topZ,
            color: settings.noteColor,
            fontFamily: settings.noteFont,
            fontSize: settings.noteFontSize,
            text: text("New note", "新しい付箋", "新便笺", "새 메모"),
          },
        ],
      }));
      setSelectedIds([id]);
    },
    [
      activeBoard,
      getCanvasSidebarOffset,
      recordUndoSnapshot,
      settings.noteColor,
      settings.noteFont,
      settings.noteFontSize,
      text,
      updateActiveBoard,
    ],
  );

  const makeEmptyBoard = useCallback((index = boardsRef.current.length): Board => ({
      id: makeId("board"),
      groupName: activeWorkspace || undefined,
      name: `${text("Untitled board", "新しい保存リスト", "未命名列表", "이름 없는 목록")} ${index + 1}`,
      accent: noteColors[index % noteColors.length],
      updated: "just now",
      viewport: { x: 80, y: 70, scale: 1 },
      items: [],
      frames: [],
      ...canvasSettings,
    }), [activeWorkspace, canvasSettings, text]);

  const addPreparedImages = useCallback(
    (
      prepared: PreparedImage[],
      worldX?: number,
      worldY?: number,
      targetBoardId = activeId,
      sourceUrl?: string,
      newBoard?: Board,
    ) => {
      const existingBoard = boardsRef.current.find(
        (board) => board.id === targetBoardId,
      );
      if (newBoard && (existingBoard || newBoard.id !== targetBoardId)) return [];
      const targetBoard = existingBoard || newBoard;
      if (!prepared.length || !targetBoard) return [];
      recordUndoSnapshot();
      const sidebarOffset = getCanvasSidebarOffset();
      const baseX =
        worldX ??
        ((canvasRef.current?.clientWidth || 900) / 2 -
          targetBoard.viewport.x -
          sidebarOffset) /
          targetBoard.viewport.scale;
      const baseY =
        worldY ??
        ((canvasRef.current?.clientHeight || 650) / 2 - targetBoard.viewport.y) /
          targetBoard.viewport.scale;
      const useAutomaticPlacement = worldX === undefined || worldY === undefined;
      const itemIds = prepared.map(() => makeId("image"));

      const applyImages = (board: Board): Board => {
        let topZ = Math.max(0, ...board.items.map((item) => item.z));
        const occupiedItems = [...board.items];
        const newItems: CanvasItem[] = prepared.map((image, index) => {
          const ratio = image.width / image.height;
          const w = ratio >= 1 ? 430 : 310;
          const h = w / ratio;
          const position = useAutomaticPlacement
            ? findOpenImagePosition(occupiedItems, w, h, baseX, baseY)
            : {
                x: baseX - w / 2 + index * 28,
                y: baseY - h / 2 + index * 28,
              };
          topZ += 1;
          const newItem: CanvasItem = {
            id: itemIds[index],
            type: "image",
            x: position.x,
            y: position.y,
            w,
            h,
            z: topZ,
            src: image.src,
            thumbnailSrc: image.thumbnailSrc,
            palette: image.palette,
            assetId: image.assetId,
            processing: image.processing,
            sourceUrl,
            originalImageUrl: image.originalImageUrl,
            caption:
              image.name.replace(/\.[a-z0-9_-]{1,12}$/i, "") || "Reference",
          };
          occupiedItems.push(newItem);
          return newItem;
        });
        return {
          ...board,
          updated: "just now",
          items: [...board.items, ...newItems],
        };
      };
      if (newBoard) setBoards((current) => current.some((board) => board.id === targetBoardId) ? current : [...current, applyImages(newBoard)]);
      else updateBoard(targetBoardId, applyImages);
      if (targetBoardId === activeIdRef.current) {
        setSelectedIds([itemIds[itemIds.length - 1]]);
      }
      return itemIds;
    },
    [activeId, getCanvasSidebarOffset, recordUndoSnapshot, updateBoard],
  );

  const reportImportResult = useCallback(
    (
      importedCount: number,
      errors: Array<{ name: string; message: string }> = [],
    ) => {
      if (importedCount && !errors.length) {
        setImportNotice(text(
          `${importedCount} image${importedCount === 1 ? "" : "s"} imported`,
          `${importedCount}枚の画像を追加しました`,
          `已导入 ${importedCount} 张图片`,
          `이미지 ${importedCount}개를 가져왔습니다`,
        ));
        return;
      }
      if (importedCount) {
        setImportNotice(text(
          `${importedCount} imported · ${errors.length} skipped`,
          `${importedCount}枚を追加・${errors.length}件をスキップ`,
          `已导入 ${importedCount} 张 · 跳过 ${errors.length} 项`,
          `${importedCount}개 가져옴 · ${errors.length}개 건너뜀`,
        ));
        return;
      }
      const first = errors[0];
      setImportNotice(
        first
          ? text(
              `Could not import ${first.name}: ${first.message}`,
              `${first.name}を追加できませんでした: ${first.message}`,
              `无法导入 ${first.name}: ${first.message}`,
              `${first.name}을(를) 가져올 수 없습니다: ${first.message}`,
            )
          : text(
              "No readable image was found",
              "読み込める画像が見つかりませんでした",
              "未找到可读取的图片",
              "읽을 수 있는 이미지를 찾지 못했습니다",
            ),
      );
    },
    [text],
  );

  const reportBoardImportResult = useCallback(
    (
      targetBoardId: string,
      importedCount: number,
      errors: Array<{ name: string; message: string }> = [],
    ) => {
      if (importedCount && targetBoardId !== activeIdRef.current) {
        const targetName =
          boardsRef.current.find((board) => board.id === targetBoardId)?.name ||
          text("saved list", "保存リスト", "保存列表", "저장 목록");
        setImportNotice(text(
          `${importedCount} image${importedCount === 1 ? "" : "s"} saved to ${targetName}${errors.length ? ` · ${errors.length} skipped` : ""}`,
          `${targetName}に${importedCount}枚の画像を保存しました${errors.length ? `・${errors.length}件をスキップ` : ""}`,
          `已将 ${importedCount} 张图片保存到 ${targetName}${errors.length ? ` · 跳过 ${errors.length} 项` : ""}`,
          `${targetName}에 이미지 ${importedCount}개를 저장했습니다${errors.length ? ` · ${errors.length}개 건너뜀` : ""}`,
        ));
        return;
      }
      reportImportResult(importedCount, errors);
    },
    [reportImportResult, text],
  );

  const applyProcessedImages = useCallback(
    (
      boardId: string,
      results: Array<{
        id: string;
        source?: string;
        image: PreparedImage | null;
        error: string | null;
      }>,
    ) => {
      const resultMap = new Map(results.map((result) => [result.id, result]));
      const sourceResults = new Map(results.filter((result) => result.source).map((result) => [result.source, result]));
      const patchResources = (board: Board): Board => ({
        ...board,
        items: board.items.map((item) => {
          const directResult = resultMap.get(item.id);
          if (directResult?.source && item.src !== directResult.source) return item;
          const result = directResult ?? (item.processing && item.src ? sourceResults.get(item.src) : undefined);
          if (!result) return item;
          if (!result.image) return { ...item, processing: false };
          return {
            ...item,
            src: result.image.src,
            thumbnailSrc: result.image.thumbnailSrc,
            palette: result.image.palette,
            assetId: result.image.assetId,
            processing: false,
          };
        }),
      });
      // Conversion can finish after Undo removed the item. Hydrate every
      // historical copy and pending duplicate before its blob URL is released, while
      // keeping the user's coordinates, notes, and other edits untouched.
      const patchSnapshot = (snapshot: UndoSnapshot): UndoSnapshot => ({
        ...snapshot,
        boards: snapshot.boards.map((board) => board.id === boardId ? patchResources(board) : board),
      });
      undoStackRef.current = undoStackRef.current.map(patchSnapshot);
      redoStackRef.current = redoStackRef.current.map(patchSnapshot);
      updateBoard(boardId, (board) => ({ ...patchResources(board), updated: "just now" }));
    },
    [updateBoard],
  );

  const optimizeStagedImages = useCallback(
    async (
      boardId: string,
      itemIds: string[],
      images: PreparedImage[],
    ) => {
      const generation = projectGenerationRef.current;
      const desktop = window.museboardDesktop;
      if (!desktop?.optimizeStagedImages || !itemIds.length) return;
      try {
        const result = await desktop.optimizeStagedImages(
          images.map((image, index) => ({
            id: itemIds[index],
            source: image.src,
            name: image.name,
            assetId: image.assetId,
          })),
        );
        if (generation !== projectGenerationRef.current) return;
        applyProcessedImages(boardId, result.results.map((entry) => ({
          ...entry,
          source: images[itemIds.indexOf(entry.id)]?.src,
        })));
      } catch {
        if (generation !== projectGenerationRef.current) return;
        applyProcessedImages(
          boardId,
          itemIds.map((id) => ({
            id,
            source: images[itemIds.indexOf(id)]?.src,
            image: null,
            error: "Background optimization failed",
          })),
        );
      }
    },
    [applyProcessedImages],
  );

  const addImageFiles = useCallback(
    async (
      files: File[],
      worldX?: number,
      worldY?: number,
      targetBoardId = activeId,
    ) => {
      if (!files.length || !boardsRef.current.length) return;
      const generation = projectGenerationRef.current;

      try {
        const desktop = window.museboardDesktop;
        if (desktop?.getPathForFile && desktop.stageImageFiles) {
          const filePaths = files.map((file) => {
            try {
              return desktop.getPathForFile(file);
            } catch {
              return "";
            }
          });
          if (filePaths.every(Boolean)) {
            const result = await desktop.stageImageFiles(filePaths);
            if (generation !== projectGenerationRef.current) return;
            const itemIds = addPreparedImages(
              result.images,
              worldX,
              worldY,
              targetBoardId,
            );
            reportBoardImportResult(
              targetBoardId,
              itemIds.length,
              result.errors,
            );
            if (itemIds.length) {
              void optimizeStagedImages(
                targetBoardId,
                itemIds,
                result.images,
              );
            }
            return;
          }
        }
        if (desktop?.convertImageFiles) {
          // Commit only durable assets. A failed conversion must never leave a
          // session-only blob URL in a board or its Undo history.
          const images: PreparedImage[] = [];
          const errors: Array<{ name: string; message: string }> = [];
          for (const file of files) {
            try {
              const result = await desktop.convertImageFiles([{
                name: file.name || "reference-image",
                bytes: await file.arrayBuffer(),
              }]);
              images.push(...result.images);
              errors.push(...result.errors);
            } catch (error) {
              errors.push({ name: file.name, message: error instanceof Error ? error.message : "Image storage failed" });
            }
            if (generation !== projectGenerationRef.current) return;
          }
          const itemIds = addPreparedImages(images, worldX, worldY, targetBoardId);
          reportBoardImportResult(targetBoardId, itemIds.length, errors);
          return;
        }

        const settled = await Promise.allSettled(files.map(prepareImagePreview));
        const prepared = settled.flatMap((entry) =>
          entry.status === "fulfilled" ? [entry.value] : [],
        );
        if (generation !== projectGenerationRef.current) {
          prepared.forEach((image) => URL.revokeObjectURL(image.src));
          return;
        }
        const errors = settled.flatMap((entry, index) =>
          entry.status === "rejected"
            ? [{ name: files[index].name, message: "Unsupported image data" }]
            : [],
        );
        const itemIds = addPreparedImages(prepared, worldX, worldY, targetBoardId);
        reportBoardImportResult(targetBoardId, itemIds.length, errors);
      } catch (error) {
        if (generation !== projectGenerationRef.current) return;
        reportImportResult(0, [
          {
            name: files[0]?.name || "image",
            message: error instanceof Error ? error.message : "Import failed",
          },
        ]);
      }
    },
    [
      activeId,
      addPreparedImages,
      optimizeStagedImages,
      reportBoardImportResult,
      reportImportResult,
    ],
  );

  const addImageUrl = useCallback(
    async (
      url: string,
      worldX?: number,
      worldY?: number,
      targetBoardId = activeId,
    ) => {
      const value = url.trim();
      if (!value) return;
      const generation = projectGenerationRef.current;
      const desktop = window.museboardDesktop;
      if (!desktop?.importImageUrl) {
        reportImportResult(0, [
          {
            name: "URL",
            message: text(
              "URL import is available in the desktop app",
              "URLの読み込みはデスクトップ版で利用できます",
              "桌面版支持从 URL 导入",
              "URL 가져오기는 데스크톱 앱에서 사용할 수 있습니다",
            ),
          },
        ]);
        return;
      }
      setImportNotice(text("Loading image…", "画像を読み込み中…", "正在加载图片…", "이미지 불러오는 중…"));
      try {
        const result = await desktop.importImageUrl(value);
        if (generation !== projectGenerationRef.current) return;
        const itemIds = addPreparedImages(result.images, worldX, worldY, targetBoardId, value);
        reportBoardImportResult(targetBoardId, itemIds.length, result.errors);
      } catch (error) {
        if (generation !== projectGenerationRef.current) return;
        reportImportResult(0, [{ name: "URL", message: error instanceof Error ? error.message : "Image download failed" }]);
      }
    },
    [
      activeId,
      addPreparedImages,
      reportBoardImportResult,
      reportImportResult,
      text,
    ],
  );

  useEffect(() => {
    window.museboardDesktop?.publishExtensionState?.({ ready: hydrated, generation: projectGenerationRef.current, activeId, boards: boards.map(({ id, name, groupName, items }) => ({ id, name, groupName, imageSources: items.filter(item => item.type === "image").map(item => ({ id: item.id, imageUrl: item.originalImageUrl || item.src, sourceUrl: item.sourceUrl })) })) });
    for (const [requestId, pending] of extensionImportsRef.current) {
      if (pending.removing && !pending.processed) continue;
      const target = boards.find((board) => board.id === pending.boardId);
      const current = pending.generation === projectGenerationRef.current && target;
      const complete = current && !pending.failed && pending.itemIds.every((id) => pending.removing ? !target.items.some((item) => item.id === id) : target.items.some((item) => item.id === id));
      if (!current || pending.failed || complete) {
        extensionImportsRef.current.delete(requestId);
        if (complete && pending.undoSnapshot) {
          recordUndoSnapshot(pending.undoSnapshot);
          if (activeId === pending.boardId) setSelectedIds(current => current.filter(id => !pending.itemIds.includes(id)));
        }
        window.museboardDesktop?.completeExtensionImport?.({
          requestId, count: complete ? pending.count ?? pending.itemIds.length : pending.removing ? -1 : 0,
          ...(complete ? { snapshot: {
            format: "museboard" as const, version: 2, savedAt: new Date().toISOString(), activeId,
            boards: applyNoteSettings(applyCanvasSettings(boards, settingsRef.current.canvas ?? DEFAULT_CANVAS_SETTINGS), settingsRef.current),
          } } : {}),
        });
      }
    }
  }, [hydrated, boards, activeId, recordUndoSnapshot]);

  useEffect(() => {
    return window.museboardDesktop?.onExtensionImport?.((request) => {
      const creating = request.newBoardName !== undefined;
      const existing = boardsRef.current.some((board) => board.id === request.boardId);
      const invalidName = creating && (typeof request.newBoardName !== "string" || !request.newBoardName.trim() || request.newBoardName.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(request.newBoardName));
      if (!hydrated || request.generation !== projectGenerationRef.current || (creating ? existing || boardsRef.current.length >= 10000 || invalidName : !existing)) {
        window.museboardDesktop?.completeExtensionImport?.({ requestId: request.requestId, count: 0 });
        return;
      }
      const newBoard = creating ? { ...makeEmptyBoard(), id: request.boardId, name: request.newBoardName!.trim() } : undefined;
      const itemIds = addPreparedImages([request.image], undefined, undefined, request.boardId, request.sourceUrl || undefined, newBoard);
      if (!itemIds.length) window.museboardDesktop?.completeExtensionImport?.({ requestId: request.requestId, count: 0 });
      else extensionImportsRef.current.set(request.requestId, { generation: request.generation, boardId: request.boardId, itemIds });
      reportBoardImportResult(request.boardId, itemIds.length);
    });
  }, [hydrated, addPreparedImages, makeEmptyBoard, reportBoardImportResult]);

  useEffect(() => {
    return window.museboardDesktop?.onExtensionRemove?.((request) => {
      const target = boardsRef.current.find(board => board.id === request.boardId);
      const valid = hydrated && request.generation === projectGenerationRef.current && target && Array.isArray(request.targets) && request.targets.every(expected => {
        const item = target.items.find(entry => entry.id === expected.id);
        return typeof expected.id === "string" && Boolean(expected.id) && (!item || (item.type === "image" && (item.originalImageUrl || item.src || "") === expected.imageUrl && (item.sourceUrl || "") === expected.sourceUrl));
      });
      if (!valid || !target) {
        window.museboardDesktop?.completeExtensionImport?.({ requestId: request.requestId, count: -1 });
        return;
      }
      const ids = new Set(request.targets.map(item => item.id));
      const pending = { generation: request.generation, boardId: request.boardId, itemIds: [...ids], removing: true, count: 0, processed: false, failed: false, undoSnapshot: undefined as UndoSnapshot | undefined };
      extensionImportsRef.current.set(request.requestId, pending);
      setBoards(current => {
        // React may already have queued edits that boardsRef has not seen yet.
        // Revalidate the actual state, and record Undo only after it commits.
        const board = current.find(entry => entry.id === request.boardId);
        pending.processed = true;
        pending.undoSnapshot = undefined;
        pending.failed = request.generation !== projectGenerationRef.current || !board || !request.targets.every(expected => {
          const item = board.items.find(entry => entry.id === expected.id);
          return !item || (item.type === "image" && (item.originalImageUrl || item.src || "") === expected.imageUrl && (item.sourceUrl || "") === expected.sourceUrl);
        });
        if (pending.failed || !board) return [...current];
        pending.count = board.items.filter(item => ids.has(item.id)).length;
        if (!pending.count) return [...current];
        pending.undoSnapshot = { boards: current, activeId: activeIdRef.current };
        return current.map(entry => entry.id !== request.boardId ? entry : {
          ...entry, updated: "just now", items: entry.items.filter(item => !ids.has(item.id)),
          frames: (entry.frames || []).map(frame => ({ ...frame, itemIds: frame.itemIds.filter(id => !ids.has(id)) })).filter(frame => frame.itemIds.length > 0),
        });
      });
    });
  }, [hydrated]);

  const chooseImageFiles = useCallback(async () => {
    const generation = projectGenerationRef.current;
    const desktop = window.museboardDesktop;
    if (!desktop?.chooseImageFiles) {
      fileInputRef.current?.click();
      return;
    }
    const result = await desktop.chooseImageFiles();
    if (generation !== projectGenerationRef.current) return;
    if (result.canceled) return;
    const targetBoardId = activeId;
    const itemIds = addPreparedImages(
      result.images,
      undefined,
      undefined,
      targetBoardId,
    );
    reportImportResult(result.images.length, result.errors);
    if (itemIds.length) {
      void optimizeStagedImages(targetBoardId, itemIds, result.images);
    }
  }, [
    activeId,
    addPreparedImages,
    optimizeStagedImages,
    reportImportResult,
  ]);

  const choosePinterestBoardFile = useCallback(async () => {
    if (boardFileChoosingRef.current || !window.museboardDesktop?.openPinterestBoardFile) return;
    boardFileChoosingRef.current = true;
    const generation = projectGenerationRef.current;
    try {
      const result = await window.museboardDesktop.openPinterestBoardFile();
      if (generation !== projectGenerationRef.current || result.canceled) return;
      if (result.error || !result.boardFile) throw new Error(result.error || "ボードファイルを読み込めませんでした。");
      boardFileGenerationRef.current = generation; setBoardFileImport(result.boardFile);
    } catch (error) { setImportNotice(error instanceof Error ? error.message : "ボードファイルを読み込めませんでした。"); }
    finally { boardFileChoosingRef.current = false; }
  }, []);

  const commitPinterestBoardFile = useCallback((name: string, images: PinterestBoardImage[]) => {
    if (boardFileGenerationRef.current !== projectGenerationRef.current) throw new Error("プロジェクトが切り替わりました。ボードファイルを開き直してください。");
    if (!name.trim() || !images.length || boardsRef.current.length >= 10000) throw new Error("リスト名と取得結果を確認してください。");
    const next = { ...makeEmptyBoard(), name: name.trim(), items: pinterestBoardItems(images, () => makeId("image")) };
    recordUndoSnapshot();
    setBoards(current => [...current, next]); setActiveId(next.id); setShowSettings(false); setSelectedIds([]);
    setSelectionMarquee(null); setItemContextMenu(null); setSearch(""); setBoardFileImport(null);
    setImportNotice(`${images.length}枚の画像を「${next.name}」に取り込みました。`);
  }, [makeEmptyBoard, recordUndoSnapshot]);

  const promptForImageUrl = useCallback(() => {
    const value = window.prompt(text(
      "Paste an image URL, webpage URL, file URL, or local path",
      "画像URL、WebページURL、ファイルURL、またはローカルパスを貼り付けてください",
      "请粘贴图片 URL、网页 URL、文件 URL 或本地路径",
      "이미지 URL, 웹페이지 URL, 파일 URL 또는 로컬 경로를 붙여넣으세요",
    ));
    if (value) void addImageUrl(value);
  }, [addImageUrl, text]);

  useEffect(() => {
    const stopPointerAction = (event?: Event) => {
      const action = actionRef.current;
      if (
        event instanceof PointerEvent &&
        action &&
        event.pointerId !== action.pointerId
      ) {
        return;
      }
      if (action?.mode === "select") setSelectionMarquee(null);
      actionRef.current = null;
      document.body.classList.remove("is-manipulating");
      document.body.classList.remove("is-selecting");
    };

    const handlePointerMove = (event: PointerEvent) => {
      const action = actionRef.current;
      if (!action || event.pointerId !== action.pointerId) return;

      if (action.mode === "pan") {
        updateBoard(action.boardId, (board) => ({
          ...board,
          viewport: {
            ...board.viewport,
            x: action.startX + event.clientX - action.startClientX,
            y: action.startY + event.clientY - action.startClientY,
          },
        }));
        return;
      }

      if (action.mode === "select") {
        const currentCanvasX = event.clientX - action.canvasLeft;
        const currentCanvasY = event.clientY - action.canvasTop;
        const startCanvasX = action.startClientX - action.canvasLeft;
        const startCanvasY = action.startClientY - action.canvasTop;
        setSelectionMarquee({
          left: Math.min(startCanvasX, currentCanvasX),
          top: Math.min(startCanvasY, currentCanvasY),
          width: Math.abs(currentCanvasX - startCanvasX),
          height: Math.abs(currentCanvasY - startCanvasY),
        });

        const startWorldX =
          (action.startClientX -
            action.canvasLeft -
            action.viewportX -
            action.sidebarOffset) /
          action.scale;
        const startWorldY =
          (action.startClientY - action.canvasTop - action.viewportY) /
          action.scale;
        const currentWorldX =
          (event.clientX -
            action.canvasLeft -
            action.viewportX -
            action.sidebarOffset) /
          action.scale;
        const currentWorldY =
          (event.clientY - action.canvasTop - action.viewportY) / action.scale;
        const left = Math.min(startWorldX, currentWorldX);
        const right = Math.max(startWorldX, currentWorldX);
        const top = Math.min(startWorldY, currentWorldY);
        const bottom = Math.max(startWorldY, currentWorldY);
        const board = boardsRef.current.find(
          (entry) => entry.id === action.boardId,
        );
        const enclosedIds = (board?.items ?? [])
          .filter(
            (item) =>
              item.x < right &&
              item.y < bottom &&
              item.x + item.w > left &&
              item.y + item.h > top,
          )
          .map((item) => item.id);
        setSelectedIds(
          Array.from(new Set([...action.initialSelectedIds, ...enclosedIds])),
        );
        return;
      }

      let dx = (event.clientX - action.startClientX) / action.scale;
      let dy = (event.clientY - action.startClientY) / action.scale;
      if (action.mode === "drag") {
        if (action.snapEnabled) {
          dx =
            Math.round((action.anchorStartX + dx) / action.gridSize) * action.gridSize -
            action.anchorStartX;
          dy =
            Math.round((action.anchorStartY + dy) / action.gridSize) * action.gridSize -
            action.anchorStartY;
        }
        const origins = new Map(
          action.itemOrigins.map((origin) => [origin.id, origin]),
        );
        updateBoard(action.boardId, (board) => ({
          ...board,
          updated: "just now",
          items: board.items.map((item) => {
            const origin = origins.get(item.id);
            return origin
              ? { ...item, x: origin.x + dx, y: origin.y + dy }
              : item;
          }),
        }));
        return;
      }

      if (action.mode === "frame-drag") {
        if (action.snapEnabled) {
          dx =
            Math.round((action.frameOrigin.x + dx) / action.gridSize) * action.gridSize -
            action.frameOrigin.x;
          dy =
            Math.round((action.frameOrigin.y + dy) / action.gridSize) * action.gridSize -
            action.frameOrigin.y;
        }
        const origins = new Map(action.itemOrigins.map((origin) => [origin.id, origin]));
        updateBoard(action.boardId, (board) => ({
          ...board,
          updated: "just now",
          frames: (board.frames || []).map((frame) =>
            frame.id === action.frameId
              ? { ...frame, x: action.frameOrigin.x + dx, y: action.frameOrigin.y + dy }
              : frame,
          ),
          items: board.items.map((item) => {
            const origin = origins.get(item.id);
            return origin ? { ...item, x: origin.x + dx, y: origin.y + dy } : item;
          }),
        }));
        return;
      }

      updateBoard(action.boardId, (board) => ({
        ...board,
        updated: "just now",
        items: board.items.map((item) => {
          if (item.id !== action.itemId) return item;
          if (item.type !== "image") {
            return {
              ...item,
              w: Math.max(120, action.startW + dx),
              h: Math.max(90, action.startH + dy),
            };
          }
          const handle = action.resizeHandle ?? "se";
          const horizontalDirection = handle.includes("e")
            ? 1
            : handle.includes("w")
              ? -1
              : 0;
          const verticalDirection = handle.includes("s")
            ? 1
            : handle.includes("n")
              ? -1
              : 0;
          let projectedScale = 1;
          if (horizontalDirection && verticalDirection) {
            projectedScale +=
              (dx * action.startW * horizontalDirection +
                dy * action.startH * verticalDirection) /
              (action.startW ** 2 + action.startH ** 2);
          } else if (horizontalDirection) {
            projectedScale +=
              (dx * horizontalDirection) / action.startW;
          } else {
            projectedScale +=
              (dy * verticalDirection) / action.startH;
          }
          const minimumScale = Math.max(
            120 / action.startW,
            90 / action.startH,
          );
          const scale = Math.max(minimumScale, projectedScale);
          const width = action.startW * scale;
          const height = action.startH * scale;
          const x = horizontalDirection
            ? horizontalDirection < 0
              ? action.startX + action.startW - width
              : action.startX
            : action.startX + (action.startW - width) / 2;
          const y = verticalDirection
            ? verticalDirection < 0
              ? action.startY + action.startH - height
              : action.startY
            : action.startY + (action.startH - height) / 2;
          return {
            ...item,
            x,
            y,
            w: width,
            h: height,
          };
        }),
      }));
    };

    const handlePointerUp = (event: PointerEvent) => {
      handlePointerMove(event);
      stopPointerAction(event);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") stopPointerAction();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", stopPointerAction);
    window.addEventListener("lostpointercapture", stopPointerAction);
    window.addEventListener("blur", stopPointerAction);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", stopPointerAction);
      window.removeEventListener("lostpointercapture", stopPointerAction);
      window.removeEventListener("blur", stopPointerAction);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [updateBoard]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!canvasShortcutsBlocked && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setShowCommandPalette(true);
        return;
      }
      if (canvasShortcutsBlocked) {
        if (event.key === "Escape") {
          event.preventDefault();
          if (boardFileImport) {
            setBoardFileImport(null);
            return;
          }
          if (pendingDeleteBoardId) {
            setPendingDeleteBoardId(null);
            return;
          }
          if (headerImageDraft) {
            cancelHeaderImageEditor();
            return;
          }
          if (showListManager) {
            closeListManager();
            return;
          }
          if (!modalInteractionBlocked) closeSettingsPage();
          setShowLibrary(false);
          setShowBoardGrouping(false);
          setShowShortcuts(false);
          setImageInfoDraft(null);
          setHeaderImageDraft(null);
          setPendingDeleteBoardId(null);
          setShowCommandPalette(false);
          setSidebarMenu(null);
        }
        return;
      }
      const target = event.target as HTMLElement | null;
      const editing =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable;

      if (event.code === "Space" && !editing) {
        spacePressedRef.current = true;
        document.body.classList.add("space-pan");
        event.preventDefault();
      }
      if (editing) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "z"
      ) {
        event.preventDefault();
        if (event.shiftKey) redoLastChange();
        else undoLastChange();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "b"
      ) {
        event.preventDefault();
        toggleSidebar();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "d" &&
        selectedItem
      ) {
        event.preventDefault();
        duplicateItem(selectedItem.id);
      }
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key.toLowerCase() === "r" &&
        selectedItem?.type === "image"
      ) {
        event.preventDefault();
        rotateImage(selectedItem.id, event.shiftKey ? -90 : 90);
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        event.preventDefault();
        deleteSelected();
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        addSticky();
      }
      if (event.key === "Escape") {
        setSelectedIds([]);
        setSelectionMarquee(null);
        setShowShortcuts(false);
        setItemContextMenu(null);
        setPendingDeleteBoardId(null);
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePressedRef.current = false;
        document.body.classList.remove("space-pan");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [
    addSticky,
    boardFileImport,
    canvasShortcutsBlocked,
    cancelHeaderImageEditor,
    closeListManager,
    closeSettingsPage,
    headerImageDraft,
    modalInteractionBlocked,
    pendingDeleteBoardId,
    showListManager,
    deleteSelected,
    duplicateItem,
    rotateImage,
    selectedId,
    selectedIds,
    selectedItem,
    toggleSidebar,
    redoLastChange,
    undoLastChange,
  ]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (canvasShortcutsBlocked) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "TEXTAREA" || target?.tagName === "INPUT") return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void addImageFiles(files);
        return;
      }
      const text = event.clipboardData?.getData("text/plain").trim() || "";
      if (
        /^(?:https?:|file:|data:image\/|[a-zA-Z]:[\\/]|\\\\)/i.test(text)
      ) {
        event.preventDefault();
        void addImageUrl(text);
      }
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [addImageFiles, addImageUrl, canvasShortcutsBlocked]);

  useEffect(() => {
    if (
      selectedItem?.type !== "image" ||
      selectedItem.palette?.length ||
      selectedItem.processing ||
      !selectedItem.src
    ) {
      return;
    }
    const desktop = window.museboardDesktop;
    if (!desktop?.extractColorPalette) return;

    let canceled = false;
    const itemId = selectedItem.id;
    const source = selectedItem.src;
    queueMicrotask(() => {
      if (!canceled) setPaletteLoadingId(itemId);
    });
    void desktop
      .extractColorPalette(source)
      .then((result) => {
        if (canceled) return;
        if (!result.colors.length) {
          if (result.error) setImportNotice("Could not extract colors");
          return;
        }
        updateBoard(activeId, (board) => ({
          ...board,
          items: board.items.map((item) =>
            item.id === itemId ? { ...item, palette: result.colors } : item,
          ),
        }));
      })
      .finally(() => {
        if (!canceled) setPaletteLoadingId(null);
      });

    return () => {
      canceled = true;
    };
  }, [
    activeId,
    selectedItem?.id,
    selectedItem?.palette?.length,
    selectedItem?.processing,
    selectedItem?.src,
    selectedItem?.type,
    updateBoard,
  ]);

  useEffect(() => {
    if (!itemContextMenu) return;
    const closeContextMenu = () => setItemContextMenu(null);
    window.addEventListener("pointerdown", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    return () => {
      window.removeEventListener("pointerdown", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
    };
  }, [itemContextMenu]);

  if (!activeBoard) return null;

  const startCanvasAction = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.currentTarget !== event.target &&
      event.button !== 1 &&
      !spacePressedRef.current
    ) {
      return;
    }
    if (event.button !== 0 && event.button !== 1) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Losing capture is handled by the global cancel and blur listeners.
    }
    if (event.button === 1 || spacePressedRef.current) {
      setSelectionMarquee(null);
      actionRef.current = {
        mode: "pan",
        boardId: activeBoard.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        pointerId: event.pointerId,
        startX: activeBoard.viewport.x,
        startY: activeBoard.viewport.y,
      };
      document.body.classList.add("is-manipulating");
      return;
    }

    const rect = event.currentTarget.getBoundingClientRect();
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const preserveSelection = event.shiftKey || event.ctrlKey || event.metaKey;
    const initialSelectedIds = preserveSelection ? selectedIds : [];
    if (!preserveSelection) setSelectedIds([]);
    setItemContextMenu(null);
    setSelectionMarquee({
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      width: 0,
      height: 0,
    });
    actionRef.current = {
      mode: "select",
      boardId: activeBoard.id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerId: event.pointerId,
      canvasLeft: rect.left,
      canvasTop: rect.top,
      viewportX: activeBoard.viewport.x,
      viewportY: activeBoard.viewport.y,
      sidebarOffset: getCanvasSidebarOffset(),
      scale: activeBoard.viewport.scale,
      initialSelectedIds,
    };
    document.body.classList.add("is-selecting");
  };

  const startItemAction = (
    event: ReactPointerEvent,
    item: CanvasItem,
    mode: "drag" | "resize",
    resizeHandle?: ResizeHandle,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Losing capture is handled by the global cancel and blur listeners.
    }
    recordUndoSnapshot();
    syncImagePaletteVisibility(item, activeBoard.viewport.scale);
    const movingIds =
      mode === "drag" && selectedIdSet.has(item.id)
        ? [...selectedIds.filter((id) => id !== item.id), item.id]
        : [item.id];
    setSelectedIds(movingIds);
    setItemContextMenu(null);
    const movingIdSet = new Set(movingIds);
    const topZ = Math.max(0, ...activeBoard.items.map((entry) => entry.z)) + 1;
    const orderedMovingItems = activeBoard.items
      .filter((entry) => movingIdSet.has(entry.id))
      .sort((a, b) => a.z - b.z);
    const nextLayers = new Map(
      orderedMovingItems.map((entry, index) => [entry.id, topZ + index]),
    );
    updateActiveBoard((board) => ({
      ...board,
      items: board.items.map((entry) =>
        nextLayers.has(entry.id)
          ? { ...entry, z: nextLayers.get(entry.id) ?? entry.z }
          : entry,
      ),
    }));
    actionRef.current =
      mode === "drag"
        ? {
            mode: "drag",
            boardId: activeBoard.id,
            itemId: item.id,
            startClientX: event.clientX,
            startClientY: event.clientY,
            pointerId: event.pointerId,
            scale: activeBoard.viewport.scale,
            itemOrigins: activeBoard.items
              .filter((entry) => movingIdSet.has(entry.id))
              .map((entry) => ({ id: entry.id, x: entry.x, y: entry.y })),
            snapEnabled: Boolean(activeBoard.snapEnabled),
            gridSize: activeBoard.gridSize || 40,
            anchorStartX: item.x,
            anchorStartY: item.y,
          }
        : {
            mode: "resize",
            boardId: activeBoard.id,
            itemId: item.id,
            startClientX: event.clientX,
            startClientY: event.clientY,
            pointerId: event.pointerId,
            startX: item.x,
            startY: item.y,
            startW: item.w,
            startH: item.h,
            scale: activeBoard.viewport.scale,
            resizeHandle,
          };
    document.body.classList.add("is-manipulating");
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorX = event.clientX - rect.left;
    const cursorY = event.clientY - rect.top;
    const oldViewport = activeBoard.viewport;
    const sidebarOffset = getCanvasSidebarOffset();
    const nextScale = oldViewport.scale * Math.exp(-event.deltaY * 0.0013);
    if (!Number.isFinite(nextScale) || nextScale <= 0) return;
    syncImagePaletteVisibility(selectedItem, nextScale, {
      width: rect.width,
      height: rect.height,
    });
    const scaleRatio = nextScale / oldViewport.scale;
    updateActiveBoard((board) => ({
      ...board,
      viewport: {
        scale: nextScale,
        x:
          cursorX -
          sidebarOffset -
          (cursorX - sidebarOffset - oldViewport.x) * scaleRatio,
        y: cursorY - (cursorY - oldViewport.y) * scaleRatio,
      },
    }));
  };

  const fitBoard = () => {
    const items = activeBoard.items;
    const rect = canvasRef.current?.getBoundingClientRect();
    const sidebarOffset = getCanvasSidebarOffset();
    if (!items.length || !rect) {
      updateActiveBoard((board) => ({
        ...board,
        viewport: { x: 80 - sidebarOffset, y: 70, scale: 1 },
      }));
      return;
    }
    const minX = Math.min(...items.map((item) => item.x));
    const minY = Math.min(...items.map((item) => item.y));
    const maxX = Math.max(...items.map((item) => item.x + item.w));
    const maxY = Math.max(...items.map((item) => item.y + item.h));
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.max(
      Number.EPSILON,
      Math.min((rect.width - 160) / width, (rect.height - 150) / height),
    );
    syncImagePaletteVisibility(selectedItem, scale, {
      width: rect.width,
      height: rect.height,
    });
    updateActiveBoard((board) => ({
      ...board,
      viewport: {
        scale,
        x:
          (rect.width - width * scale) / 2 -
          minX * scale -
          sidebarOffset,
        y: (rect.height - height * scale) / 2 - minY * scale,
      },
    }));
  };

  const createBoard = () => {
    recordUndoSnapshot();
    const nextBoard = makeEmptyBoard();
    setBoards((current) => [...current, nextBoard]);
    setActiveId(nextBoard.id);
    setShowSettings(false);
    setSelectedIds([]);
    setSelectionMarquee(null);
    setSearch("");
    setItemContextMenu(null);
    if (activeWorkspace) setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(activeWorkspace);
      return next;
    });
    window.requestAnimationFrame(() => {
      sidebarRef.current?.querySelector<HTMLElement>(".board-row.active")?.scrollIntoView({ block: "nearest" });
    });
  };

  const removeBoard = (boardId: string) => {
    if (!boards.some((board) => board.id === boardId)) return;
    recordUndoSnapshot();
    const remaining = boards.filter((board) => board.id !== boardId);
    if (!remaining.length) remaining.push(makeEmptyBoard());
    setBoards(remaining);
    if (activeId === boardId) {
      const nextBoard = remaining.find((board) => activeWorkspace && board.groupName?.trim() === activeWorkspace) ?? remaining[0];
      setActiveId(nextBoard.id);
      if (activeWorkspace && nextBoard.groupName?.trim() !== activeWorkspace) setWorkspaceFilter(null);
    }
    setSelectedIds([]);
    setSelectionMarquee(null);
    setPendingDeleteBoardId(null);
    setItemContextMenu(null);
  };

  const openListManager = () => {
    listManagerSessionRef.current += 1;
    listManagerBaseRef.current = boards;
    setListManagerDraft(boards.map((board) => ({ ...board })));
    setHeaderImageError(null);
    setPendingDeleteBoardId(null);
    setShowListManager(true);
  };

  const addListManagerBoard = () => {
    let index = listManagerDraft.length;
    const prefix = text("Untitled board", "新しい保存リスト", "未命名列表", "이름 없는 목록");
    while (listManagerDraft.some((board) => board.name.trim() === `${prefix} ${index + 1}`)) index += 1;
    const nextBoard = makeEmptyBoard(index);
    setListManagerDraft((current) => [...current, nextBoard]);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>(`.list-manager-row[data-board-id="${nextBoard.id}"] .list-manager-name`)?.focus();
    });
  };

  const moveListManagerBoard = (boardId: string, direction: -1 | 1) => {
    setListManagerDraft((current) => {
      const index = current.findIndex((board) => board.id === boardId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const prepareListManagerDrag = (event: ReactPointerEvent<HTMLDivElement>, boardId: string) => {
    if (listManagerPointerDragRef.current?.active) return;
    listManagerPreviewDragRef.current = null;
    const control = (event.target as HTMLElement).closest("input, button, select, textarea, a, label, [contenteditable]");
    if (control && !control.matches("button.list-manager-preview-button")) return;
    listManagerPointerDragRef.current?.begin(event, boardId, event.currentTarget);
  };

  const openListManagerPreview = (event: ReactMouseEvent<HTMLButtonElement>, board: Board) => {
    // Ignore the click generated after a completed or cancelled pointer drag.
    // A fresh pointer-down clears this guard, and keyboard activation remains available.
    if (event.detail > 0 && listManagerPreviewDragRef.current === board.id) {
      event.preventDefault();
      return;
    }
    openHeaderImageEditor(board, listManagerSessionRef.current);
  };

  const confirmBoardDeletion = (boardId: string) => {
    if (showListManager) {
      setListManagerDraft((current) => current.filter((entry) => entry.id !== boardId));
      setPendingDeleteBoardId(null);
      return;
    }
    removeBoard(boardId);
  };

  const saveListManager = () => {
    const current = boardsRef.current;
    const originalById = new Map(listManagerBaseRef.current.map((board) => [board.id, board]));
    const currentById = new Map(current.map((board) => [board.id, board]));
    const fallbackName = text("Untitled list", "名称未設定", "未命名列表", "이름 없는 목록");
    const remaining = listManagerDraft
      .filter((draft) => !originalById.has(draft.id) || currentById.has(draft.id))
      .map((draft) => mergeListManagerEntry(draft, originalById.get(draft.id), currentById.get(draft.id), fallbackName));
    if (!remaining.length) remaining.push(makeEmptyBoard());
    if (remaining.length !== current.length || remaining.some((board, index) => board !== current[index])) {
      recordUndoSnapshot();
      setBoards(remaining);
      const nextActive = remaining.find((board) => board.id === activeId) ??
        remaining.find((board) => activeWorkspace && board.groupName?.trim() === activeWorkspace) ?? remaining[0];
      if (!remaining.some((board) => board.id === activeId)) {
        setActiveId(nextActive.id);
        setSelectedIds([]);
        setSelectionMarquee(null);
        setItemContextMenu(null);
      }
      if (activeWorkspace && nextActive.groupName?.trim() !== activeWorkspace) setWorkspaceFilter(null);
      setCollapsedGroups((groups) => {
        const next = new Set(groups);
        for (const board of remaining) {
          if (board.groupName && originalById.get(board.id)?.groupName !== board.groupName) next.delete(board.groupName);
        }
        return next;
      });
    }
    closeListManager();
  };

  const dragCarriesAssets = (event: DragEvent<HTMLElement>) => hasImageDropData(event.dataTransfer);

  const importDroppedImages = (
    transfer: DataTransfer,
    targetBoardId: string,
    worldX?: number,
    worldY?: number,
  ) => {
    setAssetDropBoardId(null);
    setIsDraggingFiles(false);
    const dropped = readImageDrop(transfer);
    if (dropped.files.length) {
      void addImageFiles(dropped.files, worldX, worldY, targetBoardId);
    } else if (dropped.url) {
      void addImageUrl(dropped.url, worldX, worldY, targetBoardId);
    } else {
      setImportNotice(dropped.error === "browser-only"
        ? text("This image is available only inside the browser. Save the image, then drop the file here.", "この画像はブラウザ内だけで使える形式です。画像を保存して、そのファイルをドロップしてください。", "此图片仅在浏览器内可用。请先保存图片，再拖入文件。", "브라우저에서만 사용할 수 있는 이미지입니다. 이미지를 저장한 다음 파일을 끌어 놓으세요.")
        : text("No image or image URL was received. Try dragging the image itself or its saved file.", "画像や画像URLを受け取れませんでした。画像そのもの、または保存した画像ファイルをドロップしてください。", "未收到图片或图片网址。请拖入图片本身或已保存的图片文件。", "이미지 또는 이미지 URL을 받지 못했습니다. 이미지 자체나 저장한 파일을 끌어 놓으세요."));
    }
  };

  const handleBoardAssetDrop = (
    event: DragEvent<HTMLDivElement>,
    targetBoardId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    importDroppedImages(event.dataTransfer, targetBoardId);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDraggingFiles(false);
    const rect = event.currentTarget.getBoundingClientRect();
    const sidebarOffset = getCanvasSidebarOffset();
    const worldX =
      (event.clientX -
        rect.left -
        activeBoard.viewport.x -
        sidebarOffset) /
      activeBoard.viewport.scale;
    const worldY =
      (event.clientY - rect.top - activeBoard.viewport.y) /
      activeBoard.viewport.scale;
    if (dragCarriesAssets(event)) importDroppedImages(event.dataTransfer, activeId, worldX, worldY);
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    void addImageFiles(Array.from(event.target.files ?? []));
    event.target.value = "";
  };

  const switchBoard = (boardId: string) => {
    setShowSettings(false);
    setActiveId(boardId);
    setSelectedIds([]);
    setSelectionMarquee(null);
    setItemContextMenu(null);
  };

  const openBoardGrouping = () => {
    const currentGroup = activeBoard.groupName?.trim() || "";
    setBoardGroupNameDraft(currentGroup);
    setBoardGroupSelection(
      currentGroup
        ? boards
            .filter((board) => board.groupName?.trim() === currentGroup)
            .map((board) => board.id)
        : [activeBoard.id],
    );
    setShowBoardGrouping(true);
  };

  const toggleBoardGroupSelection = (boardId: string) => {
    setBoardGroupSelection((current) =>
      current.includes(boardId)
        ? current.filter((id) => id !== boardId)
        : [...current, boardId],
    );
  };

  const applyBoardGrouping = () => {
    const groupName = boardGroupNameDraft.trim();
    if (!groupName || boardGroupSelection.length < 2) return;
    const selectedBoardIds = new Set(boardGroupSelection);
    recordUndoSnapshot();
    if (selectedBoardIds.has(activeId) && activeWorkspace && groupName !== activeWorkspace) setWorkspaceFilter(null);
    setBoards((current) =>
      current.map((board) =>
        selectedBoardIds.has(board.id)
          ? { ...board, groupName, updated: "just now" }
          : board,
      ),
    );
    setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(groupName);
      return next;
    });
    setShowBoardGrouping(false);
  };

  const removeSelectedBoardsFromGroup = () => {
    if (!boardGroupSelection.length) return;
    const selectedBoardIds = new Set(boardGroupSelection);
    recordUndoSnapshot();
    if (selectedBoardIds.has(activeId)) setWorkspaceFilter(null);
    setBoards((current) =>
      current.map((board) =>
        selectedBoardIds.has(board.id)
          ? { ...board, groupName: undefined, updated: "just now" }
          : board,
      ),
    );
    setShowBoardGrouping(false);
  };

  const selectWorkspace = (group: string | null) => {
    setWorkspaceFilter(group);
    setSearch("");
    if (group && activeBoard.groupName?.trim() !== group) {
      const first = boards.find((board) => board.groupName?.trim() === group);
      if (first) switchBoard(first.id);
    }
    if (group) setCollapsedGroups((current) => {
      const next = new Set(current);
      next.delete(group);
      return next;
    });
  };
  const createActions: ChromeMenuItem[] = [
    { id: "new-list", icon: "plus", label: text("New saved list", "新しい保存リスト", "新建保存列表", "새 저장 목록"), onSelect: createBoard },
    { id: "add-images", icon: "image", label: text("Add images", "画像を追加", "添加图片", "이미지 추가"), disabled: showSettings, onSelect: () => void chooseImageFiles() },
    { id: "import-board-file", icon: "open", label: text("Import board file", "ボードファイルを読み込む", "导入看板文件", "보드 파일 가져오기"), disabled: typeof window === "undefined" || !window.museboardDesktop?.openPinterestBoardFile, onSelect: () => void choosePinterestBoardFile() },
    { id: "add-note", icon: "note", label: text("Add note", "付箋を追加", "添加便笺", "메모 추가"), shortcut: "N", disabled: showSettings, onSelect: () => addSticky() },
    { id: "group-lists", icon: "folder", label: text("Group lists", "リストをまとめる", "整理列表", "목록 묶기"), onSelect: openBoardGrouping },
  ];
  const projectFilesAvailable = typeof window !== "undefined" && Boolean(window.museboardDesktop);
  const projectActions: ChromeMenuItem[] = projectFilesAvailable ? [
    { id: "open", icon: "open", label: text("Open project", "プロジェクトを開く", "打开项目", "프로젝트 열기"), shortcut: "Ctrl+O", onSelect: () => void openProjectFromSettings() },
    { id: "save", icon: "save", label: text("Save project", "プロジェクトを保存", "保存项目", "프로젝트 저장"), shortcut: "Ctrl+S", onSelect: () => window.dispatchEvent(new CustomEvent("museboard:save-request")) },
  ] : [];
  const mainActions: ChromeMenuItem[] = [
    ...projectActions,
    { id: "manage-lists", icon: "pen", label: text("Manage lists", "リストを管理", "管理列表", "목록 관리"), separatorBefore: projectActions.length > 0, onSelect: openListManager },
    { id: "grid", icon: "grid", label: text("Show grid", "グリッドを表示", "显示网格", "그리드 표시"), checked: canvasSettings.gridVisible, separatorBefore: true, onSelect: () => updateCanvasSettings({ gridVisible: !canvasSettings.gridVisible }) },
    { id: "snap", icon: "snap", label: text("Snap to grid", "グリッドにスナップ", "吸附到网格", "그리드에 스냅"), checked: canvasSettings.snapEnabled, onSelect: () => updateCanvasSettings({ snapEnabled: !canvasSettings.snapEnabled }) },
    { id: "settings", icon: "settings", label: text("Settings", "設定", "设置", "설정"), separatorBefore: true, onSelect: openSettingsPage },
  ];
  const commandItems: CommandItem[] = [
    ...boards.map((board) => ({
      id: `board:${board.id}`, icon: "boards" as const, label: board.name,
      detail: board.groupName || text("Saved list", "保存リスト", "保存列表", "저장 목록"),
      onSelect: () => {
        setWorkspaceFilter(null);
        setSearch("");
        setCollapsedGroups((current) => { const next = new Set(current); next.delete(board.groupName || ""); return next; });
        switchBoard(board.id);
      },
    })),
    ...createActions,
    { id: "library", icon: "library", label: text("Library", "ライブラリ", "资料库", "라이브러리"), onSelect: () => setShowLibrary(true) },
    ...mainActions,
  ];
  const settingsCategories = [
    { icon: "settings" as const, label: text("General", "一般", "常规", "일반") },
    { icon: "note" as const, label: text("Notes", "付箋", "便笺", "메모") },
    { icon: "image" as const, label: text("Canvas", "キャンバス", "画布", "캔버스") },
    { icon: "boards" as const, label: text("Current list", "現在のリスト", "当前列表", "현재 목록") },
    { icon: "save" as const, label: text("Saving", "保存", "保存", "저장") },
    { icon: "help" as const, label: text("Project & help", "プロジェクトとヘルプ", "项目和帮助", "프로젝트 및 도움말") },
    { icon: "save" as const, label: text("Data management", "データ管理", "数据管理", "데이터 관리") },
  ];

  return (
    <main
      data-modal-open={modalInteractionBlocked || undefined}
      data-canvas-shortcuts-blocked={canvasShortcutsBlocked || undefined}
      className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""} ${
        sidebarPeekOpen ? "is-sidebar-peeking" : ""
      } ${settings.edgeToEdge ? "is-edge-to-edge" : ""}`}
      onDragEnterCapture={(event) => {
        if (!modalInteractionBlocked && dragCarriesAssets(event)) handleSidebarPeekPointerMove(event.nativeEvent);
      }}
      onDragOverCapture={(event) => {
        if (!modalInteractionBlocked && dragCarriesAssets(event)) handleSidebarPeekPointerMove(event.nativeEvent);
      }}
      onDragLeave={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX <= bounds.left || event.clientX >= bounds.right || event.clientY <= bounds.top || event.clientY >= bounds.bottom) {
          setAssetDropBoardId(null);
          setIsDraggingFiles(false);
          hideSidebarPeek();
        }
      }}
    >
      {storageBusy && <div className="storage-busy-overlay" role="status" aria-live="polite">{text("Processing…", "処理中…", "正在处理…", "처리 중…")}</div>}
      <aside
        ref={sidebarRef}
        className={`sidebar ${sidebarPeekOpen ? "is-peeking" : ""}`}
        aria-label={text("Saved boards", "保存リスト", "保存列表", "저장 목록")}
        aria-hidden={sidebarCollapsed && !sidebarPeekOpen}
        inert={(sidebarCollapsed && !sidebarPeekOpen) || modalInteractionBlocked}
        onPointerEnter={showSidebarPeek}
        onPointerMoveCapture={showSidebarPeek}
        onPointerLeave={hideSidebarPeek}
      >
        <div className="sidebar-navigation">
          <button className="sidebar-main-menu" title={text("Menu", "メニュー", "菜单", "메뉴")} aria-label={text("Menu", "メニュー", "菜单", "메뉴")} aria-haspopup="menu" aria-expanded={sidebarMenu === "main"} onClick={() => setSidebarMenu("main")}><UiIcon name="menu" /></button>
          <button className={`sidebar-toggle-button ${sidebarCollapsed ? "is-unpinned" : "is-pinned"}`} title={text("Compact mode", "コンパクト表示", "紧凑模式", "컴팩트 모드")} aria-label={text("Toggle compact mode", "コンパクト表示を切り替え", "切换紧凑模式", "컴팩트 모드 전환")} aria-pressed={sidebarCollapsed} aria-expanded={!sidebarCollapsed} onClick={toggleSidebar}><UiIcon name="sidebar" /></button>
          <span className="sidebar-navigation-spacer" />
          <button title={text("Undo", "元に戻す", "撤销", "실행 취소")} aria-label={text("Undo", "元に戻す", "撤销", "실행 취소")} disabled={showSettings || !historyAvailability.undo} onClick={undoLastChange}><UiIcon name="undo" /></button>
          <button title={text("Redo", "やり直す", "重做", "다시 실행")} aria-label={text("Redo", "やり直す", "重做", "다시 실행")} disabled={showSettings || !historyAvailability.redo} onClick={redoLastChange}><UiIcon name="redo" /></button>
          <button className="rail-tool fit-tool" title={text("Fit all items", "全体を表示", "显示全部", "전체 보기")} aria-label={text("Fit all items", "全体を表示", "显示全部", "전체 보기")} disabled={showSettings} onClick={fitBoard}><UiIcon name="fit" /></button>
        </div>
        <nav className="board-list">
          {filteredBoards.map((board, index) => (
            <Fragment key={board.id}>
            {board.groupName &&
              (index === 0 || filteredBoards[index - 1]?.groupName !== board.groupName) && (
                <button
                  className="board-group-heading"
                  onClick={() =>
                    setCollapsedGroups((current) => {
                      const next = new Set(current);
                      if (next.has(board.groupName || "")) next.delete(board.groupName || "");
                      else next.add(board.groupName || "");
                      return next;
                    })
                  }
                >
                  <span>{collapsedGroups.has(board.groupName) ? "›" : "⌄"}</span>
                  {board.groupName}
                </button>
              )}
            {(!board.groupName || !collapsedGroups.has(board.groupName)) && (
            <div
              className={`board-row ${
                board.id === activeId && !showSettings ? "active" : ""
              } ${
                assetDropBoardId === board.id ? "asset-drop" : ""
              } ${board.headerImageSrc ? "has-header" : ""}`}
              title={board.name}
              data-board-id={board.id}
              data-drop-label={text("Add here", "ここに追加", "添加到此处", "여기에 추가")}
              draggable={false}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openHeaderImageEditor(board);
              }}
              onDragStart={(event) => event.preventDefault()}
              onDragOver={(event) => {
                if (!dragCarriesAssets(event)) {
                  event.dataTransfer.dropEffect = "none";
                  setAssetDropBoardId(null);
                  return;
                }
                const effect = getImageDropEffect(event.dataTransfer);
                event.dataTransfer.dropEffect = effect;
                if (effect === "none") {
                  setAssetDropBoardId(null);
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setIsDraggingFiles(false);
                setAssetDropBoardId(board.id);
              }}
              onDrop={(event) => {
                if (dragCarriesAssets(event)) {
                  handleBoardAssetDrop(event, board.id);
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setAssetDropBoardId(null);
              }}
              onDragLeave={(event) => {
                if (
                  assetDropBoardId === board.id &&
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  setAssetDropBoardId(null);
                }
              }}
              onDragEnd={() => {
                setAssetDropBoardId(null);
              }}
            >
              {board.headerImageSrc && <MiniPreview board={board} />}
              <button
                className="board-button"
                onClick={() => switchBoard(board.id)}
                aria-current={board.id === activeId && !showSettings ? "page" : undefined}
                aria-label={`${text("Open", "開く", "打开", "열기")} ${board.name}`}
              >
                {!board.headerImageSrc && <MiniPreview board={board} />}
                <span className="board-name-label">{board.name}</span>
              </button>
            </div>
            )}
            </Fragment>
          ))}
          {!filteredBoards.length && <p className="board-search-empty">
            {text("No matching lists", "一致するリストがありません", "没有匹配的列表", "일치하는 목록이 없습니다")}
          </p>}
          {settingsTabOpen && (
            <div className={`sidebar-settings-row ${showSettings ? "active" : ""}`}>
              <button
                className="sidebar-settings-tab board-button"
                onClick={openSettingsPage}
                aria-current={showSettings ? "page" : undefined}
                aria-controls={showSettings ? "workspace-settings-page" : undefined}
                title={text("Settings", "設定", "设置", "설정")}
              >
                <span className="mini-preview empty" aria-hidden="true" />
                <span className="board-name-label">{text("Settings", "設定", "设置", "설정")}</span>
              </button>
              <button
                className="sidebar-settings-close"
                onClick={closeSettingsPage}
                title={text("Close settings", "設定を閉じる", "关闭设置", "설정 닫기")}
                aria-label={text("Close settings", "設定を閉じる", "关闭设置", "설정 닫기")}
              ><UiIcon name="close" /></button>
            </div>
          )}
          <div className="sidebar-window-drag-space" aria-hidden="true" />
        </nav>

        <div className="workspace-sidebar-footer">
          <button className="rail-library" onClick={() => setShowLibrary(true)} title={text("Library — search and organize images", "ライブラリ：画像を検索・整理", "资料库：搜索和整理图片", "라이브러리: 이미지 검색 및 정리")} aria-label={text("Library", "ライブラリ", "资料库", "라이브러리")}><UiIcon name="library" /></button>
          <div className="workspace-switches" aria-label={text("Workspaces", "ワークスペース", "工作区", "작업 공간")}>
            {boardGroups.length > 0 && <>
              <button className={`workspace-switch ${!activeWorkspace ? "active" : ""}`} data-workspace="" aria-pressed={!activeWorkspace} aria-label={text("All lists", "すべてのリスト", "全部列表", "모든 목록")} title={text("All lists", "すべてのリスト", "全部列表", "모든 목록")} onClick={() => selectWorkspace(null)}><UiIcon name="boards" /></button>
              {boardGroups.map((group) => <button key={group} className={`workspace-switch ${activeWorkspace === group ? "active" : ""}`} data-workspace={group} title={group} aria-label={group} aria-pressed={activeWorkspace === group} onClick={() => selectWorkspace(group)}>{Array.from(group)[0]}</button>)}
            </>}
          </div>
          <button className="sidebar-create-menu" title={text("Create…", "新しく作成…", "新建…", "새로 만들기…")} aria-label={text("Create…", "新しく作成…", "新建…", "새로 만들기…")} aria-haspopup="menu" aria-expanded={sidebarMenu === "create"} onClick={() => setSidebarMenu("create")}><UiIcon name="plus" /></button>
        </div>
      </aside>

      {sidebarMenu && <ChromeMenu title={sidebarMenu === "main" ? text("Menu", "メニュー", "菜单", "메뉴") : text("Create", "作成", "新建", "새로 만들기")} sidebarRef={sidebarRef} anchor={sidebarMenu === "main" ? "top" : "bottom"} items={sidebarMenu === "main" ? mainActions : createActions} onClose={() => setSidebarMenu(null)} />}
      {showCommandPalette && <CommandPalette title={text("Search lists and actions", "リストと操作を検索", "搜索列表和操作", "목록 및 작업 검색")} placeholder={text("Search…", "検索…", "搜索…", "검색…")} emptyLabel={text("No results", "一致する項目がありません", "没有结果", "결과 없음")} closeLabel={text("Close", "閉じる", "关闭", "닫기")} items={commandItems} onClose={() => setShowCommandPalette(false)} />}

      {headerImageDraft && (
        <div
          className="header-image-editor-backdrop"
          onPointerDown={cancelHeaderImageEditor}
        >
          <section
            className="header-image-editor"
            role="dialog"
            aria-modal="true"
            aria-label={text("List header image", "リストのヘッダー画像", "列表标题图片", "목록 헤더 이미지")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <h2>{text("Adjust list header", "リストヘッダーを調整", "调整列表标题", "목록 헤더 조정")}</h2>
              </div>
              <button className="header-image-apply" onClick={applyHeaderImage}>
                {headerImageDraft.managerSession !== undefined
                  ? text("Apply and return", "適用して戻る", "应用并返回", "적용 후 돌아가기")
                  : text("Apply", "適用", "应用", "적용")}
              </button>
            </header>

            <div className="header-image-editor-content">
              <div
                className="header-image-editor-preview"
                aria-label={text("Drag to position header image", "ドラッグしてヘッダー画像の位置を調整", "拖动以调整标题图片位置", "드래그하여 헤더 이미지 위치 조정")}
                onPointerDown={startHeaderImageDrag}
                onPointerMove={updateHeaderImageDrag}
                onPointerUp={finishHeaderImageDrag}
                onPointerCancel={finishHeaderImageDrag}
                onLostPointerCapture={() => {
                  headerImageDragRef.current = null;
                }}
              >
                <div className="header-image-editor-image-plane">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    className="header-image-editor-image"
                    src={headerImageDraft.src}
                    alt=""
                    draggable={false}
                    onLoad={(event) => {
                      const image = event.currentTarget;
                      const renderedSrc = image.getAttribute("src");
                      if (!image.naturalWidth || !image.naturalHeight) return;
                      setHeaderImageDraft((current) => {
                        if (
                          !current ||
                          renderedSrc !== current.src ||
                          (current.imageWidth === image.naturalWidth && current.imageHeight === image.naturalHeight)
                        ) {
                          return current;
                        }
                        return constrainHeaderImageDraft({
                          ...current,
                          imageWidth: image.naturalWidth,
                          imageHeight: image.naturalHeight,
                        });
                      });
                    }}
                    style={headerImageLayout ? {
                      left: "50%",
                      top: "50%",
                      width: `${headerImageLayout.widthPercent}%`,
                      height: `${headerImageLayout.heightPercent}%`,
                      transform: `translate(-${headerImageLayout.positionX}%, -${headerImageLayout.positionY}%)`,
                    } : undefined}
                  />
                </div>
                <div className="header-image-editor-crop-window">
                </div>
              </div>

              <div className="header-image-editor-controls">
                {headerImageError && <p className="header-image-error" role="alert">{headerImageError}</p>}
                <div className="header-image-zoom-control">
                  <span aria-hidden="true">−</span>
                  <input
                    type="range"
                    min={HEADER_IMAGE_MIN_SCALE}
                    max={HEADER_IMAGE_MAX_SCALE}
                    step={HEADER_IMAGE_SCALE_STEP}
                    value={headerImageDraft.scale}
                    onChange={(event) => {
                      const scale = Number(event.target.value);
                      setHeaderImageDraft((current) => current
                        ? constrainHeaderImageDraft(current, scale)
                        : current);
                    }}
                    aria-label={text("Zoom", "拡大縮小", "缩放", "확대/축소")}
                  />
                  <span aria-hidden="true">＋</span>
                </div>
                <div className="header-image-editor-actions">
                  <button className="header-image-remove" onClick={restoreHeaderImageList}>
                    {text("Back to image list", "画像一覧に戻す", "返回图片列表", "이미지 목록으로 돌아가기")}
                  </button>
                  <button className="header-image-change" onClick={() => void chooseHeaderImage(headerImageDraft.boardId, headerImageDraft.managerSession)}>
                    {text("Choose another image", "画像を選び直す", "重新选择图片", "다른 이미지 선택")}
                  </button>
                  {headerImageDraft.managerSession !== undefined && (
                    <button className="header-image-manager-cancel" onClick={cancelHeaderImageEditor}>
                      {text("Cancel and return", "キャンセルして戻る", "取消并返回", "취소 후 돌아가기")}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}

      {showSettings && (
          <section
            id="workspace-settings-page"
            ref={settingsPageRef}
            className="settings-dialog settings-page"
            aria-label={text("Settings", "設定", "设置", "설정")}
            inert={modalInteractionBlocked}
          >
            <header>
              <div>
                <small>IMAGESTORAGE</small>
                <h2>{text("Settings", "設定", "设置", "설정")}</h2>
              </div>
              <button onClick={closeSettingsPage} aria-label={text("Close settings", "設定を閉じる", "关闭设置", "설정 닫기")}><UiIcon name="close" /></button>
            </header>

            <div className="settings-layout">
              <nav className="settings-categories" aria-label={text("Settings categories", "設定カテゴリ", "设置类别", "설정 카테고리")}>
                {settingsCategories.map((category, index) => <button key={index} className={settingsCategory === index ? "active" : ""} aria-current={settingsCategory === index ? "page" : undefined} onClick={() => setSettingsCategory(index)}><UiIcon name={category.icon} /><span>{category.label}</span></button>)}
              </nav>
            <div className="settings-scroll">
              <fieldset hidden={settingsCategory !== 0}>
                <legend>{text("General", "一般", "常规", "일반")}</legend>
                <label>
                  <span>{text("Display language", "表示言語", "显示语言", "표시 언어")}</span>
                  <select
                    value={settings.language}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, language: event.target.value as UiLanguage }))
                    }
                  >
                    <option value="ja">日本語</option>
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                    <option value="ko">한국어</option>
                  </select>
                </label>
                <label className="settings-switch-row">
                  <span>{text("Reopen the last list", "前回のリストを開く", "重新打开上次列表", "마지막 목록 다시 열기")}</span>
                  <input
                    type="checkbox"
                    checked={settings.reopenPreviousBoard}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, reopenPreviousBoard: event.target.checked }))
                    }
                  />
                </label>
                <label>
                  <span>{text("Sidebar at startup", "起動時のサイドバー", "启动时侧边栏", "시작할 때 사이드바")}</span>
                  <select
                    value={settings.startupSidebar}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        startupSidebar: event.target.value as AppSettings["startupSidebar"],
                      }))
                    }
                  >
                    <option value="pinned">{text("Pinned", "固定", "固定", "고정")}</option>
                    <option value="closed">{text("Closed", "閉じる", "关闭", "닫기")}</option>
                  </select>
                </label>
              </fieldset>

              <fieldset hidden={settingsCategory !== 1}>
                <legend>{text("Notes · All lists", "付箋・全リスト共通", "便笺・所有列表", "메모 · 모든 목록")}</legend>
                <label>
                  <span>{text("Font", "フォント", "字体", "글꼴")}</span>
                  <select
                    value={settings.noteFont}
                    onChange={(event) => setSettings((current) => ({ ...current, noteFont: event.target.value }))}
                  >
                    <option value={'Inter, "Noto Sans JP", "Segoe UI", sans-serif'}>Inter / Noto Sans</option>
                    <option value={'"Yu Gothic UI", "Noto Sans JP", sans-serif'}>Yu Gothic UI</option>
                    <option value={'"BIZ UDPGothic", "Noto Sans JP", sans-serif'}>BIZ UDPGothic</option>
                    <option value={'Georgia, "Noto Serif JP", serif'}>Georgia / Noto Serif</option>
                  </select>
                </label>
                <label>
                  <span>{text("Font size", "文字サイズ", "字号", "글자 크기")} <b>{settings.noteFontSize}px</b></span>
                  <input
                    type="range"
                    min="9"
                    max="28"
                    value={settings.noteFontSize}
                    onChange={(event) =>
                      setSettings((current) => ({ ...current, noteFontSize: Number(event.target.value) }))
                    }
                  />
                </label>
              </fieldset>

              <fieldset hidden={settingsCategory !== 2}>
                <legend>{text("Canvas · All lists", "キャンバス・全リスト共通", "画布・所有列表", "캔버스 · 모든 목록")}</legend>
                <label className="settings-switch-row" htmlFor="setting-edge-to-edge">
                  <span>{text("Edge-to-edge canvas", "端まで表示", "画布延伸至窗口边缘", "창 가장자리까지 표시")}</span>
                  <input
                    id="setting-edge-to-edge"
                    type="checkbox"
                    checked={settings.edgeToEdge}
                    onChange={(event) => setSettings((current) => ({ ...current, edgeToEdge: event.target.checked }))}
                  />
                </label>
                <label className="settings-color-row">
                  <span>{text("Background color", "背景色", "背景色", "배경색")}</span>
                  <input
                    type="color"
                    value={canvasSettings.backgroundColor}
                    onChange={(event) =>
                      updateCanvasSettings({ backgroundColor: event.target.value })
                    }
                  />
                </label>
                <div className="settings-action-row">
                  <span>{text("Background image", "背景画像", "背景图片", "배경 이미지")}</span>
                  <button onClick={() => void pickBoardVisual()}>{text("Choose", "選択", "选择", "선택")}</button>
                  {canvasSettings.backgroundImageSrc && (
                    <button onClick={() => updateCanvasSettings({
                      backgroundImageSrc: undefined,
                      backgroundImageThumbnailSrc: undefined,
                      backgroundImageAssetId: undefined,
                    })}>{text("Clear", "解除", "清除", "지우기")}</button>
                  )}
                </div>
                <label>
                  <span>{text("Image fitting", "背景画像の表示", "背景图适应", "배경 맞춤")}</span>
                  <select
                    value={canvasSettings.backgroundFit}
                    onChange={(event) => updateCanvasSettings({ backgroundFit: event.target.value as CanvasSettings["backgroundFit"] })}
                  >
                    <option value="cover">Cover</option>
                    <option value="contain">Contain</option>
                    <option value="tile">Tile</option>
                  </select>
                </label>
                <label className="settings-switch-row">
                  <span>{text("Show grid", "グリッドを表示", "显示网格", "그리드 표시")}</span>
                  <input type="checkbox" checked={canvasSettings.gridVisible} onChange={(event) =>
                    updateCanvasSettings({ gridVisible: event.target.checked })
                  } />
                </label>
                <label className="settings-switch-row">
                  <span>{text("Snap to grid", "グリッドにスナップ", "吸附到网格", "그리드에 스냅")}</span>
                  <input type="checkbox" checked={canvasSettings.snapEnabled} onChange={(event) =>
                    updateCanvasSettings({ snapEnabled: event.target.checked })
                  } />
                </label>
                <label>
                  <span>{text("Grid spacing", "グリッド間隔", "网格间距", "그리드 간격")} <b>{canvasSettings.gridSize}px</b></span>
                  <input type="range" min="10" max="120" step="5" value={canvasSettings.gridSize} onChange={(event) =>
                    updateCanvasSettings({ gridSize: Number(event.target.value) })
                  } />
                </label>
              </fieldset>

              <fieldset hidden={settingsCategory !== 3}>
                <legend>{text("Current saved list", "現在の保存リスト", "当前保存列表", "현재 저장 목록")}</legend>
                <label>
                  <span>{text("List group", "リストのグループ", "列表分组", "목록 그룹")}</span>
                  <input
                    value={activeBoard.groupName || ""}
                    placeholder={text("None", "なし", "无", "없음")}
                    onFocus={() => { groupSnapshotRecordedRef.current = false; }}
                    onChange={(event) => {
                      if (!groupSnapshotRecordedRef.current) {
                        recordUndoSnapshot();
                        groupSnapshotRecordedRef.current = true;
                      }
                      const groupName = event.target.value;
                      if (activeWorkspace && groupName.trim() !== activeWorkspace) setWorkspaceFilter(null);
                      updateActiveBoard((board) => ({ ...board, groupName }));
                    }}
                  />
                </label>
              </fieldset>

              <fieldset hidden={settingsCategory !== 4}>
                <legend>{text("Saving", "保存", "保存", "저장")}</legend>
                <label className="settings-switch-row">
                  <span>{text("Automatic save", "自動保存", "自动保存", "자동 저장")}</span>
                  <input type="checkbox" checked={settings.autoSaveEnabled} onChange={(event) =>
                    setSettings((current) => ({ ...current, autoSaveEnabled: event.target.checked }))
                  } />
                </label>
                <label>
                  <span>{text("Save delay", "保存までの間隔", "保存延迟", "저장 지연")} <b>{(settings.autoSaveDelayMs / 1000).toFixed(1)}s</b></span>
                  <input type="range" min="300" max="10000" step="100" value={settings.autoSaveDelayMs} onChange={(event) =>
                    setSettings((current) => ({ ...current, autoSaveDelayMs: Number(event.target.value) }))
                  } />
                </label>
              </fieldset>

              <fieldset hidden={settingsCategory !== 5}>
                <legend>{text("Project and help", "プロジェクトとヘルプ", "项目和帮助", "프로젝트 및 도움말")}</legend>
                <div className="settings-project-actions">
                  <button disabled={!projectFilesAvailable} onClick={() => void openProjectFromSettings()}>{text("Open project", "プロジェクトを開く", "打开项目", "프로젝트 열기")}</button>
                  <button disabled={!projectFilesAvailable} onClick={() => void choosePinterestBoardFile()}>{text("Import board file", "ボードファイルを読み込む", "导入看板文件", "보드 파일 가져오기")}</button>
                  <button disabled={!projectFilesAvailable} onClick={() => window.dispatchEvent(new CustomEvent("museboard:save-request"))}>{text("Save project", "プロジェクトを保存", "保存项目", "프로젝트 저장")}</button>
                  <button onClick={() => { setShowSettings(false); setShowShortcuts(true); }}>{text("Shortcut list", "ショートカット一覧", "快捷键列表", "단축키 목록")}</button>
                </div>
              </fieldset>
              <div hidden={settingsCategory !== 6}>
                <StorageSettings boards={boards} activeId={activeId} text={text} onBusyChange={setStorageBusy}
                  getSnapshot={() => ({
                    format: "museboard", version: 2, savedAt: new Date().toISOString(), activeId: activeIdRef.current,
                    boards: applyNoteSettings(applyCanvasSettings(boardsRef.current, settingsRef.current.canvas ?? DEFAULT_CANVAS_SETTINGS), settingsRef.current),
                  })} />
              </div>
            </div>
            </div>

            <footer>
              <button className="settings-reset" onClick={resetSettings}>{text("Reset all settings", "すべての設定を初期化", "重置所有设置", "모든 설정 초기화")}</button>
              <button className="settings-done" onClick={closeSettingsPage}>{text("Done", "完了", "完成", "완료")}</button>
            </footer>
          </section>
      )}

      {boardFileImport && <PinterestBoardImport data={boardFileImport} onClose={() => setBoardFileImport(null)} onCommit={commitPinterestBoardFile} />}
      {showBoardGrouping && (
        <div
          className="board-grouping-backdrop"
          onPointerDown={() => setShowBoardGrouping(false)}
        >
          <section
            className="board-grouping-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={text("Group saved lists", "保存リストをまとめる", "整理保存列表", "저장 목록 묶기")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>IMAGESTORAGE</small>
                <h2>{text("Group saved lists", "保存リストをまとめる", "整理保存列表", "저장 목록 묶기")}</h2>
              </div>
              <button onClick={() => setShowBoardGrouping(false)} aria-label={text("Close", "閉じる", "关闭", "닫기")}>×</button>
            </header>
            <div className="board-grouping-content">
              <label className="board-group-name-field">
                <span>{text("Group name", "グループ名", "分组名称", "그룹 이름")}</span>
                <input
                  autoFocus
                  value={boardGroupNameDraft}
                  onChange={(event) => setBoardGroupNameDraft(event.target.value)}
                  placeholder={text("e.g. Character studies", "例：キャラクター資料", "例如：角色资料", "예: 캐릭터 자료")}
                />
              </label>
              {boardGroups.length > 0 && (
                <div className="board-group-existing">
                  <span>{text("Existing groups", "既存のグループ", "现有分组", "기존 그룹")}</span>
                  <div>
                    {boardGroups.map((groupName) => (
                      <button
                        key={groupName}
                        className={boardGroupNameDraft.trim() === groupName ? "active" : ""}
                        onClick={() => {
                          setBoardGroupNameDraft(groupName);
                          setBoardGroupSelection(
                            boards
                              .filter((board) => board.groupName?.trim() === groupName)
                              .map((board) => board.id),
                          );
                        }}
                      >
                        {groupName}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="board-group-selection-header">
                <span>{text("Lists to include", "まとめるリスト", "包含的列表", "포함할 목록")}</span>
                <small>{text(`${boardGroupSelection.length} selected`, `${boardGroupSelection.length}個を選択中`, `已选择 ${boardGroupSelection.length} 项`, `${boardGroupSelection.length}개 선택됨`)}</small>
              </div>
              <div className="board-group-selection-list">
                {boards.map((board) => {
                  const checked = boardGroupSelection.includes(board.id);
                  return (
                    <label key={board.id} className={checked ? "selected" : ""}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleBoardGroupSelection(board.id)}
                      />
                      <MiniPreview board={board} />
                      <span>{board.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <footer>
              <button
                className="board-group-remove"
                onClick={removeSelectedBoardsFromGroup}
                disabled={!boardGroupSelection.length}
              >
                {text("Remove from group", "グループから外す", "从分组中移除", "그룹에서 빼기")}
              </button>
              <button
                className="board-group-apply"
                onClick={applyBoardGrouping}
                disabled={!boardGroupNameDraft.trim() || boardGroupSelection.length < 2}
              >
                {text("Group lists", "まとめる", "整理列表", "목록 묶기")}
              </button>
            </footer>
          </section>
        </div>
      )}

      {showLibrary && (
        <div className="library-backdrop" onPointerDown={() => setShowLibrary(false)}>
          <section
            className="library-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={text("Search and organize", "検索・整理", "搜索和整理", "검색·정리")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>IMAGESTORAGE</small>
                <h2>{text("Search and organize", "検索・整理", "搜索和整理", "검색·정리")}</h2>
              </div>
              <button onClick={() => setShowLibrary(false)} aria-label={text("Close", "閉じる", "关闭", "닫기")}>×</button>
            </header>
            <nav className="library-categories" aria-label={text("Library categories", "ライブラリのカテゴリ", "资料库类别", "라이브러리 카테고리")}>
              <button className={libraryFilter === "all" ? "active" : ""} aria-pressed={libraryFilter === "all"} onClick={() => setLibraryFilter("all")}><UiIcon name="image" /><span>{text("All images", "すべての画像", "全部图片", "모든 이미지")}</span></button>
              <button className={libraryFilter === "favorite" ? "active" : ""} aria-pressed={libraryFilter === "favorite"} onClick={() => setLibraryFilter("favorite")}><UiIcon name="favorite" /><span>{text("Favorites", "お気に入り", "收藏", "즐겨찾기")}</span></button>
            </nav>
            <div className="library-content">
            <div className="library-search-area">
              <input
                className="library-search-input"
                autoFocus
                value={libraryQuery}
                onChange={(event) => setLibraryQuery(event.target.value)}
                placeholder={text("Search name, tag, creator, source, or note", "名前・タグ・作者・出典・メモを検索", "搜索名称、标签、作者、来源或备注", "이름, 태그, 작가, 출처, 메모 검색")}
              />
              {libraryTags.length > 0 && (
                <div className="library-tag-row">
                  <button className={libraryTag === null ? "active" : ""} onClick={() => setLibraryTag(null)}>{text("All tags", "全タグ", "全部标签", "모든 태그")}</button>
                  {libraryTags.map((tag) => (
                    <button key={tag} className={libraryTag === tag ? "active" : ""} onClick={() => setLibraryTag((current) => current === tag ? null : tag)}>#{tag}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="library-results" aria-live="polite">
              <p>{text(`${libraryImages.length} references`, `${libraryImages.length}件の資料`, `${libraryImages.length} 个参考`, `자료 ${libraryImages.length}개`)}</p>
              {libraryImages.map(({ board, item }) => (
                <button
                  key={`${board.id}-${item.id}`}
                  className="library-result"
                  onClick={() => focusLibraryImage(board.id, item.id)}
                >
                  <span className="library-result-image">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.thumbnailSrc || item.src} alt="" loading="lazy" />
                  </span>
                  <span className="library-result-copy">
                    <strong>{item.caption || text("Untitled image", "名称未設定の画像", "未命名图像", "이름 없는 이미지")}</strong>
                    <small>{board.name}{item.creator ? ` · ${item.creator}` : ""}</small>
                    {(item.tags?.length || item.favorite) && <span className="library-result-tags">
                      {item.favorite && <i>★</i>}
                      {item.tags?.slice(0, 4).map((tag) => <em key={tag}>#{tag}</em>)}
                    </span>}
                  </span>
                </button>
              ))}
              {!libraryImages.length && <div className="library-empty">{text("No references found", "一致する資料がありません", "没有找到参考", "일치하는 자료가 없습니다")}</div>}
            </div>
            </div>
          </section>
        </div>
      )}

      {imageInfoDraft && (
        <div className="image-info-backdrop" onPointerDown={() => setImageInfoDraft(null)}>
          <section
            className="image-info-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={text("Image details", "画像の詳細", "图像详情", "이미지 세부 정보")}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <small>REFERENCE</small>
                <h2>{imageInfoItem?.caption || text("Image details", "画像の詳細", "图像详情", "이미지 세부 정보")}</h2>
              </div>
              <button onClick={() => setImageInfoDraft(null)} aria-label={text("Close", "閉じる", "关闭", "닫기")}>×</button>
            </header>
            <div className="image-info-content">
              {imageInfoItem?.src && <div className="image-info-preview">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={imageInfoItem.thumbnailSrc || imageInfoItem.src} alt="" />
              </div>}
              <div className="image-info-fields">
                <label>
                  <span>{text("Tags", "タグ", "标签", "태그")}</span>
                  <input value={imageInfoDraft.tagsText} onChange={(event) => setImageInfoDraft((current) => current ? { ...current, tagsText: event.target.value } : current)} placeholder={text("e.g. character, blue, profile", "例：人物、青、横顔", "例如：角色、蓝色、侧脸", "예: 인물, 파랑, 옆모습")} />
                </label>
                <label>
                  <span>{text("Creator", "作者", "作者", "작가")}</span>
                  <input value={imageInfoDraft.creator} onChange={(event) => setImageInfoDraft((current) => current ? { ...current, creator: event.target.value } : current)} />
                </label>
                <label>
                  <span>{text("Source URL", "出典URL", "来源 URL", "출처 URL")}</span>
                  <input type="url" value={imageInfoDraft.sourceUrl} onChange={(event) => setImageInfoDraft((current) => current ? { ...current, sourceUrl: event.target.value } : current)} placeholder="https://" />
                </label>
                <label>
                  <span>{text("Memo", "メモ", "备注", "메모")}</span>
                  <textarea value={imageInfoDraft.referenceNote} onChange={(event) => setImageInfoDraft((current) => current ? { ...current, referenceNote: event.target.value } : current)} />
                </label>
                <div className="image-info-flags">
                  <label><input type="checkbox" checked={imageInfoDraft.favorite} onChange={(event) => setImageInfoDraft((current) => current ? { ...current, favorite: event.target.checked } : current)} />★ {text("Favorite", "お気に入り", "收藏", "즐겨찾기")}</label>
                </div>
              </div>
            </div>
            <footer>
              <button onClick={() => setImageInfoDraft(null)}>{text("Cancel", "キャンセル", "取消", "취소")}</button>
              <button className="image-info-save" onClick={saveImageInfo}>{text("Save", "保存", "保存", "저장")}</button>
            </footer>
          </section>
        </div>
      )}

      {showListManager && (
        <div className="list-manager-backdrop" inert={Boolean(pendingDeleteBoardId || headerImageDraft)} aria-hidden={pendingDeleteBoardId || headerImageDraft ? true : undefined} onPointerDown={closeListManager}>
          <form className="list-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="list-manager-title" aria-describedby="list-manager-description" onPointerDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); saveListManager(); }}>
            <header>
              <h2 id="list-manager-title">{text("Manage lists", "リストを管理", "管理列表", "목록 관리")}</h2>
              <button type="button" className="list-manager-close" onClick={closeListManager} aria-label={text("Close", "閉じる", "关闭", "닫기")}><UiIcon name="close" /></button>
            </header>
            <p id="list-manager-description">{text("Manage names, header images, groups and order. All changes take effect when you save.", "名前・ヘッダー画像・グループ・並び順をまとめて管理できます。変更は「保存」で反映されます。", "统一管理名称、标题图片、分组及顺序。所有更改将在保存后应用。", "이름, 헤더 이미지, 그룹, 순서를 한곳에서 관리합니다. 모든 변경은 저장할 때 반영됩니다.")}</p>
            <div className="list-manager-toolbar">
              <span>{text(`${listManagerDraft.length} lists`, `${listManagerDraft.length}件のリスト`, `${listManagerDraft.length}个列表`, `목록 ${listManagerDraft.length}개`)}</span>
              <button type="button" className="list-manager-add" onClick={addListManagerBoard}><UiIcon name="plus" />{text("New list", "新しいリスト", "新建列表", "새 목록")}</button>
            </div>
            {headerImageError && <p className="list-manager-error" role="alert">{headerImageError}</p>}
            <datalist id="list-manager-groups">
              {Array.from(new Set(listManagerDraft.map((board) => board.groupName?.trim()).filter(Boolean))).map((group) => <option key={group} value={group} />)}
            </datalist>
            <div className={`list-manager-content${listManagerDraggedId ? " is-reordering" : ""}`} ref={listManagerContentRef}
              onDragStartCapture={(event) => event.preventDefault()}
              onPointerDownCapture={() => { if (!listManagerPointerDragRef.current?.active) listManagerPreviewDragRef.current = null; }}
              onClickCapture={(event) => {
                if (event.detail > 0 && listManagerPreviewDragRef.current) { event.preventDefault(); event.stopPropagation(); }
              }}>
              {listManagerDraft.map((entry, index) => (
                <div
                  className={`list-manager-row${entry.id === activeId ? " is-current" : ""}${entry.id === listManagerDraggedId ? " is-dragging" : ""}${listManagerDropTarget?.boardId === entry.id ? ` drop-${listManagerDropTarget.edge}` : ""}`}
                  key={entry.id} data-board-id={entry.id} draggable={false}
                  onPointerDownCapture={(event) => prepareListManagerDrag(event, entry.id)}
                >
                  <div className="list-manager-preview">
                    <button type="button" className="list-manager-preview-button" draggable={false} onClick={(event) => openListManagerPreview(event, entry)} title={text("Click to adjust image; drag to reorder", "クリックで画像を調整・ドラッグで並び替え", "点击调整图片，拖动排序", "클릭하여 이미지 조정, 드래그하여 순서 변경")} aria-label={`${text("Set or adjust the list image", "リスト画像を設定・調整", "设置或调整列表图片", "목록 이미지 설정 및 조정")}: ${entry.name}`}>
                      <MiniPreview board={{ ...entry, items: boards.find((board) => board.id === entry.id)?.items ?? entry.items }} />
                      <span className="list-manager-preview-edit"><UiIcon name="image" /></span>
                    </button>
                    <span>{entry.headerImageSrc ? text("Header image", "ヘッダー画像", "标题图片", "헤더 이미지") : text("Automatic preview", "画像一覧のプレビュー", "自动预览", "자동 미리보기")}</span>
                  </div>
                  <div className="list-manager-row-body">
                    <div className="list-manager-row-summary">
                      <span className="list-manager-drag-grip" title={text("Drag to reorder", "ドラッグして並び替え", "拖动以排序", "드래그하여 순서 변경")}><UiIcon name="menu" /></span>
                      <span>{index + 1}<span aria-hidden="true"> · </span>{text(`${entry.items.length} items`, `${entry.items.length}件のアイテム`, `${entry.items.length}个项目`, `항목 ${entry.items.length}개`)}</span>
                      {entry.id === activeId && <span className="list-manager-badge">{text("Current", "表示中", "当前", "현재")}</span>}
                      {!boards.some((board) => board.id === entry.id) && <span className="list-manager-badge">{text("New", "新規", "新建", "신규")}</span>}
                    </div>
                    <div className="list-manager-fields">
                      <label>
                        <span>{text("List name", "リスト名", "列表名称", "목록 이름")}</span>
                        <input className="list-manager-name" aria-label={`${text("List name", "リスト名", "列表名称", "목록 이름")} ${index + 1}`} value={entry.name} placeholder={text("Untitled list", "名称未設定", "未命名列表", "이름 없는 목록")} onChange={(event) => {
                          const name = event.target.value;
                          setListManagerDraft((current) => current.map((draft) => draft.id === entry.id ? { ...draft, name } : draft));
                        }} />
                      </label>
                      <label>
                        <span>{text("Group", "グループ", "分组", "그룹")}</span>
                        <input className="list-manager-group" list="list-manager-groups" aria-label={`${text("Group", "グループ", "分组", "그룹")} ${index + 1}`} value={entry.groupName ?? ""} placeholder={text("No group", "グループなし", "无分组", "그룹 없음")} onChange={(event) => {
                          const groupName = event.target.value;
                          setListManagerDraft((current) => current.map((draft) => draft.id === entry.id ? { ...draft, groupName } : draft));
                        }} />
                      </label>
                    </div>
                    <div className="list-manager-image-actions">
                      <button type="button" onClick={() => void chooseHeaderImage(entry.id, listManagerSessionRef.current)}><UiIcon name="image" />{text("Choose image", "画像を選ぶ", "选择图片", "이미지 선택")}</button>
                      <button type="button" disabled={!entry.headerImageSrc} onClick={() => openHeaderImageEditor(entry, listManagerSessionRef.current)}><UiIcon name="fit" />{text("Adjust", "位置を調整", "调整", "위치 조정")}</button>
                      <button type="button" disabled={!entry.headerImageSrc} onClick={() => setListManagerDraft((current) => current.map((draft) => draft.id === entry.id ? clearListHeader(draft) : draft))}>{text("Use automatic preview", "画像一覧に戻す", "恢复自动预览", "자동 미리보기로 복원")}</button>
                    </div>
                  </div>
                  <div className="list-manager-row-actions">
                    <button type="button" disabled={index === 0} onClick={() => moveListManagerBoard(entry.id, -1)} title={text("Move up", "上に移動", "上移", "위로 이동")} aria-label={`${text("Move up", "上に移動", "上移", "위로 이동")}: ${entry.name}`}><UiIcon name="chevronDown" style={{ transform: "rotate(180deg)" }} /></button>
                    <button type="button" disabled={index === listManagerDraft.length - 1} onClick={() => moveListManagerBoard(entry.id, 1)} title={text("Move down", "下に移動", "下移", "아래로 이동")} aria-label={`${text("Move down", "下に移動", "下移", "아래로 이동")}: ${entry.name}`}><UiIcon name="chevronDown" /></button>
                    <button type="button" className="list-manager-delete" onClick={() => setPendingDeleteBoardId(entry.id)} title={text("Delete list", "リストを削除", "删除列表", "목록 삭제")} aria-label={`${text("Delete", "削除", "删除", "삭제")}: ${entry.name}`}><UiIcon name="trash" /></button>
                  </div>
                </div>
              ))}
              {!listManagerDraft.length && <p className="list-manager-empty">{text("Saving will create one empty list.", "保存すると、新しい空のリストが1つ作成されます。", "保存时将创建一个空列表。", "저장하면 새 빈 목록 하나가 만들어집니다.")}</p>}
            </div>
            <footer>
              <button type="button" className="list-manager-cancel" onClick={closeListManager}>{text("Cancel", "キャンセル", "取消", "취소")}</button>
              <button type="submit" className="list-manager-save">{text("Save", "保存", "保存", "저장")}</button>
            </footer>
          </form>
        </div>
      )}

      {pendingDeleteBoard && (
        <div
          className="confirmation-backdrop"
          onPointerDown={() => setPendingDeleteBoardId(null)}
        >
          <div
            className="confirmation-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-board-title"
            aria-describedby="delete-board-description"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <strong id="delete-board-title">
              {text("Delete this saved list?", "この保存リストを削除しますか？", "删除此保存列表？", "이 저장 목록을 삭제할까요?")}
            </strong>
            <p id="delete-board-description">
              {text(
                `Images and notes in “${pendingDeleteBoard.name}” will be removed.`,
                `「${pendingDeleteBoard.name}」にある画像と付箋が削除されます。`,
                `“${pendingDeleteBoard.name}”中的图片和便笺将被删除。`,
                `“${pendingDeleteBoard.name}”의 이미지와 메모가 삭제됩니다.`,
              )}
            </p>
            {showListManager && <p>{text("The deletion will be applied when you save the list manager.", "削除はリスト管理画面で「保存」したときに反映されます。", "在列表管理中保存后才会执行删除。", "목록 관리에서 저장할 때 삭제됩니다.")}</p>}
            <div>
              <button onClick={() => setPendingDeleteBoardId(null)}>
                {text("Cancel", "キャンセル", "取消", "취소")}
              </button>
              <button
                className="danger"
                onClick={() => confirmBoardDeletion(pendingDeleteBoard.id)}
              >
                {text("Delete", "削除する", "删除", "삭제")}
              </button>
            </div>
          </div>
        </div>
      )}

      <section className="workspace" hidden={showSettings} tabIndex={-1} inert={canvasShortcutsBlocked && !showShortcuts}>
        <div
          ref={canvasRef}
          className={`canvas ${isDraggingFiles ? "drag-over" : ""} ${
            activeBoard.gridVisible ? "is-grid-visible" : ""
          }`}
          style={
            {
              "--grid-scale": `${(activeBoard.gridSize || 40) * activeBoard.viewport.scale}px`,
              "--grid-x": `calc(${activeBoard.viewport.x}px + var(--canvas-sidebar-offset, 0px))`,
              "--grid-y": `${activeBoard.viewport.y}px`,
            } as CSSProperties
          }
          onPointerDown={startCanvasAction}
          onWheel={handleWheel}
          onDoubleClick={(event) => {
            if (event.currentTarget !== event.target) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const sidebarOffset = getCanvasSidebarOffset();
            addSticky(
              (event.clientX -
                rect.left -
                activeBoard.viewport.x -
                sidebarOffset) /
                activeBoard.viewport.scale -
                125,
              (event.clientY - rect.top - activeBoard.viewport.y) /
                activeBoard.viewport.scale -
                86,
            );
          }}
          onDragEnter={(event) => {
            if (!dragCarriesAssets(event)) return;
            if (getImageDropEffect(event.dataTransfer) === "none") return;
            event.preventDefault();
            setIsDraggingFiles(true);
          }}
          onDragOver={(event) => {
            if (!dragCarriesAssets(event)) return;
            const effect = getImageDropEffect(event.dataTransfer);
            event.dataTransfer.dropEffect = effect;
            if (effect === "none") {
              setIsDraggingFiles(false);
              return;
            }
            event.preventDefault();
          }}
          onDragLeave={(event) => {
            if (event.currentTarget === event.target) setIsDraggingFiles(false);
          }}
          onDrop={handleDrop}
        >
          <div
            className="canvas-background-layer"
            style={{
              backgroundColor: activeBoard.backgroundColor || "#171717",
              backgroundImage: activeBoard.backgroundImageSrc
                ? `url("${activeBoard.backgroundImageSrc.replaceAll('"', "%22")}")`
                : undefined,
              backgroundRepeat: activeBoard.backgroundFit === "tile" ? "repeat" : "no-repeat",
              backgroundSize:
                activeBoard.backgroundFit === "tile"
                  ? "auto"
                  : activeBoard.backgroundFit || "cover",
              backgroundPosition: "center",
            }}
            aria-hidden="true"
          />
          <div className="canvas-grid-layer" aria-hidden="true" />

          <div className="selection-tools">
            {selectedIds.length > 1 && (
              <button className="create-frame-button" onClick={createFrameFromSelection}>
                {text("Create frame", "まとめ枠を作成", "创建分组框", "그룹 프레임 만들기")}
              </button>
            )}
            {selectedImageItems.length > 1 && (
              <div className="image-arrange-control">
                <button
                  className="image-tool-button image-arrange-button"
                  onClick={() => setShowArrangeMenu((current) => !current)}
                  aria-expanded={showArrangeMenu}
                  title={text("Arrange selected images", "選択画像を整列", "排列所选图像", "선택 이미지 정렬")}
                >
                  {text("Arrange", "整列", "排列", "정렬")}
                </button>
                {showArrangeMenu && (
                  <div className="image-arrange-menu">
                    <button onClick={() => arrangeSelectedImages("grid")}>{text("Grid", "グリッド", "网格", "그리드")}</button>
                    <button onClick={() => arrangeSelectedImages("row")}>{text("Row", "横並び", "横向排列", "가로")}</button>
                    <button onClick={() => arrangeSelectedImages("column")}>{text("Column", "縦並び", "纵向排列", "세로")}</button>
                  </div>
                )}
              </div>
            )}
            {selectedItem?.type === "image" &&
              paletteSuppressedItemId !== selectedItem.id && (
              <div
                className="image-selection-toolbar"
                role="group"
                aria-label={text("Selected image tools", "選択画像のツール", "所选图像工具", "선택 이미지 도구")}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div
                  className="image-palette"
                  role="group"
                  aria-label={text("Image color palette", "画像のカラーパレット", "图像调色板", "이미지 색상 팔레트")}
                  aria-busy={paletteLoadingId === selectedItem.id}
                >
                  <span
                    className="palette-label"
                    title={paletteLoadingId === selectedItem.id
                      ? text("Extracting colors…", "カラーを抽出中…", "正在提取颜色…", "색상 추출 중…")
                      : text("Color palette", "カラーパレット", "调色板", "색상 팔레트")}
                  >
                    <UiIcon name="palette" />
                  </span>
                  <div className="palette-swatches">
                    {paletteLoadingId === selectedItem.id &&
                    !selectedItem.palette?.length
                      ? Array.from({ length: 6 }, (_, index) => (
                          <i key={index} className="palette-loading-swatch" />
                        ))
                      : selectedItem.palette?.map((color) => (
                          <button
                            key={color}
                            type="button"
                            className={copiedColor === color ? "copied" : ""}
                            style={{ backgroundColor: color }}
                            onClick={() => void copyPaletteColor(color)}
                            aria-label={text(`Copy ${color}`, `${color} をコピー`, `复制 ${color}`, `${color} 복사`)}
                            data-tooltip={copiedColor === color
                              ? text("Copied", "コピーしました", "已复制", "복사됨")
                              : color.toUpperCase()}
                          >
                            {copiedColor === color && <UiIcon name="check" />}
                          </button>
                        ))}
                  </div>
                </div>
                <span className="image-toolbar-divider" aria-hidden="true" />
                <div className="image-quick-tools" role="group" aria-label={text("Image actions", "画像の操作", "图像操作", "이미지 작업")}>
                  <button
                    type="button"
                    className="image-tool-button"
                    onClick={() => openImageInfo(selectedItem)}
                    aria-label={text("Image details", "画像の詳細", "图像详情", "이미지 세부 정보")}
                    data-tooltip={text("Image details", "画像の詳細", "图像详情", "이미지 세부 정보")}
                  >
                    <UiIcon name="info" />
                  </button>
                  <button
                    type="button"
                    className={`image-tool-button image-favorite-button ${selectedItem.favorite ? "active" : ""}`}
                    onClick={() => updateImageProperties(selectedItem.id, { favorite: !selectedItem.favorite })}
                    aria-label={text("Favorite", "お気に入り", "收藏", "즐겨찾기")}
                    data-tooltip={text("Favorite", "お気に入り", "收藏", "즐겨찾기")}
                    aria-pressed={Boolean(selectedItem.favorite)}
                  >
                    <UiIcon name="favorite" />
                  </button>
                  <span className="image-tool-separator" aria-hidden="true" />
                  <button
                    type="button"
                    className={`image-tool-button ${selectedItem.flipHorizontal ? "active" : ""}`}
                    onClick={() => updateImageProperties(selectedItem.id, { flipHorizontal: !selectedItem.flipHorizontal })}
                    aria-label={text("Flip horizontally", "左右反転", "水平翻转", "좌우 반전")}
                    data-tooltip={text("Flip horizontally", "左右反転", "水平翻转", "좌우 반전")}
                    aria-pressed={Boolean(selectedItem.flipHorizontal)}
                  >
                    <UiIcon name="flipHorizontal" />
                  </button>
                  <button
                    type="button"
                    className={`image-tool-button ${selectedItem.grayscale ? "active" : ""}`}
                    onClick={() => updateImageProperties(selectedItem.id, { grayscale: !selectedItem.grayscale })}
                    aria-label={text("Grayscale", "グレースケール", "灰度", "흑백")}
                    data-tooltip={text("Grayscale", "グレースケール", "灰度", "흑백")}
                    aria-pressed={Boolean(selectedItem.grayscale)}
                  >
                    <UiIcon name="grayscale" />
                  </button>
                </div>
              </div>
            )}
          </div>

          <div
            ref={canvasWorldRef}
            className="canvas-world"
            data-viewport-scale={activeBoard.viewport.scale}
            style={{
              transform: `translate(calc(${activeBoard.viewport.x}px + var(--canvas-sidebar-offset, 0px)), ${activeBoard.viewport.y}px)`,
            }}
          >
            {(activeBoard.frames || []).map((frame) => {
              const viewportScale = activeBoard.viewport.scale;
              return (
                <section
                  key={frame.id}
                  className="canvas-frame"
                  style={{
                    left: frame.x * viewportScale,
                    top: frame.y * viewportScale,
                    width: frame.w * viewportScale,
                    height: frame.h * viewportScale,
                    "--frame-grid-x": `${-frame.x * viewportScale}px`,
                    "--frame-grid-y": `${-frame.y * viewportScale}px`,
                  } as CSSProperties}
                >
                  <div
                    className="canvas-frame-drag-surface"
                    onPointerDown={(event) => startFrameAction(event, frame)}
                    aria-label={text(
                      "Drag group",
                      "グループを移動",
                      "移动分组",
                      "그룹 이동",
                    )}
                  />
                  <div
                    className="canvas-frame-header"
                    onPointerDown={(event) => startFrameAction(event, frame)}
                  >
                    <input
                      value={frame.name}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        updateActiveBoard((board) => ({
                          ...board,
                          frames: (board.frames || []).map((entry) =>
                            entry.id === frame.id ? { ...entry, name: event.target.value } : entry,
                          ),
                        }))
                      }
                      aria-label={text("Frame name", "枠の名前", "分组框名称", "프레임 이름")}
                    />
                    <button
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => removeFrame(frame.id)}
                      aria-label={text("Remove frame", "枠を削除", "删除分组框", "프레임 삭제")}
                    >
                      ×
                    </button>
                  </div>
                </section>
              );
            })}
            {contentBounds && (
              <div
                className="content-bounds-guide"
                style={{
                  left: contentBounds.x * activeBoard.viewport.scale,
                  top: contentBounds.y * activeBoard.viewport.scale,
                  width: contentBounds.width * activeBoard.viewport.scale,
                  height: contentBounds.height * activeBoard.viewport.scale,
                  "--content-grid-x": `${-contentBounds.x * activeBoard.viewport.scale}px`,
                  "--content-grid-y": `${-contentBounds.y * activeBoard.viewport.scale}px`,
                } as CSSProperties}
                aria-hidden="true"
              />
            )}
            {activeBoard.items.map((item) => {
              const viewportScale = activeBoard.viewport.scale;
              const rotation = normalizeRotation(item.rotation);
              return (
                <article
                key={item.id}
                data-item-id={item.id}
                className={`canvas-item ${item.type} ${
                  selectedIdSet.has(item.id) ? "selected" : ""
                } ${item.processing ? "processing" : ""}`}
                style={{
                  left: item.x * viewportScale,
                  top: item.y * viewportScale,
                  width: item.w * viewportScale,
                  height: item.h * viewportScale,
                  zIndex: item.z,
                  transform:
                    item.type === "note" && rotation !== 0
                      ? `rotate(${rotation}deg)`
                      : undefined,
                  ...(item.type === "note" ? {
                    "--note-scale": viewportScale,
                  } : {}),
                } as CSSProperties}
                onPointerDown={
                  item.type === "image"
                    ? (event) => startItemAction(event, item, "drag")
                    : undefined
                }
                onDoubleClick={
                  item.type === "image"
                    ? (event) => {
                        event.stopPropagation();
                        openImageAnalysis(item);
                      }
                    : undefined
                }
                onContextMenu={(event) => openItemContextMenu(event, item)}
              >
                {item.type === "image" ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.src}
                      alt={item.caption || "Reference"}
                      draggable={false}
                      loading="lazy"
                      decoding="async"
                      style={getImageMediaStyle(item, viewportScale)}
                    />
                    {item.analysis && (
                      <svg
                        className="canvas-image-analysis"
                        viewBox="0 0 1000 1000"
                        preserveAspectRatio="none"
                        style={getImageMediaStyle(item, viewportScale, false)}
                        aria-hidden="true"
                      >
                        <AnalysisMarks analysis={item.analysis} />
                      </svg>
                    )}
                    <span className="image-caption">{item.caption}</span>
                  </>
                ) : (
                  <>
                    <div
                      className="note-drag-handle"
                      onPointerDown={(event) => startItemAction(event, item, "drag")}
                    >
                      <span />
                      <span />
                      <span />
                    </div>
                    <textarea
                      data-note-id={item.id}
                      data-canvas-scale={viewportScale}
                      value={item.text}
                      style={{
                        padding: `${23 * viewportScale}px ${16 * viewportScale}px ${15 * viewportScale}px`,
                        fontFamily: settings.noteFont,
                        fontSize: `${settings.noteFontSize * viewportScale}px`,
                      }}
                      onFocus={() => {
                        recordUndoSnapshot();
                        setSelectedIds([item.id]);
                      }}
                      onPointerDown={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        updateNoteText(
                          item.id,
                          event.target.value,
                          event.currentTarget,
                        )
                      }
                      aria-label={text("Sticky note", "付箋", "便笺", "메모")}
                      spellCheck={false}
                    />
                  </>
                )}

                {item.id === selectedId && (
                  <>
                    {(item.type === "image"
                      ? imageResizeHandles
                      : (["se"] as ResizeHandle[])
                    ).map((handle) => (
                      <span
                        key={handle}
                        className={`resize-handle resize-${handle}`}
                        onPointerDown={(event) =>
                          startItemAction(event, item, "resize", handle)
                        }
                        aria-hidden="true"
                      />
                    ))}
                  </>
                )}
                </article>
              );
            })}
          </div>

          {selectionMarquee && (
            <div
              className="selection-marquee"
              style={selectionMarquee}
              aria-hidden="true"
            />
          )}

          {itemContextMenu && (
            <div
              className="item-context-menu"
              style={{ left: itemContextMenu.x, top: itemContextMenu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              role="menu"
            >
              <button
                className="danger"
                onClick={() => deleteItem(itemContextMenu.itemId)}
                role="menuitem"
              >
                <span>{text("Delete", "削除", "删除", "삭제")}</span>
              </button>
              <div className="context-menu-separator" />
              <button
                onClick={() => duplicateItem(itemContextMenu.itemId)}
                role="menuitem"
              >
                <span>{text("Duplicate", "複製", "复制", "복제")}</span>
              </button>
              {contextMenuItem?.type === "image" && (
                <>
                  <button
                    onClick={() => openImageAnalysis(contextMenuItem)}
                    role="menuitem"
                  >
                    <span>{text("Analyze composition", "構図を確認", "分析构图", "구도 분석")}</span>
                    <kbd>↗</kbd>
                  </button>
                  <button
                    onClick={() => rotateImage(itemContextMenu.itemId, -90)}
                    role="menuitem"
                  >
                    <span>{text("Rotate left", "左に回転", "向左旋转", "왼쪽 회전")}</span>
                  </button>
                  <button
                    onClick={() => rotateImage(itemContextMenu.itemId, 90)}
                    role="menuitem"
                  >
                    <span>{text("Rotate right", "右に回転", "向右旋转", "오른쪽 회전")}</span>
                  </button>
                </>
              )}
              <div className="context-menu-separator" />
              <button
                onClick={() =>
                  moveItemLayer(itemContextMenu.itemId, "front")
                }
                role="menuitem"
              >
                <span>{text("Bring to front", "最前面へ", "移到最前", "맨 앞으로")}</span>
              </button>
              <button
                onClick={() => moveItemLayer(itemContextMenu.itemId, "back")}
                role="menuitem"
              >
                <span>{text("Send to back", "最背面へ", "移到最后", "맨 뒤로")}</span>
              </button>
              {contextMenuItem?.type === "image" && (
                <>
                  <div className="context-menu-separator" />
                  <div className="context-palette">
                    <span>
                      {paletteLoadingId === contextMenuItem.id
                        ? text("Extracting colors…", "カラーを抽出中…", "正在提取颜色…", "색상 추출 중…")
                        : text("Color palette", "カラーパレット", "调色板", "색상 팔레트")}
                    </span>
                    <div>
                      {contextMenuItem.palette?.map((color) => (
                        <button
                          key={color}
                          type="button"
                          className={copiedColor === color ? "copied" : ""}
                          style={{ backgroundColor: color }}
                          onClick={() => void copyPaletteColor(color)}
                          aria-label={`Copy ${color}`}
                          title={`Copy ${color}`}
                        />
                      ))}
                    </div>
                  </div>
                </>
              )}
              <div className="context-menu-separator" />
              <button onClick={undoLastChange} role="menuitem">
                <span>{text("Undo", "元に戻す", "撤销", "실행 취소")}</span>
              </button>
              <button onClick={redoLastChange} role="menuitem">
                <span>{text("Redo", "やり直す", "重做", "다시実行")}</span>
              </button>
            </div>
          )}

          {activeBoard.items.length === 0 && (
            <div className="empty-state">
              <span className="empty-art">
                <i />
                <i />
                <i />
              </span>
              <strong>
                {text("Drop your references anywhere", "好きな場所に画像を追加", "将参考图放到任意位置", "원하는 곳에 참고 이미지 추가")}
              </strong>
              <p>
                {text(
                  "Drag images here, paste from the clipboard, or start with a note.",
                  "画像をドロップ、クリップボードから貼り付け、または付箋を追加できます。",
                  "将图片拖到这里、从剪贴板粘贴，或添加便笺。",
                  "이미지를 끌어오거나 클립보드에서 붙여넣고 메모를 추가하세요.",
                )}
              </p>
              <div>
                <button onClick={() => void chooseImageFiles()}>
                  {text("Choose images", "画像を選択", "选择图片", "이미지 선택")}
                </button>
                <button onClick={promptForImageUrl}>
                  {text("Paste URL", "URLを貼り付け", "粘贴 URL", "URL 붙여넣기")}
                </button>
                <button onClick={() => addSticky()}>
                  {text("Add a note", "付箋を追加", "添加便笺", "메모 추가")}
                </button>
              </div>
            </div>
          )}

          {isDraggingFiles && (
            <div className="drop-overlay">
              <span>＋</span>
              <strong>{text("Drop to place", "ここに追加", "放置到这里", "여기에 놓기")}</strong>
              <small>
                {text("Images stay in this board", "画像はこの保存リストに入ります", "图片将保存到此列表", "이미지가 이 목록에 저장됩니다")}
              </small>
            </div>
          )}

          <div className="canvas-hint">
            <span>SPACE</span> {text("drag to pan", "ドラッグで移動", "拖动平移", "드래그하여 이동")}
            <i />
            {text("Scroll to zoom", "スクロールで拡大縮小", "滚动缩放", "스크롤하여 확대/축소")}
            <i />
            {text("Double-click for note", "ダブルクリックで付箋", "双击添加便笺", "두 번 클릭하여 메모")}
          </div>

          <div className="item-count">
            {text(
              `${activeBoard.items.length} ${activeBoard.items.length === 1 ? "item" : "items"}`,
              `${activeBoard.items.length}件`,
              `${activeBoard.items.length} 项`,
              `${activeBoard.items.length}개`,
            )}
          </div>

          {importNotice && (
            <div className="import-notice" role="status">
              {importNotice}
            </div>
          )}

          {showShortcuts && (
            <div className="shortcuts-popover" role="dialog" aria-modal="true" aria-label={text("Keyboard shortcuts", "キーボード操作", "键盘快捷键", "키보드 단축키")}>
              <div>
                <strong>{text("Keyboard", "キーボード操作", "键盘快捷键", "키보드")}</strong>
                <button
                  onClick={() => setShowShortcuts(false)}
                  aria-label={text("Close", "閉じる", "关闭", "닫기")}
                >
                  ×
                </button>
              </div>
              <dl>
                <dt>{text("Pan canvas", "キャンバスを移動", "平移画布", "캔버스 이동")}</dt>
                <dd>Space + drag</dd>
                <dt>{text("Add note", "付箋を追加", "添加便笺", "메모 추가")}</dt>
                <dd>N</dd>
                <dt>{text("Delete item", "アイテムを削除", "删除项目", "항목 삭제")}</dt>
                <dd>⌫</dd>
                <dt>{text("Undo", "元に戻す", "撤销", "실행 취소")}</dt>
                <dd>Ctrl + Z</dd>
                <dt>{text("Duplicate item", "アイテムを複製", "复制项目", "항목 복제")}</dt>
                <dd>Ctrl + D</dd>
                <dt>{text("Rotate right / left", "右／左に回転", "向右／向左旋转", "오른쪽/왼쪽 회전")}</dt>
                <dd>R / Shift + R</dd>
                <dt>{text("Deselect", "選択を解除", "取消选择", "선택 해제")}</dt>
                <dd>Esc</dd>
                <dt>{text("Paste image", "画像を貼り付け", "粘贴图片", "이미지 붙여넣기")}</dt>
                <dd>⌘ / Ctrl + V</dd>
              </dl>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          multiple
          onChange={handleFileInput}
          aria-label="Choose reference images"
        />
      </section>
    </main>
  );
}
