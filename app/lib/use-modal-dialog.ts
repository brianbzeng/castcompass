"use client";

import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

const modalStack: HTMLElement[] = [];
let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";

function isVisibleFocusable(element: HTMLElement) {
  if (element.getAttribute("aria-hidden") === "true" || element.closest("[inert]")) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function focusableElements(dialog: HTMLElement) {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisibleFocusable);
}

function lockBodyScroll() {
  if (bodyLockCount === 0) {
    bodyOverflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  bodyLockCount += 1;
}

function unlockBodyScroll() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
}

interface UseModalDialogOptions {
  open: boolean;
  onClose?: () => void;
  closeOnEscape?: boolean;
  lockScroll?: boolean;
  openerRef?: RefObject<HTMLElement | null>;
  restoreFocus?: () => HTMLElement | null;
}

/**
 * Keeps modal keyboard behavior coherent across nested product surfaces.
 *
 * Only the top entry in the shared stack may trap focus or consume Escape. This prevents a
 * location report, account surface, and trip editor from competing when one opens another.
 */
export function useModalDialog<T extends HTMLElement>({
  open,
  onClose,
  closeOnEscape = true,
  lockScroll = true,
  openerRef,
  restoreFocus,
}: UseModalDialogOptions) {
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusRef = useRef(restoreFocus);

  useEffect(() => {
    onCloseRef.current = onClose;
    restoreFocusRef.current = restoreFocus;
  }, [onClose, restoreFocus]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;

    const activeElement = document.activeElement;
    const capturedOpener = activeElement instanceof HTMLElement
      && activeElement !== document.body
      && activeElement !== document.documentElement
      ? activeElement
      : null;
    const explicitOpener = openerRef?.current ?? null;

    modalStack.push(dialog);
    if (lockScroll) lockBodyScroll();

    const focusFrame = window.requestAnimationFrame(() => {
      if (modalStack.at(-1) !== dialog) return;
      dialog.focus({ preventScroll: true });
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== dialog) return;

      if (event.key === "Escape" && closeOnEscape && onCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      if (!dialog.contains(current)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && (current === first || current === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (modalStack.at(-1) !== dialog || dialog.contains(event.target as Node)) return;
      event.stopPropagation();
      dialog.focus({ preventScroll: true });
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      const stackIndex = modalStack.lastIndexOf(dialog);
      if (stackIndex >= 0) modalStack.splice(stackIndex, 1);
      if (lockScroll) unlockBodyScroll();

      const fallbackDialog = modalStack.at(-1);
      const restoreTarget = restoreFocusRef.current?.()
        ?? explicitOpener
        ?? capturedOpener;
      window.requestAnimationFrame(() => {
        if (restoreTarget?.isConnected) {
          restoreTarget.focus({ preventScroll: true });
          if (document.activeElement === restoreTarget) return;
        }
        if (fallbackDialog?.isConnected) {
          fallbackDialog.focus({ preventScroll: true });
        }
      });
    };
  }, [closeOnEscape, lockScroll, open, openerRef]);

  return dialogRef;
}
