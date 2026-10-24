// 拖动、改大小时的对齐线和间距、尺寸标注（V3）。store 里是白板坐标，这里按视口换成屏幕坐标画，线宽和字号不随缩放变。

import { useEffect } from 'react';
import type { Guide } from '../model/snap.ts';
import { useBoardState } from './context.tsx';

/** 间距线两头的短竖线，屏幕像素。 */
const TICK = 4;

let meta = false;

/** 最近一次键盘、指针事件里 ⌘ 是否按着。window-shell 的改大小回调不带事件，从这里读。 */
export function metaHeld(): boolean {
  return meta;
}

/** 跟踪 ⌘（Board 里装一次）：按住 ⌘ 拖动时不吸附。 */
export function useTrackMeta(): void {
  useEffect(() => {
    const track = (e: KeyboardEvent | PointerEvent) => {
      meta = e.metaKey;
    };
    const events = ['keydown', 'keyup', 'pointerdown', 'pointermove'] as const;
    for (const ev of events) window.addEventListener(ev, track, true);
    return () => {
      for (const ev of events) window.removeEventListener(ev, track, true);
    };
  }, []);
}

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  dashed: boolean;
}

interface Label {
  x: number;
  y: number;
  text: string;
}

/** 把对齐线换成屏幕上的线段和标注。导出给测试用。 */
export function layoutGuides(guides: readonly Guide[], vp: { x: number; y: number; zoom: number }): { lines: Line[]; labels: Label[] } {
  const sx = (x: number) => x * vp.zoom + vp.x;
  const sy = (y: number) => y * vp.zoom + vp.y;
  const lines: Line[] = [];
  const labels: Label[] = [];
  const text = (n: number) => String(Math.round(n));
  for (const g of guides) {
    if (g.kind === 'align') {
      if (g.axis === 'x') lines.push({ x1: sx(g.at), y1: sy(g.from), x2: sx(g.at), y2: sy(g.to), dashed: true });
      else lines.push({ x1: sx(g.from), y1: sy(g.at), x2: sx(g.to), y2: sy(g.at), dashed: true });
    } else if (g.kind === 'gap') {
      for (const s of g.segments) {
        if (g.axis === 'x') {
          const y = sy(s.cross);
          const a = sx(s.from);
          const b = sx(s.to);
          lines.push({ x1: a, y1: y, x2: b, y2: y, dashed: false });
          lines.push({ x1: a, y1: y - TICK, x2: a, y2: y + TICK, dashed: false }, { x1: b, y1: y - TICK, x2: b, y2: y + TICK, dashed: false });
          labels.push({ x: (a + b) / 2, y, text: text(g.size) });
        } else {
          const x = sx(s.cross);
          const a = sy(s.from);
          const b = sy(s.to);
          lines.push({ x1: x, y1: a, x2: x, y2: b, dashed: false });
          lines.push({ x1: x - TICK, y1: a, x2: x + TICK, y2: a, dashed: false }, { x1: x - TICK, y1: b, x2: x + TICK, y2: b, dashed: false });
          labels.push({ x, y: (a + b) / 2, text: text(g.size) });
        }
      }
    } else {
      // 同宽：每个窗口下面一条线；同高：右边一条线
      for (const r of g.rects) {
        if (g.axis === 'x') {
          const y = sy(r.y + r.h) + TICK * 2;
          lines.push({ x1: sx(r.x), y1: y, x2: sx(r.x + r.w), y2: y, dashed: false });
          labels.push({ x: sx(r.x + r.w / 2), y, text: text(g.size) });
        } else {
          const x = sx(r.x + r.w) + TICK * 2;
          lines.push({ x1: x, y1: sy(r.y), x2: x, y2: sy(r.y + r.h), dashed: false });
          labels.push({ x, y: sy(r.y + r.h / 2), text: text(g.size) });
        }
      }
    }
  }
  return { lines, labels };
}

export function Guides() {
  const guides = useBoardState((s) => s.guides);
  const viewport = useBoardState((s) => s.viewport);
  if (guides.length === 0) return null;
  const { lines, labels } = layoutGuides(guides, viewport);
  return (
    <div className="ad-guides" aria-hidden="true" data-testid="snap-guides">
      <svg className="ad-guides-svg">
        {lines.map((l, i) => (
          <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} className={l.dashed ? 'ad-guide-line ad-guide-line--dashed' : 'ad-guide-line'} />
        ))}
      </svg>
      {labels.map((l, i) => (
        <span key={i} className="ad-guide-label" style={{ left: l.x, top: l.y }}>
          {l.text}
        </span>
      ))}
    </div>
  );
}
