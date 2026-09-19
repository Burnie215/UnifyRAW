/* eslint-disable react-refresh/only-export-components -- Provider and its context hook form one public boundary. */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  resolveDeviceProfile,
  useDeviceProfile,
  type AdaptiveUiMode,
  type DeviceProfile,
  type PrimaryInput,
  type ScreenClass,
} from '../platform/adaptiveLayout';
import { STORAGE_KEYS } from '../platform/storageKeys';

export const ADAPTIVE_UI_MODE_STORAGE_KEY = STORAGE_KEYS.uiModeOverride;

interface AdaptiveLayoutValue extends DeviceProfile {
  uiMode: AdaptiveUiMode;
  detectedScreen: ScreenClass;
  detectedPrimaryInput: PrimaryInput;
  setUiMode: (mode: AdaptiveUiMode) => void;
}

function parseUiMode(value: string | null): AdaptiveUiMode {
  return value === 'desktop' || value === 'tablet' || value === 'phone' ? value : 'auto';
}

function readStoredUiMode(): AdaptiveUiMode {
  try {
    return parseUiMode(localStorage.getItem(ADAPTIVE_UI_MODE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

const AdaptiveLayoutContext = createContext<AdaptiveLayoutValue | null>(null);

export function AdaptiveLayoutProvider({ children }: { children: ReactNode }) {
  const detectedProfile = useDeviceProfile();
  const [uiMode, setUiModeState] = useState<AdaptiveUiMode>(readStoredUiMode);
  const profile = useMemo(
    () => resolveDeviceProfile(detectedProfile, uiMode),
    [detectedProfile, uiMode],
  );

  const setUiMode = useCallback((mode: AdaptiveUiMode) => {
    setUiModeState(mode);
    try { localStorage.setItem(ADAPTIVE_UI_MODE_STORAGE_KEY, mode); } catch { /* unavailable */ }
  }, []);

  useEffect(() => {
    const syncFromAnotherTab = (event: StorageEvent) => {
      if (event.key === ADAPTIVE_UI_MODE_STORAGE_KEY) setUiModeState(parseUiMode(event.newValue));
    };
    window.addEventListener('storage', syncFromAnotherTab);
    return () => window.removeEventListener('storage', syncFromAnotherTab);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.screen = profile.screen;
    root.dataset.input = profile.primaryInput;
    root.dataset.orientation = profile.orientation;
    root.dataset.uiMode = uiMode;
    return () => {
      delete root.dataset.screen;
      delete root.dataset.input;
      delete root.dataset.orientation;
      delete root.dataset.uiMode;
    };
  }, [profile.screen, profile.primaryInput, profile.orientation, uiMode]);

  const value = useMemo<AdaptiveLayoutValue>(() => ({
    ...profile,
    uiMode,
    detectedScreen: detectedProfile.screen,
    detectedPrimaryInput: detectedProfile.primaryInput,
    setUiMode,
  }), [profile, uiMode, detectedProfile.screen, detectedProfile.primaryInput, setUiMode]);

  return (
    <AdaptiveLayoutContext.Provider value={value}>
      {children}
    </AdaptiveLayoutContext.Provider>
  );
}

export function useAdaptiveLayout(): AdaptiveLayoutValue {
  const context = useContext(AdaptiveLayoutContext);
  if (!context) throw new Error('useAdaptiveLayout must be used inside AdaptiveLayoutProvider');
  return context;
}
