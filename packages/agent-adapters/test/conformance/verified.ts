// 合格测试 L1 的“标准答案”：在真程序上核对过的启动参数和按键，和适配器代码分开写。
// 改适配器里的参数（known.ts、claude.ts、codex.ts）时 L1 的对应 K 会失败：先用真程序核对（L2 或手工），再改这里。
// `<id>` 换成要接回 / fork 的会话 id，`<new>` 换成 AgentDeck 生成的新 id，`<cwd>` 换成工作目录，`<prompt>` 换成第一条消息。

export interface Verified {
  /** 假程序 --version 打印什么（L1 的 K1），和 compat 记录的版本一致。 */
  versionOutput: string;
  version: string;
  /** 新会话的会话参数（开头几项）。 */
  newArgs: string[];
  resume: string[] | null;
  fork: string[] | null;
  /**
   * 第一条消息：tail = 放在参数最后（和前面的分隔）；beforeExtra = 放在用户额外参数前面（pi 不认 --）并对 @、- 开头加空格；
   * after-ready = 启动后打进去（kimi）。
   */
  prompt: { kind: 'tail'; args: string[] } | { kind: 'before-extra' } | { kind: 'after-ready' };
  /** “允许一次”的按键。 */
  approveOnce: string[] | null;
  /** AgentDeck 的 MCP 怎么挂（K14）：启动参数里要出现的东西。 */
  mcpArgs: string[] | null;
  /** 带 skill 的参数名（K15）。 */
  skillFlag: string | null;
  /** 会让 agent 自己另开 worktree 或换目录的参数（K18），AgentDeck 生成的参数里不能有。 */
  worktreeFlags: string[];
}

export const VERIFIED: Record<string, Verified> = {
  claude: {
    versionOutput: '2.1.291 (Claude Code)',
    version: '2.1.291',
    newArgs: ['--session-id', '<new>'],
    resume: ['--resume', '<id>'],
    fork: ['--resume', '<id>', '--fork-session', '--session-id', '<new>'],
    prompt: { kind: 'tail', args: ['--', '<prompt>'] },
    approveOnce: ['1'],
    mcpArgs: ['--mcp-config'],
    skillFlag: '--plugin-dir',
    worktreeFlags: ['--worktree', '-w', '--tmux'],
  },
  codex: {
    versionOutput: 'codex-cli 0.165.0',
    version: '0.165.0',
    newArgs: [],
    resume: ['resume', '<id>'],
    fork: ['fork', '-C', '<cwd>', '<id>'],
    prompt: { kind: 'tail', args: ['--', '<prompt>'] },
    approveOnce: ['y'],
    mcpArgs: ['-c', 'mcp_servers.agentdeck.url="<url>"'],
    skillFlag: null,
    worktreeFlags: ['--worktree'],
  },
  pi: {
    versionOutput: '0.83.0',
    version: '0.83.0',
    newArgs: ['--session-id', '<new>'],
    resume: ['--session', '<id>'],
    fork: ['--fork', '<id>', '--session-id', '<new>'],
    prompt: { kind: 'before-extra' },
    approveOnce: null,
    mcpArgs: null,
    skillFlag: '--skill',
    worktreeFlags: [],
  },
  omp: {
    versionOutput: 'omp/18.0.4',
    version: '18.0.4',
    newArgs: [],
    resume: ['--resume', '<id>'],
    fork: ['--fork', '<id>'],
    prompt: { kind: 'tail', args: ['--', '<prompt>'] },
    approveOnce: ['Up', 'Enter'],
    mcpArgs: ['--plugin-dir', '<mcp-plugin>'],
    skillFlag: '--plugin-dir',
    worktreeFlags: ['--cwd'],
  },
  kimi: {
    versionOutput: '2.3.3',
    version: '2.3.3',
    newArgs: [],
    resume: ['-S', '<id>'],
    fork: null,
    prompt: { kind: 'after-ready' },
    approveOnce: null,
    mcpArgs: null,
    skillFlag: '--skills-dir',
    worktreeFlags: [],
  },
};

/** 把模板里的占位换掉。 */
export function fill(template: readonly string[], v: Record<string, string>): string[] {
  return template.map((a) => a.replace(/<(\w[\w-]*)>/g, (m, k: string) => v[k] ?? m));
}

/** needle 作为连续的一段出现在 hay 里的位置；没有为 -1。 */
export function indexOfRun(hay: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return 0;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((x, j) => hay[i + j] === x)) return i;
  }
  return -1;
}
