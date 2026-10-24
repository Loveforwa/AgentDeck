// 通用适配器：按已知 agent 表（known.ts）的一行检测、算启动命令、解析钩子。claude、codex 有自己的适配器，不走这里。
//
// 钩子：表里有 extension 的 agent（pi、omp），启动时加 `-e <agentdeck-pi-extension.mjs>`，再在 LaunchSpec.env 里
// 告诉扩展 notify 的路径和自己是谁。扩展把事件转成和 claude 同名的钩子（SessionStart、UserPromptSubmit、
// PermissionRequest、Stop、SessionEnd），另加一个 Question，经 agentdeck-notify 发到 HookServer。
// 所以这里的 parseHook 基本就是 parseCommonHook。扩展的路径由组装阶段传入（AdapterDeps.agentExtension），没有就不加钩子。

import { randomUUID } from 'node:crypto';
import type { AbsPath, AgentCapabilities, AgentHookEvent, AgentSessionId, LaunchContext, LaunchSpec } from '@agentdeck/contracts';
import { atLeast } from '../env.ts';
import { parseCommonHook } from '../hook-payload.ts';
import type { KnownAgent } from './known.ts';
import { EXTENSION_ENV } from './known.ts';
import type { AdapterDeps, AgentAdapterExt, DetectResult } from './types.ts';
import { detectCommand, unsupported } from './types.ts';

export interface KnownAgentAdapterOptions extends AdapterDeps {
  /** agentdeck-pi-extension.mjs 的绝对路径。没有时表里有 extension 的 agent 也按没有钩子处理。 */
  agentExtension?: AbsPath | null;
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
      const r = await detectCommand(command, this.deps, this.def.versionArgs);
      if (r.installed) {
        this.command = command;
        this.lastVersion = r.version;
        return r;
      }
    }
    this.lastVersion = null;
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

  launch(ctx: LaunchContext): LaunchSpec {
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
    let env: Record<string, string> | undefined;
    if (ext && this.deps.agentExtension && this.hooksFor(this.lastVersion)) {
      args.push(ext.flag, this.deps.agentExtension);
      env = {
        [EXTENSION_ENV.notify]: ctx.notifyCommand,
        [EXTENSION_ENV.agent]: this.id,
        [EXTENSION_ENV.turnEnd]: ext.turnEnd,
      };
    }
    args.push(...ctx.extraArgs);
    return { cmd: this.command, args, ...(env ? { env } : {}), sessionId: sessionId as AgentSessionId | null };
  }

  parseHook(hookName: string, payload: unknown): AgentHookEvent | null {
    if (hookName === 'Question') {
      const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
      const q = typeof p.question === 'string' ? p.question.trim().split('\n')[0]!.slice(0, SUMMARY_MAX) : '';
      return { type: 'question', summary: q || 'Question' };
    }
    return parseCommonHook(hookName, payload);
  }

  private hooksFor(version: string | null): boolean {
    const ext = this.def.extension;
    return !!ext && !!this.deps.agentExtension && atLeast(version, ext.minVersion);
  }
}
