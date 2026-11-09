// ESLint flat config for this library: likely bugs are errors (CI fails), style and noise are warnings.
// Run `npm run lint` in this folder; the packages are installed at the repository root.
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(globalIgnores(['dist-demo/', 'node_modules/']), {
  files: ['**/*.{ts,mjs}'],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser, ...globals.node } },
  rules: {
    'no-unsafe-optional-chaining': 'error',
    'no-unreachable': 'error',
    'no-constant-condition': 'error',
    'no-self-assign': 'error',
    'no-dupe-keys': 'error',
    'no-fallthrough': 'error',
    'no-cond-assign': 'error',
    'no-loss-of-precision': 'error',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'prefer-const': 'warn',
    'no-useless-assignment': 'warn',
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    '@typescript-eslint/no-non-null-assertion': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
  },
});
