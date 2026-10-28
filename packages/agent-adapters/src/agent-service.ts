// AgentService 的真实实现：检测安装情况，用适配器算出启动命令，再调 TerminalHost.create。
//
// AH3（DR-60 P0）在这里做的几件事：
// - 能力报告（AgentInfo.report、check）：适配器声明 + 合格测试记录（src/compat/records.ts）+ 运行时降级，见 capabilities/report.ts。
// - agent 自己升级了（可执行文件的修改时间变了）：启动前重读这一家的版本（IS-77）。
// - 启动参数被拒（IS-73）：版本没核对过的第一次启动，等 3 秒看它有没有因为“不认识的参数”退出；退出了就只带会话参数重开一次，
//   终端标降级（StatusSnapshot.degraded），报告的 status 一项写原因。核对过的版本、同一版本已经起来过一次的，不等。
// - Check again（check）：重读版本、在 --help 里找要带的参数、带钩子空启动一次等钩子（在上次启动的目录里，10 秒后关掉），不发提示词。

import { randomBytes } from 'node:crypto';
import { delimiter } from 'node:path';
import { AgentDeckError, TERMINAL_KEY_ENV } from '@agentdeck/contracts';
import type {
  AgentCapabilityReport,
  AbsPath,
  AgentInfo,
  AgentKind,
  AgentService,
  AgentSessionId,
  CapabilityEntry,
  CapabilityKey,
  LaunchSpec,
  McpEndpoint,
  StartAgentRequest,
  StartAgentResult,
  TerminalEvent,
  TerminalHost,
  TerminalId,
  WorkspaceId,
} from '@agentdeck/contracts';
import type { FirstMessageTiming } from './first-message.ts';
import { FirstMessageTyper } from './first-message.ts';
import type { CommandLaunchContext } from './adapters/shell.ts';
import type { AdapterLaunchContext, AgentAdapterExt, DetectResult } from './adapters/types.ts';
import { no, statusFromActivity, yes } from './capabilities/declare.ts';
import { buildReport, newerThanChecked } from './capabilities/report.ts';
import { COMPAT_RECORDS } from './compat/records.ts';
import type { CompatRecord } from './compat/types.ts';
import type { LaunchSkills } from './skills/types.ts';
import type { EnvSource } from './env.ts';
import { fileStamp, findExecutable, helpHasFlag, readHelp } from './env.ts';
import type { ConversationCheck } from './fork.ts';

/**
 * LaunchContext.terminalId 要求在创建前就知道终端 id，但 TerminalHost.create 才分配 id，调用方没法指定。
 * 目前没有适配器用到它（钩子靠 tmux 设的 AGENTDECK_TERM 认终端），先传这个占位值。见 CONTRACT_NOTES.md。
 */
export const PENDING_TERMINAL_ID = 'pending' as TerminalId;

/** 一个 agent 终端开起来之后告诉状态机（StatusMachine.track）。 */
export interface StartedAgent {
  terminalId: TerminalId;
  agent: AgentKind;
  workspaceId: WorkspaceId | null;
  /** 这次启动是否真的带上了钩子。没有时状态靠输出活动判断。 */
  hooks: boolean;
  sessionId: AgentSessionId | null;
  /** N9：这次带上的 skill 和 MCP（没有 skills 选项、或 shell 时为 null）。组装方据此记下 running。 */
  skills: LaunchSkills | null;
  /**
   * AH3（IS-74）：钩子什么时候该来（StatusMachine 的 TrackOptions.watchHooks）。没有钩子时为 null。
   * codex 的 SessionStart 要等第一次输入（带第一条消息启动时算 startup）。
   */
  watchHooks: 'startup' | 'first-input' | null;
  /** AH3：一开始就按输出判断的原因（没有钩子的 agent、钩子准备失败、只带会话参数重开），给状态灯悬停。 */
  degraded: string | null;
}

