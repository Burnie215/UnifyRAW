import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';

/**
 * Two test projects:
 *   - node:    pure-logic + mock-GL tests, jsdom-free, fast (default)
 *   - browser: bit-exact GL compat tests against real WebGL2 (Chromium via
 *              Playwright). Opt-in via `npx vitest --project browser`.
 *
 * Browser tests live in `*.browser.test.ts` files so the project glob picks
 * them up without duplicating run paths.
 */
export default defineConfig({
  // Tests run against the shared sources, not the last `dist` someone built.
  resolve: {
    alias: {
      '@photolib/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    testTimeout: 10_000,
    projects: [
      {
        // Inline projects do not inherit the root config (the alias) otherwise.
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'packages/**/*.test.ts'],
          exclude: ['**/*.browser.test.ts'],
        },
      },
      {
        // Inline projects do not inherit the root config (the alias) otherwise.
        extends: true,
        // Vite discovers a dependency while the suite is already running, then
        // reloads the page to serve the new bundle - and React's hook
        // dispatcher does not survive that reload ("Invalid hook call"). It
        // only bites when the dep cache is STALE (a browser test added since
        // the last run), which is exactly the moment someone writes one.
        // Naming them up front means the optimizer is complete before the
        // first test mounts. Vite names what is missing in its own log line.
        optimizeDeps: {
          include: [
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-dom/client',
            'react-i18next',
            'libraw-wasm',
            'utif',
          ],
        },
        test: {
          name: 'browser',
          include: ['src/**/*.browser.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
