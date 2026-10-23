# @agentdeck/boundary-fixtures

证明根目录的检查规则真的会拦东西。只有样例和一个测试文件，不被任何包依赖。

- `cases/<规则名>/`：模仿仓库目录结构（`packages/...`、`apps/...`、`tools/...`）的小样例，故意违反 `.dependency-cruiser.cjs` 里同名的规则。目录名必须和规则名一致，测试会核对「每条规则恰好有一个样例」。
- `cases/allowed/`：所有允许的写法，必须一条规则都不触发，防止规则写得过严。
- `eslint/`：`packages/ui` 里写死颜色（`Bad.tsx`，必须报）和不该报的写法（`Good.tsx`、design-tokens 里的颜色）。
- `boundaries.test.ts`：用 `scripts/boundaries.mjs` 在每个样例目录里跑 dependency-cruiser，用 ESLint API 跑 `eslint/`。

样例只用相对路径互相 import，不进 typecheck、ESLint 和根目录的 boundaries 检查（都已排除）。

跑测试：`pnpm --filter @agentdeck/boundary-fixtures test`，或根目录 `pnpm test`。

加规则时：在 `.dependency-cruiser.cjs` 加规则，在 `cases/` 加同名目录放违规样例，必要时在 `cases/allowed/` 补允许的写法，再更新根目录 AGENTS.md 的规则表。
