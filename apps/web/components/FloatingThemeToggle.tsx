"use client";

import { useEffect, useRef, useState } from "react";
import {
  getTheme,
  setTheme,
  isThemeFabHidden,
  setThemeFabHidden,
  applyStoredTheme,
  THEME_EVENT,
  THEME_FAB_EVENT,
  THEME_KEY,
  THEME_FAB_KEY,
  type Theme,
} from "@/lib/theme";

/**
 * Small, non-intrusive quick theme toggle that floats just above the composer's
 * send button. Tapping it opens a compact popover — Light (Zen) / Dark (Cosmic)
 * / Hide. It's a convenience shortcut for the canonical control in the bottom-
 * left Settings menu; "Hide" persists a preference (localStorage) so the button
 * can be removed entirely and re-shown later from Settings.
 *
 * a11y: the popover is a labelled group of plain buttons (NOT an ARIA menu — we
 * don't implement the menu keyboard model, so we don't claim it). Tab moves
 * between options natively; Escape / outside-click close and return focus to the
 * trigger; choosing "Hide" hands focus to the Settings launcher so keyboard
 * users aren't stranded when this control unmounts.
 *
 * Styled with semantic tokens (`bg-elevated`, `text-fg`, `border-line`) so it
 * auto-adapts to either theme. Stays in sync with the Settings toggle via
 * same-tab custom events, and across tabs via the `storage` event.
 */
export function FloatingThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [theme, setThemeStateLocal] = useState<Theme>("dark");
  const [hidden, setHidden] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);

  // Initialise from storage post-mount (avoids hydration mismatch) and keep in
  // sync with any other control: same-tab via custom events, cross-tab via the
  // `storage` event (which fires only in other tabs, so no double-fire here).
  useEffect(() => {
    setMounted(true);
    setThemeStateLocal(getTheme());
    setHidden(isThemeFabHidden());
    const syncTheme = () => setThemeStateLocal(getTheme());
    const syncFab = () => setHidden(isThemeFabHidden());
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) {
        applyStoredTheme();
        syncTheme();
      } else if (e.key === THEME_FAB_KEY) {
        syncFab();
      }
    };
    window.addEventListener(THEME_EVENT, syncTheme);
    window.addEventListener(THEME_FAB_EVENT, syncFab);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(THEME_EVENT, syncTheme);
      window.removeEventListener(THEME_FAB_EVENT, syncFab);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  // While open: close on outside-click / Escape, returning focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const close = () => {
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Move focus into the popover when it opens (keyboard users land on a choice).
  useEffect(() => {
    if (open) firstOptionRef.current?.focus();
  }, [open]);

  if (!mounted || hidden) return null;

  const choose = (t: Theme) => {
    setTheme(t);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const hide = () => {
    setThemeFabHidden(true);
    setOpen(false);
    // The trigger is about to unmount — hand focus to the Settings launcher so
    // keyboard users aren't dropped to <body>. (Falls back gracefully if absent.)
    const launcher = document.querySelector<HTMLElement>(
      'button[aria-label="Settings & Sources"]',
    );
    launcher?.focus();
  };

  const itemBase =
    "w-full flex items-center justify-between gap-2 px-3 py-2 text-fg hover:bg-surface transition " +
    "focus:outline-none focus-visible:bg-surface focus-visible:ring-2 focus-visible:ring-cyan-500/60 focus-visible:ring-inset";

  return (
    <div ref={ref} className="absolute bottom-12 right-0.5 z-30">
      {open && (
        <div
          role="group"
          aria-label="Theme"
          className="absolute bottom-11 right-0 w-44 rounded-xl border border-line bg-elevated shadow-2xl overflow-hidden text-sm"
        >
          <button
            ref={firstOptionRef}
            type="button"
            aria-pressed={theme === "light"}
            onClick={() => choose("light")}
            className={itemBase}
          >
            <span className="flex items-center gap-2"><span aria-hidden>☀️</span> Light</span>
            {theme === "light" && <span aria-hidden className="text-cyan-500">✓</span>}
          </button>
          <button
            type="button"
            aria-pressed={theme === "dark"}
            onClick={() => choose("dark")}
            className={itemBase}
          >
            <span className="flex items-center gap-2"><span aria-hidden>🌙</span> Dark</span>
            {theme === "dark" && <span aria-hidden className="text-cyan-500">✓</span>}
          </button>
          <div className="border-t border-line" />
          <button
            type="button"
            onClick={hide}
            className={
              "w-full flex items-center gap-2 px-3 py-2 text-muted hover:bg-surface hover:text-fg transition " +
              "focus:outline-none focus-visible:bg-surface focus-visible:text-fg focus-visible:ring-2 focus-visible:ring-cyan-500/60 focus-visible:ring-inset"
            }
          >
            <span aria-hidden>🙈</span> Hide (restore in Settings)
          </button>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Theme"
        aria-label="Theme"
        className="w-9 h-9 rounded-full flex items-center justify-center text-base border border-line
                   bg-elevated/90 backdrop-blur shadow-md hover:scale-110 hover:border-line-strong transition
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/70 focus-visible:ring-offset-2
                   focus-visible:ring-offset-app print:hidden"
      >
        <span className="drop-shadow-sm" aria-hidden>{theme === "dark" ? "🌙" : "🌍"}</span>
      </button>
    </div>
  );
}
