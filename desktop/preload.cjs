const { contextBridge, ipcRenderer, webUtils } = require("electron");

const preferredLanguagesPrefix = "--imagestorage-preferred-languages=";
const preferredLanguages = process.argv.find((argument) => argument.startsWith(preferredLanguagesPrefix))
  ?.slice(preferredLanguagesPrefix.length).split(",").filter(Boolean);

contextBridge.exposeInMainWorld("museboardDesktop", {
  windowMaterial: process.argv.includes("--imagestorage-window-material=acrylic") ? "acrylic" : "none",
  preferredLanguages,
  publishExtensionState: (state) => ipcRenderer.send("extension:state", state),
  completeExtensionImport: (result) => ipcRenderer.send("extension:complete", result),
  onExtensionImport: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("extension:import", listener);
    return () => ipcRenderer.removeListener("extension:import", listener);
  },
  onExtensionRemove: (callback) => {
    const listener = (_event, request) => callback(request);
    ipcRenderer.on("extension:remove", listener);
    return () => ipcRenderer.removeListener("extension:remove", listener);
  },
  openProject: () => ipcRenderer.invoke("project:open"),
  openPinterestBoardFile: () => ipcRenderer.invoke("pinterest-board:open"),
  saveProject: (data) => ipcRenderer.invoke("project:save", data),
  loadAutosave: () => ipcRenderer.invoke("project:load-autosave"),
  autoSaveProject: (data) => ipcRenderer.invoke("project:auto-save", data),
  listBackups: () => ipcRenderer.invoke("storage:list-backups"),
  createBackup: (data) => ipcRenderer.invoke("storage:create-backup", data),
  restoreBackup: (token, current) => ipcRenderer.invoke("storage:restore-backup", token, current),
  completeBackupRestore: () => ipcRenderer.send("storage:restore-complete"),
  findDuplicateImages: (data) => ipcRenderer.invoke("storage:find-duplicates", data),
  exportListImages: (data, boardId) => ipcRenderer.invoke("storage:export-list", data, boardId),
  saveGlobalBackground: (reference) => ipcRenderer.invoke("settings:save-global-background", reference),
  chooseImageFiles: () => ipcRenderer.invoke("image:choose-files"),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  stageImageFiles: (filePaths) =>
    ipcRenderer.invoke("image:stage-paths", filePaths),
  convertImageFiles: (files) => ipcRenderer.invoke("image:convert-files", files),
  optimizeStagedImages: (entries) =>
    ipcRenderer.invoke("image:optimize-staged", entries),
  persistImageSource: (entry) =>
    ipcRenderer.invoke("image:persist-source", entry),
  importImageUrl: (url) => ipcRenderer.invoke("image:import-url", url),
  extractColorPalette: (source) =>
    ipcRenderer.invoke("image:extract-palette", source),
  openImageAnalysis: (payload) =>
    ipcRenderer.invoke("image-analysis:open", payload),
  getImageAnalysisInit: () => ipcRenderer.invoke("image-analysis:get-init"),
  updateImageAnalysis: (payload) =>
    ipcRenderer.send("image-analysis:update", payload),
  onImageAnalysisInit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("image-analysis:init", listener);
    return () => ipcRenderer.removeListener("image-analysis:init", listener);
  },
  onImageAnalysisUpdate: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("image-analysis:updated", listener);
    return () => ipcRenderer.removeListener("image-analysis:updated", listener);
  },
  toggleAlwaysOnTop: () => ipcRenderer.invoke("window:toggle-always-on-top"),
  getTitlebarVisibility: () =>
    ipcRenderer.invoke("window:get-titlebar-visibility"),
  getWindowPointerPosition: () => ipcRenderer.invoke("window:get-pointer-position"),
  onWindowPointerPosition: (callback) => {
    const listener = (_event, position) => callback(position);
    ipcRenderer.on("window:pointer-position", listener);
    return () => ipcRenderer.removeListener("window:pointer-position", listener);
  },
  onTitlebarVisibilityChange: (callback) => {
    const listener = (_event, visible) => callback(Boolean(visible));
    ipcRenderer.on("titlebar:visibility-change", listener);
    return () =>
      ipcRenderer.removeListener("titlebar:visibility-change", listener);
  },
  minimize: () => ipcRenderer.send("window:minimize"),
  toggleMaximize: () => ipcRenderer.send("window:toggle-maximize"),
  close: () => ipcRenderer.send("window:close"),
  onCloseRequest: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("app:request-close", listener);
    return () => ipcRenderer.removeListener("app:request-close", listener);
  },
  completeClose: (data) => ipcRenderer.send("window:close-ready", data),
});
