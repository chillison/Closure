import { useRef } from 'react';
import type { MouseEvent, PointerEvent } from 'react';

/**
 * Overlay dismissal that ignores text-selection misfires. A bare overlay
 * `onClick={onClose}` closes the dialog when a drag-selection that started
 * inside the dialog is released over the overlay — the click event fires on
 * the common ancestor (the overlay), so `stopPropagation` on the panel cannot
 * prevent it (dogfood 2026-08-20: 新建项目对话框选中项目名即误关). Only a press
 * that BOTH started and ended on the overlay itself dismisses.
 *
 * Usage: `<div className="…-overlay" role="dialog" aria-modal="true" {...useOverlayDismiss(onClose)}>`
 */
export function useOverlayDismiss(onClose: () => void): {
  onPointerDown: (e: PointerEvent<HTMLDivElement>) => void;
  onClick: (e: MouseEvent<HTMLDivElement>) => void;
} {
  const startedOnOverlay = useRef(false);
  return {
    onPointerDown: (e) => {
      startedOnOverlay.current = e.target === e.currentTarget;
    },
    onClick: (e) => {
      const dismiss = startedOnOverlay.current && e.target === e.currentTarget;
      startedOnOverlay.current = false;
      if (dismiss) onClose();
    },
  };
}
