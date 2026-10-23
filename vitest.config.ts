import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// 根目录跑 vitest = 跑 pnpm-workspace.yaml 里每个包自己的测试。
// 每个包是一个 project：有自己的 vitest.config.* 就用它（比如界面包要 jsdom），没有就用默认设置、以包目录为根。
// 包名单从 pnpm-workspace.yaml 的 `- dir/*` 读出来，只认有 package.json 的目录。
const workspaceGlobs = [
  ...readFileSync('pnpm-workspace.yaml', 'utf8').matchAll(/^\s+-\s+['"]?([\w./-]+)\/\*['"]?\s*$/gm),
];

const projects = workspaceGlobs.flatMap(([, dir]) =>
  dir && existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'package.json')))
        .map((d) => join(dir, d.name))
    : [],
);

export default defineConfig({
  test: {
    projects,
    passWithNoTests: true,
  },
});
