// Usage 插件（PL2，设计画布“插件能力”页 PluginUsage，规则见 docs/plugins.md，数据来源见 DR-55）。
// 贴在终端上（claude、codex、pi、omp、kimi；shell 和自定义命令灰掉）。开着时终端上方（或下方）贴一条细长的圆角条，
// 和终端一样宽、隔 6px：拖动把手（点阵）、in、out、cache 读 / 写，右边 ctx + 小进度条 + 百分比；上下文到 85% 变黄。
// 拖把手只能贴到这个终端的上边或下边（拖动中蓝色落点线）；点条弹出小卡片（模型、窗口、最近一次请求、请求次数、
// codex 的 5 小时 / 每周额度、Move to bottom / top、Hide）。只在条画着时 watch，收起、关窗口、关插件时 unwatch。
// 开关和位置写进 TerminalWindowData.usage，随白板保存。

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { TerminalId, TerminalUsage, UsageStripSettings, WindowId } from '@agentdeck/contracts';
import { Popover } from '@agentdeck/ui-kit';
import type { BoardController } from '../controller.ts';
import { terminalIdOf } from '../model/windows.ts';
import { useBoardState, useController } from '../react/context.tsx';
import type { PluginDefinition } from './types.ts';
import {
  USAGE_AGENTS,
  abbreviate,
  cacheText,
  contextAttention,
  hasData,
  INFERRED_NOTE,
  lastRequestText,
  limitRows,
  noDataReason,
  percentText,
  stripTitle,
  usageSettings,
  usageShown,
  type StripPosition,
} from './usage-model.ts';

/** 改这个终端的 Usage 设置（写进窗口数据，白板负责保存）。 */
export function setUsage(c: BoardController, windowId: WindowId, patch: Partial<UsageStripSettings>): void {
  const cur = usageSettings(c.windowById(windowId));
  c.updateData(windowId, { usage: { ...cur, ...patch } });
}

export const usagePlugin: PluginDefinition = {
  id: 'usage',
  label: 'Usage',
  attachesTo: ['terminal'],
  agents: USAGE_AGENTS,
  isOn: (c, t) => t.kind === 'window' && usageSettings(c.windowById(t.windowId)).on,
  toggle: (c, t) => {
    if (t.kind !== 'window') return;
    setUsage(c, t.windowId, { on: !usageSettings(c.windowById(t.windowId)).on });
  },
  WindowMark: UsageStrip,
};

/** 跟踪一个终端的用量：挂上时 watch，卸下（条收起、窗口关掉、换了 terminalId）时 unwatch。 */
function useTerminalUsage(c: BoardController, terminalId: TerminalId | null): { usage: TerminalUsage | null; error: string | null } {
  const [usage, setUsageState] = useState<TerminalUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUsageState(null);
    setError(null);
    if (!terminalId) return;
    let alive = true;
    // watch 的返回值比事件晚到时不覆盖事件里更新的值
    let gotEvent = false;
    const off = c.api.on('usage.changed', (e) => {
      if (!alive || e.usage.terminalId !== terminalId) return;
      gotEvent = true;
      setUsageState(e.usage);
      setError(null);
    });
    c.api.usage.watch(terminalId).then(
      (u) => {
        if (alive && !gotEvent) setUsageState(u);
      },
      () => {
        if (alive && !gotEvent) setError('Couldn’t read usage');
      },
    );
    return () => {
      alive = false;
      off();
      void c.api.usage.unwatch(terminalId).catch(() => undefined);
    };
  }, [c, terminalId]);
  return { usage, error };
}

type Drag = { pointerId: number; startY: number; dy: number; target: StripPosition };

/** 贴在终端上边或下边的用量条。没开时不画（也不 watch）。 */
export function UsageStrip({ windowId }: { windowId: WindowId }) {
  const c = useController();
  const node = useBoardState((s) => s.windows.find((w) => w.id === windowId));
  if (!node || !usageShown(node)) return null;
  return <UsageStripOn windowId={windowId} terminalId={terminalIdOf(node)} position={usageSettings(node).position} c={c} />;
}

