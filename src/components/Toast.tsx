/**
 * Minimal toast system: stacked notifications with auto-dismiss + manual close.
 *
 * Three kinds (`'info' | 'warning' | 'error'`) drive only the accent color.
 * Persistent toasts (no auto-dismiss) need an explicit close action.
 *
 * Usage:
 *   1. Wrap the app in <ToastProvider />
 *   2. Call useToast() and `push({ title, message, kind, persistent })`
 *
 * Behaviour goals:
 *   - Stacks bottom-right; newest on top.
 *   - Auto-dismiss after 6s by default.
 *   - Pointer-events on the close button only — toasts never block clicks.
 */
/* eslint-disable react-refresh/only-export-components -- Provider and companion hook intentionally share one context module. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import './Toast.css';

export interface ToastSpec {
  title?: string;
  message: string;
  kind?: 'info' | 'warning' | 'error';
  /** Stays until user closes. Auto-dismiss otherwise. */
  persistent?: boolean;
  /** Override auto-dismiss timeout (ms). Default 6000. */
  timeoutMs?: number;
  /** Dedupe-key. If a toast with the same key is already visible, the
   *  new one is suppressed. Useful for boot-time migration banners. */
  dedupeKey?: string;
  /** One button next to the message; pressing it also closes the toast. */
  action?: { label: string; onClick: () => void };
}

interface Toast extends ToastSpec {
  id: number;
}

interface ToastContextValue {
  push(spec: ToastSpec): void;
  dismiss(id: number): void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) { clearTimeout(timer); timersRef.current.delete(id); }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((spec: ToastSpec) => {
    setToasts((prev) => {
      if (spec.dedupeKey && prev.some((t) => t.dedupeKey === spec.dedupeKey)) return prev;
      const id = nextIdRef.current++;
      const toast: Toast = { id, ...spec };
      if (!spec.persistent) {
        const timeout = spec.timeoutMs ?? 6000;
        const timer = setTimeout(() => dismiss(id), timeout);
        timersRef.current.set(id, timer);
      }
      return [toast, ...prev];
    });
  }, [dismiss]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const ctx = useMemo<ToastContextValue>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div
        aria-live="polite"
        className="toast-stack"
      >
        {toasts.map((t) => <ToastView key={t.id} toast={t} onClose={() => dismiss(t.id)} />)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    return {
      push: () => { /* no provider — silent no-op so non-app contexts (tests) don't crash */ },
      dismiss: () => {},
    };
  }
  return ctx;
}

function ToastView({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const accent = toast.kind === 'error' ? '#e74c3c'
    : toast.kind === 'warning' ? '#f5a623'
    : '#4a9eff';
  return (
    <div
      role="status"
      className="toast-notification"
      style={{
        background: 'rgba(30,30,30,0.96)',
        border: `1px solid ${accent}`,
        borderLeft: `4px solid ${accent}`,
        padding: '10px 12px',
        borderRadius: 4,
        color: '#eee',
        boxShadow: '0 2px 12px rgba(0,0,0,0.4)',
        fontSize: 12,
        lineHeight: 1.4,
        display: 'flex', alignItems: 'flex-start', gap: 8,
      }}
    >
      <div style={{ flex: 1 }}>
        {toast.title && (
          <div style={{ fontWeight: 600, marginBottom: 2, color: accent }}>{toast.title}</div>
        )}
        <div>{toast.message}</div>
        {toast.action && (
          <button
            onClick={() => { toast.action?.onClick(); onClose(); }}
            className="toast-action"
            style={{
              background: 'transparent', border: 'none', color: accent,
              cursor: 'pointer', fontSize: 12, fontWeight: 600,
              padding: 0, marginTop: 6, textDecoration: 'underline',
            }}
          >{toast.action.label}</button>
        )}
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        className="toast-close"
        style={{
          background: 'transparent', border: 'none', color: '#aaa',
          cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1,
        }}
      >×</button>
    </div>
  );
}