export interface AgentServiceOptions {
  adapters: AgentAdapterExt[];
  /**
   * create 开终端。sendKeys、lastLines 给“启动后打第一条消息”（AH1，kimi）用：不给 sendKeys 时这类 agent 带 prompt 会报 unsupported。
   * lastLines、kill 给启动参数被拒时重开（AH3）、Check again 的空启动用。
   * 要让这些工作，组装方还要把 TerminalHost 的事件交给 onTerminalEvent（createAgentRuntime 已经接好）。
   */
  terminals: Pick<TerminalHost, 'create'> & Partial<Pick<TerminalHost, 'sendKeys' | 'sendText' | 'lastLines' | 'kill'>>;
  /** 登录 shell 的环境，检测自定义命令用。 */
  env: EnvSource;
  /** agentdeck-notify 的绝对路径。 */
  notifyCommand: AbsPath;
  /** Settings › Agents 里的额外启动参数。 */
  extraArgs?: (agent: AgentKind) => string[];
  /** AgentDeck 的 MCP 服务（M1）。返回 null 表示没起来，这次启动不挂。 */
  mcp?: () => McpEndpoint | null;
  /**
   * N9：这次启动带哪些 skill 和 MCP（按白板上存的选择，SkillsServiceImpl.prepareLaunch）。不给、返回 null 时和以前一样：
   * 有 mcp 就挂 AgentDeck 的 MCP，不带别的。出错时当作 null（skill 带不上不能让终端起不来）。
   */
  skills?: (req: StartAgentRequest) => Promise<LaunchSkills | null>;
  onStarted?: (started: StartedAgent) => void;
  /**
   * X4：fork 前看原来的对话在不在（fork.ts）。返回 false 时不开终端，抛 not-found；null、出错、不给时照常启动。
   */
  conversationExists?: ConversationCheck;
  /**
   * CR15（IS-101）：这个终端的钥匙（组装时接 mcp-server 的 terminalKey）。给了就在启动前生成终端 id（CreateTerminalRequest.id），
   * 钥匙放进环境的 AGENTDECK_TERM_KEY，挂 AgentDeck MCP 时也用它代替共用 token（MCP 配置里的 ${AGENTDECK_MCP_TOKEN} 展开成钥匙），
   * 终端环境里就没有共用的密钥了。返回 null 时这个终端不带钥匙。
   */
  terminalKey?: (terminalId: TerminalId) => string | null;
  /** CR15：agentdeck 命令所在的目录（<数据目录>/bin），放在每个 AgentDeck 终端 PATH 的最前面。系统自己的终端不受影响。 */
  binDir?: AbsPath;
  /** AH1：启动后打第一条消息的等待时间（测试用）。 */
  firstMessageTiming?: FirstMessageTiming;
  /** AH3：合格测试记录，默认 src/compat/records.ts（测试里换）。 */
  compat?: Readonly<Record<string, CompatRecord>>;
  /** AH3：Check again 的空启动等钩子：这个终端在 timeoutMs 内有没有发来任何钩子（runtime 接 HookServer）。不给时不做空启动。 */
  waitForHook?: (terminalId: TerminalId, timeoutMs: number) => Promise<boolean>;
  /** AH3：启动后等多久看参数有没有被拒（毫秒，默认 3000）；空启动等钩子多久（默认 10000）。 */
  launchTiming?: { earlyExitMs?: number; probeMs?: number };
  now?: () => Date;
}

/** 改 PATH 时经它启动（见 start）。macOS 和 Linux 都在这里。 */
const ENV_COMMAND = '/usr/bin/env';

/** 和 tmux-host 生成的 id 同一个样子。 */
function newTerminalId(): TerminalId {
  return `t-${randomBytes(6).toString('hex')}` as TerminalId;
}

/** agent 因为不认识的参数退出时输出里常见的话（commander、clap、yargs、cac、node:util parseArgs……）。 */
const REJECTED_OPTION = /unknown (?:option|argument|flag|command)|unrecognized (?:option|argument|arguments)|unexpected argument|invalid option|unexpected (?:option|flag)|no such option|not a valid option/i;

