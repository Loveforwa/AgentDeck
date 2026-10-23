// 全仓库唯一的 ESLint 配置（flat config）。各包不要再放自己的 eslint 配置。
// 格式交给 Prettier，eslint-config-prettier 关掉和它冲突的规则。
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * 界面代码里禁止写死颜色：十六进制、rgb()/hsl()/hwb()/lab()/lch()/oklab()/oklch()。颜色只在 packages/design-tokens 里定。
 * 两个正则和 packages/design-tokens/lint/raw-colors.mjs（F4，扫 CSS 用）保持一致。
 */
const HEX_COLOR = String.raw`/(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/`;
const FUNC_COLOR = String.raw`/(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i`;
const COLOR_MESSAGE =
  'Hard-coded color. Colors live in packages/design-tokens; use a token CSS variable such as var(--ink) instead.';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      'docs/**',
      // 故意违规的样例，由 tools/boundary-fixtures 的测试单独检查
      'tools/boundary-fixtures/cases/**',
      'tools/boundary-fixtures/eslint/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      // 终端相关代码常要匹配 ANSI 转义（\x1b），这条规则在这里只会误报
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.{jsx,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // packages/design-tokens 不在 packages/ui 下，自然不受这条限制
    files: ['packages/ui/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: `Literal[value=${HEX_COLOR}]`, message: COLOR_MESSAGE },
        { selector: `Literal[value=${FUNC_COLOR}]`, message: COLOR_MESSAGE },
        { selector: `TemplateElement[value.raw=${HEX_COLOR}]`, message: COLOR_MESSAGE },
        { selector: `TemplateElement[value.raw=${FUNC_COLOR}]`, message: COLOR_MESSAGE },
      ],
    },
  },
  prettier,
);
