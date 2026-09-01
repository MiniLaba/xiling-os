import { useEffect, useState } from "react";

export type ThemePreference = "system" | "lingjing" | "poxiao";
export type ResolvedTheme = "lingjing" | "poxiao";

const STORAGE_KEY = "xiling-theme";
export const DEFAULT_THEME_PREFERENCE: ThemePreference = "lingjing";

export function parseStoredTheme(value: string | null): ThemePreference {
  return value === "system" || value === "lingjing" || value === "poxiao" ? value : DEFAULT_THEME_PREFERENCE;
}

function readPreference(): ThemePreference {
  try {
    return parseStoredTheme(localStorage.getItem(STORAGE_KEY));
  } catch { return DEFAULT_THEME_PREFERENCE; }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "lingjing" : "poxiao";
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** 在 React 首次渲染前应用主题，避免默认灵境闪成浅色或延迟读取用户选择。 */
export function initializeTheme(): ResolvedTheme {
  return applyTheme(readPreference());
}

/** 汐语灵境主题：首次使用默认灵境，可在设置中手动覆盖（localStorage 持久）。 */
export function useTheme(): { preference: ThemePreference; resolved: ResolvedTheme; setPreference: (next: ThemePreference) => void } {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readPreference());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => applyTheme(readPreference()));

  useEffect(() => {
    setResolved(applyTheme(preference));
    try {
      if (preference === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, preference);
    } catch { /* storage unavailable */ }
  }, [preference]);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(applyTheme("system"));
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  return { preference, resolved, setPreference: setPreferenceState };
}
