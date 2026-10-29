// IS-82：白板缩放不是 100% 时，xterm 换算鼠标位置要算进缩放（zoom.ts）。
// 这里的 @xterm/xterm 是 test/setup.ts 垫的 headless，没有 MouseService；在真 xterm 上的效果由 e2e is82-zoomed-mouse 验证。
import { describe, expect, it } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { fixMouseForZoom, scaleOf, unscaledPoint } from '../src/zoom.ts';

/** 一个排版宽 800、画出来按 scale 缩放、左上角在 (100, 50) 的元素（jsdom 不排版，手动给尺寸）。 */
function scaled(scale: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'offsetWidth', { value: 800 });
  el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800 * scale, height: 400 * scale, right: 0, bottom: 0, x: 100, y: 50, toJSON() {} });
  return el;
}

describe('IS-82: mouse positions on a zoomed board', () => {
  it('measures the board scale from drawn vs laid-out width', () => {
    expect(scaleOf(scaled(0.6))).toBeCloseTo(0.6);
    expect(scaleOf(scaled(1.5))).toBeCloseTo(1.5);
    expect(scaleOf(document.createElement('div'))).toBe(1); // 没排版：当 1
  });

  it('maps a point back to where it would be unzoomed; at 100% the event is passed through', () => {
    // 60% 时元素里 (60, 30) 处的点，没缩放时在 (100, 50) 处
    expect(unscaledPoint({ clientX: 160, clientY: 80 }, scaled(0.6))).toEqual({ clientX: 200, clientY: 100 });
    const ev = { clientX: 160, clientY: 80 };
    expect(unscaledPoint(ev, scaled(1))).toBe(ev);
  });

  it('the wrapped mouse service gets unzoomed coordinates (links, selection and tmux mouse reports all use it)', () => {
    const seen: unknown[] = [];
    const ms = {
      getCoords: (e: { clientX: number; clientY: number }, _el: HTMLElement, cols: number, rows: number, sel?: boolean) => {
        seen.push(['coords', e.clientX, e.clientY, cols, rows, sel]);
        return undefined;
      },
      getMouseReportCoords: (e: { clientX: number; clientY: number }) => {
        seen.push(['report', e.clientX, e.clientY]);
        return undefined;
      },
    };
    const term = { _core: { _mouseService: ms } } as unknown as Terminal;
    expect(fixMouseForZoom(term)).toBe(true);
    const el = scaled(0.5);
    ms.getCoords({ clientX: 150, clientY: 70 }, el, 80, 24, true);
    (ms.getMouseReportCoords as (e: object, el: HTMLElement) => unknown)({ clientX: 150, clientY: 70 }, el);
    expect(seen).toEqual([
      ['coords', 200, 90, 80, 24, true],
      ['report', 200, 90],
    ]);
  });
});
