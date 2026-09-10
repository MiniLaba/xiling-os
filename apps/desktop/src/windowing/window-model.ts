export interface WindowGeometry {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  state: "open" | "minimized" | "maximized";
}

export interface ViewportBounds {
  width: number;
  height: number;
  topInset: number;
  bottomInset: number;
}

export function fitWindowToViewport<T extends WindowGeometry>(
  model: T,
  viewport: ViewportBounds,
  minimum = { width: 460, height: 300 },
): T {
  const maxWidth = Math.max(minimum.width, viewport.width - 24);
  const maxHeight = Math.max(minimum.height, viewport.height - viewport.topInset - viewport.bottomInset);
  const width = Math.min(maxWidth, Math.max(minimum.width, model.width));
  const height = Math.min(maxHeight, Math.max(minimum.height, model.height));
  return {
    ...model,
    width,
    height,
    x: Math.max(8, Math.min(viewport.width - width - 8, model.x)),
    y: Math.max(viewport.topInset, Math.min(viewport.height - height - viewport.bottomInset, model.y)),
  };
}

export function mergeRestoredWindows<T extends WindowGeometry & { appKey: string }>(
  current: readonly T[],
  restored: readonly T[],
): T[] {
  const byId = new Map(restored.map((item) => [item.id, item]));
  for (const item of current) {
    const saved = byId.get(item.id);
    byId.set(item.id, saved ? { ...item, ...saved, appKey: item.appKey, state: "open" } : item);
  }
  return [...byId.values()];
}

export function nextWindowToFocus<T extends WindowGeometry>(windows: readonly T[]): T | undefined {
  return windows
    .filter((item) => item.state !== "minimized")
    .sort((a, b) => b.zIndex - a.zIndex)[1];
}
