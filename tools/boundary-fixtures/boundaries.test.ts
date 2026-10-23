// 证明边界规则真的生效：cases/<规则名>/ 必须触发同名规则，cases/allowed/ 必须一条都不触发；
// eslint/ 下的界面文件写死颜色必须被拦住，design-tokens 里的颜色和 token 变量不拦。
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { findViolations } from '../../scripts/boundaries.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CASES = join(HERE, 'cases');

const config = (await import(join(ROOT, '.dependency-cruiser.cjs'))).default as {
  forbidden: Array<{ name: string }>;
};
const ruleNames = config.forbidden.map((r) => r.name);
const violatingCases = readdirSync(CASES).filter((name) => name !== 'allowed');

describe('dependency-cruiser boundaries', () => {
  it('has one violating fixture per rule', () => {
    expect([...violatingCases].sort()).toEqual([...ruleNames].sort());
  });

  it.each(violatingCases)('cases/%s is rejected by its rule', async (rule) => {
    const violations = await findViolations(join(CASES, rule));
    expect(violations.map((v) => v.rule)).toContain(rule);
  });

  it('cases/allowed passes every rule', async () => {
    expect(await findViolations(join(CASES, 'allowed'))).toEqual([]);
  });
});

describe('eslint: no hard-coded colors in packages/ui', () => {
  const cwd = join(HERE, 'eslint');
  const eslint = new ESLint({ cwd, overrideConfigFile: join(ROOT, 'eslint.config.js') });

  const colorErrors = async () => {
    const results = await eslint.lintFiles(['.']);
    return Object.fromEntries(
      results.map((r) => [
        relative(cwd, r.filePath),
        r.messages.filter((m) => m.message.startsWith('Hard-coded color')).map((m) => m.line),
      ]),
    );
  };

  it('flags every hard-coded color in ui code and nothing else', async () => {
    expect(await colorErrors()).toEqual({
      'packages/design-tokens/src/colors.ts': [],
      'packages/ui/kit/src/Bad.tsx': [3, 4, 5, 6, 8, 9, 10],
      'packages/ui/kit/src/Good.tsx': [],
    });
  });
});
