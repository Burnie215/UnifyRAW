import { useState, useEffect } from 'react';
import { PERSISTED_STATE_PREFIX } from '../platform/storageKeys';

/**
 * Like useState but persists to localStorage.
 * Falls back to defaultValue if nothing stored or parsing fails.
 */
export function usePersistedState<T>(key: string, defaultValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const storageKey = PERSISTED_STATE_PREFIX + key;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return JSON.parse(stored);
    } catch { /* ignore */ }
    return defaultValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch { /* quota exceeded */ }
  }, [storageKey, value]);

  return [value, setValue];
}

/**
 * Persisted Set<string> — stored as JSON array.
 */
export function usePersistedSet(key: string, defaultValue: Set<string> = new Set()): [Set<string>, React.Dispatch<React.SetStateAction<Set<string>>>] {
  const storageKey = PERSISTED_STATE_PREFIX + key;

  const [value, setValue] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      if (stored !== null) return new Set(JSON.parse(stored));
    } catch { /* ignore */ }
    return defaultValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(value)));
    } catch { /* quota exceeded */ }
  }, [storageKey, value]);

  return [value, setValue];
}