interface Detection {
  adapter: AgentAdapterExt;
  result: DetectResult;
  /** 检测时可执行文件的修改时间（IS-77）。 */
  stamp: number | null;
  /** 能力报告的检查时间（检测或 Check again）。 */
  checkedAt: string;
}

export class AgentServiceImpl implements AgentService {
  private readonly adapters: Map<string, AgentAdapterExt>;
  private detection: Promise<void> | null = null;
  /** 最近一次检测的结果（同步读，ApprovalService 的策略要用）。 */
  private latest = new Map<string, Detection>();
  private readonly typer: FirstMessageTyper | null;
  private readonly compat: Readonly<Record<string, CompatRecord>>;
  private readonly now: () => Date;
  /** 上一次启动的状态退回按输出判断的原因（报告的 status 一项），钩子来了就清掉。 */
  private readonly launchNotes = new Map<string, string>();
  /** 上一次 Check again 失败的项。 */
  private readonly checkFailures = new Map<string, Map<CapabilityKey, string>>();
  /** 上一次启动的目录（Check again 在这里空启动：agent 信任过它，不会弹信任框）。 */
  private readonly lastCwd = new Map<string, AbsPath>();
  /** 这次运行里已经正常起来过的 “agent@版本@修改时间”（不用再等参数被拒）。 */
  private readonly proven = new Set<string>();
  /** 这次运行里参数被拒过的 “agent@版本@修改时间” → 那一行输出：之后直接只带会话参数启动，不再等 3 秒。 */
  private readonly rejected = new Map<string, string>();
  private readonly exitWaiters = new Map<TerminalId, (code: number) => void>();

  constructor(private readonly opts: AgentServiceOptions) {
    this.adapters = new Map(opts.adapters.map((a) => [a.id, a]));
    this.compat = opts.compat ?? COMPAT_RECORDS;
    this.now = opts.now ?? (() => new Date());
    const { sendKeys, sendText, lastLines } = opts.terminals;
    this.typer = sendKeys
      ? new FirstMessageTyper(
          {
            sendKeys: sendKeys.bind(opts.terminals),
            ...(sendText ? { sendText: sendText.bind(opts.terminals) } : {}),
            ...(lastLines ? { lastLines: lastLines.bind(opts.terminals) } : {}),
          },
          opts.firstMessageTiming,
        )
      : null;
  }

  /** TerminalHost 的事件（AH1：等终端安静下来再打第一条消息；AH3：启动后很快退出）。createAgentRuntime 接好了。 */
  onTerminalEvent(event: TerminalEvent): void {
    this.typer?.onTerminalEvent(event);
    if (event.type === 'terminal.exit') {
      const w = this.exitWaiters.get(event.id);
      if (w) {
        this.exitWaiters.delete(event.id);
        w(event.code);
      }
    }
  }

  /** 停掉还在等着打第一条消息的计时器。 */
  dispose(): void {
    this.typer?.dispose();
  }

  async list(): Promise<AgentInfo[]> {
    this.detection ??= this.detectAll();
    await this.detection;
    return [...this.adapters.values()].flatMap((a) => {
      const d = this.latest.get(a.id);
      return d ? [this.info(d)] : [];
    });
  }

  async refresh(): Promise<AgentInfo[]> {
    this.detection = this.detectAll();
    return this.list();
  }

