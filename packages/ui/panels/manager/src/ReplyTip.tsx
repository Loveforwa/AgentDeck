// 开着的 agent 一行的悬停提示（CO4 搬过来）：第一行 “claude · shop · feat/login · Idle · now”，然后最后一条回复，
// 最后 “Click to jump · ⌥⌘3”（NEEDS YOU 的前 9 行）。墨色底，放在行的右边（面板在白板左边），放不下翻到左边。

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { computePosition, Portal } from '@agentdeck/ui-kit';
import { statusText } from './board.ts';
import type { LastReply, LastReplyReader } from './lastReply.ts';
import type { Row } from './model.ts';

/** 悬停多久出提示。 */
export const TIP_DELAY_MS = 350;

type ReplyState = { state: 'loading' } | { state: 'done'; reply: LastReply | null };

export interface TipTarget {
  row: Row;
  /** 快捷键文字（“⌥⌘3”），没有为 null。 */
  shortcut: string | null;
  anchor: DOMRect;
}

/** 提示开着没有、读到的回复。按 “终端 + 状态开始的时间” 记：状态没变就不再读一次。 */
export function useReplyTip(readReply: LastReplyReader) {
  const [tip, setTip] = useState<TipTarget | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [replies, setReplies] = useState<Record<string, ReplyState>>({});
  const repliesRef = useRef(replies);
  repliesRef.current = replies;

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const show = useCallback(
    (row: Row, shortcut: string | null, el: HTMLElement, delay: number) => {
      cancel();
      const open = () => {
        setTip({ row, shortcut, anchor: el.getBoundingClientRect() });
        const key = replyKey(row);
        const tid = row.open?.terminalId;
        if (!tid || !key || repliesRef.current[key]) return;
        setReplies((r) => ({ ...r, [key]: { state: 'loading' } }));
        readReply(tid).then(
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

  const replyOf = (row: Row) => {
    const key = replyKey(row);
    return key ? replies[key] : undefined;
  };
  return { tip, show, hide, replyOf };
}

function replyKey(row: Row): string | null {
  const o = row.open;
  return o?.terminalId ? `${o.terminalId}|${o.since ?? ''}` : null;
}

/** 键盘聚焦（不是鼠标单击）时也出提示。 */
export function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(':focus-visible');
  } catch {
    return false;
  }
}

export function ReplyTip({ id, target, row, now, reply }: { id: string; target: TipTarget; row: Row; now: number; reply: ReplyState | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const o = row.open;
  const title = [o?.agent && o.agent !== 'shell' && o.agent !== 'custom' ? o.agent : o?.name, row.where, o?.group, o ? statusText(o, now) : null].filter(Boolean).join(' · ');
  const text = !o?.terminalId
    ? 'The session has ended.'
    : !reply || reply.state === 'loading'
      ? 'Reading…'
      : reply.reply
        ? reply.reply.text
        : 'Nothing to show yet.';
  const heading = reply?.state === 'done' && reply.reply?.kind === 'lines' ? 'On screen' : 'Last reply';
  const anchor = target.anchor;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const p = computePosition(
      { x: anchor.x, y: anchor.y, width: anchor.width, height: anchor.height },
      { width: box.width, height: box.height },
      { width: window.innerWidth, height: window.innerHeight },
      'right-start',
      8,
    );
    setPos((cur) => (cur && cur.x === p.x && cur.y === p.y ? cur : { x: p.x, y: p.y }));
  }, [anchor, text, title]);

  return (
    <Portal>
      <div ref={ref} id={id} role="tooltip" className="mgr-tip" style={pos ? { left: pos.x, top: pos.y } : { left: -9999, top: 0, visibility: 'hidden' }}>
        <span className="mgr-tip-title">{title}</span>
        {o?.terminalId ? <span className="mgr-tip-dim">{heading}</span> : null}
        <span className="mgr-tip-text">{text}</span>
        <span className="mgr-tip-dim">{target.shortcut ? `Click to jump · ${target.shortcut}` : 'Click to jump'}</span>
      </div>
    </Portal>
  );
}
