// 白板对窗口数据知道的一点点东西。白板对窗口类型本来是不可知的（注册表里查组件），
// 但有几条规则只对终端成立（不能换框、关闭前确认、状态），这里集中放，按 TerminalWindowData 的形状判断。
// contracts 里还没有让窗口类型自己声明这些的字段，见 CONTRACT_NOTES.md。

import type {
  AgentKind,
  BrowserWindowData,
  TerminalId,
  TerminalWindowData,
  WindowNode,
  Workspace,
} from '@agentdeck/contracts';

export const TERMINAL_TYPE = 'terminal';
export const BROWSER_TYPE = 'browser';

export function isTerminal(node: WindowNode): node is WindowNode<TerminalWindowData> {
  return node.type === TERMINAL_TYPE;
}

export function terminalIdOf(node: WindowNode): TerminalId | null {
  if (!isTerminal(node)) return null;
  return (node.data as Partial<TerminalWindowData> | null)?.terminalId ?? null;
}

export function agentOf(node: WindowNode): AgentKind | null {
  if (!isTerminal(node)) return null;
  return (node.data as Partial<TerminalWindowData> | null)?.agent ?? null;
}

/** 跑的是 agent（claude、codex、kimi……），不是 shell 或自定义命令。只有 agent 终端有 Auto-approve（IS-68）。 */
export function isAgentTerminal(node: WindowNode): boolean {
  const agent = agentOf(node);
  return agent !== null && agent !== 'shell' && agent !== 'custom';
}

/** 终端创建后工作目录就固定了，不能换框（需求「5 · 终端窗口」）。其他窗口可以换框。 */
export function isPinnedToWorkspace(node: WindowNode): boolean {
  return isTerminal(node);
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** 标题栏等宽显示的名字：终端是命令名（claude、zsh），网页是主机名，其他用类型的 label。 */
export function defaultName(node: WindowNode, typeLabel: string | undefined): string {
  if (isTerminal(node)) {
    const d = node.data as Partial<TerminalWindowData> | null;
    if (d?.agent && d.agent !== 'shell' && d.agent !== 'custom') return d.agent;
    if (d?.cmd) return basename(d.cmd);
    return 'terminal';
  }
  if (node.type === BROWSER_TYPE) {
    const url = (node.data as Partial<BrowserWindowData> | null)?.url;
    if (url) {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    }
  }
  return typeLabel ?? node.type;
}

/** “agentdeck · feat/login”。散放的窗口是“~”。 */
export function workspaceLabel(ws: Workspace | null | undefined, projectName: string | undefined): string {
  if (!ws) return '~';
  const tail = ws.branch ?? ws.name;
  return projectName ? `${projectName} · ${tail}` : tail;
}

/** “Open a new claude in …”里的名字。 */
export function agentNoun(agent: AgentKind | null): string {
  if (!agent || agent === 'shell') return 'shell';
  if (agent === 'custom') return 'terminal';
  return agent;
}

/**
 * 按内容区像素估算终端的行列数，传给 agents.start 免得 TUI 先按 80×24 画。
 * 估的是 13px 等宽字体（7.8×17）加 xterm 的边距，真实的大小由终端窗口 attach 时再 resize。
 */
export function estimateTermSize(content: { w: number; h: number }): { cols: number; rows: number } {
  return { cols: Math.max(20, Math.floor((content.w - 16) / 7.8)), rows: Math.max(5, Math.floor((content.h - 8) / 17)) };
}