  /**
   * AH3：Check again。只做不花钱的探测：重读版本、在 --help 里找要带的参数、（有钩子、知道上次在哪个目录启动时）带钩子空启动一次，
   * 等钩子 10 秒后关掉。不发提示词，不写 agent 自己的配置。返回新的报告。
   */
  async check(agent: AgentKind): Promise<AgentCapabilityReport> {
    const adapter = this.adapters.get(agent);
    if (!adapter) throw new AgentDeckError({ code: 'not-found', message: `Unknown agent: ${agent}` });
    await this.list();
    const d = await this.detectOne(adapter);
    const failures = new Map<CapabilityKey, string>();
    if (d.result.installed && d.result.path) {
      const flags = adapter.launchFlags?.(d.result.version) ?? [];
      if (flags.length > 0) {
        const help = await readHelp(d.result.path, this.opts.env());
        if (help !== null) {
          for (const f of flags) {
            if (helpHasFlag(help, f.flag)) continue;
            const what = f.flag.startsWith('command:') ? `The ${f.flag.slice('command:'.length)} command` : f.flag;
            for (const k of f.keys) if (!failures.has(k)) failures.set(k, `${what} isn't in ${adapter.command} --help`);
          }
        }
      }
      const alive = await this.probeHooks(adapter, d);
      if (alive === true) this.launchNotes.delete(agent);
      else if (alive === false) this.launchNotes.set(agent, "Hooks didn't report when checked");
    }
    this.checkFailures.set(agent, failures);
    return this.report(d);
  }

