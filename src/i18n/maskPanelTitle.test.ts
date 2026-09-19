import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Since cr-masks-one-owner the eight sliders under a mask write the adjustment
 * LAYER the mask gates, not the mask (MaskList.tsx, `maskLayerAdjustments`).
 * "Local adjustments" described the ownership they had before, so the title of
 * that panel has to name the layer instead. The key itself stays put - AP22
 * clears keys collectively.
 */
const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));

function maskPanelTitle(lang: 'de' | 'en'): string {
  const file = path.join(I18N_DIR, 'locales', lang, 'panels-extra.json');
  const tree = JSON.parse(readFileSync(file, 'utf8'));
  return tree.panels.masks.localAdjustments;
}

describe('title of the slider panel in the mask list', () => {
  it('names the layer in German, and no longer calls the sliders local', () => {
    const title = maskPanelTitle('de');
    expect(title).toMatch(/Ebene/);
    expect(title).not.toMatch(/lokal/i);
  });

  it('names the layer in English, and no longer calls the sliders local', () => {
    const title = maskPanelTitle('en');
    expect(title).toMatch(/layer/i);
    expect(title).not.toMatch(/local/i);
  });
});
