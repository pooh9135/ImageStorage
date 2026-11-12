type MuseboardProjectData = {
  format: "museboard";
  version: number;
  savedAt: string;
  activeId: string;
  boards: unknown[];
};

type OpenProjectResult = {
  canceled: boolean;
  name?: string;
  data?: MuseboardProjectData;
};

type SaveProjectResult = {
  canceled: boolean;
  name?: string;
};

type PinterestBoardPin = { imageUrl: string; pinUrl: string; title: string; width: number; height: number };
type PinterestBoardFile = { format: "imagestorage-pinterest-board"; version: 1 | 2; board: { name: string; url: string }; pins: PinterestBoardPin[]; duplicates: number };
type PinterestBoardImage = { pin: PinterestBoardPin; image: ImportedImageData };

type ImportedImageData = {
  originalImageUrl?: string;
  clientId?: string;
  name: string;
  src: string;
  thumbnailSrc?: string;
  width: number;
  height: number;
  palette?: string[];
  assetId?: string;
  processing?: boolean;
};

type ImageImportResult = {
  canceled: boolean;
  images: ImportedImageData[];
  errors: Array<{ name: string; message: string }>;
};

type AutoSaveResult = {
  saved: boolean;
  error: string | null;
};

type StorageFailure = { error: string };
type BackupEntry = {
  id: string; digest: string; savedAt: string; kind: "automatic" | "manual" | "before-restore";
  boards: number; images: number; bytes: number;
};
type BackupListResult = { backups: BackupEntry[]; errors: Array<{ name: string; message: string }> };
type DuplicateImageOccurrence = { boardId: string; boardName: string; itemId: string; name: string };
type DuplicateImagesResult = {
  scanned: number;
  groups: Array<{ hash: string; items: DuplicateImageOccurrence[] }>;
  errors: Array<DuplicateImageOccurrence & { message: string }>;
};
type ExportListImagesResult = {
  canceled: boolean; directory?: string; exported?: number; files?: string[];
  errors?: Array<{ name: string; message: string }>;
};

type ImageAnalysisPoint = { x: number; y: number; pressure?: number };

type ImageAnalysisStroke = {
  id: string;
  kind: "freehand" | "line";
  points: ImageAnalysisPoint[];
  color: string;
  width: number;
  pressureMinimum?: number;
};

type ImageAnalysisState = {
  preset:
    | "none"
    | "thirds"
    | "diagonals"
    | "golden"
    | "golden-wide"
    | "golden-tall"
    | "center"
    | "center-frame"
    | "perspective";
  gridVisible: boolean;
  guideColor?: string;
  guideColorVersion?: number;
  strokes: ImageAnalysisStroke[];
};

type ImageAnalysisPayload = {
  itemId: string;
  src: string;
  caption?: string;
  width: number;
  height: number;
  analysis?: ImageAnalysisState;
};

type ExtensionImportRequest = { requestId: string; generation: number; boardId: string; newBoardName?: string; sourceUrl: string; image: ImportedImageData };
type ExtensionRemoveRequest = { requestId: string; generation: number; boardId: string; targets: Array<{ id: string; imageUrl: string; sourceUrl: string }> };

interface Window {
  museboardDesktop?: {
    readonly windowMaterial?: "acrylic" | "none";
    readonly preferredLanguages?: readonly string[];
    publishExtensionState: (state: { ready: boolean; generation: number; activeId: string; boards: Array<{ id: string; name: string; groupName?: string; imageSources?: Array<{ id?: string; imageUrl?: string; sourceUrl?: string }> }> }) => void;
    onExtensionImport: (callback: (request: ExtensionImportRequest) => void) => () => void;
    onExtensionRemove: (callback: (request: ExtensionRemoveRequest) => void) => () => void;
    completeExtensionImport: (result: { requestId: string; count: number; snapshot?: MuseboardProjectData }) => void;
    openProject: () => Promise<OpenProjectResult>;
    openPinterestBoardFile: () => Promise<{ canceled: boolean; boardFile?: PinterestBoardFile; error?: string }>;
    saveProject: (data: MuseboardProjectData) => Promise<SaveProjectResult>;
    loadAutosave: () => Promise<{
      found: boolean;
      recoveredFromBackup: boolean;
      data: MuseboardProjectData | null;
    }>;
    autoSaveProject: (data: MuseboardProjectData) => Promise<AutoSaveResult>;
    listBackups: () => Promise<BackupListResult | StorageFailure>;
    createBackup: (data: MuseboardProjectData) => Promise<{ id: string } | StorageFailure>;
    restoreBackup: (token: Pick<BackupEntry, "id" | "digest">, current: MuseboardProjectData) => Promise<{ data: MuseboardProjectData } | StorageFailure>;
    completeBackupRestore: () => void;
    findDuplicateImages: (data: MuseboardProjectData) => Promise<DuplicateImagesResult | StorageFailure>;
    exportListImages: (data: MuseboardProjectData, boardId: string) => Promise<ExportListImagesResult | StorageFailure>;
    saveGlobalBackground: (reference: {
      backgroundImageSrc?: string;
      backgroundImageThumbnailSrc?: string;
      backgroundImageAssetId?: string;
    } | null) => Promise<{ saved: boolean; error?: string }>;
    chooseImageFiles: () => Promise<ImageImportResult>;
    getPathForFile: (file: File) => string;
    stageImageFiles: (filePaths: string[]) => Promise<ImageImportResult>;
    convertImageFiles: (
      files: Array<{
        id?: string;
        name: string;
        bytes: ArrayBuffer;
        assetId?: string;
      }>,
    ) => Promise<ImageImportResult>;
    optimizeStagedImages: (
      entries: Array<{
        id: string;
        source: string;
        name: string;
        assetId?: string;
      }>,
    ) => Promise<{
      results: Array<{
        id: string;
        image: ImportedImageData | null;
        error: string | null;
      }>;
    }>;
    persistImageSource: (entry: {
      source: string;
      name: string;
      assetId?: string;
    }) => Promise<{
      image: ImportedImageData | null;
      error: string | null;
    }>;
    importImageUrl: (url: string) => Promise<ImageImportResult>;
    extractColorPalette: (
      source: string,
    ) => Promise<{ colors: string[]; error: string | null }>;
    openImageAnalysis: (payload: ImageAnalysisPayload) => Promise<boolean>;
    getImageAnalysisInit: () => Promise<ImageAnalysisPayload | null>;
    updateImageAnalysis: (payload: {
      itemId: string;
      analysis: ImageAnalysisState;
    }) => void;
    onImageAnalysisInit: (
      callback: (payload: ImageAnalysisPayload) => void,
    ) => () => void;
    onImageAnalysisUpdate: (
      callback: (payload: { itemId: string; analysis: ImageAnalysisState }) => void,
    ) => () => void;
    toggleAlwaysOnTop: () => Promise<boolean>;
    getTitlebarVisibility: () => Promise<boolean>;
    getWindowPointerPosition: () => Promise<{ clientX: number; clientY: number } | null>;
    onWindowPointerPosition: (
      callback: (position: { clientX: number; clientY: number } | null) => void,
    ) => () => void;
    onTitlebarVisibilityChange: (
      callback: (visible: boolean) => void,
    ) => () => void;
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    onCloseRequest: (callback: () => void) => () => void;
    completeClose: (data: MuseboardProjectData | { skipRecovery: true }) => void;
  };
}
