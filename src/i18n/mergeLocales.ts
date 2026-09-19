/**
 * How the locale files become one translation tree per language.
 *
 * The order is named here instead of inherited from the bundler's glob order:
 * the legacy single file `./locales/<lang>.json` first, then the namespace
 * files `./locales/<lang>/<name>.json` alphabetically, later files overwriting
 * earlier ones. A leaf key may still live in only one file — locales.test.ts
 * holds that — so the order is a safety net, not a way to override texts.
 */
export type LocaleTree = Record<string, unknown>;

export function deepMerge(target: LocaleTree, source: LocaleTree): LocaleTree {
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      target[k] = deepMerge(tv as LocaleTree, sv as LocaleTree);
    } else if (sv && typeof sv === 'object' && !Array.isArray(sv)) {
      // Copy instead of taking the reference: a later file merging into this
      // subtree would otherwise write into the source module's own object.
      target[k] = deepMerge({}, sv as LocaleTree);
    } else {
      target[k] = sv;
    }
  }
  return target;
}

function parseLocalePath(path: string): { lang: string; name: string | null } | null {
  const m = path.match(/\.\/locales\/([a-z]{2})(?:\.json|\/([^/]+)\.json)$/i);
  if (!m) return null;
  return { lang: m[1], name: m[2] ?? null };
}

export function localeMergeOrder(paths: readonly string[]): string[] {
  const rank = (path: string): [string, number, string] => {
    const parsed = parseLocalePath(path)!;
    return [parsed.lang, parsed.name === null ? 0 : 1, parsed.name ?? ''];
  };
  return paths
    .filter((path) => parseLocalePath(path) !== null)
    .sort((a, b) => {
      const [langA, legacyA, nameA] = rank(a);
      const [langB, legacyB, nameB] = rank(b);
      if (langA !== langB) return langA < langB ? -1 : 1;
      if (legacyA !== legacyB) return legacyA - legacyB;
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0;
    });
}

export function mergeLocaleModules(
  modules: Record<string, { default: LocaleTree }>,
  languages: readonly string[],
): Record<string, { translation: LocaleTree }> {
  const resources: Record<string, { translation: LocaleTree }> = {};
  for (const lang of languages) resources[lang] = { translation: {} };
  for (const path of localeMergeOrder(Object.keys(modules))) {
    const { lang } = parseLocalePath(path)!;
    if (!resources[lang]) continue;
    deepMerge(resources[lang].translation, modules[path].default);
  }
  return resources;
}
