/**
 * Whether this page can run the app at all, and what to tell someone when it
 * cannot.
 *
 * Over http:// from anywhere but localhost the browser withholds
 * crypto.randomUUID, crypto.subtle, OPFS, the folder picker, the service
 * worker and Web Locks. Measured 2026-09-19 against the self-hosted container:
 * the app did not fail gracefully, it died while its modules loaded - a module
 * in the SourceContext chunk calls crypto.randomUUID at its top level - and
 * left a black screen. A check inside the app comes too late for that, so
 * ../main.tsx asks this module first and loads the app only afterwards.
 *
 * This module imports nothing and touches no API a plain http:// page lacks,
 * so it cannot be what crashes. secureContext.test.ts holds main.tsx to that.
 */

export type StartVerdict = 'app' | 'needs-https';

/**
 * The browser's own judgement decides. It already counts localhost as secure
 * and a LAN address over http:// as not; second-guessing it by hostname would
 * only get the edge cases wrong. An engine without the property predates
 * secure contexts altogether - there the app gets its chance.
 */
export function startVerdict(page: { isSecureContext?: boolean }): StartVerdict {
  return page.isSecureContext === false ? 'needs-https' : 'app';
}

export interface PageAddress {
  hostname: string;
  port: string;
}

/**
 * The same host over HTTPS on the default port. That is where the Caddy of
 * docker-compose.yml answers; behind another proxy it is still the best guess.
 * The port is dropped on purpose: http://<ip>:3000 is the app itself, and its
 * port speaks no TLS.
 */
export function httpsAddress(page: PageAddress): string {
  return `https://${page.hostname}/`;
}

/** Works on the machine the server runs on: the browser counts localhost as secure. */
export function localhostAddress(page: PageAddress): string {
  return page.port ? `http://localhost:${page.port}/` : 'http://localhost/';
}

export type NoticeLanguage = 'de' | 'en';

/**
 * German or English, from the first preference that names a language: the
 * app's own stored choice first (./storageKeys `language`), then the browser's
 * list. Everything that is not German reads English.
 */
export function noticeLanguage(preferences: ReadonlyArray<string | null | undefined>): NoticeLanguage {
  const first = preferences.find((value): value is string => typeof value === 'string' && value.length > 0);
  return first?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

/** The README heading the notice points to; secureContext.test.ts checks it exists. */
export const README_SECTION = 'Running on your home network';

export interface NoticeCopy {
  title: string;
  lead: string;
  stepsTitle: string;
  httpsStep: string;
  localhostStep: string;
  setupHint: string;
}

/**
 * The notice's wording. Kept here rather than in the locale files because the
 * i18n runtime belongs to the module graph that just could not load - and so
 * it lives in both languages side by side, like every locale key.
 */
export function noticeCopy(language: NoticeLanguage, appName: string): NoticeCopy {
  if (language === 'de') {
    return {
      title: `${appName} braucht eine sichere Verbindung`,
      lead: `Du hast ${appName} über eine unverschlüsselte Adresse (http://) geöffnet. `
        + 'Dort schaltet der Browser Funktionen ab, ohne die die App nicht starten kann – '
        + 'daran lässt sich auf dieser Seite nichts ändern.',
      stepsTitle: 'So geht es weiter:',
      httpsStep: 'Öffne dieselbe Adresse verschlüsselt:',
      localhostStep: 'Auf dem Rechner, auf dem der Server läuft, geht auch diese Adresse:',
      setupHint: 'Du betreibst den Server selbst? Für das Heimnetz bringt docker-compose.yml '
        + 'Caddy mit, der HTTPS auch für eine nackte IP-Adresse ausstellt. Hinter einem eigenen '
        + 'Reverse Proxy muss der die Verschlüsselung übernehmen. Mehr dazu im README unter '
        + `„${README_SECTION}“.`,
    };
  }
  return {
    title: `${appName} needs a secure connection`,
    lead: `You opened ${appName} over an unencrypted address (http://). `
      + 'There the browser switches off features the app cannot start without – '
      + 'nothing on this page can change that.',
    stepsTitle: 'How to go on:',
    httpsStep: 'Open the same address encrypted:',
    localhostStep: 'On the machine the server runs on, this address works as well:',
    setupHint: 'Running the server yourself? For a home network, docker-compose.yml brings '
      + 'Caddy, which serves HTTPS even for a bare IP address. Behind your own reverse proxy, '
      + 'that proxy has to do the encryption. More in the README under '
      + `"${README_SECTION}".`,
  };
}
