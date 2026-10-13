import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
}

export interface ToastApi {
  push(message: string, kind?: ToastKind): void;
}

const NOOP: ToastApi = { push: () => undefined };
const ToastContext = createContext<ToastApi>(NOOP);
const TOAST_MS = 3500;
const MAX_VISIBLE = 4;
let seq = 0;

/** Simple bottom-right toast stack. Mount once near the root; use `useToast().push(...)` anywhere below. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timers = useRef<number[]>([]);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback(
    (message: string, kind: ToastKind = 'info') => {
      const id = ++seq;
      setItems((list) => [...list, { id, message, kind }].slice(-MAX_VISIBLE));
      if (typeof window !== 'undefined') {
        const t = window.setTimeout(() => dismiss(id), TOAST_MS);
        timers.current.push(t);
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
    };
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <button key={t.id} type="button" className={`toast toast--${t.kind}`} onClick={() => dismiss(t.id)} title="Dismiss">
            {t.message}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Toast API; a no-op outside a `ToastProvider` so components stay testable in isolation. */
export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export default ToastProvider;
