// 模块边界规则。按目录写，目录还不存在时规则照样生效。
// 跑法：pnpm boundaries（scripts/boundaries.mjs 调 dependency-cruiser 的 API）。
// 每条规则在 tools/boundary-fixtures/cases/ 下有一个故意违规的样例，pnpm test 会断言它被拦住。
// 改规则时同步改样例和根目录 AGENTS.md 的「模块边界」一节。

/** 服务包：实现 contracts 里的服务，跑在主进程。 */
const SERVICES = ['tmux-host', 'git-service', 'workspace-service', 'agent-adapters', 'port-watch', 'store', 'mcp-server'];
const SERVICE = `^packages/(${SERVICES.join('|')})/`;

/** 内部代码（相对仓库根目录或样例根目录）。第三方包和 node 内置模块不匹配。 */
const INTERNAL = '^(packages|apps|tools)/';

/**
 * packages/ui 下任何代码都能用的东西。canvas 只开放注册表（src/registry.ts 或 src/registry/）。
 * tools/fakes 也放在这里，谁能用它由 fakes-only-in-tests-and-dev 单独管。
 */
const UI_SHARED = [
  '^packages/contracts/',
  '^packages/design-tokens/',
  '^packages/ui/kit/',
  '^packages/ui/canvas/src/registry(\\.tsx?$|/)',
  '^tools/fakes/',
];

/** 只有测试和 dev 入口可以 import tools/fakes。 */
const TEST_OR_DEV = [
  '\\.(test|spec)\\.tsx?$',
  '(^|/)(__tests__|test|tests|e2e)/',
  '(^|/)dev/',
  '\\.dev\\.tsx?$',
  '(^|/)(vitest|playwright)\\.config\\.[cm]?[jt]s$',
  '\\.setup\\.tsx?$',
];

