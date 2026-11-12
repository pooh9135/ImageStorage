# Zen UI reference and ImageStorage adaptation

Verified on 2026-11-02 against the user's running Zen 1.24b on Windows.

## Reference inspection

The investigation combined installed theme/source inspection with direct Windows Computer Use. The source/settings phase took about 25 minutes; direct interaction took about 11 minutes after repairing the stale Computer Use launcher path. No login or logout was performed.

Directly inspected: sidebar navigation, the floating address/search panel, main menu, compact mode and edge reveal, Library categories, workspace creation form (cancelled), tab context menu, Essentials using a temporary settings tab, split view and divider resizing. The temporary tab was removed; compact mode, split view and Library selection were returned to their starting states. Browser-only functions such as Glance were studied in source, not all exercised live.

### Measured appearance

| Surface | Reference value |
| --- | --- |
| Main chrome | `#202020` |
| Address/search field | `#383838`, 36 px high |
| Selected tab | `#464646` |
| Settings background / card | `#1c1b22` / `#23222b` |
| Muted text / accent | `#b0b0b0` / approximately `#b99ac8` |
| Main content edge | 8 px outer inset; 206 px from the left |
| Navigation controls | 28 px buttons, 16 px icons |
| Normal list rows | 36 px |
| Floating search | Up to 750 px wide; 44 px results |

The live Mica appearance is used for chrome rather than copying the opaque color from source alone.

## Implemented mapping

| Zen pattern | ImageStorage behavior |
| --- | --- |
| Compact navigation row | Menu, compact toggle, undo, redo, fit canvas |
| Address/search field | Search saved lists and actions with `Ctrl+K` |
| Vertical tabs | Dense saved-list rows; existing custom image headers keep their crop ratio |
| Bottom Library / workspace / plus | Image Library, group filters, create/import actions |
| Workspace switching | Existing list groups; no project format migration |
| Compact mode | `Ctrl+B`, edge hover to reveal, background canvas position retained |
| Category settings | Existing settings grouped in a left navigation column |
| Restrained panels | Shared dark surfaces, borders, icons, focus states and sliders |

Browser-only navigation, account features and destructive tab-clearing behavior are not mapped onto project data. Existing `Ctrl+O` / `Ctrl+S` retain project open/save behavior; Zen's conflicting key bindings are not copied.

## Interaction guarantees

- Normal clicks switch saved lists. Reordering still requires a 30 ms hold and at least 4 px of movement. A stationary hold remains a click. The normal pointer is retained outside actual dragging.
- Thumbnail images explicitly disable native image dragging, which otherwise cancels the list's pointer gesture. Entering drag mode no longer shifts rows to make room for legacy drop zones.
- Search supports Japanese IME, normalized full-width text, arrow navigation and cancellation. Executing a command must not restore focus to a previous list's rename input.
- Group changes keep the active list visible. Opening another project clears undo/redo and transient workspace filters.
- Focus alone does not create a rename/group undo snapshot or discard redo. The first actual edit creates the snapshot.
- Dialogs contain keyboard focus; project shortcuts are blocked during modal editing. Explicit dialog buttons remain usable.
- Header preview uses the original image and preserves the fixed 2.1 crop ratio on small windows. Cancel does not alter the saved header.
- Drawing coordinates and clipped rendering remain separate, so a straight line can start outside the image without drawing into its margins.

## Validation artifacts

- `npm test`: renderer build plus persistence, history, modal, editor, distribution and signature regressions.
- `npm run lint` and `tsc --noEmit`.
- `work/zen-parity-qa/ui-smoke.cjs`: isolated Electron interaction checks and screenshots; result in `ui-result.json`.
- `work/zen-redesign-before-20261102`: pre-change copies, including earlier uncommitted work.

## Official reference

- [Zen 1.24b release](https://github.com/zen-browser/desktop/releases/tag/1.24b)
- [Theme](https://github.com/zen-browser/desktop/blob/1.24b/src/zen/common/styles/zen-theme.css)
- [Vertical tabs](https://github.com/zen-browser/desktop/blob/1.24b/src/zen/tabs/zen-tabs/vertical-tabs.css)
- [Library](https://github.com/zen-browser/desktop/blob/1.24b/src/zen/library/ZenLibrary.mjs)

This UI work does not alter the existing Windows signing/distribution requirements.
