"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { UiIcon } from "./UiIcon";

export type AnalysisPoint = { x: number; y: number; pressure?: number };

export type AnalysisStroke = {
  id: string;
  kind: "freehand" | "line";
  points: AnalysisPoint[];
  color: string;
  width: number;
  pressureMinimum?: number;
};

export type CompositionPreset =
  | "none"
  | "thirds"
  | "diagonals"
  | "golden"
  | "golden-wide"
  | "golden-tall"
  | "center"
  | "center-frame"
  | "perspective";

export type ImageAnalysisState = {
  preset: CompositionPreset;
  gridVisible: boolean;
  guideColor?: string;
  guideColorVersion?: number;
  strokes: AnalysisStroke[];
};

export type ImageAnalysisPayload = {
  itemId: string;
  src: string;
  caption?: string;
  width: number;
  height: number;
  analysis?: ImageAnalysisState;
};

type AnalysisPreferences = {
  tool: "draw" | "line";
  color: string;
  guideColor: string;
  guideColorVersion: number;
  lineWidth: number;
  gridVisible: boolean;
  preset: CompositionPreset;
};

const PREFERENCES_KEY = "imagestorage-analysis-preferences-v2";
const DEFAULT_GUIDE_COLOR = "#ff0000";
const EMPTY_ANALYSIS: ImageAnalysisState = {
  preset: "none",
  gridVisible: false,
  strokes: [],
};
const DEFAULT_PREFERENCES: AnalysisPreferences = {
  tool: "draw",
  color: "#2aa8ef",
  guideColor: DEFAULT_GUIDE_COLOR,
  guideColorVersion: 1,
  lineWidth: 5,
  gridVisible: false,
  preset: "none",
};

const PRESETS: Array<{
  id: CompositionPreset;
  en: string;
  ja: string;
  zh: string;
  ko: string;
}> = [
  { id: "none", en: "None", ja: "なし", zh: "无", ko: "없음" },
  { id: "thirds", en: "Thirds", ja: "三分割", zh: "三分法", ko: "삼분할" },
  { id: "diagonals", en: "Diagonals", ja: "対角線", zh: "对角线", ko: "대각선" },
  { id: "golden", en: "Golden ratio", ja: "黄金比", zh: "黄金比例", ko: "황금비" },
  { id: "golden-wide", en: "Golden ratio · wide", ja: "黄金比・横", zh: "黄金比例・横", ko: "황금비 · 가로" },
  { id: "golden-tall", en: "Golden ratio · tall", ja: "黄金比・縦", zh: "黄金比例・竖", ko: "황금비 · 세로" },
  { id: "center", en: "Center", ja: "中央", zh: "中心", ko: "중앙" },
  { id: "center-frame", en: "Center frame", ja: "中央枠", zh: "中心框", ko: "중앙 프레임" },
  { id: "perspective", en: "Perspective", ja: "遠近法", zh: "透视", ko: "원근법" },
];

// Older releases persisted the blue default even when no color was chosen.
// Mark the conversion so a blue color chosen after upgrading stays blue.
export function migrateAnalysisGuideColor<T extends { guideColor?: string; guideColorVersion?: number }>(state: T): T {
  if (state.guideColorVersion === 1) return state;
  const color = state.guideColor?.trim();
  return {
    ...state,
    guideColor: !color || color.toLowerCase() === "#2aa8ef" ? DEFAULT_GUIDE_COLOR : state.guideColor,
    guideColorVersion: 1,
  };
}

export function migrateBoardAnalysisGuides<T extends { items: Array<{ analysis?: ImageAnalysisState }> }>(boards: T[]): T[] {
  let changed = false;
  const migrated = boards.map((board) => {
    let boardChanged = false;
    const items = board.items.map((item) => {
      if (!item.analysis) return item;
      const analysis = migrateAnalysisGuideColor(item.analysis);
      if (analysis === item.analysis) return item;
      boardChanged = true;
      return { ...item, analysis };
    });
    if (!boardChanged) return board;
    changed = true;
    return { ...board, items };
  });
  return changed ? migrated : boards;
}

