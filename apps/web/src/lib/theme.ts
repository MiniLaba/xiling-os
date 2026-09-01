import { useEffect, useState } from "react";

export type ThemePreference = "system" | "lingjing" | "poxiao";
export type ResolvedTheme = "lingjing" | "poxiao";

const STORAGE_KEY = "xiling-theme";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "lingjing" || value === "poxiao" ? value : "system";
  } catch { return "system"; }
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "lingjing" : "poxiao";
}

function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = preference === "system" ? systemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

/** 汐语灵境主题：跟随系统，可在设置中手动覆盖（localStorage 持久）。 */
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
