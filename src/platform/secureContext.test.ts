import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  httpsAddress,
  localhostAddress,
  noticeCopy,
  noticeLanguage,
  README_SECTION,
  startVerdict,
} from './secureContext';

describe('startVerdict', () => {
  it('starts the app in a secure context', () => {
    expect(startVerdict({ isSecureContext: true })).toBe('app');
  });

  it('shows the notice where the browser says the page is not secure', () => {
    expect(startVerdict({ isSecureContext: false })).toBe('needs-https');
  });

  // An engine from before secure contexts has no such property. Refusing it
  // would turn "might work" into "certainly does not".
  it('lets an engine without the property try', () => {
    expect(startVerdict({})).toBe('app');
  });
});

describe('the addresses the notice offers', () => {
  // The app's own port speaks no TLS; the Caddy of docker-compose.yml answers
  // on the default one.
  it('points to the same host over HTTPS on the default port', () => {
    expect(httpsAddress({ hostname: '192.168.1.50', port: '3000' })).toBe('https://192.168.1.50/');
    expect(httpsAddress({ hostname: 'fotos.local', port: '' })).toBe('https://fotos.local/');
  });

  it('keeps the port for localhost, where the app answers itself', () => {
    expect(localhostAddress({ hostname: '192.168.1.50', port: '3000' })).toBe('http://localhost:3000/');
    expect(localhostAddress({ hostname: '192.168.1.50', port: '' })).toBe('http://localhost/');
  });
});

describe('noticeLanguage', () => {
  it('takes the first preference that names a language', () => {
    expect(noticeLanguage(['de', 'en-US'])).toBe('de');
    expect(noticeLanguage([null, 'de-AT'])).toBe('de');
    expect(noticeLanguage([undefined, '', 'en-GB', 'de'])).toBe('en');
  });

  it('reads everything that is not German as English', () => {
    expect(noticeLanguage(['fr-FR'])).toBe('en');
    expect(noticeLanguage([])).toBe('en');
  });
});

describe('noticeCopy', () => {
  it('names the app and the reason in both languages', () => {
    for (const language of ['de', 'en'] as const) {
      const copy = noticeCopy(language, 'UnifyRAW');
      expect(copy.title).toContain('UnifyRAW');
      expect(copy.lead).toContain('http://');
      expect(copy.setupHint).toContain('docker-compose.yml');
    }
  });

  // Same rule as the locale files: every text in both languages, no key missing.
  it('has the same fields in German and English, none empty', () => {
    const de = noticeCopy('de', 'X');
    const en = noticeCopy('en', 'X');
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
    for (const value of [...Object.values(de), ...Object.values(en)]) expect(value.trim()).not.toBe('');
  });

  // The notice sends people to a README section by name. Renaming the heading
  // without the notice would leave them looking for something that is not there.
  it('points to a README section that exists', () => {
    const readme = readFileSync('README.md', 'utf8');
    expect(readme).toMatch(new RegExp(`^#{2,4} ${README_SECTION}$`, 'm'));
    for (const language of ['de', 'en'] as const) {
      expect(noticeCopy(language, 'X').setupHint).toContain(README_SECTION);
    }
  });

  it('speaks German with du, like the locale files', () => {
    const text = Object.values(noticeCopy('de', 'X')).join(' ');
    expect(text).toMatch(/\bDu\b|\bdu\b/);
    expect(text).not.toMatch(/\bSie haben\b|\bÖffnen Sie\b/);
  });
});

/**
 * The guard for the switch itself. If main.tsx - or anything it imports
 * statically - reaches a module that uses crypto at load time, a page without a
 * secure context is back to a black screen, and nothing else would notice:
 * every other test runs where crypto exists. So the static import closure of
 * main.tsx is pinned to exactly these files, none of them imports a package or
 * a stylesheet, and none of them mentions crypto at all. The app itself may
 * only arrive through the dynamic import('./bootstrap').
 */
describe('main.tsx', () => {
  const ALLOWED = [
    'src/main.tsx',
    'src/platform/chunkRecovery.ts',
    'src/platform/insecureNotice.ts',
    'src/platform/secureContext.ts',
    'src/platform/storageKeys.ts',
  ];

  function staticImports(source: string): string[] {
    const specifiers: string[] = [];
    const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/gm;
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
    return specifiers;
  }

  function resolve(fromFile: string, specifier: string): string {
    const base = normalize(join(dirname(fromFile), specifier));
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate)) return candidate;
    }
    throw new Error(`${fromFile}: cannot resolve ${specifier}`);
  }

  function closure(entry: string): { files: string[]; bare: string[] } {
    const files = new Set<string>();
    const bare: string[] = [];
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const specifier of staticImports(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) queue.push(resolve(file, specifier));
        else bare.push(`${file} -> ${specifier}`);
      }
    }
    return { files: [...files].sort(), bare };
  }

  it('statically imports only the few modules that cannot fail without a secure context', () => {
    const { files, bare } = closure('src/main.tsx');
    expect(bare).toEqual([]);
    expect(files).toEqual([...ALLOWED].sort());
  });

  // Code, not prose: secureContext.ts explains in its comments which crypto
  // calls fail, and that explanation must stay.
  it('keeps crypto out of the code it loads before the switch', () => {
    const withoutComments = (source: string) => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const file of ALLOWED) {
      expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(/\bcrypto\b/);
    }
  });

  it('loads the app only through the dynamic import, after the verdict', () => {
    const source = readFileSync('src/main.tsx', 'utf8');
    expect(source).toMatch(/startVerdict\(window\) === 'app'\) \{\n\s*void import\('\.\/bootstrap'\)/);
  });
});
