// 通用适配器：按已知 agent 表（known.ts）的一行检测、算启动命令、解析钩子。claude、codex 有自己的适配器，不走这里。
//
// 钩子：表里有 extension 的 agent（pi、omp），启动时加 `-e <agentdeck-pi-extension.mjs>`，再在 LaunchSpec.env 里
// 告诉扩展 notify 的路径和自己是谁。扩展把事件转成和 claude 同名的钩子（SessionStart、UserPromptSubmit、
// PermissionRequest、Stop、SessionEnd），另加一个 Question，经 agentdeck-notify 发到 HookServer。
// 所以这里的 parseHook 基本就是 parseCommonHook。扩展的路径由组装阶段传入（AdapterDeps.agentExtension），没有就不加钩子。
//
// AgentDeck 的 MCP（N1）：表里有 mcp 的 agent（omp）启动时加 `--plugin-dir <mcpPluginDir>`，url、token 放进 LaunchSpec.env，
// 插件清单里写成 ${…} 由 agent 自己展开（mcp-plugin.ts）。pi、kimi 启动时挂不上，见 AGENTS.md。

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MCP_TOKEN_ENV } from '@agentdeck/contracts';
import type { AbsPath, AgentCapabilities, AgentHookEvent, AgentSessionId, CapabilityEntry, LaunchSpec } from '@agentdeck/contracts';
import { no, statusFromActivity } from '../capabilities/declare.ts';
import { atLeast } from '../env.ts';
import { parseCommonHook } from '../hook-payload.ts';
import type { KnownAgent } from './known.ts';
import { EXTENSION_ENV } from './known.ts';
import { MCP_URL_ENV } from './mcp-plugin.ts';
import type { AdapterDeps, AdapterLaunchContext, AgentAdapterExt, DetectResult, LaunchFlag } from './types.ts';
import { detectWithHelp, unsupported } from './types.ts';

export interface KnownAgentAdapterOptions extends AdapterDeps {
  /** agentdeck-pi-extension.mjs 的绝对路径。没有时表里有 extension 的 agent 也按没有钩子处理。 */
  agentExtension?: AbsPath | null;
  /** 写好 mcpPluginFiles() 的目录（N1，omp 的 --plugin-dir）。没有时这些 agent 不挂 AgentDeck 的 MCP。 */
  mcpPluginDir?: AbsPath | null;
  /** 测试里固定新会话 id。 */
  newSessionId?: () => string;
}

const SUMMARY_MAX = 200;

export class KnownAgentAdapter implements AgentAdapterExt {
  readonly id: string;
  readonly label: string;
  readonly approveOnceKeys: string[] | null;
  /** 最近一次检测找到的命令名；没检测或没找到时是表里的第一个。 */
  command: string;
  private lastVersion: string | null = null;
  /** 读不出版本时的 --help 输出（AH3：按它决定带不带 -e、--plugin-dir 这些）。 */
  private lastHelp: string | null = null;
  private readonly newSessionId: () => string;

