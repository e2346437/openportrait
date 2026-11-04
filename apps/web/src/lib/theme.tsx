import { useCallback, useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "op-theme";
const COLORS = { light: "#f3eee5", dark: "#151412" };

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Apply a preference to the page and the browser's theme-color bar. */
export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  // A manual choice overrides the media-scoped theme-color tags with an unscoped one.
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (pref === "system") {
    meta?.remove();
    return;
  }
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = COLORS[pref];
}

export function setTheme(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* private mode: the choice still applies for this visit */
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent("op-theme"));
}

export const THEME_LABEL: Record<ThemePref, string> = { system: "Match device", light: "Light", dark: "Dark" };
const NEXT: Record<ThemePref, ThemePref> = { system: "light", light: "dark", dark: "system" };

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readTheme);
  useEffect(() => {
    const on = () => setPref(readTheme());
    window.addEventListener("op-theme", on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener("op-theme", on);
      window.removeEventListener("storage", on);
    };
  }, []);
  const cycle = useCallback(() => setTheme(NEXT[readTheme()]), []);
  return { pref, set: setTheme, cycle };
}
