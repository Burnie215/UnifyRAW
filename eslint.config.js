import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores([
    'dist',
    '**/dist/**',
    'plans/**',
    'website/**',
    'docs/**',
    'playwright-report/**',
    'test-results/**',
    '.vitest-attachments/**',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // The project currently uses the standard Vite React transform, not the
      // React Compiler. Keep the semantic hook checks below, but do not fail
      // CI for diagnostics whose only effect is that the Compiler would skip
      // optimising a component.
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',

      // Co-locating providers with their hooks only affects development hot
      // reload. It must remain visible without making a production build red.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],

      // A leading underscore is the explicit convention for callback and
      // interface parameters that must be accepted but are intentionally unused.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
    },
  },
])
