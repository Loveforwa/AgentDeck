// 后台 agent（MVP v3 · N10，画板 13）：主终端底边右侧的小提示、侧边栏的 BACKGROUND 一组、只读的记录窗口。
// 数据在 store 的 backgroundAgents（SubagentService 推来，不保存），开着的面板在 backgroundPanels。
// 主终端是窗口组的 lead 时，BACKGROUND 一组并进 N2 的侧边栏（GroupSidebar），这里只画别的主终端的侧边栏。

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Node, NodeProps } from '@xyflow/react';
import type { BackgroundAgent, BackgroundAgentTranscript, Rect, WindowId, WindowNode } from '@agentdeck/contracts';
import { Button } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import {
  STATE_LABEL,
  agentElapsedMs,
  agentLabel,
  formatElapsed,
  formatTokens,
  hintOf,
  transcriptRect,
  type BackgroundPanel,
} from '../model/background.ts';
import { WINDOW_NODE_CLASS } from '../model/gestures.ts';
import { groupOf, sidebarRect } from '../model/groups.ts';
import { agentOf, terminalIdOf } from '../model/windows.ts';
import { useBoardState, useController } from './context.tsx';
import '../background.css';

export const BACKGROUND_SIDEBAR_TYPE = 'background-sidebar';
export const BACKGROUND_TRANSCRIPT_TYPE = 'background-transcript';

export type BackgroundNodeData = { windowId: WindowId };

