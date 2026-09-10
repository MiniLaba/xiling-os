const key = "xiling:main-session";
export function selectedSession(): string | undefined {
  try { return localStorage.getItem(key) || undefined; } catch { return undefined; }
}
export function selectSession(id?: string) {
  try { if (id) localStorage.setItem(key, id); else localStorage.removeItem(key); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent("xiling:main-session-change", { detail: id }));
}
