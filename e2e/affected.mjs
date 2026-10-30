// 改了哪些文件 → 要跑哪些 e2e（2026-10-29 用户定：只跑可能被影响到的，不每次全跑，见 e2e/AGENTS.md「只跑受影响的」）。
//
// 每条规则：路径（前缀，或正则）→ 要跑的 spec 文件名，或 ALL（全跑）、NONE（不用跑）。一个文件可以命中多条，取并集。
// - 跨很多功能的地方（contracts、apps/desktop 的组装、白板的控制器和 store、ui/kit、e2e 自己的支撑代码、依赖）→ ALL；
// - 文档、各包的单元测试、AGENTS.md → NONE；
// - 改了 e2e/tests 里的某个 spec → 跑它自己；
// - 没有规则认领的源码文件 → ALL（宁可多跑，打印出来，补一条规则）。
// 只要选中了任何一条，另加 SMOKE（启动、加项目、建工作区，几秒）。
// 新加 spec 时在下面挂上它覆盖的代码；`node e2e/scripts/affected.mjs --check` 会查每个 spec 都挂上了、挂的都存在。

export const ALL = 'ALL';
export const NONE = 'NONE';

export const SMOKE = ['tc01-tc02-project-workspace.e2e.ts'];

const TERMINAL = [
  'is05-terminal-feel.e2e.ts',
  'is07-back-to-back-terminals.e2e.ts',
  'is23-summary-restore.e2e.ts',
  'is82-zoomed-mouse.e2e.ts',
  'is157-zoom-idle-shell.e2e.ts',
  'tc06-tc09-tc10-terminals.e2e.ts',
  'tc11-system-terminal.e2e.ts',
  'tc25-resize-emoji.e2e.ts',
  'tc26-dark-theme.e2e.ts',
  'tc38-outside-workspace.e2e.ts',
  'tc109-send-sql.e2e.ts',
  'tc147-send-selection.e2e.ts',
];
const BROWSER = ['tc06-tc09-tc10-terminals.e2e.ts', 'tc18-shortcuts-in-browser.e2e.ts', 'tc27-tc28-web.e2e.ts', 'is16-keyboard-in-browser.e2e.ts', 'is124-local-pdf.e2e.ts'];
const GIT = [
  'tc03-tc08-two-worktrees.e2e.ts',
  'tc07-tc12-git.e2e.ts',
  'tc23-tc24-panel-stage-switch.e2e.ts',
  'tc36-commit-graph.e2e.ts',
  'tc16-tc33-manager.e2e.ts',
];
const WORKSPACES = ['tc01-tc02-project-workspace.e2e.ts', 'is02-worktree-rollback.e2e.ts', 'tc03-tc08-two-worktrees.e2e.ts', 'tc07-tc12-git.e2e.ts', 'tc15-project-settings.e2e.ts', 'tc23-tc24-panel-stage-switch.e2e.ts'];
const STATUS = ['tc04-tc13-notify.e2e.ts', 'tc05-tc30-agent-status.e2e.ts', 'is06-trust-prompt.e2e.ts', 'is14-notify-click.e2e.ts', 'tc42-approve-all.e2e.ts', 'tc148-needs-you.e2e.ts'];
const AGENTS = ['tc17-tc21-tc22-new-terminal.e2e.ts', 'tc46-first-message.e2e.ts', 'tc48-untested-version.e2e.ts', 'tc20-dock-launch-env.e2e.ts', 'is06-trust-prompt.e2e.ts'];
const MCP = ['tc34-tc35-subagent-group.e2e.ts', 'tc68-send-to-waiting.e2e.ts', 'tc110-hide-from-agents.e2e.ts', 'tc46-first-message.e2e.ts', 'cr15-agentdeck-command.e2e.ts', 'is14-notify-click.e2e.ts'];
const RESTORE = ['tc06-tc09-tc10-terminals.e2e.ts', 'is27-sigkill-restore.e2e.ts', 'tc14-restore-after-reboot.e2e.ts', 'tc52-tc55-sessions.e2e.ts'];
const AUTO_APPROVE = ['tc40-auto-approve.e2e.ts', 'tc42-approve-all.e2e.ts', 'tc48-untested-version.e2e.ts'];
const AUTO_RESUME = ['tc78-auto-resume.e2e.ts', 'tc80-tc81-codex-limits.e2e.ts'];
const USAGE = ['tc41-usage.e2e.ts'];
const SETTINGS = ['tc15-project-settings.e2e.ts', 'tc39-skills-mcp.e2e.ts', 'is14-notify-click.e2e.ts', 'is15-system-terminal-apps.e2e.ts', 'tc26-dark-theme.e2e.ts'];
const LAYOUT = ['tc29-topbar.e2e.ts', 'tc31-snap-avoid.e2e.ts', 'tc32-panel-collapse.e2e.ts', 'tc37-gestures.e2e.ts', 'tc40-auto-approve.e2e.ts'];
const NAV = ['tc16-tc33-manager.e2e.ts', 'tc148-needs-you.e2e.ts', 'mp2-pin-new-search.e2e.ts', 'tc32-panel-collapse.e2e.ts', 'tc147-send-selection.e2e.ts'];
// 性能（IS-26）要 AGENTDECK_E2E_PERF=1 才跑，默认跳过；选中它只是提醒
const PERF = ['is26-performance.e2e.ts'];

