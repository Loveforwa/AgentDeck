// agentdeck 命令行的服务端（CR14）：主进程 /cli 收一个 CliRequest，回一个 CliResponse。
// 和 MCP 同一个服务、同一份工具实现：open、notify 直接调 tools.ts 里的 open_browser、notify；
// crew、session 只在这里（不进 MCP），转给 CrewService；doc、flow、lesson、run、job、out、forge 先只有路由和放行规则，服务还没有。
// 谁能跑哪条命令只看 contracts 的 cliCommandAllowed（规则只有那一份）；碰别的终端（session read / send / result）
// 先过 guard.ts 的 agentTerminalRefusal（AH7、AH11），和 MCP 的 read_terminal、send_to_terminal 同一条判断。
// 身份（终端 id）由 server.ts 按终端钥匙认好再传进来，这里不再看请求头。

import { cliCommandAllowed, parseCliCommand } from '@agentdeck/contracts';
import type {
  AgentDeckErrorData,
  AgentKind,
  CliCaller,
  CliCommandGroup,
  CliRequest,
  CliResponse,
  CrewMembership,
  CrewService,
  CrewSessionRef,
  CrewWaitRequest,
  SessionService,
  TerminalId,
} from '@agentdeck/contracts';
import { agentTerminalRefusal, WAITING_FOR_USER_MESSAGE } from './guard.ts';
import type { AgentTerminalAccess } from './guard.ts';
import { callTool, toErrorData, ToolContext } from './tools.ts';
import type { McpToolDeps } from './tools.ts';

/** 命令行另外要的服务。都是函数：服务可能还没组装（CR2、SE2 是别的线），返回 null 时相应的命令回 “… is not available yet”。 */
export interface CliDeps {
  /** 集群（membership 认角色；crew、session 命令）。 */
  crew?: () => CrewService | null;
  /** Session（调用者的 origin；session read / send 找目标的终端）。 */
  sessions?: () => Pick<SessionService, 'list' | 'get'> | null;
  /** 一条命令被拒绝了（不许、未登记的命令）。组装时记日志（TC-61：拒绝的调用记一条日志）。 */
  onCliRefused?: (r: { terminalId: TerminalId; command: string; message: string }) => void;
}

export type CliServiceDeps = McpToolDeps & CliDeps;

/** 一条命令的说明（agentdeck help 列出来的）。 */
interface CliCommandHelp {
  /** 和 CliRequest.command 一样的写法，cliCommandAllowed 据此判断给不给看。 */
  command: string;
  usage: string;
  about: string;
}

const HELP: readonly CliCommandHelp[] = [
  { command: 'open', usage: 'agentdeck open <url>', about: 'Open a web page (http(s) or a local file) in a browser window next to your terminal.' },
  { command: 'notify', usage: 'agentdeck notify <message>', about: 'Show the user a short notice on the board.' },
  { command: 'help', usage: 'agentdeck help [group]', about: 'The commands you can run here.' },
  { command: 'crew status', usage: 'agentdeck crew status [--since TIME]', about: 'Crew progress: tasks, sessions, slots and the digest.' },
  { command: 'crew diff', usage: 'agentdeck crew diff [label]', about: 'Changes against the crew branch (yours, or a session’s).' },
  { command: 'crew check', usage: 'agentdeck crew check [label]', about: 'Run the crew’s check command in a worktree.' },
  { command: 'crew merge', usage: 'agentdeck crew merge <label> [--continue | --abort]', about: 'Merge a session’s branch into the crew branch.' },
  { command: 'crew ask', usage: 'agentdeck crew ask <question> [--option A --option B]', about: 'Ask the user; the answer is typed back here.' },
  { command: 'crew note', usage: 'agentdeck crew note <text>', about: 'Record a finding for the crew report.' },
  { command: 'crew done', usage: 'agentdeck crew done <summary>', about: 'Say you are done.' },
  { command: 'session open', usage: 'agentdeck session open --agent AGENT [--label L] [--shared] < prompt.md', about: 'Open a session next to you and send it the prompt (stdin).' },
  { command: 'session list', usage: 'agentdeck session list', about: 'Sessions in this crew with their status.' },
  { command: 'session read', usage: 'agentdeck session read <label> [--lines N]', about: 'Last lines of a session’s screen.' },
  { command: 'session result', usage: 'agentdeck session result <label>', about: 'A session’s last full reply.' },
  { command: 'session send', usage: 'agentdeck session send <label> < message.md', about: 'Type a message into a session and press Enter.' },
  { command: 'session wait', usage: 'agentdeck session wait [label] [--all] [--timeout SECONDS]', about: 'Wait until a session (any, or all) stops.' },
  { command: 'session close', usage: 'agentdeck session close <label>', about: 'Close a session’s terminal.' },
];