  constructor(
    readonly def: KnownAgent,
    private readonly deps: KnownAgentAdapterOptions,
  ) {
    this.id = def.id;
    this.label = def.label;
    this.approveOnceKeys = def.approveOnceKeys;
    this.command = def.commands[0] ?? def.id;
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  async detect(): Promise<DetectResult> {
    for (const command of this.def.commands) {
      const { result, help } = await detectWithHelp(command, this.deps, this.def.versionArgs);
      if (result.installed) {
        this.command = command;
        this.lastVersion = result.version;
        this.lastHelp = help;
        return result;
      }
    }
    this.lastVersion = null;
    this.lastHelp = null;
    return { installed: false, version: null, path: null };
  }

  capabilities(version: string | null): AgentCapabilities {
    const hooks = this.hooksFor(version);
    return {
      hooks,
      resume: this.def.launch.resume !== null,
      fork: this.def.launch.fork !== null,
      askTool: hooks && this.def.askTool,
    };
  }

  /**
   * AH0 / AH2：表里的声明（known.ts declared），扩展没给或版本太老时靠扩展的几项改掉；
   * MCP、skill 的版本门槛没过时那一项写 no。
   */
  declareCapabilities(version: string | null): CapabilityEntry[] {
    const hooks = this.hooksFor(version);
    const ext = this.def.extension;
    const why = !ext
      ? null
      : !this.deps.agentExtension
        ? "AgentDeck's extension isn't available"
        : version === null
          ? `Couldn't read the ${this.label} version`
          : `Needs ${this.label} ${ext.minVersion} or later`;
    const needs = (min: string) => (version === null ? `Couldn't read the ${this.label} version` : `Needs ${this.label} ${min} or later`);
    return this.def.declared.map((e) => {
      if (e.key === 'agentdeck-mcp' && e.level !== 'no' && this.def.mcp && !this.gate(version, this.def.mcp.minVersion, this.def.mcp.flag)) {
        return no(e.key, needs(this.def.mcp.minVersion));
      }
      const skillMin = this.def.skills?.minVersion;
      if (e.key === 'skills' && e.level !== 'no' && skillMin && !this.gate(version, skillMin, this.def.skills!.flag)) {
        return no(e.key, needs(skillMin));
      }
      if (hooks || e.via !== 'extension' || why === null) return e;
      if (e.key === 'status') return statusFromActivity(`${why}; status comes from terminal activity`);
      return no(e.key, why);
    });
  }

  launch(ctx: AdapterLaunchContext): LaunchSpec {
    let template: string[];
    let id = '';
    switch (ctx.mode.kind) {
      case 'new':
        template = this.def.launch.new;
        break;
      case 'resume':
        template = this.def.launch.resume ?? unsupported(this.label, ctx.mode);
        id = ctx.mode.sessionId;
        break;
      case 'fork':
        template = this.def.launch.fork ?? unsupported(this.label, ctx.mode);
        id = ctx.mode.sessionId;
        break;
    }
    const newId = template.some((a) => a.includes('{newId}')) ? this.newSessionId() : null;
    const args = template.map((a) => a.replaceAll('{newId}', newId ?? '').replaceAll('{id}', id));
    // 接回时会话 id 不变；新建、fork 用了 {newId} 时就是它，否则要等扩展的 session-start。
    const sessionId = ctx.mode.kind === 'resume' ? id : newId;

    const ext = this.def.extension;
    // AH3：只带会话参数重开时（IS-73）扩展、MCP、skill、用户参数都不带
    const full = !ctx.sessionOnly;
    let env: Record<string, string> | undefined;
    if (full && ext && this.deps.agentExtension && this.hooksFor(this.lastVersion)) {
      args.push(ext.flag, this.deps.agentExtension);
      env = {
        [EXTENSION_ENV.notify]: ctx.notifyCommand,
        [EXTENSION_ENV.agent]: this.id,
        [EXTENSION_ENV.turnEnd]: ext.turnEnd,
      };
    }
    // AgentDeck 的 MCP（N1）：插件目录是固定内容，url 和 token 走环境变量
    const mcp = this.def.mcp;
    if (full && ctx.mcp && mcp && this.deps.mcpPluginDir && this.gate(this.lastVersion, mcp.minVersion, mcp.flag)) {
      args.push(mcp.flag, this.deps.mcpPluginDir);
      env = { ...env, [MCP_URL_ENV]: ctx.mcp.url, [MCP_TOKEN_ENV]: ctx.mcp.token };
    }
    if (full) args.push(...this.skillArgs(ctx));
    // AH1：第一条消息（只在新会话时带），做法见 known.ts 的 prompt 一列
    const how = this.def.prompt;
    const prompt = ctx.mode.kind === 'new' && ctx.prompt ? ctx.prompt : null;
    let consumed = false;
    let sendAfterReady: string | undefined;
    if (prompt && how?.kind === 'arg' && how.separator === null) {
      args.push(/^[@-]/.test(prompt) ? ` ${prompt}` : prompt);
      consumed = true;
    }
    if (full) args.push(...ctx.extraArgs);
    if (prompt && how?.kind === 'arg' && how.separator !== null) {
      args.push(how.separator, prompt);
      consumed = true;
    }
    if (prompt && how?.kind === 'after-ready') sendAfterReady = prompt;
    return {
      cmd: this.command,
      args,
      ...(env ? { env } : {}),
      sessionId: sessionId as AgentSessionId | null,
      consumed: { prompt: consumed },
      ...(sendAfterReady !== undefined ? { sendAfterReady } : {}),
    };
  }

  /** AH1：after-ready 的 agent 屏幕上出现这些字时还没到输入框（AgentService 等下一次安静）。 */
  get notReadyScreens(): readonly string[] {
    return this.def.prompt?.kind === 'after-ready' ? this.def.prompt.notReadyScreens : [];
  }

  parseHook(hookName: string, payload: unknown): AgentHookEvent | null {
    if (hookName === 'Question') {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      const q = typeof p.question === 'string' ? p.question.trim().split('\n')[0]!.slice(0, SUMMARY_MAX) : '';
      return { type: 'question', summary: q || 'Question' };
    }
    return parseCommonHook(hookName, payload);
  }

  /**
   * N9：这次要带的 skill（和 omp 的库里 MCP），按表里的 skills 一列：
   * plugin-dir（omp）`--plugin-dir <那套目录>`；skill-flag（pi）每个 skill 一个 `--skill <文件夹>`；
   * skills-dir（kimi）`--skills-dir <那套目录>/skills`，再把它自己的目录（keepSkillRoots）一起传回去。
   */
  private skillArgs(ctx: AdapterLaunchContext): string[] {
    const s = ctx.skills;
    const how = this.def.skills;
    if (!s || !how || (how.minVersion && !this.gate(this.lastVersion, how.minVersion, how.flag))) return [];
    switch (how.kind) {
      case 'plugin-dir':
        return s.setDir ? [how.flag, s.setDir] : [];
      case 'skill-flag':
        return s.skills.flatMap((k) => [how.flag, k.path]);
      case 'skills-dir':
        return s.setDir && s.skills.length > 0 ? [...s.keepSkillRoots, join(s.setDir, 'skills')].flatMap((d) => [how.flag, d]) : [];
    }
  }

  private hooksFor(version: string | null): boolean {
    const ext = this.def.extension;
    return !!ext && !!this.deps.agentExtension && this.gate(version, ext.minVersion, ext.flag);
  }

  /** 版本够新；读不出版本时看 --help 里有没有这个参数（AH3，env.ts atLeast）。 */
  private gate(version: string | null, min: string, flag: string): boolean {
    return atLeast(version, min, version === null ? { text: this.lastHelp, flag } : null);
  }

  /** AH3：Check again 在 --help 里找的参数：会话参数、扩展、MCP、skill（helpHides 里的不找，例如 omp 的 --fork 不在 help 里）。 */
  launchFlags(version: string | null): LaunchFlag[] {
    const hidden = new Set(this.def.helpHides ?? []);
    const flags: LaunchFlag[] = [];
    const first = (t: string[] | null) => t?.find((a) => a.startsWith('-')) ?? null;
    const add = (flag: string | null, keys: LaunchFlag['keys']) => {
      if (flag && !hidden.has(flag) && !flags.some((f) => f.flag === flag)) flags.push({ flag, keys });
    };
    add(first(this.def.launch.new), ['session-id', 'first-prompt']);
    add(first(this.def.launch.resume), ['resume']);
    add(first(this.def.launch.fork), ['fork']);
    if (this.hooksFor(version)) add(this.def.extension!.flag, ['status', 'approval-wait', 'question', 'session-id']);
    if (this.def.mcp) add(this.def.mcp.flag, ['agentdeck-mcp']);
    if (this.def.skills) add(this.def.skills.flag, ['skills']);
    return flags;
  }
}