/** 构建配置文件，在 node 里跑。 */
const BUILD_CONFIG = '(^|/)(vite|vitest|playwright)\\.config\\.[cm]?[jt]s$';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---- contracts ----
    {
      name: 'contracts-standalone',
      comment: 'packages/contracts 只放类型和纯函数：不依赖任何其他内部包、第三方包或 node 内置模块。',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { pathNot: '^packages/contracts/' },
    },

    // ---- 界面 ----
    {
      name: 'ui-allowed-deps',
      comment: 'packages/ui/* 只能依赖 contracts、design-tokens、ui/kit、ui/canvas 的注册表，以及自己包里的文件。canvas 另见下一条。',
      severity: 'error',
      from: { path: '^packages/ui/(?!widgets/|panels/|canvas/)([^/]+)/' },
      to: { path: INTERNAL, pathNot: [...UI_SHARED, '^packages/ui/$1/'] },
    },
    {
      name: 'ui-canvas-allowed-deps',
      comment:
        'packages/ui/canvas 是白板，把窗口外框（ui/window-shell）和顶栏（ui/topbar）组装起来，所以比其他界面包多这两个；' +
        '这两个包本身只是外观，不反过来依赖 canvas。其他照 ui-allowed-deps。',
      severity: 'error',
      from: { path: '^packages/ui/canvas/' },
      to: { path: INTERNAL, pathNot: [...UI_SHARED, '^packages/ui/(canvas|window-shell|topbar)/'] },
    },
    {
      name: 'ui-widget-panel-allowed-deps',
      comment:
        'packages/ui/widgets/*、packages/ui/panels/* 只能依赖 contracts、design-tokens、ui/kit、ui/canvas 的注册表，以及自己包里的文件。',
      severity: 'error',
      from: { path: '^packages/ui/(widgets|panels)/([^/]+)/' },
      to: { path: INTERNAL, pathNot: [...UI_SHARED, '^packages/ui/$1/$2/'] },
    },
    {
      name: 'no-widget-to-widget',
      comment: '各个 widget 之间不互相 import，要共享的东西放 contracts 或 ui/kit。',
      severity: 'error',
      from: { path: '^packages/ui/widgets/([^/]+)/' },
      to: { path: '^packages/ui/widgets/([^/]+)/', pathNot: '^packages/ui/widgets/$1/' },
    },
    {
      name: 'no-panel-to-panel',
      comment: '各个 panel 之间不互相 import，要共享的东西放 contracts 或 ui/kit。',
      severity: 'error',
      from: { path: '^packages/ui/panels/([^/]+)/' },
      to: { path: '^packages/ui/panels/([^/]+)/', pathNot: '^packages/ui/panels/$1/' },
    },
    {
      name: 'ui-no-services',
      comment: '界面不直接用服务包，走 window.agentdeck（contracts 里的 AgentDeckApi）。',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: SERVICE },
    },
    {
      name: 'ui-no-electron',
      comment: '界面跑在渲染进程，不能 import electron。',
      severity: 'error',
      from: { path: '^packages/ui/' },
      to: { path: '^electron(/|$)|(^|/)node_modules/electron/' },
    },
    {
      name: 'ui-no-node-builtins',
      comment: '界面跑在渲染进程，不能 import node 内置模块（fs、path、child_process……）。构建配置（vite / vitest / playwright 的 config）在 node 里跑，不算。',
      severity: 'error',
      from: { path: '^packages/ui/', pathNot: BUILD_CONFIG },
      to: { dependencyTypes: ['core'] },
    },

    // ---- 服务 ----
    {
      name: 'service-no-ui',
      comment: '服务包不能依赖界面。',
      severity: 'error',
      from: { path: SERVICE },
      to: { path: '^packages/ui/' },
    },
    {
      name: 'service-to-service',
      comment: '服务包之间不互相 import，只通过 contracts。唯一例外是 workspace-service → git-service（见下一条）。',
      severity: 'error',
      from: { path: `^packages/(${SERVICES.filter((s) => s !== 'workspace-service').join('|')})/` },
      to: { path: SERVICE, pathNot: '^packages/$1/' },
    },
    {
      name: 'workspace-service-only-git-service',
      comment: 'workspace-service 只能直接用 git-service，其他服务通过 contracts。',
      severity: 'error',
      from: { path: '^packages/workspace-service/' },
      to: { path: SERVICE, pathNot: '^packages/(workspace-service|git-service)/' },
    },

    // ---- 假实现 ----
    {
      name: 'fakes-only-contracts',
      comment: 'tools/fakes 在内部只能依赖 contracts（第三方包和 node 内置模块可以用）。',
      severity: 'error',
      from: { path: '^tools/fakes/' },
      to: { path: INTERNAL, pathNot: '^(tools/fakes|packages/contracts)/' },
    },
    {
      name: 'fakes-only-in-tests-and-dev',
      comment:
        '只有测试文件（*.test.ts、__tests__/、test/、e2e/、*.setup.ts、vitest 配置）和 dev 入口（dev/ 目录、*.dev.ts）可以 import tools/fakes。',
      severity: 'error',
      from: { pathNot: ['^tools/fakes/', ...TEST_OR_DEV] },
      to: { path: '^tools/fakes/' },
    },

    // ---- 组装 ----
    {
      name: 'only-desktop-uses-services',
      comment: '服务只由 apps/desktop 接到 IPC 上（加上上面允许的 workspace-service → git-service）。',
      severity: 'error',
      from: { pathNot: [SERVICE, '^apps/desktop/'] },
      to: { path: SERVICE },
    },
    {
      name: 'only-desktop-uses-ui',
      comment: '界面包只由 apps/desktop 的渲染进程装起来；只有 apps/desktop 能把服务和界面接在一起。',
      severity: 'error',
      from: { pathNot: ['^packages/ui/', '^apps/desktop/'] },
      to: { path: '^packages/ui/' },
    },
  ],
  options: {
    // node_modules 只是不往里走，不能 exclude：exclude 会把指向第三方包的依赖也删掉，electron 之类的规则就失效了
    doNotFollow: { path: '(^|/)node_modules/' },
    exclude: {
      path: [
        '^(packages|apps|tools)/[^/]+/(dist|out)/',
        '^packages/ui/[^/]+/[^/]+/(dist|out)/',
        '^tools/boundary-fixtures/',
      ],
    },
    // import type 也算依赖：界面引用服务的类型同样越界
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
      extensions: ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'],
      mainFields: ['types', 'module', 'main'],
    },
  },
};
