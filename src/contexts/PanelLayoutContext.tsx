/* eslint-disable react-refresh/only-export-components -- Provider and its context hook form one public boundary. */
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { usePanelLayout, type PanelLayoutApi } from '../ui/usePanelLayout';

const PanelLayoutContext = createContext<PanelLayoutApi | null>(null);

/**
 * One owner for the stored panel layout key (STORAGE_KEYS.panelLayout).
 *
 * The library shell and the editor shell show the same layout, and the editor
 * shell remounts with every photo. While each of them ran its own
 * `usePanelLayout`, both wrote the shared key from the snapshot they had
 * mounted with: open a photo, reorder a panel, go back, and the library's older
 * copy saved over it. Order and collapse state therefore depended on the order
 * of clicks. With one instance above both, a new panel is also registered in
 * two places (registry and content map) instead of five.
 */
export function PanelLayoutProvider({ children }: { children: ReactNode }) {
  const value = usePanelLayout();
  return <PanelLayoutContext.Provider value={value}>{children}</PanelLayoutContext.Provider>;
}

export function usePanelLayoutContext(): PanelLayoutApi {
  const value = useContext(PanelLayoutContext);
  if (!value) throw new Error('usePanelLayoutContext must be used inside PanelLayoutProvider');
  return value;
}
