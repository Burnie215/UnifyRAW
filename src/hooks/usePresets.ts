import { useCallback, useEffect, useMemo } from 'react';
import { useRepos, useStorageRevisions } from '../contexts/StorageContext';
import type { PresetRow } from '../storage/repos';
import type { Adjustments } from '../types';
import { DEFAULT_PRESETS } from '../data/defaultPresets';
import { calibrateLegacyLightroomAdjustments, parseLightroomPreset } from '../data/lightroomPreset';

export type Preset = PresetRow;

export interface PresetImportResult {
  name: string;
  warnings: string[];
  importedFields: string[];
}

export function usePresets() {
  const repos = useRepos();
  const revisions = useStorageRevisions();
  const presetRevision = revisions.presets;
  const presets = useMemo(
    () => {
      void presetRevision;
      return repos.presets.list();
    },
    [repos, presetRevision],
  );

  useEffect(() => {
    repos.presets.ensureDefaults(DEFAULT_PRESETS);
  }, [repos]);

  useEffect(() => {
    for (const preset of repos.presets.list()) {
      const calibrated = calibrateLegacyLightroomAdjustments(preset.adjustments);
      if (calibrated) repos.presets.update(preset.id, { adjustments: calibrated });
    }
  }, [repos]);

  const savePreset = useCallback((name: string, adjustments: Adjustments, category?: string) => {
    repos.presets.add({ name, adjustments, category });
  }, [repos]);

  const deletePreset = useCallback((id: number) => {
    repos.presets.softDelete(id);
  }, [repos]);

  const exportPreset = useCallback((preset: PresetRow): string => {
    return JSON.stringify({ name: preset.name, category: preset.category, adjustments: preset.adjustments }, null, 2);
  }, []);

  const importPreset = useCallback((contents: string, fileName?: string): PresetImportResult => {
    if (/\.xmp$/i.test(fileName ?? '') || /^\s*(?:<\?xpacket\b|<x:xmpmeta\b)/i.test(contents)) {
      const parsed = parseLightroomPreset(contents, fileName);
      repos.presets.add({
        name: parsed.name,
        adjustments: parsed.adjustments,
        category: parsed.category,
      });
      return {
        name: parsed.name,
        warnings: parsed.warnings,
        importedFields: parsed.importedFields,
      };
    }

    const data = JSON.parse(contents) as {
      name?: unknown;
      category?: unknown;
      adjustments?: unknown;
    };
    if (typeof data.name !== 'string' || !data.name.trim() || !data.adjustments || typeof data.adjustments !== 'object') {
      throw new Error('Ungültiges PhotoLib-Preset.');
    }
    repos.presets.add({
      name: data.name.trim(),
      adjustments: data.adjustments as Partial<Adjustments>,
      category: typeof data.category === 'string' ? data.category : undefined,
    });
    return { name: data.name.trim(), warnings: [], importedFields: Object.keys(data.adjustments) };
  }, [repos]);

  return { presets, savePreset, deletePreset, exportPreset, importPreset };
}
