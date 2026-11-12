"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { UiIcon, type IconName } from "./UiIcon";

export type CommandItem = {
  id: string;
  label: string;
  detail?: string;
  shortcut?: string;
  icon: IconName;
  onSelect: () => void;
};

type CommandPaletteProps = {
  title: string;
  placeholder: string;
  emptyLabel: string;
  closeLabel: string;
  items: CommandItem[];
  onClose: () => void;
};

function normalizeQuery(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

export function CommandPalette({
  title,
  placeholder,
  emptyLabel,
  closeLabel,
  items,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const rowsRef = useRef(new Map<string, HTMLButtonElement>());
  const executedRef = useRef(false);
  const id = useId();
  const titleId = `${id}-title`;
  const listId = `${id}-results`;
  const filteredItems = useMemo(() => {
    const terms = normalizeQuery(query).split(/\s+/).filter(Boolean);
    return items.filter((item) => {
      const searchable = normalizeQuery(`${item.label} ${item.detail || ""}`);
      return terms.every((term) => searchable.includes(term));
    });
  }, [items, query]);
  const activeIndex = filteredItems.length
    ? Math.max(0, filteredItems.findIndex((item) => item.id === activeId))
    : -1;
  const activeItemId = filteredItems[activeIndex]?.id;

  useEffect(() => {
    const closingDialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      // A command may open another dialog in this same commit. Let its
      // autofocus run before deciding whether the trigger needs focus back.
      queueMicrotask(() => {
        if (executedRef.current) return;
        const active = document.activeElement;
        const focusNeedsRestoring = !active || active === document.body ||
          !active.isConnected || Boolean(closingDialog?.contains(active));
        if (focusNeedsRestoring && previousFocus?.isConnected && !previousFocus.closest("[inert]")) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, []);

  useEffect(() => {
    if (activeItemId) rowsRef.current.get(activeItemId)?.scrollIntoView({ block: "nearest" });
  }, [activeItemId]);

  const selectItem = (item: CommandItem) => {
    if (executedRef.current) return;
    executedRef.current = true;
    onClose();
    item.onSelect();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Enter confirms an IME candidate before it may execute a command.
    if (event.nativeEvent.isComposing || event.key === "Process") return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (!filteredItems.length) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (activeIndex + direction + filteredItems.length) % filteredItems.length;
      setActiveId(filteredItems[nextIndex].id);
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat && activeIndex >= 0) selectItem(filteredItems[activeIndex]);
      return;
    }
    if (event.key === "Tab") {
      const dialog = dialogRef.current;
      const focusable = Array.from(dialog?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]',
      ) || []).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert]"));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !dialog?.contains(current))) {
        event.preventDefault();
        event.stopPropagation();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog?.contains(current))) {
        event.preventDefault();
        event.stopPropagation();
        first.focus();
      }
    }
  };

  return (
    <div
      className="command-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <section
        ref={dialogRef}
        className="command-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
      >
        <h2 id={titleId} className="visually-hidden">{title}</h2>
        <div className="command-input-row">
          <UiIcon name="search" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveId(null); }}
            placeholder={placeholder}
            aria-label={placeholder}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" onClick={onClose} aria-label={closeLabel} title={closeLabel}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="command-results" id={listId} role="listbox" aria-label={title}>
          {filteredItems.map((item, index) => (
            <button
              key={item.id}
              id={`${listId}-${index}`}
              data-command-id={item.id}
              ref={(element) => {
                if (element) rowsRef.current.set(item.id, element);
                else rowsRef.current.delete(item.id);
              }}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className={`command-result ${index === activeIndex ? "is-active" : ""}`}
              onPointerMove={() => setActiveId(item.id)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selectItem(item)}
            >
              <UiIcon name={item.icon} />
              <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
            </button>
          ))}
          {!filteredItems.length && <p className="command-empty" role="status">{emptyLabel}</p>}
        </div>
      </section>
    </div>
  );
}
