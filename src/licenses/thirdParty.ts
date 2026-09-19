/**
 * thirdParty — what this build ships, and under which terms.
 *
 * The online build hands JavaScript and WebAssembly to a stranger's browser
 * on every page load. That is distribution, so the same obligations apply as
 * to a downloadable archive: name the component, its licence, and where the
 * source can be had.
 *
 * The entries below are read off the installed packages, not remembered.
 * Build tooling is deliberately absent — Vite and TypeScript never reach a
 * browser, and listing them padded the list while the one component with a
 * real copyleft obligation was missing from it.
 */

export type LicenceId = 'MIT' | 'ISC' | 'Apache-2.0' | 'LGPL-3.0';

export interface ThirdPartyComponent {
  /** Stable key for the translated prose in the locale files. */
  id: string;
  name: string;
  version: string;
  licence: LicenceId;
  url: string;
  copyright?: string;
  /**
   * True where the licence asks for more than a notice — the source pointer
   * for LGPL and LibRaw. Rendered as its own line so the obligation is
   * visible rather than buried in a table cell. The wording is translated,
   * keyed by `id`.
   */
  hasNote?: boolean;
}

/** Shipped to every browser that opens the app. */
export const BUNDLED_COMPONENTS: readonly ThirdPartyComponent[] = [
  {
    id: 'react', name: 'React', version: '19.2.5', licence: 'MIT',
    url: 'https://github.com/facebook/react',
    copyright: 'Copyright (c) Meta Platforms, Inc. and affiliates.',
  },
  {
    id: 'react-dom', name: 'React DOM', version: '19.2.5', licence: 'MIT',
    url: 'https://github.com/facebook/react',
    copyright: 'Copyright (c) Meta Platforms, Inc. and affiliates.',
  },
  {
    id: 'libraw-wasm', name: 'libraw-wasm', version: '1.1.2', licence: 'ISC',
    url: 'https://github.com/ybouane/LibRaw-Wasm',
    hasNote: true,
  },
  {
    id: 'libheif-js', name: 'libheif-js', version: '1.19.8', licence: 'LGPL-3.0',
    url: 'https://github.com/catdad-experiments/libheif-js',
    hasNote: true,
  },
  {
    id: 'onnxruntime', name: 'onnxruntime-web', version: '1.20.1', licence: 'MIT',
    url: 'https://github.com/microsoft/onnxruntime',
    copyright: 'Copyright (c) Microsoft Corporation',
  },
  {
    id: 'scunet', name: 'SCUNet', version: 'psnr.v1', licence: 'Apache-2.0',
    url: 'https://huggingface.co/deepghs/image_restoration',
    hasNote: true,
  },
  {
    id: 'exifr', name: 'exifr', version: '7.1.3', licence: 'MIT',
    url: 'https://github.com/MikeKovarik/exifr',
    copyright: 'Copyright (c) 2020 Mike Kovařík, Mutiny.cz',
  },
  {
    id: 'utif', name: 'UTIF.js', version: '3.1.0', licence: 'MIT',
    url: 'https://github.com/photopea/UTIF.js',
    copyright: 'Copyright (c) 2017 Photopea',
  },
  {
    id: 'icc', name: 'icc', version: '4.0.0', licence: 'Apache-2.0',
    url: 'https://github.com/lovell/icc',
    copyright: 'Copyright Lovell Fuller',
  },
  {
    id: 'blurhash', name: 'blurhash', version: '2.0.5', licence: 'MIT',
    url: 'https://github.com/woltapp/blurhash',
    copyright: 'Copyright (c) 2018 Wolt Enterprises',
  },
  {
    id: 'sqljs', name: 'sql.js', version: '1.14.1', licence: 'MIT',
    url: 'https://github.com/sql-js/sql.js',
    copyright: 'Copyright (c) 2017 sql.js authors',
  },
  {
    id: 'i18next', name: 'i18next', version: '26.2.0', licence: 'MIT',
    url: 'https://github.com/i18next/i18next',
    copyright: 'Copyright (c) 2011-present i18next',
  },
  {
    id: 'react-i18next', name: 'react-i18next', version: '17.0.8', licence: 'MIT',
    url: 'https://github.com/i18next/react-i18next',
    copyright: 'Copyright (c) 2015-present i18next',
  },
  {
    id: 'i18next-langdetector', name: 'i18next-browser-languagedetector', version: '8.2.1', licence: 'MIT',
    url: 'https://github.com/i18next/i18next-browser-languageDetector',
    copyright: 'Copyright (c) 2025 i18next',
  },
];

/** Where the full text of each licence lives, for the ones we do not inline. */
export const LICENCE_TEXT_URLS: Readonly<Record<LicenceId, string>> = {
  'MIT': 'https://opensource.org/license/mit',
  'ISC': 'https://opensource.org/license/isc-license-txt',
  'Apache-2.0': 'https://www.apache.org/licenses/LICENSE-2.0',
  'LGPL-3.0': 'https://www.gnu.org/licenses/lgpl-3.0.html',
};

/** Licences present in the bundle, in the order they first appear. */
export function bundledLicences(): LicenceId[] {
  const seen: LicenceId[] = [];
  for (const c of BUNDLED_COMPONENTS) if (!seen.includes(c.licence)) seen.push(c.licence);
  return seen;
}
