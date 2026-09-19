/**
 * The wording a user actually reads after a refresh.
 *
 * The count is the whole point of these messages: an album the server carries
 * without a name is skipped silently otherwise, and "1 Album ohne Namen
 * uebersprungen" is what sends the user to Immich to name it. German counts
 * albums with a different word than one album, so both plural forms have to
 * exist in both languages.
 *
 * The same holds for the photos a rescan takes back in: the background sync
 * leaves a removed photo removed, only the rescan revives it (F079), and a
 * revival nobody is told about is as bad as a removal nobody is told about.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import i18next, { type i18n as I18n } from 'i18next';
import { describe, expect, it } from 'vitest';

import { refreshToastMessage } from './sourceMessages';

const I18N_DIR = path.dirname(fileURLToPath(import.meta.url));

async function translator(lang: 'de' | 'en'): Promise<I18n> {
  const translation = JSON.parse(readFileSync(path.join(I18N_DIR, 'locales', `${lang}.json`), 'utf8'));
  const instance = i18next.createInstance();
  await instance.init({
    lng: lang,
    resources: { [lang]: { translation } },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

describe('the refresh message for albums without a name', () => {
  it.each([
    ['de', 1, 'Immich: 3 neu. 1 Album ohne Namen übersprungen, es wurde nichts entfernt.'],
    ['de', 2, 'Immich: 3 neu. 2 Alben ohne Namen übersprungen, es wurde nichts entfernt.'],
    ['en', 1, 'Immich: 3 added. 1 album without a name was skipped, so nothing was removed.'],
    ['en', 2, 'Immich: 3 added. 2 albums without a name were skipped, so nothing was removed.'],
  ] as const)('%s names the source, the count and that nothing was removed (%i)', async (lang, count, expected) => {
    const i18n = await translator(lang);
    expect(i18n.t('sources.refreshPartialAlbumsWithoutName', { source: 'Immich', added: 3, count })).toBe(expected);
  });
});

describe('the refresh message for photos taken back in', () => {
  const walked = { added: 3, removed: 0, complete: true, namelessAlbums: 0, failedParts: 0 };

  it.each([
    ['de', 1, 'Immich: aktualisiert — 3 neu, 0 entfernt. 1 zuvor entferntes Foto wieder aufgenommen.'],
    ['de', 2, 'Immich: aktualisiert — 3 neu, 0 entfernt. 2 zuvor entfernte Fotos wieder aufgenommen.'],
    ['en', 1, 'Immich: refreshed — 3 added, 0 removed. 1 previously removed photo is back in the library.'],
    ['en', 2, 'Immich: refreshed — 3 added, 0 removed. 2 previously removed photos are back in the library.'],
  ] as const)('%s names exactly how many came back (%i)', async (lang, revived, expected) => {
    const i18n = await translator(lang);
    expect(refreshToastMessage(i18n.t, 'Immich', { ...walked, revived })).toBe(expected);
  });

  it.each(['de', 'en'] as const)('%s says nothing at all when none came back', async (lang) => {
    const i18n = await translator(lang);
    const message = refreshToastMessage(i18n.t, 'Immich', { ...walked, revived: 0 });

    expect(message).toBe(i18n.t('sources.refreshDone', { source: 'Immich', added: 3, removed: 0 }));
    expect(message).not.toMatch(/wieder aufgenommen|back in the library/);
  });

  it('composes with the skipped-album sentence instead of replacing it', async () => {
    const i18n = await translator('de');
    const message = refreshToastMessage(i18n.t, 'Immich', {
      added: 3, removed: 0, revived: 2, complete: false, namelessAlbums: 1, failedParts: 0,
    });

    expect(message).toBe(
      'Immich: 3 neu. 1 Album ohne Namen übersprungen, es wurde nichts entfernt.'
      + ' 2 zuvor entfernte Fotos wieder aufgenommen.',
    );
  });
});

describe('the refresh message for a listing that stopped short', () => {
  const partial = { added: 3, removed: 0, revived: 0, complete: false };
  const TOO_LONG = { de: /zu lang/, en: /too long/ } as const;

  it.each(['de', 'en'] as const)('%s blames the page cap only when nothing was skipped', async (lang) => {
    const i18n = await translator(lang);
    const message = (namelessAlbums: number, failedParts: number) =>
      refreshToastMessage(i18n.t, 'Immich', { ...partial, namelessAlbums, failedParts });

    expect(message(0, 0)).toMatch(TOO_LONG[lang]);
    expect(message(0, 2)).not.toMatch(TOO_LONG[lang]);
    expect(message(1, 0)).not.toMatch(TOO_LONG[lang]);
    expect(message(1, 2)).not.toMatch(TOO_LONG[lang]);
  });

  it.each([
    ['de', 1, 'Immich: 3 neu. 1 Teil der Liste hat nicht geantwortet, es wurde nichts entfernt.'],
    ['de', 2, 'Immich: 3 neu. 2 Teile der Liste haben nicht geantwortet, es wurde nichts entfernt.'],
    ['en', 1, 'Immich: 3 added. 1 part of the listing did not answer, so nothing was removed.'],
    ['en', 2, 'Immich: 3 added. 2 parts of the listing did not answer, so nothing was removed.'],
  ] as const)('%s says how many parts did not answer (%i)', async (lang, failedParts, expected) => {
    const i18n = await translator(lang);
    expect(refreshToastMessage(i18n.t, 'Immich', { ...partial, namelessAlbums: 0, failedParts })).toBe(expected);
  });

  it('keeps naming the album the user can go and name when both happened', async () => {
    const i18n = await translator('de');
    const message = refreshToastMessage(i18n.t, 'Immich', { ...partial, namelessAlbums: 1, failedParts: 3 });

    expect(message).toBe('Immich: 3 neu. 1 Album ohne Namen übersprungen, es wurde nichts entfernt.');
  });

  it('composes the revived sentence with the cause sentence', async () => {
    const i18n = await translator('en');
    const message = refreshToastMessage(i18n.t, 'Immich', {
      ...partial, revived: 2, namelessAlbums: 0, failedParts: 1,
    });

    expect(message).toBe(
      'Immich: 3 added. 1 part of the listing did not answer, so nothing was removed.'
      + ' 2 previously removed photos are back in the library.',
    );
  });
});