function UsageStripOn({ windowId, terminalId, position, c }: { windowId: WindowId; terminalId: TerminalId | null; position: StripPosition; c: BoardController }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [drag, setDragState] = useState<Drag | null>(null);
  // 指针事件里读 ref：按下和松开在同一帧里到时 state 还没更新
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const { usage, error } = useTerminalUsage(c, terminalId);

  const targetOf = (clientX: number, clientY: number): StripPosition => {
    const w = c.windowById(windowId);
    if (!w) return position;
    const p = c.clientToFlow({ x: clientX, y: clientY });
    return p.y < w.rect.y + w.rect.h / 2 ? 'top' : 'bottom';
  };

  const onGripDown = (e: ReactPointerEvent<HTMLSpanElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setOpen(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrag({ pointerId: e.pointerId, startY: c.clientToFlow({ x: e.clientX, y: e.clientY }).y, dy: 0, target: position });
  };
  const onGripMove = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    const y = c.clientToFlow({ x: e.clientX, y: e.clientY }).y;
    setDrag({ ...drag, dy: y - drag.startY, target: targetOf(e.clientX, e.clientY) });
  };
  const onGripUp = (e: ReactPointerEvent<HTMLSpanElement>) => {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.stopPropagation();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const target = targetOf(e.clientX, e.clientY);
    setDrag(null);
    if (target !== position) setUsage(c, windowId, { position: target });
  };
  const onGripCancel = () => setDrag(null);

  const ok = hasData(usage);
  const attention = ok && contextAttention(usage);
  const reason = ok ? null : noDataReason(usage, error, terminalId);
  const title = ok ? stripTitle(usage) : `No usage data${reason ? `: ${reason}` : ''}${usage?.match === 'inferred' ? `\n${INFERRED_NOTE}` : ''}`;
  const pct = ok ? percentText(usage.context?.percent) : null;
  const cls = ['ad-usage-strip', drag ? 'ad-usage-strip--dragging' : null, attention ? 'ad-usage-strip--attention' : null, 'nopan', 'nodrag']
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {drag ? <div className="ad-usage-drop" data-position={drag.target} aria-hidden="true" /> : null}
      <div
        ref={ref}
        className={cls}
        data-plugin="usage"
        data-position={position}
        data-state={ok ? 'ok' : 'no-data'}
        style={drag ? { transform: `translateY(${drag.dy}px)` } : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <span
          className="ad-usage-grip"
          role="separator"
          aria-label="Drag to the top or bottom edge"
          title="Drag to the top or bottom edge"
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripCancel}
          onLostPointerCapture={() => {
            if (dragRef.current) setDrag(null);
          }}
        />
        <button
          type="button"
          className="ad-usage-body"
          title={title}
          aria-label="Usage"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
        >
          {ok ? (
            <>
              <span className="ad-usage-field" data-field="in">
                <span className="ad-usage-k">in</span> {abbreviate(usage.total?.input)}
              </span>
              <span className="ad-usage-field" data-field="out">
                <span className="ad-usage-k">out</span> {abbreviate(usage.total?.output)}
              </span>
              <span className="ad-usage-field" data-field="cache">
                <span className="ad-usage-k">cache</span> {cacheText(usage.total)}
              </span>
              <span className="ad-usage-ctx" data-field="ctx" data-attention={attention || undefined}>
                <span className="ad-usage-k">ctx</span> {abbreviate(usage.context?.tokens)}
                {pct ? (
                  <>
                    <span className="ad-usage-meter" aria-hidden="true">
                      <i style={{ width: pct }} />
                    </span>
                    <span className="ad-usage-pct">{pct}</span>
                  </>
                ) : null}
              </span>
            </>
          ) : (
            <span className="ad-usage-empty">{!usage && !error && terminalId ? 'Loading…' : 'No usage data'}</span>
          )}
        </button>
      </div>
      <Popover
        open={open}
        anchor={ref}
        placement={position === 'top' ? 'bottom-start' : 'top-start'}
        role="dialog"
        aria-label="Usage details"
        onClose={() => setOpen(false)}
        className="ad-usage-card"
      >
        <UsageCard
          usage={usage}
          reason={reason}
          position={position}
          onMove={() => {
            setOpen(false);
            setUsage(c, windowId, { position: position === 'top' ? 'bottom' : 'top' });
          }}
          onHide={() => {
            setOpen(false);
            setUsage(c, windowId, { on: false });
          }}
        />
      </Popover>
    </>
  );
}

function UsageCard(props: { usage: TerminalUsage | null; reason: string | null; position: StripPosition; onMove(): void; onHide(): void }) {
  const u = props.usage;
  const ok = hasData(u);
  const limits = ok ? limitRows(u) : [];
  return (
    <div className="ad-usage-card-body">
      {ok ? (
        <>
          <div className="ad-usage-card-head">
            <span className="ad-usage-card-model">{u.model ?? 'Unknown model'}</span>
            {u.context?.window !== null && u.context?.window !== undefined ? (
              <span className="ad-usage-card-muted">window {abbreviate(u.context.window)}</span>
            ) : null}
          </div>
          <div className="ad-usage-card-rows">
            <div className="ad-usage-card-row" data-row="last">
              <span className="ad-usage-card-label">last request</span>
              <span>{lastRequestText(u.last)}</span>
            </div>
            <div className="ad-usage-card-row" data-row="requests">
              <span className="ad-usage-card-label">requests</span>
              <span>{u.requests}</span>
            </div>
            {limits.map((l) => (
              <div key={l.label} className="ad-usage-card-row" data-row="limit">
                <span className="ad-usage-card-label">{l.label}</span>
                <span>{l.text}</span>
              </div>
            ))}
          </div>
          {u.match === 'inferred' ? <div className="ad-usage-card-note">{INFERRED_NOTE}</div> : null}
        </>
      ) : (
        <>
          <div className="ad-usage-card-head">
            <span className="ad-usage-card-model">No usage data</span>
          </div>
          {props.reason ? <div className="ad-usage-card-note">{props.reason}</div> : null}
        </>
      )}
      <div className="ad-usage-card-sep" role="separator" />
      <button type="button" className="ad-usage-card-action" onClick={props.onMove}>
        {props.position === 'top' ? 'Move to bottom' : 'Move to top'}
      </button>
      <button type="button" className="ad-usage-card-action" onClick={props.onHide}>
        Hide
      </button>
    </div>
  );
}
