// ESLint flat config for StoreX. It looks for likely mistakes; formatting is left to Prettier (.prettierrc.json,
// checked by hand with `npm run format:check`). Run `npm run lint` in this folder; the packages are installed at the repository root.
// Rules that point to likely bugs are errors and fail CI; style and noise rules are warnings: shown, but allowed.
//
// ESLint 配置：只查可能的错误，格式交给 Prettier（.prettierrc.json，手动运行 `npm run format:check` 检查）。
// 在本目录运行 `npm run lint`（相关的包装在仓库根目录）。可能是错误的规则报 error，自动测试会失败；写法和噪声类的规则报 warning，只显示、不失败。
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'docs/', 'node_modules/']),
  {
    files: ['**/*.{ts,mjs}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // Likely bugs: errors, CI fails. Most of them are already in the recommended sets above; they are listed so the intent is visible.
      // 可能的错误：报 error，自动测试失败。多数已经在上面的推荐规则集里，写在这里是为了一眼看出意图。
      'no-unsafe-optional-chaining': 'error',
      'no-unreachable': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-condition': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-assign': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-fallthrough': 'error',
      'no-cond-assign': 'error',
      'no-loss-of-precision': 'error',
      '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
      // Empty catch blocks are used on purpose (for example around browser storage). · 空的 catch 是有意的（例如浏览器存储）。
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Style and noise: warnings, CI does not fail. · 写法和噪声：报 warning，自动测试不失败。
      // The next three can catch real bugs, but here they only flag intentional code: loop-invariant guards such as `k < n && arr`,
      // NaN checks `x === x`, and a dollar sign in front of a translation placeholder such as `'${cost}'`.
      // 下面三条能发现真的错误，但在这里标出的都是有意的写法：循环条件里不变的守卫（如 `k < n && arr`）、判断 NaN 的 `x === x`、
      // 翻译占位符前面的美元符号（如 `'${cost}'`），所以只报警告。
      'no-unmodified-loop-condition': 'warn',
      'no-self-compare': 'warn',
      'no-template-curly-in-string': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
      'no-useless-catch': 'warn',
      'no-irregular-whitespace': 'warn',
      'no-case-declarations': 'warn',
      'no-prototype-builtins': 'warn',
      'no-extra-boolean-cast': 'warn',
      'prefer-const': 'warn',
      'no-var': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/no-unused-expressions': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      '@typescript-eslint/no-array-constructor': 'warn',
      '@typescript-eslint/no-unnecessary-type-constraint': 'warn',
    },
  },
);
