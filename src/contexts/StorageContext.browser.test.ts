import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageProvider,
  useStorage,
  useStorageRevisions,
  type StorageContextValue,
} from './StorageContext';
import type { StorageRevisions } from './storageRevisions';
import { STORAGE_KEYS } from '../platform/storageKeys';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

interface ProbeState {
  storageRenders: number;
  revisionRenders: number;
  storageValues: StorageContextValue[];
  revisionValues: StorageRevisions[];
  writePreset: (() => void) | null;
}

function mountStorage(): { probe: ProbeState; root: Root; host: HTMLDivElement } {
  const probe: ProbeState = {
    storageRenders: 0,
    revisionRenders: 0,
    storageValues: [],
    revisionValues: [],
    writePreset: null,
  };

  function StorageProbe() {
    const value = useStorage();
    probe.storageRenders++;
    probe.storageValues.push(value);
    probe.writePreset = value.repos
      ? () => value.repos!.presets.add({ name: 'Measured', adjustments: {} })
      : null;
    return null;
  }

  function RevisionProbe() {
    const value = useStorageRevisions();
    probe.revisionRenders++;
    probe.revisionValues.push(value);
    return null;
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(
      StorageProvider,
      null,
      createElement(StorageProbe),
      createElement(RevisionProbe),
    ));
  });
  return { probe, root, host };
}

describe('StorageProvider revision subscriptions', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('keeps storage consumers and their context identity still on a repo write', async () => {
    localStorage.setItem(STORAGE_KEYS.storagePref, JSON.stringify({ kind: 'memory', explicit: true }));
    const harness = mountStorage();
    try {
      for (let attempt = 0; attempt < 20 && !harness.probe.writePreset; attempt++) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
      }
      expect(harness.probe.writePreset).not.toBeNull();
      const storageRenders = harness.probe.storageRenders;
      const revisionRenders = harness.probe.revisionRenders;
      const storageValue = harness.probe.storageValues.at(-1);
      const revisions = harness.probe.revisionValues.at(-1)!;

      act(() => harness.probe.writePreset!());

      expect(harness.probe.storageRenders).toBe(storageRenders);
      expect(harness.probe.storageValues.at(-1)).toBe(storageValue);
      expect(harness.probe.revisionRenders).toBe(revisionRenders + 1);
      expect(harness.probe.revisionValues.at(-1)).not.toBe(revisions);
      expect(harness.probe.revisionValues.at(-1)?.presets).toBe(revisions.presets + 1);
      expect(harness.probe.revisionValues.at(-1)?.all).toBe(revisions.all + 1);
      expect(harness.probe.revisionValues.at(-1)?.edits).toBe(revisions.edits);
    } finally {
      act(() => harness.root.unmount());
      harness.host.remove();
    }
  });
});
