/* eslint-disable react-refresh/only-export-components -- Provider and companion hook intentionally share one context module. */
import { createContext, useContext } from 'react';
import type { HistogramStyle } from '../types';

export interface SettingsContextValue {
  histogramStyle: HistogramStyle;
  setHistogramStyle: (s: HistogramStyle) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    console.warn('useSettings: no provider found (HMR?). Using fallback.');
    return { histogramStyle: 'filled', setHistogramStyle: () => {} };
  }
  return ctx;
}

interface SettingsProviderProps {
  value: SettingsContextValue;
  children: React.ReactNode;
}

export function SettingsProvider({ value, children }: SettingsProviderProps) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
