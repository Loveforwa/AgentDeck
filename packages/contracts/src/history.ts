// 历史会话（MVP v3 · N11，需求见设计画布画板 14，调研 DR-62）：这台电脑上各 agent 自己存的会话记录，
// 在普通终端里开的也算。左边栏按项目 → 工作路径 → agent 列出来，单击跳到白板上开着的，没开着的 Resume / Fork。
// 实现：packages/agent-adapters 的 history 模块（主进程），只读各 agent 的会话文件，按修改时间缓存。
// 调用：packages/ui/panels/history（左边栏）。
//
// 不列：脚本里跑的（claude 的 sdk-*、codex 的 exec / mcp）和子 agent 的记录。

import type { AbsPath, AgentKind, AgentSessionId, IsoTime } from './common.ts';

/** 会话是在哪开的：terminal 是终端里（含 AgentDeck），desktop 是 agent 自己的桌面版，ide 是编辑器插件。 */
export type SessionSource = 'terminal' | 'desktop' | 'ide';

/** 标题从哪来：custom 是你起的名字（claude 的 /rename），agent 是 agent 自己起的，prompt 是第一条消息。 */
export type SessionTitleKind = 'custom' | 'agent' | 'prompt';

export interface SessionSummary {
  agent: AgentKind;
  /** 接回用的会话 id。 */
  id: AgentSessionId;
  /** 会话的工作目录。读不到为 null（归到 Other folders）。 */
  cwd: AbsPath | null;
  /** 开始时的分支（agent 记了的话）。 */
  branch: string | null;
  /** 一行标题，不会是空的（实在没有时写 "Untitled session"）。 */
  title: string;
  titleKind: SessionTitleKind | null;
  /** 第一条消息的开头（悬停卡片用）。 */
  firstPrompt: string | null;
  startedAt: IsoTime | null;
  /** 最后活动：会话文件的修改时间（kimi 用它自己记的 updatedAt）。 */
  updatedAt: IsoTime;
  source: SessionSource;
  /** 最近用的模型，原样。读不到为 null。 */
  model: string | null;
  /** 会话文件（Reveal in Finder 用）。 */
  file: AbsPath;
}

export interface HistoryService {
  /** 所有 agent 的历史会话，最后活动的在前。第一次调用扫一遍，之后只读改过的文件。 */
  list(): Promise<SessionSummary[]>;
}
