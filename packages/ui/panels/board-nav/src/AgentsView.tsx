// Agents 视图（CO4）：只列 agent 终端，按状态分组（ERROR、NEEDS YOU、RUNNING、IDLE，每组写个数）。
// 行和 Board 视图同一个零件（.bnav-row：灯 + 等宽名字 + 灰字），右边补状态和时间。
// 悬停一行（或键盘聚焦）出墨色提示：第一行 “claude · agentdeck · feat/login · Idle · now”，然后最后一条回复，最后 “Click to jump · ⌥⌘3”。

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { WindowId } from '@agentdeck/contracts';
import { computePosition, Portal } from '@agentdeck/ui-kit';
import { agentShortcut, rowStatusText, titleStatusText, type AgentRow, type AgentsView as AgentsViewData } from './agents.ts';
import type { LastReply, LastReplyReader } from './lastReply.ts';
import { LAMP_LABEL } from './model.ts';

/** 悬停多久出提示。 */
export const TIP_DELAY_MS = 350;
/** 时间（“4m”）多久刷新一次，和标题栏一样。 */
const TICK_MS = 30_000;

export interface AgentsViewProps {
  view: AgentsViewData;
  onJump(windowId: WindowId): void;
  readReply: LastReplyReader;
  /** 测试用：固定 “现在”。 */
  now?: number | undefined;
}

type ReplyState = { state: 'loading' } | { state: 'done'; reply: LastReply | null };

interface Tip {
  row: AgentRow;
  index: number;
  anchor: DOMRect;
}

function useNow(fixed: number | undefined): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, [fixed]);
  return fixed ?? now;
}

export function AgentsView({ view, onJump, readReply, now: fixedNow }: AgentsViewProps): ReactNode {
  const now = useNow(fixedNow);
  const tipId = useId();
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 按 “终端 + 状态开始的时间” 记：状态没变就不再读一次
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const repliesRef = useRef(replies);
  repliesRef.current = replies;

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const show = useCallback(
    (row: AgentRow, index: number, el: HTMLElement, delay: number) => {
      cancel();
      const open = () => {
        setTip({ row, index, anchor: el.getBoundingClientRect() });
        const key = replyKey(row);
        if (!row.terminalId || !key || repliesRef.current[key]) return;
        setReplies((r) => ({ ...r, [key]: { state: 'loading' } }));
        readReply(row.terminalId).then(
          (reply) => setReplies((r) => ({ ...r, [key]: { state: 'done', reply } })),
          () => setReplies((r) => ({ ...r, [key]: { state: 'done', reply: null } })),
        );
      };
      if (delay > 0) timer.current = setTimeout(open, delay);
      else open();
    },
    [readReply],
  );
  const hide = useCallback(() => {
    cancel();
    setTip(null);
  }, []);

  // 面板或页面滚动时提示的位置就不对了，关掉
  useEffect(() => {
    if (!tip) return;
    window.addEventListener('scroll', hide, true);
    return () => window.removeEventListener('scroll', hide, true);
  }, [tip, hide]);

  // 列表变了（状态变、行挪了）：提示跟着这一行的新数据；行没了就关
  const current = tip ? view.rows.find((r) => r.id === tip.row.id) : undefined;
  useEffect(() => {
    if (tip && !current) setTip(null);
  }, [tip, current]);

  if (view.rows.length === 0) return <p className="bnav-note">No agents on the board.</p>;

  let index = -1;
  return (
    <div className="bnav-agents">
      {view.groups.map((g) => (
        <section className="bnav-agent-group" key={g.id} aria-label={g.label}>
          <h3 className="bnav-group-heading">
            {g.label} · {g.rows.length}
          </h3>
          <ul className="bnav-windows">
            {g.rows.map((row) => {
              index += 1;
              const i = index;
              const status = rowStatusText(row, now);
              const name = row.group ? `${row.name} ${row.group}` : row.name;
              const label = [name, row.detail ?? (row.lamp ? LAMP_LABEL[row.lamp] : null), row.where].filter(Boolean).join(', ');
              const shown = tip?.row.id === row.id;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`bnav-row bnav-agent-row${row.waiting ? ' bnav-row--waiting' : ''}`}
                    data-window-id={row.id}
                    data-agent-index={i + 1}
                    aria-label={label}
                    aria-describedby={shown ? tipId : undefined}
                    onClick={() => {
                      hide();
                      onJump(row.id);
                    }}
                    onMouseEnter={(e) => show(row, i, e.currentTarget, TIP_DELAY_MS)}
                    onMouseLeave={hide}
                    onFocus={(e) => {
                      if (focusVisible(e.currentTarget)) show(row, i, e.currentTarget, 0);
                    }}
                    onBlur={hide}
                  >
                    {row.lamp ? <span className={`bnav-lamp bnav-lamp--${row.lamp}`} aria-hidden="true" title={row.detail ?? LAMP_LABEL[row.lamp]} /> : null}
                    <span className="bnav-name bnav-mono">{row.name}</span>
                    {row.where ? <span className="bnav-where">{row.where}</span> : null}
                    {row.group ? <span className="bnav-group bnav-mono">{row.group}</span> : null}
                    <span className="bnav-spacer" />
                    {status ? (
                      <span className={`bnav-agent-status bnav-agent-status--${row.agentGroup}`} title={row.detail ?? undefined}>
                        {status}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="bnav-note bnav-agents-hint">⌥⌘1–9 jumps to rows 1–9. Shells and web pages are under Board.</p>
      {tip && current ? (
        <ReplyTip id={tipId} row={current} index={tip.index} anchor={tip.anchor} now={now} reply={replyKey(current) ? replies[replyKey(current)!] : undefined} />
      ) : null}
    </div>
  );
}

/** 键盘聚焦（不是鼠标单击）时也出提示。 */
function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

function replyKey(row: AgentRow): string | null {
  return row.terminalId ? `${row.terminalId}|${row.since ?? ''}` : null;
}

/** 墨色提示，放在行的左边（面板在白板右侧），放不下翻到右边，夹在视口里。 */
function ReplyTip({ id, row, index, anchor, now, reply }: { id: string; row: AgentRow; index: number; anchor: DOMRect; now: number; reply: ReplyState | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const title = [row.name, row.where, row.group, titleStatusText(row, now)].filter(Boolean).join(' · ');
  const key = agentShortcut(index);
  const text = !row.terminalId
    ? 'The session has ended.'
    : !reply || reply.state === 'loading'
      ? 'Reading…'
      : reply.reply
        ? reply.reply.text
        : 'Nothing to show yet.';
  const heading = reply?.state === 'done' && reply.reply?.kind === 'lines' ? 'On screen' : 'Last reply';

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const p = computePosition(
      { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
      'left-start',
      8,
    );
    setPos((cur) => (cur && cur.x === p.x && cur.y === p.y ? cur : { x: p.x, y: p.y }));
  }, [anchor, text, title]);

  return (
    <Portal>
      <div
        ref={ref}
        id={id}
        role="tooltip"
        className="bnav-tip"
        style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0, visibility: 'hidden' }}
      >
        <span className="bnav-tip-title">{title}</span>
        {row.terminalId ? <span className="bnav-tip-dim">{heading}</span> : null}
        <span className="bnav-tip-text">{text}</span>
        <span className="bnav-tip-dim">{key ? `Click to jump · ${key}` : 'Click to jump'}</span>
      </div>
    </Portal>
  );
}