/** 跑着的后台 agent 要每秒刷新一次用时。 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function useAgents(windowId: WindowId): BackgroundAgent[] {
  const tid = useBoardState((s) => {
    const w = s.windows.find((x) => x.id === windowId);
    return w ? terminalIdOf(w) : null;
  });
  return useBoardState((s) => (tid ? (s.backgroundAgents[tid] ?? EMPTY) : EMPTY));
}

const EMPTY: BackgroundAgent[] = [];

/** 主终端底边右侧的小提示。没有这一轮的后台 agent 时不画。点它展开 / 收起侧边栏。 */
export function BackgroundHint({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const agents = useAgents(windowId);
  const open = useBoardState((s) => !!s.backgroundPanels[windowId]);
  const hint = hintOf(agents);
  if (!hint) return null;
  return (
    <button
      type="button"
      className="ad-bg-hint nopan nodrag nowheel"
      data-tone={hint.tone}
      aria-expanded={open}
      title={open ? 'Hide background agents' : 'Show background agents'}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        c.toggleBackgroundPanel(windowId);
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {hint.tone !== 'done' ? <span className={`ad-bg-lamp ad-bg-lamp--${hint.tone === 'error' ? 'failed' : 'running'}`} aria-hidden="true" /> : null}
      {hint.text}
    </button>
  );
}

/** 侧边栏里 BACKGROUND 一组的行（独立的侧边栏和 N2 的侧边栏共用）。 */
export function BackgroundAgentRows({ windowId, agents, selected }: { windowId: WindowId; agents: readonly BackgroundAgent[]; selected: string | null }) {
  const c = useController();
  const now = useNow(agents.some((a) => a.state === 'running'));
  return (
    <ul className="ad-group-sidebar-rows ad-bg-rows" aria-label="Background agents">
      {agents.map((a) => {
        const label = agentLabel(a);
        const time = a.state === 'failed' ? 'Failed' : formatElapsed(agentElapsedMs(a, now));
        const isSelected = a.id === selected;
        const title = [label, a.agentType, a.state === 'failed' && a.reason ? `Failed: ${a.reason}` : STATE_LABEL[a.state], a.lastStep]
          .filter(Boolean)
          .join(' · ');
        return (
          <li key={a.id}>
            <button
              type="button"
              className={['ad-group-row', 'ad-bg-row', isSelected ? 'ad-group-row--selected' : ''].filter(Boolean).join(' ')}
              data-agent-id={a.id}
              data-state={a.state}
              aria-pressed={isSelected}
              title={title}
              onClick={() => c.selectBackgroundAgent(windowId, a.id)}
            >
              {a.state === 'done' ? (
                <span className="ad-bg-check" role="img" aria-label="Done">
                  ✓
                </span>
              ) : (
                <span className={`ad-bg-lamp ad-bg-lamp--${a.state}`} role="img" aria-label={STATE_LABEL[a.state]} />
              )}
              <span className="ad-group-row-name">{label}</span>
              {time ? <span className="ad-bg-time">{time}</span> : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 白板上的后台 agent 节点：不是 lead 的主终端的侧边栏，以及选中的那个的记录窗口。主终端放大中不画。 */
export function backgroundNodes(
  c: BoardController,
  windows: readonly WindowNode[],
  panels: Readonly<Record<string, BackgroundPanel>>,
  resizing: { id: string; rect: Rect } | null,
  hidden: ReadonlySet<WindowId>,
  zBase: number,
): Node[] {
  const out: Node[] = [];
  const base = { draggable: false, selectable: false, connectable: false, focusable: false } as const;
  for (const [id, panel] of Object.entries(panels)) {
    const w = windows.find((x) => x.id === id);
    if (!w || hidden.has(w.id) || c.isMaximized(w)) continue;
    const anchor = resizing?.id === w.id ? resizing.rect : w.rect;
    const z = zBase + w.z;
    const lead = groupOf(windows, w.id)?.lead.id === w.id;
    if (!lead) {
      const r = sidebarRect(anchor);
      out.push({
        ...base,
        id: `bg-sidebar:${id}`,
        type: BACKGROUND_SIDEBAR_TYPE,
        className: WINDOW_NODE_CLASS,
        position: { x: r.x, y: r.y },
        data: { windowId: w.id },
        style: { width: r.w, height: r.h, pointerEvents: 'all' as const },
        zIndex: z,
      });
    }
    if (panel.selected) {
      const r = transcriptRect(anchor);
      out.push({
        ...base,
        id: `bg-transcript:${id}`,
        type: BACKGROUND_TRANSCRIPT_TYPE,
        className: WINDOW_NODE_CLASS,
        position: { x: r.x, y: r.y },
        data: { windowId: w.id },
        style: { width: r.w, height: r.h, pointerEvents: 'all' as const },
        zIndex: z,
      });
    }
  }
  return out;
}

export function BackgroundSidebarNode({ data }: NodeProps & { data: BackgroundNodeData }) {
  return <BackgroundSidebar windowId={data.windowId} />;
}

export function BackgroundTranscriptNode({ data }: NodeProps & { data: BackgroundNodeData }) {
  return <BackgroundTranscript windowId={data.windowId} />;
}

/** 不是窗口组 lead 的主终端旁边的侧边栏：只有 BACKGROUND 一组。 */
export function BackgroundSidebar({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const agents = useAgents(windowId);
  const selected = useBoardState((s) => s.backgroundPanels[windowId]?.selected ?? null);
  const n = agents.length;
  return (
    <div
      className="ad-group-sidebar ad-bg-sidebar nopan nodrag nowheel"
      data-window-id={windowId}
      onPointerDown={() => c.closeMenu()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="ad-group-sidebar-head">{n === 1 ? '1 background agent' : `${n} background agents`}</div>
      <div className="ad-bg-section">BACKGROUND · READ-ONLY</div>
      <BackgroundAgentRows windowId={windowId} agents={agents} selected={selected} />
      <div className="ad-group-sidebar-actions">
        <Button size="sm" variant="ghost" onClick={() => c.closeBackgroundPanel(windowId)}>
          Collapse
        </Button>
      </div>
    </div>
  );
}

/** 跟着一个后台 agent 的记录：打开时 watch，关掉、换了一个时 unwatch。 */
function useTranscript(c: BoardController, windowId: WindowId, agentId: string | null): BackgroundAgentTranscript | null {
  const tid = useBoardState((s) => {
    const w = s.windows.find((x) => x.id === windowId);
    return w ? terminalIdOf(w) : null;
  });
  const [transcript, setTranscript] = useState<BackgroundAgentTranscript | null>(null);
  useEffect(() => {
    setTranscript(null);
    if (!tid || !agentId) return;
    let alive = true;
    let gotEvent = false;
    const off = c.api.on('subagents.transcript-changed', (e) => {
      if (!alive || e.transcript.terminalId !== tid || e.transcript.agentId !== agentId) return;
      gotEvent = true;
      setTranscript(e.transcript);
    });
    c.api.subagents.watchTranscript(tid, agentId).then(
      (t) => {
        if (alive && !gotEvent) setTranscript(t);
      },
      () => {
        if (alive && !gotEvent) setTranscript({ terminalId: tid, agentId, lines: [], omitted: 0, file: null, state: 'no-data', reason: 'Couldn’t read the transcript' });
      },
    );
    return () => {
      alive = false;
      off();
      void c.api.subagents.unwatchTranscript(tid, agentId).catch(() => undefined);
    };
  }, [c, tid, agentId]);
  return transcript;
}

const LINE_PREFIX: Record<string, string> = { prompt: '› ', tool: '⏺ ', result: '  ⎿ ', error: '  ⎿ ', text: '' };

/** 选中的后台 agent 的记录，只读：跟着往下走（往上翻了就不跟），不能打字。 */
export function BackgroundTranscript({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const agents = useAgents(windowId);
  const selected = useBoardState((s) => s.backgroundPanels[windowId]?.selected ?? null);
  const agentName = useBoardState((s) => {
    const w = s.windows.find((x) => x.id === windowId);
    return (w && agentOf(w)) ?? 'the agent';
  });
  const agent = agents.find((a) => a.id === selected) ?? null;
  const transcript = useTranscript(c, windowId, agent?.id ?? null);
  const body = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const el = body.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [transcript]);
  if (!agent) return null;
  const lines = transcript?.lines ?? [];
  return (
    <section
      className="ad-bg-transcript nopan nodrag"
      data-agent-id={agent.id}
      data-state={agent.state}
      aria-label={`${agentLabel(agent)} transcript`}
      onPointerDown={() => c.closeMenu()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <header className="ad-bg-transcript-head">
        {agent.state === 'done' ? (
          <span className="ad-bg-check" aria-hidden="true">
            ✓
          </span>
        ) : (
          <span className={`ad-bg-lamp ad-bg-lamp--${agent.state}`} aria-hidden="true" />
        )}
        <span className="ad-bg-transcript-type">{agent.agentType ?? 'agent'}</span>
        <span className="ad-bg-transcript-title">· {agentLabel(agent)}</span>
        <span className="ad-bg-readonly">Read-only</span>
        <button type="button" className="ad-bg-close" aria-label="Close transcript" onClick={() => c.selectBackgroundAgent(windowId, agent.id)}>
          ×
        </button>
      </header>
      <div
        ref={body}
        className="ad-bg-transcript-body nowheel"
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {transcript === null ? <p className="ad-bg-empty">Loading…</p> : null}
        {transcript && lines.length === 0 ? <p className="ad-bg-empty">{transcript.reason ?? 'No transcript yet'}</p> : null}
        {transcript && transcript.omitted > 0 ? <p className="ad-bg-empty">{transcript.omitted} earlier lines not shown</p> : null}
        {lines.map((l, i) => (
          <div key={i} className="ad-bg-line" data-kind={l.kind}>
            {LINE_PREFIX[l.kind] ?? ''}
            {l.text}
          </div>
        ))}
        {agent.state === 'failed' ? <div className="ad-bg-line" data-kind="error">{`Failed${agent.reason ? `: ${agent.reason}` : ''}`}</div> : null}
      </div>
      <footer className="ad-bg-transcript-foot">
        <span>{`This agent runs inside ${agentName}. To change or stop it, tell the main agent.`}</span>
        <span className="ad-bg-tokens">{formatTokens(agent.tokens)}</span>
      </footer>
    </section>
  );
}