  async start(req: StartAgentRequest): Promise<StartAgentResult> {
    const adapter = this.adapters.get(req.agent);
    if (!adapter) throw new AgentDeckError({ code: 'not-found', message: `Unknown agent: ${req.agent}` });
    await this.list();
    // IS-77：agent 自己升级了（可执行文件变了）就重读这一家
    const det = await this.freshen(adapter);
    const info = this.info(det);
    if (!info.installed) {
      throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${adapter.command}` });
    }
    if (req.mode.kind === 'resume' && !info.capabilities.resume) {
      throw new AgentDeckError({ code: 'unsupported', message: `${adapter.label} can't resume a conversation` });
    }
    if (req.mode.kind === 'fork' && !info.capabilities.fork) {
      throw new AgentDeckError({ code: 'unsupported', message: `${adapter.label} can't fork a conversation` });
    }
    if (req.mode.kind === 'fork') {
      // 还没说过话的会话没有文件，agent 会报 “No conversation found” 直接退出（X4）
      const found = await this.opts.conversationExists?.(req.agent, req.mode.sessionId).catch(() => null);
      if (found === false) {
        throw new AgentDeckError({
          code: 'not-found',
          message: `No conversation to fork yet. Send ${adapter.label} a message first.`,
          detail: `${req.agent} session ${req.mode.sessionId} has no saved conversation`,
        });
      }
    }

    const skills = (await this.opts.skills?.(req).catch(() => null)) ?? null;
    // CR15：要给终端钥匙时先定下终端 id（钥匙由它算）
    const terminalId = this.opts.terminalKey ? newTerminalId() : null;
    const key = terminalId ? this.opts.terminalKey!(terminalId) : null;
    const ctx: CommandLaunchContext & AdapterLaunchContext = {
      cwd: req.cwd,
      terminalId: terminalId ?? PENDING_TERMINAL_ID,
      mode: req.mode,
      notifyCommand: this.opts.notifyCommand,
      extraArgs: this.opts.extraArgs?.(req.agent) ?? [],
      ...(req.command !== undefined ? { command: req.command } : {}),
      ...(req.prompt ? { prompt: req.prompt } : {}),
    };
    const mcp = this.opts.mcp?.();
    // N9：这个终端没勾 built-in 的 agentdeck 时不挂。CR15：有钥匙时 MCP 也按钥匙认（共用 token 不进终端环境）
    if (mcp && (skills?.agentdeckMcp ?? true)) ctx.mcp = key ? { url: mcp.url, token: key } : mcp;
    if (skills) ctx.skills = skills;
    const prepared = info.capabilities.hooks ? await adapter.prepare?.(ctx) : undefined;
    let spec = adapter.launch(ctx);
    // AH1（IS-76）：第一条消息送不到就报错，不空着启动。不填 consumed 的老适配器按旧规矩：claude、codex 算用上了。
    // prompt 只对新会话有意义（resume、fork 时照旧不带，contracts 的 LaunchContext.prompt）。
    const sendAfterReady = spec.sendAfterReady !== undefined && this.typer ? spec.sendAfterReady : null;
    if (req.prompt && req.mode.kind === 'new') {
      const consumed = spec.consumed?.prompt ?? (req.agent === 'claude' || req.agent === 'codex');
      if (!consumed && sendAfterReady === null) {
        throw new AgentDeckError({
          code: 'unsupported',
          message: `${adapter.label} can't take a first message yet. Open it without "prompt", or pick an agent that can (see Settings › Agents).`,
        });
      }
    }

    if (req.agent === 'custom' && !(await findExecutable(spec.cmd, this.opts.env()))) {
      throw new AgentDeckError({ code: 'command-not-found', message: `Command not found: ${spec.cmd}` });
    }
    const create = (s: LaunchSpec) => {
      const env = this.terminalEnv(s.env, key);
      // tmux 3.6a 不认 new-session -e PATH=…（窗格的 PATH 取 tmux 客户端自己的，实测），所以 PATH 要改时经 /usr/bin/env 设好再 exec。
      // 窗口里记的、返回的仍是原来的 cmd / args；env exec 之后窗格里的进程就是程序本身。
      const launch = env?.PATH && env.PATH !== s.env?.PATH ? { cmd: ENV_COMMAND, args: [`PATH=${env.PATH}`, s.cmd, ...s.args] } : s;
      return this.opts.terminals.create({
        // CR15：钥匙按这个 id 算；AH3 参数被拒重开时先 kill 再用同一个 id
        ...(terminalId ? { id: terminalId } : {}),
        cmd: launch.cmd,
        args: launch.args,
        cwd: req.cwd,
        ...(env ? { env } : {}),
        ...(req.size ? { size: req.size } : {}),
        // X6：恢复 Shell 时把上次的命令填进输入行、不运行。只对交互的 shell 有意义（agent 的输入框、-c 跑的命令都不该收到）
        ...(req.agent === 'shell' && req.prefill && req.command === undefined ? { prefill: req.prefill } : {}),
      });
    };
    // AH3（IS-73）：版本没核对过的第一次启动，看它会不会因为不认识的参数马上退出
    const provenKey = `${req.agent}@${det.result.version ?? '?'}@${det.stamp ?? '?'}`;
    const watchExit = !!adapter.launchFlags && !this.proven.has(provenKey) && this.unverified(det) && !!this.opts.terminals.lastLines;
    let hooks = info.capabilities.hooks && (prepared?.hooks ?? true);
    let degraded: string | null = null;
    const sessionOnly = (line: string) => {
      const only: CommandLaunchContext & AdapterLaunchContext = { ...ctx, sessionOnly: true };
      spec = adapter.launch(only);
      hooks = false;
      degraded = `Started with session options only · ${line}`;
      this.launchNotes.set(req.agent, degraded);
    };
    const known = this.rejected.get(provenKey);
    if (known !== undefined) sessionOnly(known);
    let { id } = await create(spec);
    if (watchExit && known === undefined) {
      const line = await this.rejectedOption(id);
      if (line === null) {
        this.proven.add(provenKey);
      } else {
        this.rejected.set(provenKey, line);
        await this.opts.terminals.kill?.(id).catch(() => undefined);
        sessionOnly(line);
        ({ id } = await create(spec));
      }
    }
    if (!hooks && degraded === null) degraded = noHooksReason(info);
    this.lastCwd.set(req.agent, req.cwd);

    if (sendAfterReady !== null && req.prompt && req.mode.kind === 'new') this.typer?.add(id, sendAfterReady, adapter.notReadyScreens ?? []);
    const firstInput = adapter.sessionStartOnFirstInput === true && !(req.prompt && req.mode.kind === 'new');
    this.opts.onStarted?.({
      terminalId: id,
      agent: req.agent,
      workspaceId: req.workspaceId,
      hooks,
      sessionId: spec.sessionId,
      skills,
      watchHooks: hooks ? (firstInput ? 'first-input' : 'startup') : null,
      degraded,
    });
    return { terminalId: id, sessionId: spec.sessionId, cmd: spec.cmd, args: spec.args };
  }

