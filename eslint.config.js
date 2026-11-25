import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { base } from '@radiot/config/eslint';

// Used by lint-staged from the repo root; per-package configs drive `pnpm lint`.
export default [
  ...base,
  { ignores: ['**/next-env.d.ts', '**/playwright-report/**', '**/test-results/**'] },
  { files: ['apps/web/public/**/*.js'], languageOptions: { globals: globals.serviceworker } },
  // The FiveM NUI page runs in the game's embedded browser.
  { files: ['integrations/fivem/**/html/**/*.js'], languageOptions: { globals: globals.browser } },
  // k6 runtime globals for load scripts.
  {
    files: ['infra/load/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly', open: 'readonly' },
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    settings: { next: { rootDir: 'apps/web' } },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