/** 不带值的开关。 */
const BOOLEAN_FLAGS = new Set(['continue', 'abort', 'all', 'any', 'shared', 'own']);

export function notAvailable(group: string): AgentDeckErrorData {
  return { code: 'unsupported', message: `${group} is not available yet` };
}

/** 处理一条命令。不会抛：出错时回 { ok: false }。caller 是已经按钥匙认好的终端。 */
export async function handleCli(req: CliRequest, caller: TerminalId, deps: CliServiceDeps): Promise<CliResponse> {
  try {
    return await dispatch(req, caller, deps);
  } catch (e) {
    return { ok: false, error: toErrorData(e) };
  }
}

async function dispatch(req: CliRequest, caller: TerminalId, deps: CliServiceDeps): Promise<CliResponse> {
  const parsed = parseCliCommand(req.command);
  if (parsed === null) return refuse(deps, caller, req.command, { code: 'invalid-argument', message: `Unknown command: ${req.command || '(none)'}. Run agentdeck help.` });
  const { group, verb } = parsed;
  const crew = deps.crew?.() ?? null;
  // crew、session 的放行要 CrewService 认角色：它还没有时直接说没有，不说 “Not in a crew.”
  if ((group === 'crew' || group === 'session') && crew === null) return fail(notAvailable(group));

  const membership = crew ? await crew.membership(caller) : null;
  const who: CliCaller = { crew: membership ? { mode: membership.mode, role: membership.role } : null, origin: await originOf(caller, deps) };
  if (!cliCommandAllowed(req.command, who)) return refuse(deps, caller, req.command, { code: 'invalid-argument', message: refusal(group, verb, membership) });

  const a = parseArgs(req.args);
  const text = (): string => (a.positional.length > 0 ? a.positional.join(' ') : (req.stdin ?? '')).trim();
  switch (group) {
    case 'help':
      return ok(help(who, crew !== null, verb));
    case 'open': {
      const url = a.positional[0];
      if (!url) return fail({ code: 'invalid-argument', message: 'Usage: agentdeck open <url>' });
      return fromTool(await callTool('open_browser', { url }, deps, { terminalId: caller }));
    }
    case 'notify': {
      const message = text();
      if (!message) return fail({ code: 'invalid-argument', message: 'Usage: agentdeck notify <message>' });
      return fromTool(await callTool('notify', { message }, deps, { terminalId: caller }));
    }
    case 'crew':
      return crewCommand(crew!, caller, verb, a, text, who);
    case 'session':
      return sessionCommand(crew!, membership!, caller, verb, a, req, deps, who);
    default:
      // doc（DC5）、flow（CU3）、lesson（LR3）、run / job / out（RS1、RS3、RS5）、forge（FG6）是别的线：放行规则已经按
      // cliCommandAllowed 走过了，服务接上后在这里转过去
      return fail(notAvailable(group));
  }
}

async function crewCommand(crew: CrewService, caller: TerminalId, verb: string | null, a: ParsedArgs, text: () => string, who: CliCaller): Promise<CliResponse> {
  const target = a.positional[0];
  switch (verb) {
    case null:
    case 'help':
      return ok(help(who, true, 'crew'));
    case 'status': {
      const since = a.flag('since');
      return ok(await crew.status(caller, since ? { since } : {}));
    }
    case 'diff':
      return ok({ diff: await crew.diff(caller, target) });
    case 'check':
      return ok(await crew.check(caller, target));
    case 'merge':
      if (!target) return usage('agentdeck crew merge <label> [--continue | --abort]');
      return ok(await crew.merge(caller, target, { continue: a.has('continue'), abort: a.has('abort') }));
    case 'ask': {
      const question = text();
      if (!question) return usage('agentdeck crew ask <question> [--option A --option B]');
      return ok({ item: await crew.ask(caller, question, a.all('option')) });
    }
    case 'note': {
      const t = text();
      if (!t) return usage('agentdeck crew note <text>');
      await crew.note(caller, t);
      return ok({ noted: true });
    }
    case 'done': {
      const t = text();
      if (!t) return usage('agentdeck crew done <summary>');
      await crew.done(caller, t);
      return ok({ done: true });
    }
    default:
      // 模板模式的 plan、add、update、ready、task、review、contract、issue 由 CR3 在这里接上
      return fail(notAvailable(`agentdeck crew ${verb}`));
  }
}