  /**
   * CR15：每个 AgentDeck 终端（agent、Shell、自定义命令都算，pi、kimi 也是）都加的环境：PATH 前面是 binDir（agentdeck 命令），
   * AGENTDECK_TERM_KEY 是这个终端的钥匙。只放进这个终端的 LaunchSpec.env，不写任何配置文件。
   */
  private terminalEnv(env: Record<string, string> | undefined, key: string | null): Record<string, string> | undefined {
    const binDir = this.opts.binDir;
    if (!binDir && !key) return env;
    const base = env?.PATH ?? this.opts.env().PATH ?? '';
    return {
      ...env,
      ...(binDir ? { PATH: [binDir, ...base.split(delimiter).filter((d) => d && d !== binDir)].join(delimiter) } : {}),
      ...(key ? { [TERMINAL_KEY_ENV]: key } : {}),
    };
  }

  /** 状态机和 ApprovalService 需要按 agent 找适配器（parseHook、approveOnceKeys）。 */
  adapter(agent: AgentKind): AgentAdapterExt | undefined {
    return this.adapters.get(agent);
  }

  /** AH3：最近一次检测算出的报告（同步，ApprovalService 按它决定按不按键）。还没检测过为 null。 */
  cachedReport(agent: AgentKind): AgentCapabilityReport | null {
    const d = this.latest.get(agent);
    return d ? this.report(d) : null;
  }

  /**
   * AH3（IS-74）：一次启动的钩子情况。reason 为 null 表示钩子来了（清掉上次的说明），否则写进报告 status 一项的原因。
   * runtime 把状态机的 onDegraded（钩子该来没来）、onHooksAlive 接到这里。
   */
  noteLaunch(agent: AgentKind, reason: string | null): void {
    if (reason === null) {
      // 参数被拒的说明要等下一次正常启动才清：钩子来了说明这次没被拒
      this.launchNotes.delete(agent);
    } else this.launchNotes.set(agent, reason);
  }

  // ---- 内部 ----

  private info(d: Detection): AgentInfo {
    const a = d.adapter;
    const report = this.report(d);
    const note = this.launchNotes.get(a.id) ?? null;
    return {
      id: a.id,
      label: a.label,
      installed: d.result.installed,
      version: d.result.version,
      capabilities: a.capabilities(d.result.version),
      ...(note ? { warning: note } : {}),
      report,
    };
  }

  private report(d: Detection): AgentCapabilityReport {
    const a = d.adapter;
    const version = d.result.version;
    const declared = a.declareCapabilities?.(version) ?? fallbackDeclaration(a, version);
    const failed = this.checkFailures.get(a.id);
    const status = this.launchNotes.get(a.id) ?? null;
    return buildReport({
      agent: a.id,
      label: a.label,
      version,
      declared,
      record: this.compat[a.id] ?? null,
      checkedAt: d.checkedAt,
      notes: { status, ...(failed ? { failed } : {}) },
    });
  }

  /** 装的版本没被合格测试核对过（比记录新、读不出、没有记录）。 */
  private unverified(d: Detection): boolean {
    return newerThanChecked(d.result.version, this.compat[d.adapter.id]?.verifiedUpTo ?? null);
  }

