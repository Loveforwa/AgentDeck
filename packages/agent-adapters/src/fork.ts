// X4 · Fork 对话：fork 之前看一眼原来的对话在不在 agent 自己的会话目录里。
//
// 跨目录本身不用我们做什么（DR-42，2026-10-26 实测，详见 AGENTS.md「Fork 对话」）：
//   claude 2.1.291 的 --resume <id> 在所有项目目录里找，--fork-session 把副本写进新目录对应的 projects/<新 cwd>/；
//   codex 0.164.0 的会话按日期放，和目录无关（但 TUI 要 -C，见 codex.ts）；pi 0.83.0、omp 18.0.4 先找本目录、再找全部。
// 要防的是“还没说过话”：claude、pi、omp 第一条消息之后才写会话文件，这时 fork 会直接报
// “No conversation found with session ID …” 退出，白板上留一个出错的终端。所以先找文件，找不到就不开终端。
// 只读（readdir / stat），不写 agent 自己的目录。

import type { AgentKind, AgentSessionId } from '@agentdeck/contracts';
import { defaultUsageRoots, locateClaude, locateCodex, locatePi } from './usage/locate.ts';
import type { UsageRoots } from './usage/locate.ts';
import type { EnvSource } from './env.ts';

/** true：找到了；false：确定没有；null：这种 agent 不知道怎么找，照常启动。 */
export type ConversationCheck = (agent: AgentKind, sessionId: AgentSessionId) => Promise<boolean | null>;

export function conversationExists(roots: UsageRoots): ConversationCheck {
  return async (agent, sessionId) => {
    switch (agent) {
      case 'claude':
        return (await locateClaude(roots.claude, { sessionId, cwd: null })) !== null;
      case 'codex':
        return (await locateCodex(roots.codex, sessionId)) !== null;
      case 'pi':
        return (await locatePi(roots.pi, sessionId)) !== null;
      case 'omp':
        return (await locatePi(roots.omp, sessionId)) !== null;
      default:
        return null;
    }
  };
}

/** 按登录 shell 的环境找各 agent 的目录（HOME、CLAUDE_CONFIG_DIR、CODEX_HOME、PI_CODING_AGENT_DIR）。没有 HOME 时不查。 */
export function conversationCheckFromEnv(env: EnvSource): ConversationCheck {
  return async (agent, sessionId) => {
    const e = env();
    const home = e['HOME'];
    if (!home) return null;
    return conversationExists(defaultUsageRoots(home, e))(agent, sessionId);
  };
}
