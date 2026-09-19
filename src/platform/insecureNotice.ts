import {
  httpsAddress,
  localhostAddress,
  noticeCopy,
  noticeLanguage,
  type PageAddress,
} from './secureContext';
import { STORAGE_KEYS } from './storageKeys';

/**
 * Put the notice for a page without a secure context on screen.
 *
 * Plain DOM on purpose: React and i18n are part of the module graph that did
 * not load. Every text goes in through textContent, never markup - the host
 * name comes from the address bar. Styles are set through the style object,
 * which the CSP does not restrict.
 */
export function renderInsecureNotice(doc: Document, page: PageAddress, browserLanguages: readonly string[]): void {
  const language = noticeLanguage([readStoredLanguage(), ...browserLanguages]);
  const appName = doc.title.trim() || 'UnifyRAW';
  const copy = noticeCopy(language, appName);
  doc.documentElement.lang = language;
  doc.body.style.cssText = 'margin:0;background:#1a1a1a;color:#e6e6e6;'
    + 'font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;';

  const main = element(doc, 'main', 'max-width:40rem;margin:12vh auto 0;padding:0 24px;');
  main.setAttribute('role', 'alert');
  main.append(
    element(doc, 'h1', 'font-size:1.5rem;font-weight:600;margin:0 0 1rem;', copy.title),
    element(doc, 'p', 'margin:0 0 1.25rem;', copy.lead),
    element(doc, 'p', 'margin:0 0 .5rem;font-weight:600;', copy.stepsTitle),
  );
  const steps = element(doc, 'ul', 'margin:0 0 1.25rem;padding-left:1.25rem;');
  steps.append(
    step(doc, copy.httpsStep, httpsAddress(page)),
    step(doc, copy.localhostStep, localhostAddress(page)),
  );
  main.append(steps, element(doc, 'p', 'margin:0;color:#a8a8a8;font-size:.9rem;', copy.setupHint));

  const root = doc.getElementById('root') ?? doc.body;
  root.replaceChildren(main);
}

function step(doc: Document, text: string, href: string): HTMLElement {
  const item = element(doc, 'li', 'margin:0 0 .5rem;', `${text} `);
  const link = element(doc, 'a', 'color:#6aa9ff;overflow-wrap:anywhere;', href) as HTMLAnchorElement;
  link.href = href;
  item.append(link);
  return item;
}

function element(doc: Document, tag: string, style: string, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  node.style.cssText = style;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The language the user picked inside the app, if storage lets us read it. */
function readStoredLanguage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEYS.language);
  } catch {
    return null;
  }
}
