// ESLint flat config (card #52). Next 15's eslint-config-next still ships an
// eslintrc-style config, so it is loaded through FlatCompat.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'debug-screenshots/**', 'data/**'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'none',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Plain CommonJS node scripts (kept until card #42 removes them).
    files: ['scripts/**/*.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // TODO(card #52 follow-up): chat files are owned by a concurrent chat card;
    // drop this override once chatLoop.test.ts types its fake-CLI call log.
    files: ['src/lib/services/chatLoop.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];

export default config;
