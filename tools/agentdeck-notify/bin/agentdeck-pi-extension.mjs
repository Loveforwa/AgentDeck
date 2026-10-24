// AgentDeck 给 pi / omp 的扩展（X13）。启动时用 `-e <这个文件>` 临时加载，不写进用户的 ~/.pi、~/.omp 配置。
//
// pi 和 omp 没有 claude 那样的命令式钩子，但有扩展事件。这里把事件转成和 claude 同名的钩子，
// 再运行 agentdeck-notify（`<notify> <agent> <钩子名>`，负载走 stdin），和 claude、codex 走同一条路到 HookServer：
//
//   session_start / session_switch / session_branch → SessionStart { session_id }（omp 的新会话靠它拿到 id）
//   agent_start                                     → UserPromptSubmit
//   tool_call（ask 工具）                           → Question { question }
//   tool_result（ask 工具）                         → UserPromptSubmit（回答完了，agent 接着干活）
//   tool_approval_requested（omp）                  → PermissionRequest { tool_name, tool_input }
//   tool_approval_resolved（omp）                   → UserPromptSubmit
//   agent_settled（pi）/ agent_end 且 willContinue 不为 true（omp） → Stop
//   session_shutdown                                → SessionEnd
//
// 用哪个事件当“一轮结束”由环境变量 AGENTDECK_TURN_END 指定（适配器按已知 agent 表设）：pi 的 agent_end 之后
// 还可能自动重试、压缩上下文，agent_settled 才是真的停了；omp 没有 agent_settled，它的 agent_end 带 willContinue。
//
// 原则和 agentdeck-notify 一样：绝不让 agent 卡住或报错。事件处理是同步的、什么也不返回（tool_call 返回值会被当成
// 拦截），发送在后台排队按顺序进行，每次最多等 SEND_TIMEOUT_MS，出错就丢掉。不在 AgentDeck 的终端里
// （没有 AGENTDECK_TERM 或 AGENTDECK_NOTIFY）时什么也不注册。
//
// 只用 node 内置模块（omp 跑在 bun 上，也有这些）。环境变量名和 packages/agent-adapters 的 EXTENSION_ENV 一致，测试会核对。

import { spawn } from 'node:child_process';

/** 和 contracts 的 TERMINAL_ID_ENV 一致。 */
export const TERMINAL_ID_ENV = 'AGENTDECK_TERM';
export const NOTIFY_ENV = 'AGENTDECK_NOTIFY';
export const AGENT_ENV = 'AGENTDECK_AGENT';
export const TURN_END_ENV = 'AGENTDECK_TURN_END';
/** 一次发送（起 notify 子进程到它退出）的上限。notify 自己不等回答的钩子最多 1 秒。 */
export const SEND_TIMEOUT_MS = 3000;
/** 这些工具是在向用户提问（omp 的 ask）。 */
const QUESTION_TOOLS = new Set(['ask']);
/** 记住的工具参数最多这么多条（批准前的 tool_call 到 tool_result 之间用）。 */
const MAX_REMEMBERED = 64;

/** 订阅的事件。pi 没有的（tool_approval_*）、omp 没有的（agent_settled）注册了也不会来。 */
export const EVENTS = [
  'session_start',
  'session_switch',
  'session_branch',
  'agent_start',
  'tool_call',
  'tool_result',
  'tool_approval_requested',
  'tool_approval_resolved',
  'agent_end',
  'agent_settled',
  'session_shutdown',
];

/**
 * @typedef {{ hookName: string, payload: Record<string, unknown> }} Hook
 * @typedef {{ turnEnd: string, toolInputs: Map<string, unknown> }} TranslateState
 */

/** @param {unknown} v */
function obj(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {};
}

/**
 * 当前会话 id。pi、omp 的 ctx.sessionManager 都有 getSessionId()。
 * @param {unknown} ctx
 * @returns {string | null}
 */
