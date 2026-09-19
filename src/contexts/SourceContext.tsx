/* eslint-disable react-refresh/only-export-components -- Provider and companion hook intentionally share one context module. */
import { createContext, useContext } from 'react';
import type { PhotoView, SourceRow } from '../storage/repos';

export interface SourceContextValue {
  sources: SourceRow[];
  getDisplayUrl: (photo: PhotoView) => Promise<string | null>;
  getFile?: (photo: PhotoView, signal?: AbortSignal) => Promise<File | null>;
  scanning: boolean;
  disconnectedIds: string[];
  reconnectSource: (id: string) => void;
}

const SourceContext = createContext<SourceContextValue | null>(null);

export function useSourceContext(): SourceContextValue {
  const ctx = useContext(SourceContext);
  if (!ctx) {
    // During HMR, contexts can temporarily be null. Return safe fallback.
    console.warn('useSourceContext: no provider found (HMR?). Using fallback.');
    return {
      sources: [],
      getDisplayUrl: async () => null,
      scanning: false,
      disconnectedIds: [],
      reconnectSource: () => {},
    };
  }
  return ctx;
}

interface SourceProviderProps {
  value: SourceContextValue;
  children: React.ReactNode;
}

export function SourceProvider({ value, children }: SourceProviderProps) {
  return <SourceContext.Provider value={value}>{children}</SourceContext.Provider>;
}
