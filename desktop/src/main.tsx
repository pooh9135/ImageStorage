import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Home from "../../app/page";
import { ImageAnalysisWindow } from "../../app/ImageAnalysisWindow";
import "../../app/globals.css";
import "./desktop.css";
import "../../app/zen-theme.css";
import { NativeTitlebar } from "./NativeTitlebar";

document.documentElement.classList.toggle(
  "native-backdrop-acrylic",
  window.museboardDesktop?.windowMaterial === "acrylic",
);

function DesktopApp() {
  const imageAnalysisMode =
    new URLSearchParams(window.location.search).get("mode") === "image-analysis";
  return (
    <div className={`desktop-root ${imageAnalysisMode ? "is-analysis-window" : ""}`}>
      <NativeTitlebar alwaysVisible={imageAnalysisMode} />
      {imageAnalysisMode ? <ImageAnalysisWindow /> : <Home />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesktopApp />
  </StrictMode>,
);
