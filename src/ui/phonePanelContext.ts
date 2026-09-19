import { createContext, useContext } from 'react';

export interface PhonePanelActions {
  available: boolean;
  openToolPicker: (returnFocusTo?: HTMLElement | null) => void;
}

const defaultActions: PhonePanelActions = {
  available: false,
  openToolPicker: () => undefined,
};

export const PhonePanelActionsContext = createContext<PhonePanelActions>(defaultActions);

export function usePhonePanelActions(): PhonePanelActions {
  return useContext(PhonePanelActionsContext);
}