async function sessionCommand(
  crew: CrewService,
  membership: CrewMembership,
  caller: TerminalId,
  verb: string | null,
  a: ParsedArgs,
  req: CliRequest,
  deps: CliServiceDeps,
  who: CliCaller,
): Promise<CliResponse> {
  const target = a.positional[0];
  /** 碰别的终端之前：隐藏的不许读写，在等你的不许打字（guard.ts，和 MCP 同一条判断）。 */
  const guard = async (access: AgentTerminalAccess, ref: CrewSessionRef): Promise<AgentDeckErrorData | null> => {
    const sessions = deps.sessions?.() ?? null;
    if (sessions === null) return notAvailable('session');
    const s = (await crew.sessions(membership.crewId)).find((x) => x.label === ref || x.sessionId === ref);
    if (!s) return null; // 不是这个集群的：交给服务报 not-found
    const terminalId = (await sessions.get(s.sessionId)).terminalId;
    if (terminalId === null) return null; // 终端停了：没有屏幕可看、没有输入框可打
    const ctx = new ToolContext(deps, { terminalId: caller });
    const refusal = agentTerminalRefusal(access, await ctx.accessTarget(terminalId));
    return refusal ? { code: refusal.code, message: refusal.message } : null;
  };
  switch (verb) {
    case null:
    case 'help':
      return ok(help(who, true, 'session'));
    case 'open':
    case 'spawn': {
      const agent = a.flag('agent');
      if (!agent) return usage('agentdeck session open --agent AGENT [--label L] [--shared] < prompt.md');
      const prompt = (req.stdin ?? a.flag('prompt') ?? '').trim();
      if (!prompt) return fail({ code: 'invalid-argument', message: 'Give the prompt on stdin: agentdeck session open --agent codex < prompt.md' });
      const taken = new Set((await crew.sessions(membership.crewId)).map((s) => s.label));
      const worktree = a.has('shared') ? 'shared' : a.has('own') ? 'own' : (a.flag('worktree') as 'own' | 'shared' | undefined);
      const owns = a.flag('owns');
      return ok(
        await crew.spawn(caller, {
          agent: agent as AgentKind,
          label: a.flag('label') ?? freeLabel(agent, taken),
          prompt,
          ...(worktree === 'own' || worktree === 'shared' ? { worktree } : {}),
          ...(owns ? { owns: owns.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
        }),
      );
    }
    case 'list':
      return ok((await crew.status(caller)).sessions);
    case 'read': {
      if (!target) return usage('agentdeck session read <label> [--lines N]');
      const refused = await guard('read', target);
      if (refused) return fail(refused);
      const n = Number(a.flag('lines'));
      return ok({ label: target, lines: (await crew.read(caller, target, Number.isInteger(n) && n > 0 ? n : undefined)).join('\n') });
    }
    case 'result': {
      if (!target) return usage('agentdeck session result <label>');
      const refused = await guard('read', target);
      if (refused) return fail(refused);
      return ok(await crew.result(caller, target));
    }
    case 'send': {
      const message = (a.positional.length > 1 ? a.positional.slice(1).join(' ') : (req.stdin ?? '')).trim();
      if (!target || !message) return usage('agentdeck session send <label> < message.md');
      const refused = await guard('send', target);
      if (refused) return fail(refused);
      const result = await crew.send(caller, target, message);
      if (result === 'waiting-for-user') return fail({ code: 'invalid-argument', message: WAITING_FOR_USER_MESSAGE });
      if (result === 'busy') return fail({ code: 'invalid-argument', message: `${target} is still working. Run agentdeck session wait ${target}, then send again.` });
      return ok({ sent: true, label: target });
    }
    case 'wait': {
      const seconds = Number(a.flag('timeout'));
      const timeout = Number.isFinite(seconds) && seconds > 0 ? { timeoutMs: seconds * 1000 } : {};
      const w: CrewWaitRequest = a.has('all') ? { mode: 'all', ...timeout } : target ? { mode: 'one', target, ...timeout } : { mode: 'any', ...timeout };
      return ok(await crew.wait(caller, w));
    }
    case 'close':
      if (!target) return usage('agentdeck session close <label>');
      await crew.close(caller, target);
      return ok({ closed: target });
    default:
      return fail(notAvailable(`agentdeck session ${verb}`));
  }
}

/** 发命令的终端的 Session 来历（forge 一组只给 origin 为 forge 的）。没有 SessionService、找不到时为 null。 */
async function originOf(caller: TerminalId, deps: CliDeps): Promise<CliCaller['origin']> {
  const sessions = deps.sessions?.() ?? null;
  if (sessions === null) return null;
  const all = await sessions.list().catch(() => []);
  return all.find((s) => s.terminalId === caller)?.origin.kind ?? null;
}

/** 不许时的一句话（TC-61 的几句原样）。 */
function refusal(group: CliCommandGroup, verb: string | null, m: CrewMembership | null): string {
  if (group === 'forge') return 'Only terminals opened from an issue or pull request can run agentdeck forge.';
  if (m === null) return 'Not in a crew.';
  if (group === 'session') return verb === 'open' || verb === 'spawn' ? 'Only the Lead can open sessions.' : 'Only the Lead can manage sessions.';
  if (verb === 'add' || verb === 'update' || verb === 'ready') return 'Only the Lead can change the plan.';
  return `Only the Lead can run agentdeck crew ${verb ?? ''}.`.replace(' .', '.');
}

function help(who: CliCaller, crewAvailable: boolean, group: string | null): { usage: string; commands: { usage: string; about: string }[] } {
  const commands = HELP.filter((h) => {
    const g = h.command.split(' ')[0]!;
    if ((g === 'crew' || g === 'session') && !crewAvailable) return false;
    if (group !== null && g !== group) return false;
    return cliCommandAllowed(h.command, who);
  }).map(({ usage, about }) => ({ usage, about }));
  return { usage: 'agentdeck <command> [args]. Output is JSON; on error the exit code is not 0 and the first line says why. Long text goes on stdin.', commands };
}

/** session open 没给 --label 时：agent 名，重了加 -2、-3…… */
function freeLabel(agent: string, taken: ReadonlySet<string>): string {
  if (!taken.has(agent)) return agent;
  for (let i = 2; ; i++) if (!taken.has(`${agent}-${i}`)) return `${agent}-${i}`;
}

interface ParsedArgs {
  positional: string[];
  flag(name: string): string | undefined;
  all(name: string): string[];
  has(name: string): boolean;
}

/** --name value、--name=value；BOOLEAN_FLAGS 里的不带值。`--` 之后全是普通参数。 */
export function parseArgs(args: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: [string, string | true][] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg.length === 2) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.push([arg.slice(2, eq), arg.slice(eq + 1)]);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      flags.push([name, next]);
      i++;
    } else flags.push([name, true]);
  }
  const values = (name: string) => flags.filter(([n, v]) => n === name && typeof v === 'string').map(([, v]) => v as string);
  return {
    positional,
    flag: (name) => values(name).at(-1),
    all: values,
    has: (name) => flags.some(([n]) => n === name),
  };
}

function ok(data: unknown): CliResponse {
  return data === undefined ? { ok: true } : { ok: true, data };
}

function fail(error: AgentDeckErrorData): CliResponse {
  return { ok: false, error };
}

function usage(text: string): CliResponse {
  return fail({ code: 'invalid-argument', message: `Usage: ${text}` });
}

function refuse(deps: CliDeps, terminalId: TerminalId, command: string, error: AgentDeckErrorData): CliResponse {
  deps.onCliRefused?.({ terminalId, command, message: error.message });
  return fail(error);
}

function fromTool(r: Awaited<ReturnType<typeof callTool>>): CliResponse {
  return r.ok ? ok(r.value) : fail(r.error);
}
