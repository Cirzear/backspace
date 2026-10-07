import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { layoutRect } from '../../platform/interfaceScale';

/**
 * Tracks the live composer DOM element and updates the `--composer-clearance`
 * CSS custom property on its parent element using ResizeObserver.
 */
export function useComposerClearance(deps: {
  isMobile: boolean;
  keyboardOpen: boolean;
  textInputFocused: boolean;
  chatReplyTo: unknown;
  stagedCount: number;
}) {
  const [composerEl, setComposerEl] = useState<HTMLDivElement | null>(null);
  const popoverAnchorRef = useRef<HTMLDivElement | null>(null);
  const clearanceTargetRef = useRef<HTMLElement | null>(null);

  const setComposerRef = useCallback((node: HTMLDivElement | null) => {
    popoverAnchorRef.current = node;
    setComposerEl(node);
  }, []);

  const syncClearance = useCallback((el: HTMLDivElement) => {
    const target = el.parentElement;
    if (!target) return;
    const composerRect = layoutRect(el.getBoundingClientRect());
    const parentRect = layoutRect(target.getBoundingClientRect());
    const bottomOffset = Math.max(0, parentRect.bottom - composerRect.bottom);
    const clearance = `${Math.round(composerRect.height + bottomOffset + 12)}px`;
    if (target.style.getPropertyValue('--composer-clearance') !== clearance) {
      target.style.setProperty('--composer-clearance', clearance);
    }
  }, []);

  useLayoutEffect(() => {
    if (!composerEl) return;
    const target = composerEl.parentElement;
    if (!target) return;
    const previousTarget = clearanceTargetRef.current;
    if (previousTarget && previousTarget !== target) {
      previousTarget.style.removeProperty('--composer-clearance');
    }
    clearanceTargetRef.current = target;
    const el = composerEl;
    const sync = () => syncClearance(el);

    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    ro.observe(target);

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', sync);
      vv.addEventListener('scroll', sync);
    }

    return () => {
      ro.disconnect();
      if (vv) {
        vv.removeEventListener('resize', sync);
        vv.removeEventListener('scroll', sync);
      }
    };
  }, [composerEl, syncClearance]);

  useLayoutEffect(() => () => {
    clearanceTargetRef.current?.style.removeProperty('--composer-clearance');
    clearanceTargetRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (composerEl) syncClearance(composerEl);
  }, [
    composerEl,
    syncClearance,
    deps.isMobile,
    deps.keyboardOpen,
    deps.textInputFocused,
    deps.chatReplyTo,
    deps.stagedCount,
  ]);

  return { setComposerRef, popoverAnchorRef };
}
