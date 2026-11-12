"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { CommandItem } from "./CommandPalette";
import { UiIcon } from "./UiIcon";

export type ChromeMenuItem = CommandItem & {
  checked?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
};

type ChromeMenuProps = {
  title: string;
  items: ChromeMenuItem[];
  anchor: "top" | "bottom";
  sidebarRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

type MenuBounds = { left: number; top: number; bottom: number; width: number; height: number };

export function ChromeMenu({ title, items, anchor, sidebarRef, onClose }: ChromeMenuProps) {
  const menuRef = useRef<HTMLElement>(null);
  const executedRef = useRef(false);
  const previousFocusRef = useRef<{ captured: boolean; element: HTMLElement | null }>({ captured: false, element: null });
  const [bounds, setBounds] = useState<MenuBounds | null>(null);
  const positioned = bounds !== null;

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    const list = sidebar?.querySelector<HTMLElement>(".board-list");
    if (!sidebar || !list) return;
    if (!previousFocusRef.current.captured) {
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // Making the sidebar inert can move focus to the body before this effect runs.
      const trigger = sidebar.querySelector<HTMLElement>(anchor === "top" ? ".sidebar-main-menu" : ".sidebar-create-menu");
      previousFocusRef.current = { captured: true, element: active && active !== document.body ? active : trigger };
    }
    const shell = sidebar.closest<HTMLElement>(".app-shell");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const rect = list.getBoundingClientRect();
      const left = Math.max(0, Math.min(window.innerWidth, rect.left));
      const right = Math.max(left, Math.min(window.innerWidth, rect.right));
      const top = Math.max(0, Math.min(window.innerHeight, rect.top));
      const bottom = Math.max(top, Math.min(window.innerHeight, rect.bottom));
      const next = { left, top, bottom: window.innerHeight - bottom, width: right - left, height: bottom - top };
      setBounds((current) => {
        if (!next.width || !next.height) return null;
        return current && Object.keys(next).every((key) => current[key as keyof MenuBounds] === next[key as keyof MenuBounds])
          ? current : next;
      });
    };
    const scheduleMeasure = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };
    measure();
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(list);
    resizeObserver.observe(sidebar);
    if (shell) resizeObserver.observe(shell);
    // Mode changes can move the list without changing its dimensions.
    const mutationObserver = new MutationObserver(scheduleMeasure);
    mutationObserver.observe(sidebar, { attributes: true });
    if (shell) mutationObserver.observe(shell, { attributes: true });
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    sidebar.addEventListener("transitionend", scheduleMeasure);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", scheduleMeasure);
    viewport?.addEventListener("scroll", scheduleMeasure);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      sidebar.removeEventListener("transitionend", scheduleMeasure);
      viewport?.removeEventListener("resize", scheduleMeasure);
      viewport?.removeEventListener("scroll", scheduleMeasure);
    };
  }, [anchor, sidebarRef]);

  useLayoutEffect(() => {
    if (!positioned) return;
    const list = sidebarRef.current?.querySelector<HTMLElement>(".board-list");
    const menu = menuRef.current;
    if (!list || !menu) return;
    // Preserve the backdrop beneath the translucent menu without hiding cards
    // elsewhere in the list. Clipping leaves layout and scroll position intact.
    const updateClip = () => {
      const listRect = list.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const top = anchor === "top" ? Math.min(listRect.height, Math.max(0, menuRect.bottom - listRect.top)) : 0;
      const bottom = anchor === "bottom" ? Math.min(listRect.height, Math.max(0, listRect.bottom - menuRect.top)) : 0;
      list.style.setProperty("--chrome-menu-clip-top", `${top}px`);
      list.style.setProperty("--chrome-menu-clip-bottom", `${bottom}px`);
    };
    updateClip();
    const observer = new ResizeObserver(updateClip);
    observer.observe(menu);
    observer.observe(list);
    return () => {
      observer.disconnect();
      list.style.removeProperty("--chrome-menu-clip-top");
      list.style.removeProperty("--chrome-menu-clip-bottom");
    };
  }, [anchor, bounds, positioned, sidebarRef]);

  useEffect(() => {
    if (!positioned) return;
    const closingMenu = menuRef.current;
    const previousFocus = previousFocusRef.current.element;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    return () => {
      // Preserve autofocus if this action opened another dialog.
      queueMicrotask(() => {
        if (executedRef.current) return;
        const active = document.activeElement;
        const focusNeedsRestoring = !active || active === document.body ||
          !active.isConnected || Boolean(closingMenu?.contains(active));
        if (focusNeedsRestoring && previousFocus?.isConnected && !previousFocus.closest("[inert]")) {
          previousFocus.focus({ preventScroll: true });
        }
      });
    };
  }, [positioned]);

  const selectItem = (item: ChromeMenuItem) => {
    if (item.disabled || executedRef.current) return;
    executedRef.current = true;
    onClose();
    item.onSelect();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      const enabled = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") || []);
      if (!enabled.length) return;
      const currentIndex = enabled.findIndex((button) => button === document.activeElement);
      let nextIndex;
      if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = enabled.length - 1;
      else if (currentIndex < 0) nextIndex = event.key === "ArrowDown" ? 0 : enabled.length - 1;
      else nextIndex = (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
      enabled[nextIndex].focus({ preventScroll: true });
      enabled[nextIndex].scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.repeat && (event.key === "Enter" || event.code === "Space")) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return (
    <div
      className="chrome-menu-layer"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <section
        ref={menuRef}
        className={`chrome-menu is-${anchor}`}
        style={{
          left: bounds?.left,
          width: bounds?.width,
          maxHeight: bounds?.height,
          top: anchor === "top" ? bounds?.top : "auto",
          bottom: anchor === "bottom" ? bounds?.bottom : "auto",
          visibility: bounds ? "visible" : "hidden",
        }}
        role="menu"
        aria-label={title}
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => (
          <Fragment key={item.id}>
            {item.separatorBefore && <div className="chrome-menu-separator" role="separator" />}
            <button
              type="button"
              className="chrome-menu-item"
              data-menu-item-id={item.id}
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              disabled={item.disabled}
              tabIndex={-1}
              onClick={() => selectItem(item)}
            >
              <UiIcon name={item.icon} />
              <span><span>{item.label}</span>{item.detail && <small>{item.detail}</small>}</span>
              {item.checked && <UiIcon name="check" />}
            </button>
          </Fragment>
        ))}
      </section>
    </div>
  );
}
