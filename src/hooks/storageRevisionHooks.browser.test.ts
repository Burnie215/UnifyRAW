import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  StorageProvider,
  useStorage,
} from '../contexts/StorageContext';
import { STORAGE_KEYS } from '../platform/storageKeys';
import type { Repositories } from '../storage/repos';
import { applyAdjustmentsToDocument, createDocument } from '../engine/DocumentModel';
import { defaultAdjustments } from '../types';
import { usePhotoEdits } from './usePhotoEdits';
import { usePresets } from './usePresets';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../engine/ThumbnailRenderer', () => ({ queueEditThumbnail: vi.fn() }));

const HASH = 'open-photo-hash';

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !check(); attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  expect(check()).toBe(true);
}

function setupStoragePref(): void {
  localStorage.setItem(STORAGE_KEYS.storagePref, JSON.stringify({ kind: 'memory', explicit: true }));
}

function dispose(root: Root, host: HTMLDivElement): void {
  act(() => root.unmount());
  host.remove();
}

describe('revision-driven storage hooks', () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  it('reloads a clean open edit on an edits revision but preserves a dirty local document', async () => {
    setupStoragePref();
    const probe: {
      repos: Repositories | null;
      edit: ReturnType<typeof usePhotoEdits> | null;
    } = { repos: null, edit: null };

    function EditProbe() {
      probe.edit = usePhotoEdits(HASH);
      return null;
    }
    function Gate() {
      const { repos } = useStorage();
      probe.repos = repos;
      return repos ? createElement(EditProbe) : null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(StorageProvider, null, createElement(Gate))));
    try {
      await waitFor(() => probe.edit !== null);

      const pulled = applyAdjustmentsToDocument(createDocument(), { ...defaultAdjustments, exposure: 1.25 });
      act(() => {
        // A pull writes sql.js directly and StorageProvider then bumps the
        // edits revision. A repository write raises the same public signal.
        probe.repos!.edits.upsert({
          contentHash: HASH,
          adjustments: { ...defaultAdjustments, exposure: 1.25 },
          document: pulled,
        });
      });
      expect(probe.edit!.adjustments.exposure).toBe(1.25);

      vi.useFakeTimers();
      act(() => {
        probe.edit!.setAdjustments({ ...probe.edit!.adjustments, exposure: 2.5 });
      });
      expect(probe.edit!.adjustments.exposure).toBe(2.5);

      const newerRemote = applyAdjustmentsToDocument(createDocument(), { ...defaultAdjustments, exposure: 9 });
      act(() => {
        probe.repos!.edits.upsert({
          contentHash: HASH,
          adjustments: { ...defaultAdjustments, exposure: 9 },
          document: newerRemote,
        });
      });
      expect(probe.edit!.adjustments.exposure).toBe(2.5);
    } finally {
      vi.clearAllTimers();
      dispose(root, host);
    }
  });

  it('lists presets only when the preset table revision changes', async () => {
    setupStoragePref();
    const probe: {
      repos: Repositories | null;
      enable: (() => void) | null;
      presets: ReturnType<typeof usePresets> | null;
    } = { repos: null, enable: null, presets: null };

    function PresetProbe() {
      probe.presets = usePresets();
      return null;
    }
    function Gate() {
      const { repos } = useStorage();
      const [enabled, setEnabled] = useState(false);
      probe.repos = repos;
      probe.enable = () => setEnabled(true);
      return repos && enabled ? createElement(PresetProbe) : null;
    }

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(StorageProvider, null, createElement(Gate))));
    try {
      await waitFor(() => probe.repos !== null);
      const list = vi.spyOn(probe.repos!.presets, 'list');
      act(() => probe.enable!());
      await waitFor(() => probe.presets !== null && probe.presets.presets.length > 0);
      const readsAfterMount = list.mock.calls.length;

      act(() => {
        probe.repos!.edits.upsert({ contentHash: 'other-photo', adjustments: defaultAdjustments });
      });
      expect(list).toHaveBeenCalledTimes(readsAfterMount);

      act(() => {
        probe.repos!.presets.add({ name: 'Remote preset', adjustments: { exposure: 0.5 } });
      });
      expect(list).toHaveBeenCalledTimes(readsAfterMount + 1);
      expect(probe.presets!.presets.some((preset) => preset.name === 'Remote preset')).toBe(true);
    } finally {
      dispose(root, host);
    }
  });
});
