import type { CSSProperties } from "react";

export type IconName = "fit" | "plus" | "settings" | "search" | "image" | "note" | "help" | "boards" | "menu" | "sidebar" | "undo" | "redo" | "folder" | "library" | "grid" | "snap" | "save" | "open" | "favorite" | "check" | "close" | "pin" | "minimize" | "maximize" | "reset" | "pen" | "line" | "chevronDown" | "info" | "palette" | "flipHorizontal" | "grayscale" | "trash";

const paths: Record<IconName, React.ReactNode> = {
  menu: <><circle cx="5" cy="12" r=".7" /><circle cx="12" cy="12" r=".7" /><circle cx="19" cy="12" r=".7" /></>,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16M6 8v8" /></>,
  undo: <path d="m10 6-6 6 6 6M4 12h16" />,
  redo: <path d="m14 6 6 6-6 6M20 12H4" />,
  folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  library: <><rect x="3" y="4" width="5" height="16" rx="1" /><path d="M11 4v16m3-15 4-1 4 15-4 1Z" /></>,
  grid: <><rect x="3" y="3" width="18" height="18" rx="1" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></>,
  snap: <><path d="M4 4v9a8 8 0 0 0 16 0V4h-5v9a3 3 0 0 1-6 0V4ZM4 8h5m6 0h5" /></>,
  save: <><path d="M4 3h13l4 4v14H3V3ZM7 3v6h9V3M7 21v-8h10v8" /></>,
  open: <><path d="M3 9V5h7l3 3h7v3M2 11h20l-3 10H5Z" /></>,
  favorite: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  palette: <><path d="M12 3a9 9 0 1 0 0 18h1.3a2 2 0 0 0 1.4-3.4 1.6 1.6 0 0 1 1.1-2.7H18a3 3 0 0 0 3-3A9 9 0 0 0 12 3Z" /><circle cx="7.5" cy="10" r=".6" /><circle cx="11" cy="6.8" r=".6" /><circle cx="15.5" cy="8" r=".6" /><circle cx="6.8" cy="14.5" r=".6" /></>,
  flipHorizontal: <><path d="M12 3v2m0 3v2m0 4v2m0 3v2M3 7l6 4v2l-6 4ZM21 7l-6 4v2l6 4Z" /></>,
  grayscale: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 0 0 18Z" fill="currentColor" stroke="none" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" /></>,
  pin: <><path d="M8 3h8l-1 6 3 4H6l3-4ZM12 13v8" /></>,
  minimize: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx=".5" />,
  reset: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></>,
  pen: <><path d="m4 16-1 5 5-1L21 7l-4-4ZM14 6l4 4M4 16l4 4" /></>,
  line: <path d="m4 20 16-16" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  fit: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3h3l1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3Z" /><circle cx="12" cy="12" r="3" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1.5" /><path d="m3 17 5-5 4 4 4-6 5 7" /></>,
  note: <><path d="M14 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v9Z" /><path d="M14 21v-7h7M7 8h10M7 12h4" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 4.2 1.8c-1.1.7-1.7 1.1-1.7 2.7M12 17h.01" /></>,
  boards: <><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="14" y="3" width="7" height="12" rx="2" /><rect x="3" y="14" width="8" height="7" rx="2" /><path d="M14 19h7" /></>,
};

export function UiIcon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
