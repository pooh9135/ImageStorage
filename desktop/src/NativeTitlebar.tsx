import { useCallback, useEffect, useState } from "react";
import { UiIcon } from "../../app/UiIcon";

function emitSaveRequest() {
  window.dispatchEvent(new CustomEvent("museboard:save-request"));
}

export function NativeTitlebar({ alwaysVisible = false }: { alwaysVisible?: boolean }) {
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [titlebarVisible, setTitlebarVisible] = useState(alwaysVisible);
  const desktop = window.museboardDesktop;
  const visible = alwaysVisible || titlebarVisible;
  const language = localStorage.getItem("imagestorage-language") || "en";
  const t = (en: string, ja: string, zh: string, ko: string) =>
    language === "ja" ? ja : language === "zh" ? zh : language === "ko" ? ko : en;
  const pinLabel = alwaysOnTop
    ? t("Stop keeping this window on top", "最前面への固定を解除", "取消窗口置顶", "항상 위에 표시 해제")
    : t("Keep this window on top", "ウィンドウを最前面に固定", "窗口置顶", "항상 위에 표시");

  useEffect(() => {
    if (alwaysVisible) return;
    const removeListener = desktop?.onTitlebarVisibilityChange((visible) => {
      setTitlebarVisible(visible);
    });
    void desktop?.getTitlebarVisibility().then((visible) => {
      setTitlebarVisible(visible);
    });
    return removeListener;
  }, [alwaysVisible, desktop]);

  const openProject = useCallback(async () => {
    const result = await desktop?.openProject();
    if (!result || result.canceled || !result.data) return;
    window.dispatchEvent(
      new CustomEvent("museboard:load-project", { detail: result.data }),
    );
  }, [desktop]);

  useEffect(() => {
    if (alwaysVisible) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (!(event.ctrlKey || event.metaKey) || (key !== "s" && key !== "o")) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (document.querySelector('.app-shell[data-canvas-shortcuts-blocked="true"], .app-shell[data-modal-open="true"]')) return;
      if (key === "s") emitSaveRequest();
      else void openProject();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [alwaysVisible, openProject]);

  const toggleAlwaysOnTop = async () => {
    const next = await desktop?.toggleAlwaysOnTop();
    setAlwaysOnTop(Boolean(next));
  };

  return (
    <header
      className={`native-titlebar ${visible ? "is-visible" : ""}`}
    >
        <div className="native-titlebar-drag" aria-hidden="true" />

        <div className="native-project-actions" inert={!visible}>
            <button
              className="always-on-top-button"
              onClick={() => void toggleAlwaysOnTop()}
              title={pinLabel}
              aria-label={pinLabel}
              aria-pressed={alwaysOnTop}
            >
              <UiIcon name="pin" />
            </button>
        </div>

        <div className="native-window-controls" inert={!visible}>
          <button
            onClick={() => desktop?.minimize()}
            aria-label={t("Minimize", "最小化", "最小化", "최소화")}
            title={t("Minimize", "最小化", "最小化", "최소화")}
          >
            <UiIcon name="minimize" />
          </button>
          <button
            onClick={() => desktop?.toggleMaximize()}
            aria-label={t("Maximize or restore", "最大化・元に戻す", "最大化或还原", "최대화 또는 복원")}
            title={t("Maximize or restore", "最大化・元に戻す", "最大化或还原", "최대화 또는 복원")}
          >
            <UiIcon name="maximize" />
          </button>
          <button
            className="native-close"
            onClick={() => desktop?.close()}
            aria-label={t("Close", "閉じる", "关闭", "닫기")}
            title={t("Close", "閉じる", "关闭", "닫기")}
          >
            <UiIcon name="close" />
          </button>
        </div>
    </header>
  );
}
