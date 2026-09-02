import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

type WindowStatus = "open" | "minimized" | "maximized";

interface PersistedWindowState {
  id: string;
  appId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;
  state: WindowStatus;
  payload: Record<string, unknown>;
  updatedAt: string;
}

interface DesktopBridge {
  windowState: {
    list(): Promise<PersistedWindowState[]>;
    save(state: PersistedWindowState): Promise<{ saved: true }>;
  };
}

declare global {
  interface Window {
    xilingDesktop?: DesktopBridge;
  }
}

const APP_DEFINITIONS = {
  chat: { appId: "system.chat", title: "对话", eyebrow: "智能体", body: "在这里与科研智能体协作；运行过程与对话保持同一任务上下文。" },
  research: { appId: "system.research", title: "研究", eyebrow: "科研空间", body: "研究问题、证据、计算与产物将通过可追溯关系组织。" },
  literature: { appId: "system.literature", title: "文献", eyebrow: "发现与阅读", body: "搜索论文、阅读原文并把标注转为可引用证据。" },
  data: { appId: "system.data", title: "数据", eyebrow: "数据工作区", body: "连接、检查和组织科研数据；计算运行时按任务加载。" },
  settings: { appId: "system.settings", title: "设置", eyebrow: "系统", body: "管理模型、Skill、MCP、权限、更新与资源预算。" },
} as const;

type AppKey = keyof typeof APP_DEFINITIONS;

interface ManagedWindow extends PersistedWindowState {
  appKey: AppKey;
}

const pendingApps: AppKey[] = [];
let reactRoot: Root | undefined;

function defaultWindow(appKey: AppKey, index: number): ManagedWindow {
  const definition = APP_DEFINITIONS[appKey];
  return {
    id: `managed-${appKey}`,
    appId: definition.appId,
    appKey,
    x: 116 + index * 34,
    y: 76 + index * 26,
    width: 620,
    height: 420,
    zIndex: 50 + index,
    state: "open",
    payload: {},
    updatedAt: new Date().toISOString(),
  };
}

async function saveWindow(state: ManagedWindow): Promise<void> {
  await window.xilingDesktop?.windowState.save({ ...state, updatedAt: new Date().toISOString() });
}

function InternalWindow({
  model,
  onChange,
  onFocus,
}: {
  model: ManagedWindow;
  onChange: (next: ManagedWindow, persist?: boolean) => void;
  onFocus: () => void;
}) {
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const definition = APP_DEFINITIONS[model.appKey];
  if (model.state === "minimized") return null;

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as Element).closest("button") || model.state === "maximized") return;
    drag.current = { dx: event.clientX - model.x, dy: event.clientY - model.y };
    event.currentTarget.setPointerCapture(event.pointerId);
    onFocus();
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    const width = Math.min(model.width, window.innerWidth - 24);
    const nextX = Math.max(8, Math.min(window.innerWidth - width - 8, event.clientX - drag.current.dx));
    const nextY = Math.max(30, Math.min(window.innerHeight - 100, event.clientY - drag.current.dy));
    onChange({ ...model, x: nextX, y: nextY });
  };

  const stopDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onChange(model, true);
  };

  const style = model.state === "maximized"
    ? { inset: "34px 12px 72px", zIndex: model.zIndex }
    : { left: model.x, top: model.y, width: model.width, height: model.height, zIndex: model.zIndex };

  return (
    <section className="managed-window" style={style} onPointerDown={onFocus}>
      <header className="managed-window-titlebar" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag}>
        <div className="leopard-traffic">
          <button className="traffic-close" type="button" aria-label={`关闭${definition.title}`} onClick={() => onChange({ ...model, state: "minimized" }, true)} />
          <button className="traffic-min" type="button" aria-label={`最小化${definition.title}`} onClick={() => onChange({ ...model, state: "minimized" }, true)} />
          <button className="traffic-zoom" type="button" aria-label={`最大化${definition.title}`} onClick={() => onChange({ ...model, state: model.state === "maximized" ? "open" : "maximized" }, true)} />
        </div>
        <strong>{definition.title}</strong>
        <span aria-hidden="true" />
      </header>
      <div className="managed-window-content">
        <p className="eyebrow">{definition.eyebrow}</p>
        <h2>{definition.title}</h2>
        <p>{definition.body}</p>
        <div className="managed-window-ready">应用能力已注册 · 内容将在使用时加载</div>
      </div>
    </section>
  );
}

function WindowManager() {
  const [windows, setWindows] = useState<ManagedWindow[]>(() =>
    pendingApps.map((appKey, index) => defaultWindow(appKey, index)),
  );
  const [topZ, setTopZ] = useState(60);

  useEffect(() => {
    let active = true;
    void window.xilingDesktop?.windowState.list().then((saved) => {
      if (!active) return;
      const restored = saved.flatMap((state): ManagedWindow[] => {
        const appKey = state.id.replace("managed-", "") as AppKey;
        return state.id.startsWith("managed-") && appKey in APP_DEFINITIONS ? [{ ...state, appKey }] : [];
      });
      if (restored.length) {
        setWindows((current) => {
          const byId = new Map(restored.map((item) => [item.id, item]));
          for (const item of current) byId.set(item.id, { ...byId.get(item.id), ...item, state: "open" });
          return [...byId.values()];
        });
        setTopZ(Math.max(60, ...restored.map((item) => item.zIndex)));
      }
    });

    const listener = (event: Event) => {
      const appKey = (event as CustomEvent<AppKey>).detail;
      if (!(appKey in APP_DEFINITIONS)) return;
      setWindows((current) => {
        const existing = current.find((item) => item.appKey === appKey);
        if (existing) return current.map((item) => item.id === existing.id ? { ...item, state: "open" } : item);
        return [...current, defaultWindow(appKey, current.length)];
      });
    };
    window.addEventListener("xiling:open-managed-app", listener);
    return () => {
      active = false;
      window.removeEventListener("xiling:open-managed-app", listener);
    };
  }, []);

  const update = (next: ManagedWindow, persist = false) => {
    setWindows((current) => current.map((item) => item.id === next.id ? next : item));
    if (persist) void saveWindow(next);
  };

  const focus = (model: ManagedWindow) => {
    const nextZ = topZ + 1;
    setTopZ(nextZ);
    update({ ...model, zIndex: nextZ });
  };

  return windows.map((model) => (
    <InternalWindow key={model.id} model={model} onChange={update} onFocus={() => focus(model)} />
  ));
}

export function openManagedApp(appKey: string): void {
  if (!(appKey in APP_DEFINITIONS)) return;
  const typedKey = appKey as AppKey;
  if (!reactRoot) {
    pendingApps.push(typedKey);
    const host = document.createElement("div");
    host.id = "managed-window-root";
    document.querySelector("#leopard")?.append(host);
    reactRoot = createRoot(host);
    reactRoot.render(<StrictMode><WindowManager /></StrictMode>);
    return;
  }
  window.dispatchEvent(new CustomEvent("xiling:open-managed-app", { detail: typedKey }));
}
