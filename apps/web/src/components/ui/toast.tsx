import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, XCircle, X } from "lucide-react";

export interface ToastInput { title: string; description?: string; tone?: "success" | "info" | "warning" | "danger"; action?: { label: string; onClick: () => void } }
interface ToastItem extends ToastInput { id: number }

const ToastContext = createContext<{ push: (toast: ToastInput) => void }>({ push: () => undefined });

export function useToast() { return useContext(ToastContext); }

const toneIcon = { success: CheckCircle2, info: Info, warning: AlertTriangle, danger: XCircle } as const;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);
  const push = useCallback((toast: ToastInput) => {
    const id = ++counter.current;
    setItems((current) => [...current.slice(-4), { ...toast, id }]);
    window.setTimeout(() => dismiss(id), 3_200);
  }, [dismiss]);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="xl-toast-host" role="status" aria-live="polite">
        {items.map((item) => {
          const Icon = toneIcon[item.tone ?? "info"];
          return (
            <div className="xl-toast xl-rise" key={item.id} data-tone={item.tone ?? "info"}>
              <Icon size={17} aria-hidden="true" />
              <div className="xl-toast-text">
                <b>{item.title}</b>
                {item.description ? <small>{item.description}</small> : null}
              </div>
              {item.action ? <button className="xl-toast-action" onClick={() => { item.action!.onClick(); dismiss(item.id); }}>{item.action.label}</button> : null}
              <button className="xl-icon-btn" aria-label="关闭通知" onClick={() => dismiss(item.id)}><X size={14} /></button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