export function sessionIdOf(ctx) {
  try {
    const id = obj(obj(ctx).sessionManager).getSessionId?.();
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** @param {unknown} input */
function firstQuestion(input) {
  const questions = obj(input).questions;
  const q = Array.isArray(questions) ? obj(questions[0]).question : obj(input).question;
  return typeof q === 'string' ? q : '';
}

/**
 * 一个扩展事件 → 要发的钩子（没有要发的返回 null）。纯函数，只改 state.toolInputs。
 * @param {string} name
 * @param {unknown} event
 * @param {TranslateState} state
 * @param {string | null} sessionId
 * @returns {Hook | null}
 */
export function translate(name, event, state, sessionId) {
  const e = obj(event);
  switch (name) {
    case 'session_start':
    case 'session_switch':
    case 'session_branch':
      return sessionId ? { hookName: 'SessionStart', payload: { session_id: sessionId } } : null;
    case 'agent_start':
      return { hookName: 'UserPromptSubmit', payload: {} };
    case 'tool_call': {
      const id = typeof e.toolCallId === 'string' ? e.toolCallId : null;
      if (QUESTION_TOOLS.has(e.toolName)) return { hookName: 'Question', payload: { question: firstQuestion(e.input) } };
      // omp 先发 tool_call 再问批准，tool_approval_requested 里没有参数，先记下来
      if (id) {
        if (state.toolInputs.size >= MAX_REMEMBERED) state.toolInputs.clear();
        state.toolInputs.set(id, e.input);
      }
      return null;
    }
    case 'tool_result':
      if (typeof e.toolCallId === 'string') state.toolInputs.delete(e.toolCallId);
      return QUESTION_TOOLS.has(e.toolName) ? { hookName: 'UserPromptSubmit', payload: {} } : null;
    case 'tool_approval_requested': {
      const input = typeof e.toolCallId === 'string' ? state.toolInputs.get(e.toolCallId) : undefined;
      return {
        hookName: 'PermissionRequest',
        payload: { tool_name: typeof e.toolName === 'string' ? e.toolName : null, tool_input: obj(input) },
      };
    }
    case 'tool_approval_resolved':
      if (typeof e.toolCallId === 'string' && e.approved !== true) state.toolInputs.delete(e.toolCallId);
      return { hookName: 'UserPromptSubmit', payload: {} };
    case 'agent_end':
      return state.turnEnd === 'agent_end' && e.willContinue !== true ? { hookName: 'Stop', payload: {} } : null;
    case 'agent_settled':
      return state.turnEnd === 'agent_settled' ? { hookName: 'Stop', payload: {} } : null;
    case 'session_shutdown':
      return { hookName: 'SessionEnd', payload: {} };
    default:
      return null;
  }
}

/**
 * 按顺序一个个起 notify 子进程发出去（SessionStart 要比 UserPromptSubmit 先到）。
 * @param {string} notify
 * @param {string} agent
 * @param {NodeJS.ProcessEnv} env
 */
export function createSender(notify, agent, env) {
  let chain = Promise.resolve();
  /** @param {Hook} hook */
  const runOne = (hook) =>
    new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcess} */
      let child;
      const timer = setTimeout(() => {
        child?.kill();
        resolve(undefined);
      }, SEND_TIMEOUT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(undefined);
      };
      try {
        child = spawn(notify, [agent, hook.hookName], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', done);
        child.on('close', done);
        child.stdin?.on('error', () => {});
        child.stdin?.end(JSON.stringify(hook.payload));
      } catch {
        done();
      }
    });
  /** @param {Hook} hook */
  return (hook) => {
    chain = chain.then(() => runOne(hook)).catch(() => undefined);
    return chain;
  };
}

/**
 * 扩展入口（pi、omp 都认 default export 的工厂函数）。
 * @param {{ on: (event: string, handler: (event: unknown, ctx: unknown) => void) => void }} api
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(hook: Hook) => unknown} [sendOverride] 测试用
 */
export default function agentdeckExtension(api, env = process.env, sendOverride) {
  const notify = env[NOTIFY_ENV];
  if (!env[TERMINAL_ID_ENV] || !notify) return;
  const send = sendOverride ?? createSender(notify, env[AGENT_ENV] || 'pi', env);
  /** @type {TranslateState} */
  const state = { turnEnd: env[TURN_END_ENV] || 'agent_settled', toolInputs: new Map() };
  for (const name of EVENTS) {
    api.on(name, (event, ctx) => {
      try {
        const hook = translate(name, event, state, sessionIdOf(ctx));
        if (hook) void send(hook);
      } catch {
        // 扩展出错不能影响 agent
      }
    });
  }
}
