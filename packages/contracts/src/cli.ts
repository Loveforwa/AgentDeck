// agentdeck 命令行的接口（M8 · CR13，需求见设计画布“Agent 集群”页 C7，调研 DR-72；分工 2026-10-28 修订）。
// agent 在自己的 shell 里跑 `agentdeck <组> <子命令> …`（tools/agentdeck-cli），每次现读 API_ENDPOINT_FILE 找地址，
// 带上 AGENTDECK_TERM 和 AGENTDECK_TERM_KEY 发一个 CliRequest 到主进程的 /cli（和 MCP 同一个服务、同一份工具实现，CR14）。
// 输出 JSON；出错时退出码非 0，第一行是英文原因。
//
// 谁能用哪一组（CLI_COMMAND_ACCESS、cliCommandAllowed）：
// - 开 session、管子 session 的（session）只给 Lead。
// - crew：集群流程的命令。Lead 全有；模板模式的 Worker、Reviewer、Integrator、QA 只有调度器在第一条提示词里写给它的那几条
//   （CREW_ROLE_COMMANDS，C3 第 4 节）；自由模式的子 session 一条都没有（“子 session 不带 crew 和 session 命令”）。
// - 只碰自己产物的 doc、flow、lesson、run、job、out，以及 open、notify、help：所有 AgentDeck 终端都有。
//   这些命令都不能开终端、不能批准、不能提交、不能合并。个别子命令另有限制（doc verdict 只认核查终端、flow verdicts 只认 Verifier），由各自的服务判断。
// - forge：只给 origin 为 forge 的终端（只写草稿）。
// 认身份靠终端钥匙：钥匙对不上终端 id 时 401。

import type { AgentDeckErrorData } from './common.ts';
import type { CrewMode } from './crew.ts';
import type { CrewRole, SessionOrigin } from './session.ts';

/** 每个 AgentDeck 终端环境里的钥匙：HMAC(AgentDeck 的密钥, 终端 id)。开终端时放进环境，不进命令行（IS-101）。 */
export const TERMINAL_KEY_ENV = 'AGENTDECK_TERM_KEY';

/** 相对用户主目录。AgentDeck 启动时写，换了端口也跟着改；命令行每次现读。内容是 ApiEndpointFile。 */
export const API_ENDPOINT_FILE = '.agentdeck/run/api.json';

/** 主进程上命令行的路径（和 MCP 同一个服务）。 */
export const CLI_PATH = '/cli';

/** API_ENDPOINT_FILE 的内容。url 和 socket 至少有一个（走 HTTP 还是 unix socket 由 CR12 的实测定）。 */
export interface ApiEndpointFile {
  v: 1;
  /** 例如 'http://127.0.0.1:47621'，请求发到 url + CLI_PATH。 */
  url?: string;
  /** unix socket 的绝对路径。 */
  socket?: string;
  /** 写这个文件的 AgentDeck 的 CONTRACTS_VERSION，命令行据此提示版本对不上。 */
  version: string;
}

export interface CliRequest {
  v: 1;
  /** 命令组加子命令，空格隔开，例如 'crew status'、'session spawn'、'help'。 */
  command: string;
  /** 其余参数原样（例如 ['--agent', 'codex', '--label', 'race']）。 */
  args: string[];
  /** 长内容（交接提示词、review 意见）从 stdin 读进来放在这里。 */
  stdin?: string;
}

/** ok 时 data 是这条命令的结果（JSON）；出错时 error 的 message 就是命令行打的第一行。 */
export type CliResponse = { ok: true; data?: unknown } | { ok: false; error: AgentDeckErrorData };

/** 命令组。 */
export type CliCommandGroup =
  | 'crew'
  | 'session'
  | 'doc'
  | 'flow'
  | 'lesson'
  | 'run'
  | 'job'
  | 'out'
  | 'forge'
  | 'open'
  | 'notify'
  | 'help';

/**
 * 一组命令给谁：lead 只给集群的 Lead；crew 给集群里的终端，再按角色看子命令（CREW_ROLE_COMMANDS）；
 * all 所有 AgentDeck 终端；forge 只给 origin 为 forge 的终端。
 */
export type CliAccess = 'lead' | 'crew' | 'all' | 'forge';

export const CLI_COMMAND_ACCESS: Readonly<Record<CliCommandGroup, CliAccess>> = {
  crew: 'crew',
  session: 'lead',
  doc: 'all',
  flow: 'all',
  lesson: 'all',
  run: 'all',
  job: 'all',
  out: 'all',
  forge: 'forge',
  open: 'all',
  notify: 'all',
  help: 'all',
};

/** 模板模式里非 Lead 的角色能用的 crew 子命令（C3 第 4 节）。Lead 全有；自由模式的子 session 没有。 */
export const CREW_ROLE_COMMANDS: Readonly<Record<Exclude<CrewRole, 'lead'>, readonly string[]>> = {
  worker: ['task', 'done', 'note', 'issue', 'contract', 'ask', 'help'],
  reviewer: ['task', 'diff', 'review', 'note', 'issue', 'ask', 'help'],
  integrator: ['task', 'plan', 'diff', 'note', 'issue', 'ask', 'help'],
  qa: ['task', 'plan', 'note', 'issue', 'ask', 'help'],
};

/** 发命令的终端是谁：在哪个集群、什么角色（CrewService.membership），和它的 Session 的来历。 */
export interface CliCaller {
  crew: { mode: CrewMode; role: CrewRole } | null;
  origin: SessionOrigin['kind'] | null;
}

/** 'crew status --since 23:40' → { group: 'crew', verb: 'status' }。认不出的组返回 null。 */
export function parseCliCommand(command: string): { group: CliCommandGroup; verb: string | null } | null {
  const [group, verb] = command.trim().split(/\s+/);
  if (group === undefined || !Object.hasOwn(CLI_COMMAND_ACCESS, group)) return null;
  return { group: group as CliCommandGroup, verb: verb ?? null };
}

/** 这个终端能不能跑这条命令。服务端和命令行的 help 都用它，规则只有这一份。 */
export function cliCommandAllowed(command: string, caller: CliCaller): boolean {
  const parsed = parseCliCommand(command);
  if (parsed === null) return false;
  switch (CLI_COMMAND_ACCESS[parsed.group]) {
    case 'all':
      return true;
    case 'forge':
      return caller.origin === 'forge';
    case 'lead':
      return caller.crew?.role === 'lead';
    case 'crew': {
      const crew = caller.crew;
      if (crew === null) return false;
      if (crew.role === 'lead') return true;
      if (crew.mode === 'free') return false;
      return parsed.verb === null || CREW_ROLE_COMMANDS[crew.role].includes(parsed.verb);
    }
  }
}