function makeStrokeId() {
  return `stroke-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function cloneAnalysis(analysis: ImageAnalysisState): ImageAnalysisState {
  return structuredClone(analysis);
}

function getSavedPreferences(): AnalysisPreferences {
  try {
    const saved = localStorage.getItem(PREFERENCES_KEY);
    if (!saved) return DEFAULT_PREFERENCES;
    const value = JSON.parse(saved) as Partial<AnalysisPreferences>;
    const preset = PRESETS.some((item) => item.id === value.preset)
      ? value.preset!
      : DEFAULT_PREFERENCES.preset;
    return {
      ...DEFAULT_PREFERENCES,
      ...migrateAnalysisGuideColor(value),
      preset,
      tool: value.tool === "line" ? "line" : "draw",
      lineWidth: Math.max(1, Math.min(18, Number(value.lineWidth) || DEFAULT_PREFERENCES.lineWidth)),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function CompositionGuide({ preset, color }: { preset: CompositionPreset; color: string }) {
  if (preset === "none") return null;
  const style = { "--analysis-guide-color": color } as CSSProperties;
  if (preset === "thirds") {
    return <g className="analysis-composition-lines" style={style}><line x1="333" y1="0" x2="333" y2="1000" /><line x1="667" y1="0" x2="667" y2="1000" /><line x1="0" y1="333" x2="1000" y2="333" /><line x1="0" y1="667" x2="1000" y2="667" /></g>;
  }
  if (preset === "diagonals") {
    return <g className="analysis-composition-lines" style={style}><line x1="0" y1="0" x2="1000" y2="1000" /><line x1="1000" y1="0" x2="0" y2="1000" /></g>;
  }
  if (preset === "golden") {
    return <g className="analysis-composition-lines" style={style}><line x1="382" y1="0" x2="382" y2="1000" /><line x1="618" y1="0" x2="618" y2="1000" /><line x1="0" y1="382" x2="1000" y2="382" /><line x1="0" y1="618" x2="1000" y2="618" /></g>;
  }
  if (preset === "golden-wide") {
    return <g className="analysis-composition-lines" style={style}><line x1="382" y1="0" x2="382" y2="1000" /><line x1="618" y1="0" x2="618" y2="1000" /></g>;
  }
  if (preset === "golden-tall") {
    return <g className="analysis-composition-lines" style={style}><line x1="0" y1="382" x2="1000" y2="382" /><line x1="0" y1="618" x2="1000" y2="618" /></g>;
  }
  if (preset === "center") {
    return <g className="analysis-composition-lines" style={style}><line x1="500" y1="0" x2="500" y2="1000" /><line x1="0" y1="500" x2="1000" y2="500" /><circle cx="500" cy="500" r="45" /><circle cx="500" cy="500" r="110" /></g>;
  }
  if (preset === "center-frame") {
    return <g className="analysis-composition-lines" style={style}><line x1="500" y1="0" x2="500" y2="1000" /><line x1="0" y1="500" x2="1000" y2="500" /><rect x="250" y="250" width="500" height="500" /></g>;
  }
  return <g className="analysis-composition-lines" style={style}><line x1="0" y1="0" x2="500" y2="500" /><line x1="1000" y1="0" x2="500" y2="500" /><line x1="0" y1="1000" x2="500" y2="500" /><line x1="1000" y1="1000" x2="500" y2="500" /><line x1="500" y1="0" x2="500" y2="1000" /></g>;
}

function pressureScale(stroke: AnalysisStroke, pressure: number | undefined) {
  const minimum = stroke.pressureMinimum ?? 0.18;
  const input = Math.max(0, Math.min(1, pressure ?? 1));
  return minimum + (1 - minimum) * Math.pow(input, 0.68);
}

function stabilizedPoints(points: AnalysisPoint[]) {
  if (points.length < 3) return points;
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1) return point;
    const previous = points[index - 1];
    const next = points[index + 1];
    return {
      x: (previous.x + point.x * 2 + next.x) / 4,
      y: (previous.y + point.y * 2 + next.y) / 4,
      pressure: ((previous.pressure ?? 1) + (point.pressure ?? 1) * 2 + (next.pressure ?? 1)) / 4,
    };
  });
}

function midpoint(first: AnalysisPoint, second: AnalysisPoint): AnalysisPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    pressure: ((first.pressure ?? 1) + (second.pressure ?? 1)) / 2,
  };
}

function AnalysisStrokeMarks({ strokes }: { strokes: AnalysisStroke[] }) {
  return <g className="analysis-user-strokes">{strokes.map((stroke) => {
    if (stroke.kind === "line") {
      const [start, end = start] = stroke.points;
      const pressure = pressureScale(stroke, ((start.pressure ?? 1) + (end.pressure ?? 1)) / 2);
      return <line key={stroke.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={stroke.color} strokeWidth={stroke.width * pressure} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
    }
    const points = stabilizedPoints(stroke.points);
    if (points.length < 2) {
      const point = points[0];
      return <circle key={stroke.id} cx={point.x} cy={point.y} r={(stroke.width * pressureScale(stroke, point.pressure)) / 2} fill={stroke.color} vectorEffect="non-scaling-stroke" />;
    }
    if (points.length === 2) {
      const [start, end] = points;
      return <line key={stroke.id} x1={start.x} y1={start.y} x2={end.x} y2={end.y} stroke={stroke.color} strokeWidth={stroke.width * pressureScale(stroke, ((start.pressure ?? 1) + (end.pressure ?? 1)) / 2)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
    }
    let start = points[0];
    const curves = points.slice(1, -1).map((point, index) => {
      const end = midpoint(point, points[index + 2]);
      const curve = <path key={`${stroke.id}-${index}`} d={`M ${start.x} ${start.y} Q ${point.x} ${point.y} ${end.x} ${end.y}`} fill="none" stroke={stroke.color} strokeWidth={stroke.width * pressureScale(stroke, point.pressure)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />;
      start = end;
      return curve;
    });
    const last = points.at(-1)!;
    curves.push(<path key={`${stroke.id}-last`} d={`M ${start.x} ${start.y} Q ${last.x} ${last.y} ${last.x} ${last.y}`} fill="none" stroke={stroke.color} strokeWidth={stroke.width * pressureScale(stroke, last.pressure)} strokeLinecap="round" vectorEffect="non-scaling-stroke" />);
    return <g key={stroke.id}>{curves}</g>;
  })}</g>;
}

export function AnalysisMarks({ analysis, guideColor }: { analysis: ImageAnalysisState; guideColor?: string }) {
  const color = guideColor || analysis.guideColor || DEFAULT_GUIDE_COLOR;
  return <>
    {analysis.gridVisible && <g className="analysis-grid-lines">{Array.from({ length: 9 }, (_, index) => (index + 1) * 100).flatMap((position) => [<line key={`v-${position}`} x1={position} y1="0" x2={position} y2="1000" />, <line key={`h-${position}`} x1="0" y1={position} x2="1000" y2={position} />])}</g>}
    <CompositionGuide preset={analysis.preset} color={color} />
    <AnalysisStrokeMarks strokes={analysis.strokes} />
  </>;
}

export function ImageAnalysisWindow() {
  const [payload, setPayload] = useState<ImageAnalysisPayload | null>(null);
  const [analysis, setAnalysis] = useState<ImageAnalysisState>(EMPTY_ANALYSIS);
  const [preferences, setPreferences] = useState<AnalysisPreferences>(getSavedPreferences);
  const analysisRef = useRef<ImageAnalysisState>(EMPTY_ANALYSIS);
  const imageFrameRef = useRef<HTMLDivElement>(null);
  const activeStrokeRef = useRef<AnalysisStroke | null>(null);
  const strokeSessionRef = useRef<{
    pointerId: number;
    captureTarget: HTMLElement;
    analysis: ImageAnalysisState;
    undo: ImageAnalysisState[];
    redo: ImageAnalysisState[];
  } | null>(null);
  const undoStackRef = useRef<ImageAnalysisState[]>([]);
  const redoStackRef = useRef<ImageAnalysisState[]>([]);
  const initializedRef = useRef(false);
  const desktop = window.museboardDesktop;
  const language = localStorage.getItem("imagestorage-language") || "en";
  const t = (en: string, ja: string, zh: string, ko: string) => language === "ja" ? ja : language === "zh" ? zh : language === "ko" ? ko : en;

  const stopActiveStroke = useCallback(() => {
    const session = strokeSessionRef.current;
    strokeSessionRef.current = null;
    activeStrokeRef.current = null;
    if (session) {
      try {
        if (session.captureTarget.hasPointerCapture(session.pointerId)) {
          session.captureTarget.releasePointerCapture(session.pointerId);
        }
      } catch {
        // The pointer may already have been canceled by the operating system.
      }
    }
    return session;
  }, []);

  const cancelActiveStroke = useCallback(() => {
    const session = stopActiveStroke();
    if (!session) return;
    analysisRef.current = session.analysis;
    undoStackRef.current = session.undo;
    redoStackRef.current = session.redo;
    setAnalysis(session.analysis);
  }, [stopActiveStroke]);

  useEffect(() => {
    window.addEventListener("blur", cancelActiveStroke);
    return () => window.removeEventListener("blur", cancelActiveStroke);
  }, [cancelActiveStroke]);

  useEffect(() => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    let disposed = false;
    let receivedInitEvent = false;
    const initialize = (nextPayload: ImageAnalysisPayload) => {
      initializedRef.current = false;
      stopActiveStroke();
      undoStackRef.current = [];
      redoStackRef.current = [];
      setPayload(nextPayload);
      const guide = migrateAnalysisGuideColor(nextPayload.analysis ?? getSavedPreferences());
      const nextAnalysis: ImageAnalysisState = {
        preset: nextPayload.analysis?.preset ?? "none",
        gridVisible: nextPayload.analysis?.gridVisible ?? false,
        guideColor: guide.guideColor ?? DEFAULT_GUIDE_COLOR,
        guideColorVersion: 1,
        strokes: nextPayload.analysis?.strokes ?? [],
      };
      analysisRef.current = nextAnalysis;
      setAnalysis(nextAnalysis);
      window.requestAnimationFrame(() => { initializedRef.current = true; });
    };
    const removeListener = desktop?.onImageAnalysisInit?.((nextPayload) => {
      if (disposed) return;
      receivedInitEvent = true;
      initialize(nextPayload);
    });
    void desktop?.getImageAnalysisInit?.().then((nextPayload) => {
      if (!disposed && !receivedInitEvent && nextPayload) initialize(nextPayload);
    });
    return () => {
      disposed = true;
      removeListener?.();
      stopActiveStroke();
    };
  }, [desktop, stopActiveStroke]);

  const updatePreferences = useCallback((update: Partial<AnalysisPreferences>) => {
    setPreferences((current) => ({ ...current, ...update }));
  }, []);

  const recordAnalysisUndo = useCallback((current: ImageAnalysisState) => {
    undoStackRef.current.push(cloneAnalysis(current));
    if (undoStackRef.current.length > 60) undoStackRef.current.shift();
    redoStackRef.current = [];
  }, []);

  const updateAnalysis = useCallback((update: Partial<ImageAnalysisState>) => {
    if ((Object.keys(update) as Array<keyof ImageAnalysisState>).every((key) =>
      Object.is(analysisRef.current[key], update[key]))) return;
    recordAnalysisUndo(analysisRef.current);
    const next = { ...analysisRef.current, ...update };
    analysisRef.current = next;
    setAnalysis(next);
  }, [recordAnalysisUndo]);

  const undoAnalysis = useCallback(() => {
    if (strokeSessionRef.current) {
      cancelActiveStroke();
      return;
    }
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    activeStrokeRef.current = null;
    redoStackRef.current.push(cloneAnalysis(analysisRef.current));
    analysisRef.current = previous;
    setAnalysis(previous);
  }, [cancelActiveStroke]);

  const redoAnalysis = useCallback(() => {
    cancelActiveStroke();
    const next = redoStackRef.current.pop();
    if (!next) return;
    activeStrokeRef.current = null;
    undoStackRef.current.push(cloneAnalysis(analysisRef.current));
    analysisRef.current = next;
    setAnalysis(next);
  }, [cancelActiveStroke]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      if (event.shiftKey) redoAnalysis(); else undoAnalysis();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [redoAnalysis, undoAnalysis]);

  const pointFromEvent = useCallback((event: ReactPointerEvent<HTMLElement>): AnalysisPoint => {
    const rect = imageFrameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0, pressure: 1 };
    const pressureValue = event.type === "pointerup" && event.pressure === 0
      ? activeStrokeRef.current?.points.at(-1)?.pressure ?? 0.5
      : event.pressure || 0.5;
    const pressure = event.pointerType === "pen" ? Math.max(0, Math.min(1, pressureValue)) : 1;
    return {
      x: ((event.clientX - rect.left) / rect.width) * 1000,
      y: ((event.clientY - rect.top) / rect.height) * 1000,
      pressure,
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || strokeSessionRef.current) return;
    event.preventDefault();
    const point = pointFromEvent(event);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    strokeSessionRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      analysis: analysisRef.current,
      undo: [...undoStackRef.current],
      redo: [...redoStackRef.current],
    };
    const stroke: AnalysisStroke = { id: makeStrokeId(), kind: preferences.tool === "line" ? "line" : "freehand", points: [point, point], color: preferences.color, width: preferences.lineWidth, pressureMinimum: 0.08 };
    activeStrokeRef.current = stroke;
    updateAnalysis({ strokes: [...analysisRef.current.strokes, stroke] });
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const activeStroke = activeStrokeRef.current;
    if (!activeStroke || strokeSessionRef.current?.pointerId !== event.pointerId || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromEvent(event);
    const next = { ...analysisRef.current, strokes: analysisRef.current.strokes.map((stroke) => {
      if (stroke.id !== activeStroke.id) return stroke;
      const points = stroke.kind === "line" ? [stroke.points[0], point] : [...stroke.points, point];
      const nextStroke = { ...stroke, points };
      activeStrokeRef.current = nextStroke;
      return nextStroke;
    }) };
    analysisRef.current = next;
    setAnalysis(next);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (strokeSessionRef.current?.pointerId !== event.pointerId) return;
    handlePointerMove(event);
    stopActiveStroke();
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLElement>) => {
    if (strokeSessionRef.current?.pointerId === event.pointerId) cancelActiveStroke();
  };

  const visibleAnalysis: ImageAnalysisState = analysis;

  const resetAnalysis = () => {
    cancelActiveStroke();
    if (!analysisRef.current.strokes.length && !analysisRef.current.gridVisible && analysisRef.current.preset === "none") return;
    updateAnalysis({ strokes: [], gridVisible: false, preset: "none" });
  };

  const saveAnalysis = () => {
    if (!payload) return;
    stopActiveStroke();
    desktop?.updateImageAnalysis?.({ itemId: payload.itemId, analysis: analysisRef.current });
    window.setTimeout(() => desktop?.close(), 80);
  };

  if (!payload) return <div className="analysis-loading">{t("Loading image…", "画像を読み込み中…", "正在加载图像…", "이미지를 불러오는 중…")}</div>;

  return <main className="analysis-window">
    <aside className="analysis-tools">
      <strong>{t("Draw", "描画", "绘图", "그리기")}</strong>
      <div className="analysis-tool-row">
        <button className={preferences.tool === "draw" ? "active" : ""} onClick={() => updatePreferences({ tool: "draw" })} aria-pressed={preferences.tool === "draw"} aria-label={t("Pen", "ペン", "画笔", "펜")} title={t("Pen", "ペン", "画笔", "펜")}><UiIcon name="pen" /></button>
        <button className={preferences.tool === "line" ? "active" : ""} onClick={() => updatePreferences({ tool: "line" })} aria-pressed={preferences.tool === "line"} aria-label={t("Line", "直線", "直线", "직선")} title={t("Line", "直線", "直线", "직선")}><UiIcon name="line" /></button>
      </div>
      <label><span>{t("Color", "色", "颜色", "색상")}</span><input type="color" value={preferences.color} onChange={(event) => updatePreferences({ color: event.target.value })} /></label>
      <label><span>{t("Width", "太さ", "粗细", "굵기")}</span><input type="range" min="1" max="18" value={preferences.lineWidth} onChange={(event) => updatePreferences({ lineWidth: Number(event.target.value) })} /></label>
      <label className="analysis-check-row"><span>{t("Grid", "グリッド", "网格", "그리드")}</span><input type="checkbox" checked={analysis.gridVisible} onChange={(event) => updateAnalysis({ gridVisible: event.target.checked })} /></label>
      <button onClick={undoAnalysis}><UiIcon name="undo" />{t("Undo", "元に戻す", "撤销", "실행 취소")}</button>
      <button onClick={redoAnalysis}><UiIcon name="redo" />{t("Redo", "やり直す", "重做", "다시 실행")}</button>
      <button className="analysis-reset" onClick={resetAnalysis}><UiIcon name="reset" />{t("Reset", "リセット", "重置", "초기화")}</button>
    </aside>
    <section
      className="analysis-stage-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onLostPointerCapture={handlePointerCancel}
    >
      <div ref={imageFrameRef} className="analysis-image-frame" style={{ aspectRatio: `${Math.max(1, payload.width)} / ${Math.max(1, payload.height)}`, "--analysis-aspect": Math.max(1, payload.width) / Math.max(1, payload.height) } as CSSProperties}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={payload.src} alt={payload.caption || "Analysis"} draggable={false} />
        <svg className="analysis-overlay" viewBox="0 0 1000 1000" preserveAspectRatio="none">
          <AnalysisMarks analysis={visibleAnalysis} />
        </svg>
      </div>
    </section>
    <aside className="analysis-presets">
      <strong>{t("Composition", "構図", "构图", "구도")}</strong>
      <label className="analysis-guide-color"><span>{t("Guide color", "ガイドの色", "参考线颜色", "가이드 색")}</span><input type="color" value={analysis.guideColor || preferences.guideColor} onChange={(event) => {
        updateAnalysis({ guideColor: event.target.value });
        updatePreferences({ guideColor: event.target.value });
      }} /></label>
      {PRESETS.map((preset) => <button key={preset.id} className={analysis.preset === preset.id ? "active" : ""} aria-pressed={analysis.preset === preset.id} onClick={() => updateAnalysis({ preset: preset.id })}>
        <svg className={`preset-thumbnail preset-${preset.id}`} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
          <CompositionGuide preset={preset.id} color="currentColor" />
        </svg>
        {t(preset.en, preset.ja, preset.zh, preset.ko)}
      </button>)}
      <button className="analysis-save" onClick={saveAnalysis}>{t("Save", "保存", "保存", "저장")}</button>
    </aside>
  </main>;
}
