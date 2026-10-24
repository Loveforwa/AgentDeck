// N9 · Skills · MCP 的组装部分：自带 skill 写到数据目录、启动终端时找到这个终端在白板上存的选择。
//
// 选择存在白板上（TerminalWindowData.skills，界面勾选时写），主进程启动时读保存的白板来找：
//   1. 重启（终端窗口的 Restart / Restart and resume，面板上的 Restart and resume）：窗口先 terminals.kill 旧终端，
//      再 agents.start。所以找 15 秒内刚被 kill、目录和 agent 都一样的那个终端所在的窗口；
//   2. 接回同一个会话（resume）：找 sessionId 一样的窗口；
//   3. 都没有（新开的终端、MCP 的 open_terminals、fork）：用默认（built-in 勾、library 不勾）。
// 面板上点 Restart and resume 之前会先把白板存下来（App.tsx），所以刚勾的也能读到。

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BoardStore, SkillItemId, StartAgentRequest, TerminalHost, TerminalId, TerminalWindowData } from '@agentdeck/contracts';
import { builtinSkillFiles } from '@agentdeck/agent-adapters';

/** 刚 kill 的终端多久之内的 start 算“重启它”。 */
export const RESTART_WINDOW_MS = 15_000;

/** 把 AgentDeck 自带的 skill 写进 dir（每次启动覆盖，升级后跟着变），返回 dir。 */
export async function writeBuiltinSkills(dir: string): Promise<string> {
  for (const [rel, content] of Object.entries(builtinSkillFiles())) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return dir;
}

export interface RecentKills {
  /** 包一层 TerminalHost：kill 时记下时间，其余照旧。 */
  wrap<T extends Pick<TerminalHost, 'kill'>>(terminals: T): T;
  note(id: TerminalId, at?: number): void;
  /** 多久之前 kill 的；不在窗口期内返回 null。 */
  since(id: TerminalId, now?: number): number | null;
}

export function createRecentKills(): RecentKills {
  const killed = new Map<TerminalId, number>();
  const prune = (now: number) => {
    for (const [id, at] of killed) if (now - at > RESTART_WINDOW_MS) killed.delete(id);
  };
  const api: RecentKills = {
    wrap(terminals) {
      return new Proxy(terminals, {
        get(target, prop, receiver) {
          if (prop === 'kill') {
            return (id: TerminalId) => {
              api.note(id);
              return target.kill(id);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    },
    note(id, at = Date.now()) {
      prune(at);
      killed.set(id, at);
    },
    since(id, now = Date.now()) {
      const at = killed.get(id);
      return at !== undefined && now - at <= RESTART_WINDOW_MS ? now - at : null;
    },
  };
  return api;
}

/** 这次启动用哪个选择（见文件开头的三条）。null = 默认。 */
export async function skillSelectionFor(
  req: Pick<StartAgentRequest, 'agent' | 'cwd' | 'mode'>,
  deps: { board: Pick<BoardStore, 'load'>; recentKills: Pick<RecentKills, 'since'>; now?: number },
): Promise<SkillItemId[] | null> {
  const board = await deps.board.load().catch(() => null);
  if (!board) return null;
  const terms = board.windows.flatMap((w) => (w.type === 'terminal' && w.data ? [w.data as Partial<TerminalWindowData>] : []));
  const same = (d: Partial<TerminalWindowData>) => d.agent === req.agent && d.cwd === req.cwd;
  let best: Partial<TerminalWindowData> | null = null;
  let bestAge = Infinity;
  for (const d of terms) {
    if (!d.terminalId || !same(d)) continue;
    const age = deps.recentKills.since(d.terminalId, deps.now);
    if (age !== null && age < bestAge) {
      best = d;
      bestAge = age;
    }
  }
  if (!best && req.mode.kind === 'resume') {
    const id = req.mode.sessionId;
    best = terms.find((d) => d.sessionId === id && d.agent === req.agent) ?? null;
  }
  const s = best?.skills;
  return Array.isArray(s) ? s.filter((x): x is string => typeof x === 'string') : null;
}
