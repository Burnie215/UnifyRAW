import { useState, useCallback } from 'react';
import type { OrganizePattern } from './useAutoOrganize';
import { STORAGE_KEYS } from '../platform/storageKeys';

export interface ImportPreset {
  /** Auto-organize into date-based collections */
  autoOrganize: boolean;
  organizePattern: OrganizePattern;
  /** Auto-stack burst shots */
  autoStack: boolean;
  /** Default rating for imported photos (0 = none) */
  defaultRating: number;
  /** Default flag */
  defaultFlag: 'pick' | null;
  /** Default color label */
  defaultLabel: string | null;
  /** Default keywords applied to all imported photos */
  defaultKeywords: string[];
  /** Copyright string embedded in metadata */
  copyright: string;
  /** Develop preset name to auto-apply (empty = none) */
  developPreset: string;
}

const STORAGE_KEY = STORAGE_KEYS.importPreset;

export const DEFAULT_IMPORT_PRESET: ImportPreset = {
  autoOrganize: false,
  organizePattern: 'year-month',
  autoStack: false,
  defaultRating: 0,
  defaultFlag: null,
  defaultLabel: null,
  defaultKeywords: [],
  copyright: '',
  developPreset: '',
};

const DEFAULT_PRESET = DEFAULT_IMPORT_PRESET;

/**
 * The preset as it stands right now.
 *
 * An import reads it through this function instead of through the hook's
 * state: a scan started before the user changed the tab would otherwise keep
 * writing the defaults that were current when the component rendered.
 */
export function loadImportPreset(): ImportPreset {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULT_PRESET, ...JSON.parse(raw) };
  } catch { /* */ }
  return { ...DEFAULT_PRESET };
}

function savePreset(preset: ImportPreset) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preset));
  } catch { /* */ }
}

/**
 * Manages the import preset — settings applied to every newly imported photo.
 */
export function useImportPreset() {
  const [preset, setPresetState] = useState<ImportPreset>(loadImportPreset);

  const setPreset = useCallback((update: Partial<ImportPreset>) => {
    setPresetState((prev) => {
      const next = { ...prev, ...update };
      savePreset(next);
      return next;
    });
  }, []);

  const resetPreset = useCallback(() => {
    setPresetState({ ...DEFAULT_PRESET });
    savePreset(DEFAULT_PRESET);
  }, []);

  return { preset, setPreset, resetPreset };
}
