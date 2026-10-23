#!/usr/bin/env node
// 界面代码里不许写颜色值，只能用 tokens.css 的变量。
// 两种用法：
//   1. 命令行：node lint/raw-colors.mjs [目录或文件…]，默认扫 packages/ui；有问题时退出码 1。扫 .ts .tsx .css。
//   2. ESLint：import agentdeck from '@agentdeck/design-tokens/lint'，
//      plugins: { agentdeck }，rules: { 'agentdeck/no-raw-colors': 'error' }。只查 JS/TS 里的字符串，CSS 靠命令行。
// 某一行确实需要写颜色值时，在同一行加注释 raw-color-ok 并说明原因。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 十六进制颜色：#abc #abcd #aabbcc #aabbccdd。前面不能是字母数字或 &（HTML 实体 &#123;），后面不能接着字母数字。
const HEX = /(?<![\w&#-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
// 颜色函数：rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch()
const FUNC = /(?<![\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi;
const ALLOW = 'raw-color-ok';

const MESSAGE = 'Raw color value; use a design token variable such as var(--ink) instead.';

/**
 * 在一段文本里找颜色值。
 * @param {string} text
 * @returns {{ line: number, column: number, match: string }[]}
 */
export function findRawColors(text) {
  const found = [];
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    if (lineText.includes(ALLOW)) return;
    for (const re of [HEX, FUNC]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(lineText)) !== null) {
        found.push({ line: i + 1, column: m.index + 1, match: m[0] });
      }
    }
  });
  return found.sort((a, b) => a.line - b.line || a.column - b.column);
}

const EXTS = new Set(['.ts', '.tsx', '.css']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', '.vite', 'coverage']);

function* walk(path) {
  const st = statSync(path);
  if (st.isFile()) {
    if (EXTS.has(extname(path))) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    // dist、dist-demo 之类的构建产物不查
    if (SKIP_DIRS.has(name) || name.startsWith('dist')) continue;
    yield* walk(join(path, name));
  }
}

/**
 * 扫描目录或文件，返回所有问题。
 * @param {string[]} paths
 */
export function scan(paths) {
  const problems = [];
  for (const root of paths) {
    for (const file of walk(root)) {
      for (const p of findRawColors(readFileSync(file, 'utf8'))) problems.push({ file, ...p });
    }
  }
  return problems;
}

/** ESLint 规则：JS/TS 字符串和模板字符串里不许有颜色值。 */
const noRawColors = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow raw color values in UI code; use design tokens.' },
    schema: [],
    messages: { raw: MESSAGE + ' Found "{{match}}".' },
  },
  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    const check = (node, value) => {
      if (typeof value !== 'string') return;
      const lineText = sourceCode.lines?.[node.loc.start.line - 1] ?? '';
      if (lineText.includes(ALLOW)) return;
      for (const hit of findRawColors(value)) {
        context.report({ node, messageId: 'raw', data: { match: hit.match } });
      }
    };
    return {
      Literal(node) {
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked ?? node.value.raw);
      },
      JSXText(node) {
        check(node, node.value);
      },
    };
  },
};

/** ESLint 插件对象。 */
const plugin = {
  meta: { name: '@agentdeck/design-tokens/lint' },
  rules: { 'no-raw-colors': noRawColors },
};
export default plugin;

// 命令行入口
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args.map((a) => resolve(a)) : [resolve(here, '../../ui')];
  const problems = scan(targets);
  const cwd = process.cwd();
  for (const p of problems) {
    console.error(`${relative(cwd, p.file)}:${p.line}:${p.column}  ${p.match}  ${MESSAGE}`);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} raw color value(s). Colors live only in packages/design-tokens.`);
    process.exit(1);
  }
  console.log(`No raw colors in ${targets.map((t) => relative(cwd, t) || '.').join(', ')}.`);
}
