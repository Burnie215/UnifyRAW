/* eslint-disable react-refresh/only-export-components -- Provider and companion hook intentionally share one context module. */
import { createContext, useContext, useCallback, useRef, useMemo } from 'react';
import type { Adjustments } from '../types';
import { defaultAdjustments } from '../types';

export interface AdjustmentsContextValue {
  adjustments: Adjustments;
  onChange: (adj: Adjustments) => void;
  /** Shorthand: update a single key in adjustments */
  set: <K extends keyof Adjustments>(key: K, value: Adjustments[K]) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  history: Adjustments[];
  hasChanges: boolean;
  restoreToIndex: (index: number) => void;
  /** Name of the active adjustment layer being edited (null = editing base layer) */
  activeLayerName: string | null;
}

const AdjustmentsContext = createContext<AdjustmentsContextValue | null>(null);

export function useAdjustments(): AdjustmentsContextValue {
  const ctx = useContext(AdjustmentsContext);
  if (!ctx) {
    console.warn('useAdjustments: no provider found (HMR?). Using fallback.');
    return {
      adjustments: defaultAdjustments,
      onChange: () => {},
      set: () => {},
      canUndo: false, canRedo: false,
      onUndo: () => {}, onRedo: () => {},
      history: [], hasChanges: false,
      restoreToIndex: () => {},
      activeLayerName: null,
    };
  }
  return ctx;
}

interface AdjustmentsProviderProps {
  adjustments: Adjustments;
  onChange: (adj: Adjustments) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  history?: Adjustments[];
  restoreToIndex?: (index: number) => void;
  activeLayerName?: string | null;
  children: React.ReactNode;
}

export function AdjustmentsProvider({
  adjustments, onChange, canUndo, canRedo, onUndo, onRedo, history, restoreToIndex, activeLayerName, children,
}: AdjustmentsProviderProps) {
  // Stable refs to avoid stale closures in the set() helper
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const adjustmentsRef = useRef(adjustments);
  adjustmentsRef.current = adjustments;

  const set = useCallback(<K extends keyof Adjustments>(key: K, value: Adjustments[K]) => {
    onChangeRef.current({ ...adjustmentsRef.current, [key]: value });
  }, []);

  const hasChanges = useMemo(
    () => JSON.stringify(adjustments) !== JSON.stringify(defaultAdjustments),
    [adjustments],
  );

  const value = useMemo<AdjustmentsContextValue>(() => ({
    adjustments,
    onChange,
    set,
    canUndo: canUndo ?? false,
    canRedo: canRedo ?? false,
    onUndo: onUndo ?? (() => {}),
    onRedo: onRedo ?? (() => {}),
    history: history ?? [],
    hasChanges,
    restoreToIndex: restoreToIndex ?? (() => {}),
    activeLayerName: activeLayerName ?? null,
  }), [adjustments, onChange, set, canUndo, canRedo, onUndo, onRedo, history, hasChanges, restoreToIndex, activeLayerName]);

  return <AdjustmentsContext.Provider value={value}>{children}</AdjustmentsContext.Provider>;
}
