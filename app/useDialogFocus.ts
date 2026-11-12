"use client";

import { useEffect } from "react";

/** Keep keyboard navigation inside the current editor, including changing categories. */
export function useDialogFocus(selector: string | null) {
  useEffect(() => {
    if (!selector) return;
    const dialog = document.querySelector<HTMLElement>(selector);
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0 && !element.closest("[inert], [hidden]"));
    if (!dialog.contains(document.activeElement)) focusable()[0]?.focus({ preventScroll: true });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      const first = elements[0];
      const last = elements.at(-1);
      const current = document.activeElement;
      if (!first || !last) {
        event.preventDefault();
      } else if (event.shiftKey && (current === first || !dialog.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !dialog.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trapFocus, true);
    return () => {
      document.removeEventListener("keydown", trapFocus, true);
      queueMicrotask(() => {
        if (document.querySelector('.app-shell [aria-modal="true"]')) return;
        if (previousFocus?.isConnected && !previousFocus.closest("[inert]")) previousFocus.focus({ preventScroll: true });
      });
    };
  }, [selector]);
}