  /** 等 earlyExitMs：这段时间里非 0 退出、输出里有“不认识的参数”之类的话时返回那一行，否则 null。 */
  private async rejectedOption(id: TerminalId): Promise<string | null> {
    const ms = this.opts.launchTiming?.earlyExitMs ?? 3000;
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters.delete(id);
        resolve(null);
      }, ms);
      this.exitWaiters.set(id, (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    if (code === null || code === 0) return null;
    const lines = await this.opts.terminals.lastLines!(id, 40).catch(() => [] as string[]);
    const line = lines.map((l) => l.trim()).find((l) => REJECTED_OPTION.test(l));
    return line ? line.slice(0, 160) : null;
  }

  /** Check again 的空启动：带钩子开一次（不发提示词），等钩子，关掉。true 来了、false 没来、null 没做（codex、没钩子、不知道目录）。 */
  private async probeHooks(adapter: AgentAdapterExt, d: Detection): Promise<boolean | null> {
    const cwd = this.lastCwd.get(adapter.id);
    const kill = this.opts.terminals.kill;
    if (!cwd || !kill || !this.opts.waitForHook || adapter.sessionStartOnFirstInput) return null;
    if (!adapter.capabilities(d.result.version).hooks) return null;
    const ctx: AdapterLaunchContext = {
      cwd,
      terminalId: PENDING_TERMINAL_ID,
      mode: { kind: 'new' },
      notifyCommand: this.opts.notifyCommand,
      extraArgs: this.opts.extraArgs?.(adapter.id) ?? [],
    };
    const prepared = await adapter.prepare?.(ctx);
    if (prepared && !prepared.hooks) return false;
    const spec = adapter.launch(ctx);
    let id: TerminalId;
    try {
      ({ id } = await this.opts.terminals.create({ cmd: spec.cmd, args: spec.args, cwd, ...(spec.env ? { env: spec.env } : {}) }));
    } catch {
      return null;
    }
    try {
      return await this.opts.waitForHook(id, this.opts.launchTiming?.probeMs ?? 10_000);
    } finally {
      await kill.call(this.opts.terminals, id).catch(() => undefined);
    }
  }

  /** 可执行文件的修改时间变了就重读这一家（IS-77）。 */
  private async freshen(adapter: AgentAdapterExt): Promise<Detection> {
    const d = this.latest.get(adapter.id);
    if (!d) return this.detectOne(adapter);
    if (!d.result.path) return d;
    const stamp = await fileStamp(d.result.path);
    return stamp === d.stamp ? d : this.detectOne(adapter);
  }

  private async detectOne(adapter: AgentAdapterExt): Promise<Detection> {
    let result: DetectResult;
    try {
      result = await adapter.detect();
    } catch {
      result = { installed: false, version: null, path: null };
    }
    const d: Detection = { adapter, result, stamp: await fileStamp(result.path), checkedAt: this.now().toISOString() };
    this.latest.set(adapter.id, d);
    return d;
  }

  private async detectAll(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((a) => this.detectOne(a)));
  }
}

/** 没有钩子时状态灯悬停写的话（StatusSnapshot.degraded）。shell、自定义命令不是 agent，不写。 */
function noHooksReason(info: AgentInfo): string | null {
  if (info.id === 'shell' || info.id === 'custom') return null;
  if (info.capabilities.hooks) return `Status from terminal activity · ${info.label} hooks couldn't be set up`;
  // 声明里 status 的原因取第一句，例如 “Kimi has no hooks”
  const status = info.report?.entries.find((e) => e.key === 'status');
  const why = status?.reason?.split(';')[0]?.trim() || `${info.label} has no hooks`;
  return `Status from terminal activity · ${why}`;
}

/** 没有 declareCapabilities 的老适配器：从 capabilities() 粗推几项。 */
function fallbackDeclaration(a: AgentAdapterExt, version: string | null): CapabilityEntry[] {
  const c = a.capabilities(version);
  return [
    c.hooks ? yes('status', 'hook') : statusFromActivity(`${a.label} has no hooks`),
    c.resume ? yes('resume', 'flag') : no('resume', `${a.label} can't resume a conversation`),
    c.fork ? yes('fork', 'flag') : no('fork', `${a.label} can't fork a conversation`),
    c.askTool ? yes('question', 'hook') : no('question', `${a.label} has no question tool`),
  ];
}
