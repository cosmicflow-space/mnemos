"use client";

export type Theme = "dark" | "light";

/** Current theme from the <html> class (set pre-paint by the layout script). */
export function getTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

/** Apply + persist a theme. Toggles the class set the Tailwind tokens key off. */
export function setTheme(t: Theme): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.classList.toggle("light", t === "light");
  el.classList.toggle("dark", t === "dark");
  try {
    localStorage.setItem("mnemos.theme", t);
  } catch {
    // private mode / storage disabled — theme still applies for this session
  }
}
