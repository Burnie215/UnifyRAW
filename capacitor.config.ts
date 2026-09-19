import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor 7 config. Every key here must exist in `CapacitorConfig` of the
 * INSTALLED `@capacitor/cli` (node_modules/@capacitor/cli/dist/declarations.d.ts)
 * - `bundledWebRuntime` lived here until it was dropped with Capacitor 5 and
 * silently did nothing afterwards. tsconfig.node.json now type-checks this
 * file, so the next removed key fails `npm run verify` instead of surviving as
 * decoration.
 */
const config: CapacitorConfig = {
  appId: 'de.beseb.photolib',
  appName: 'PhotoLib',
  webDir: 'dist',
  // The WebView serves the built bundle from capacitor://localhost. All
  // /api/* fetches resolve there too - backend traffic is therefore routed
  // by an explicit `backendUrl` setting (see src/platform/config.ts).
  server: {
    androidScheme: 'https',
    // What this really controls: which hosts the WebView may NAVIGATE to and
    // still keep treating as app content. Backend traffic is fetch/XHR and is
    // governed by CORS, not by this list, so these entries are not what makes
    // a configured backend reachable. No code in src/ navigates to them
    // either - the one outbound window.open is the OAuth popup in
    // platform/oauth.ts, and it goes to the provider, not to the hosted app. The
    // list is kept until someone with a device can confirm nothing depends on
    // it; see docs/CAPACITOR.md.
    allowNavigation: ['app.unifyraw.com'],
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'always',
  },
};

export default config;