/** @type {{ match: string | RegExp, run: string | string[] }[]} */
/**
 * @typedef {{ match: string | RegExp, run: string[] | typeof ALL | typeof NONE | '$1' }} Rule
 * @type {Rule[]}
 */
export const RULES = [
  // 不用跑
  { match: /^docs\//, run: NONE },
  { match: /(^|\/)(AGENTS|CLAUDE|README|CONTRIBUTING|CONTRACT_NOTES)\.md$/, run: NONE },
  { match: /^packages\/.+\/(test|tests|__tests__|dev)\//, run: NONE },
  { match: /\.(test|spec)\.(ts|tsx|mjs)$/, run: NONE },
  { match: /^tools\/(fakes|boundary-fixtures)\//, run: NONE },
  { match: /^\.github\/workflows\/check\.yml$/, run: NONE },
  { match: /^\.claude\//, run: NONE },

  // e2e 自己：改了哪个 spec 跑哪个；支撑代码、假 agent、配置全跑
  { match: /^e2e\/tests\/([^/]+\.e2e\.ts)$/, run: '$1' },
  { match: 'e2e/affected.mjs', run: NONE },
  { match: 'e2e/scripts/affected.mjs', run: NONE },
  { match: /^e2e\//, run: ALL },
  { match: '.github/workflows/e2e.yml', run: ALL },

  // 跨很多功能：全跑
  { match: 'packages/contracts/', run: ALL },
  { match: /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json)$/, run: ALL },
  { match: /^packages\/[^/]+\/package\.json$/, run: ALL },
  { match: /^packages\/ui\/[^/]+\/package\.json$/, run: ALL },
  { match: 'packages/ui/kit/', run: ALL },
  { match: 'packages/design-tokens/tokens.css', run: [...LAYOUT, 'tc26-dark-theme.e2e.ts', 'tc05-tc30-agent-status.e2e.ts'] },
  { match: 'packages/design-tokens/', run: NONE },

  // apps/desktop：组装全跑，各块按功能
  { match: 'apps/desktop/src/main/browser/', run: BROWSER },
  { match: 'apps/desktop/src/main/mcp', run: MCP },
  { match: 'apps/desktop/src/main/sessions', run: RESTORE },
  { match: 'apps/desktop/src/main/window-options.ts', run: LAYOUT },
  { match: 'apps/desktop/src/main/alerts', run: ['tc04-tc13-notify.e2e.ts', 'is14-notify-click.e2e.ts'] },
  { match: 'apps/desktop/src/main/skills', run: ['tc39-skills-mcp.e2e.ts', 'tc77-skill-sets-cleanup.e2e.ts'] },
  { match: 'apps/desktop/src/main/limits', run: AUTO_RESUME },
  { match: 'apps/desktop/src/main/settings', run: SETTINGS },
  { match: /^apps\/desktop\/src\/main\/(terminal-service|terminal-ports)/, run: [...TERMINAL, 'tc11-system-terminal.e2e.ts', 'is15-system-terminal-apps.e2e.ts'] },
  { match: 'apps/desktop/src/utility/', run: [...TERMINAL, ...RESTORE, 'tc19-tmux-missing.e2e.ts'] },
  { match: 'apps/desktop/', run: ALL },

  // 服务
  { match: 'packages/tmux-host/', run: [...TERMINAL, ...RESTORE, 'tc19-tmux-missing.e2e.ts'] },
  { match: 'packages/git-service/', run: GIT },
  { match: 'packages/workspace-service/', run: WORKSPACES },
  { match: 'packages/port-watch/', run: ['tc06-tc09-tc10-terminals.e2e.ts', 'tc27-tc28-web.e2e.ts'] },
  { match: 'packages/store/', run: RESTORE },
  { match: 'packages/mcp-server/', run: MCP },
  { match: 'packages/doc-service/', run: NONE }, // 还没有界面用它
  { match: 'packages/agent-adapters/src/limits/', run: AUTO_RESUME },
  { match: 'packages/agent-adapters/src/usage/', run: USAGE },
  { match: 'packages/agent-adapters/src/skills/', run: ['tc39-skills-mcp.e2e.ts', 'tc77-skill-sets-cleanup.e2e.ts'] },
  { match: 'packages/agent-adapters/src/history/', run: ['tc52-tc55-sessions.e2e.ts', 'tc14-restore-after-reboot.e2e.ts'] },
  { match: 'packages/agent-adapters/src/subagents/', run: ['tc34-tc35-subagent-group.e2e.ts'] },
  { match: 'packages/agent-adapters/src/replies/', run: ['tc148-needs-you.e2e.ts'] },
  { match: 'packages/agent-adapters/src/first-message', run: ['tc46-first-message.e2e.ts'] },
  { match: 'packages/agent-adapters/src/status/', run: STATUS },
  { match: /^packages\/agent-adapters\/src\/(hook|approve)/, run: [...STATUS, ...AUTO_APPROVE] },
  { match: 'packages/agent-adapters/', run: [...AGENTS, ...STATUS] },
  { match: /^tools\/agentdeck-(cli|notify)\//, run: ['cr15-agentdeck-command.e2e.ts', 'is14-notify-click.e2e.ts', 'tc04-tc13-notify.e2e.ts'] },

  // 界面
  { match: 'packages/ui/widgets/terminal/', run: TERMINAL },
  { match: 'packages/ui/widgets/browser/', run: BROWSER },
  { match: 'packages/ui/panels/scm/', run: [...GIT, 'tc39-skills-mcp.e2e.ts', 'tc38-outside-workspace.e2e.ts'] },
  // 左边管理面板（MP2，取代 history 和 board-nav）
  { match: 'packages/ui/panels/manager/', run: [...NAV, 'tc52-tc55-sessions.e2e.ts'] },
  { match: 'packages/ui/topbar/', run: ['tc29-topbar.e2e.ts', 'tc32-panel-collapse.e2e.ts', 'tc05-tc30-agent-status.e2e.ts'] },
  { match: 'packages/ui/window-shell/', run: ['tc25-resize-emoji.e2e.ts', 'tc31-snap-avoid.e2e.ts', 'is23-summary-restore.e2e.ts', 'tc05-tc30-agent-status.e2e.ts'] },
  { match: /^packages\/ui\/canvas\/src\/plugins\/auto-approve/, run: AUTO_APPROVE },
  { match: /^packages\/ui\/canvas\/src\/plugins\/auto-resume/, run: AUTO_RESUME },
  { match: /^packages\/ui\/canvas\/src\/plugins\/usage/, run: USAGE },
  { match: 'packages/ui/canvas/src/plugins/', run: [...AUTO_APPROVE, ...AUTO_RESUME, ...USAGE] },
  { match: /^packages\/ui\/canvas\/src\/react\/(FrameNodeView|PluginMarks)/, run: [...LAYOUT, 'tc03-tc08-two-worktrees.e2e.ts', 'tc80-tc81-codex-limits.e2e.ts'] },
  { match: /^packages\/ui\/canvas\/src\/(model\/arrange|model\/snap|model\/avoid)/, run: LAYOUT },
  { match: /^packages\/ui\/canvas\/src\/react\/(Settings|settings)/, run: SETTINGS },
  { match: 'packages/ui/canvas/src/model/settings', run: SETTINGS },
  { match: /^packages\/ui\/canvas\/src\/react\/(BoardMenu|NewTerminal|AddProject|NewWorkspace)/, run: ['tc17-tc21-tc22-new-terminal.e2e.ts', ...WORKSPACES] },
  { match: /^packages\/ui\/canvas\/src\/react\/Group/, run: ['tc34-tc35-subagent-group.e2e.ts'] },
  { match: 'packages/ui/canvas/src/react/approvals', run: AUTO_APPROVE },
  { match: 'packages/ui/canvas/src/model/send', run: ['tc147-send-selection.e2e.ts', 'tc109-send-sql.e2e.ts'] },
  { match: /^packages\/ui\/canvas\/src\/model\/(navigation|agents)/, run: NAV },
  { match: 'packages/ui/canvas/src/model/restore', run: RESTORE },
  { match: /^packages\/ui\/canvas\/src\/react\/Clawd/, run: [...PERF, 'tc29-topbar.e2e.ts'] },
  { match: /^packages\/ui\/canvas\/src\/react\/(Background|background)/, run: ['tc34-tc35-subagent-group.e2e.ts'] },
  { match: 'packages/ui/canvas/src/canvas.css', run: [...LAYOUT, 'tc26-dark-theme.e2e.ts', 'tc34-tc35-subagent-group.e2e.ts'] },
  // 白板的控制器、store、Workbench、快捷键……几乎每条都经过：全跑
  { match: 'packages/ui/canvas/', run: ALL },
  { match: /^packages\/ui\//, run: ALL },
  { match: /^packages\//, run: ALL },
];

/**
 * @param {Rule} rule
 * @param {string} file
 * @returns {string[] | RegExpExecArray | null}
 */
function matches(rule, file) {
  if (typeof rule.match === 'string') return file.startsWith(rule.match) ? [file] : null;
  return rule.match.exec(file);
}

/**
 * 每个改动的文件按顺序找第一条命中的规则（规则从具体到宽泛排）。
 * @param {string[]} files 相对仓库根目录的路径
 * @param {string[]} specs e2e/tests 里现有的 spec 文件名
 * @returns {{ all: boolean, specs: string[], reasons: Map<string, string[]>, unmatched: string[] }}
 */
export function selectSpecs(files, specs) {
  /** @type {Set<string>} */
  const picked = new Set();
  /** @type {Map<string, string[]>} */
  const reasons = new Map();
  /** @type {string[]} */
  const unmatched = [];
  let all = false;
  /** @type {(spec: string, file: string) => void} */
  const add = (spec, file) => {
    picked.add(spec);
    const list = reasons.get(spec) ?? [];
    list.push(file);
    reasons.set(spec, list);
  };
  for (const file of files) {
    let hit = null;
    for (const rule of RULES) {
      const m = matches(rule, file);
      if (m) {
        hit = { rule, m };
        break;
      }
    }
    if (!hit) {
      // 不在任何源码目录里的文件（比如根目录的脚本）：宁可全跑
      if (/\.(ts|tsx|mjs|js|cjs|css|json)$/.test(file)) {
        unmatched.push(file);
        all = true;
      }
      continue;
    }
    const { run } = hit.rule;
    if (run === NONE) continue;
    if (run === ALL) {
      all = true;
      reasons.set('*', [...(reasons.get('*') ?? []), file]);
      continue;
    }
    if (run === '$1') {
      const spec = hit.m[1];
      if (spec && specs.includes(spec)) add(spec, file); // 删掉的 spec 不用跑
      continue;
    }
    for (const spec of run) add(spec, file);
  }
  if (!all && picked.size > 0) for (const s of SMOKE) add(s, '(smoke)');
  return { all, specs: all ? [...specs] : [...picked].filter((s) => specs.includes(s)).sort(), reasons, unmatched };
}

/**
 * 每个 spec 至少被一条规则挂上；规则里写的 spec 都存在。返回问题列表（空 = 没问题）。
 * @param {string[]} specs
 * @returns {string[]}
 */
export function checkRules(specs) {
  const mentioned = new Set(SMOKE);
  for (const rule of RULES) if (Array.isArray(rule.run)) for (const s of rule.run) mentioned.add(s);
  /** @type {string[]} */
  const problems = [];
  for (const s of mentioned) if (!specs.includes(s)) problems.push(`rule names ${s}, but e2e/tests has no such spec`);
  for (const s of specs) if (!mentioned.has(s)) problems.push(`${s} is not covered by any rule in e2e/affected.mjs`);
  return problems;
}
