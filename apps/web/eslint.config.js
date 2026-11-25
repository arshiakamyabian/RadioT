import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import { base } from '@radiot/config/eslint';

export default [
  ...base,
  { ignores: ['next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.serviceworker } },
  // Node tools that also carry code injected into the page they drive.
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
