"use client";

export type Theme = "dark" | "light";

/** Broadcast on theme change so all theme controls (settings toggle + the
 * floating switcher) stay in sync regardless of which one was used. */
export const THEME_EVENT = "mnemos:themechange";

/** Broadcast when the floating quick-toggle's visibility preference changes. */
export const THEME_FAB_EVENT = "mnemos:themefab";

/** localStorage keys (exported so consumers can match cross-tab `storage` events). */
export const THEME_KEY = "mnemos.theme";
export const THEME_FAB_KEY = "mnemos.ui.themeFab";
const FAB_KEY = THEME_FAB_KEY;

/**
 * Whether the floating quick-toggle is hidden. This is a per-machine UI
 * preference, stored in localStorage alongside `mnemos.theme` — NOT in the
 * SQLite knowledge store (that file is reserved for RAG content/creds/history).
 * Defaults to shown.
 */
export function isThemeFabHidden(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(FAB_KEY) === "hidden";
  } catch {
    return false;
  }
}

/** Persist the floating-toggle visibility preference and notify listeners. */
export function setThemeFabHidden(hidden: boolean): void {
  try {
    localStorage.setItem(FAB_KEY, hidden ? "hidden" : "shown");
  } catch {
    // private mode / storage disabled — applies for this session only
  }
  try {
    window.dispatchEvent(new Event(THEME_FAB_EVENT));
  } catch {
    // SSR / no window
  }
}

/** Current theme from the <html> class (set pre-paint by the layout script). */
export function getTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** Apply + persist a theme. Toggles the class set the Tailwind tokens key off. */
/**
 * Re-apply the theme class from localStorage onto <html>. Used to handle the
 * `storage` event, which fires only in OTHER tabs — there the DOM class is stale
 * until we re-read the persisted value. (The originating tab is covered by the
 * same-tab THEME_EVENT, so the two paths never double-fire.)
 */
export function applyStoredTheme(): void {
  if (typeof document === "undefined" || typeof localStorage === "undefined") return;
  let t: string | null = null;
  try {
    t = localStorage.getItem(THEME_KEY);
  } catch {
    return;
  }
  if (t === "light" || t === "dark") {
    const el = document.documentElement;
    el.classList.toggle("light", t === "light");
    el.classList.toggle("dark", t === "dark");
  }
}

export function setTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.toggle("light", t === "light");
  el.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    // private mode / storage disabled — theme still applies for this session
  }
  // Notify any mounted theme controls so they reflect the new value.
  try {
    window.dispatchEvent(new Event(THEME_EVENT));
  } catch {
    // SSR / no window — nothing to notify
  }
}
