// X10：白板操作的撤销 / 重做（⌘Z / ⌘⇧Z）。纯函数和一个小栈，控制器在操作前后各取一次白板，算出这一步改了什么。
//
// - 只管白板上的东西：窗口的位置、大小、放大 / 还原、在哪个框、名字、窗口组（N2 的显示方式），框的位置和大小，
//   关掉的窗口（撤销时原样放回）。不管进程和 git：撤销关闭只把窗口放回去，终端窗口自己按 terminalId 重新接回，
//   进程已经没了就显示 “Previous session ended”。
// - 按实体记前后两份（窗口按 id、框按工作区），撤销时只改这一步动过的那几个，别的（服务后来开的窗口、终端自己改的 data）不碰。
// - 一次拖动算一步（控制器在按下时取“之前”，松手时比较）。最多 HISTORY_LIMIT 步；只在这次运行里，重开应用就没了。

import type { FrameNode, Rect, WindowId, WindowNode, WorkspaceId } from '@agentdeck/contracts';
import { sameRect } from './geometry.ts';

export const HISTORY_LIMIT = 100;

export interface BoardLayout {
  frames: readonly FrameNode[];
  windows: readonly WindowNode[];
}

/** before 为 null 不会出现（新开的窗口不记）；after 为 null：这一步把它关掉了。 */
export interface WindowChange {
  id: WindowId;
  before: WindowNode;
  after: WindowNode | null;
}

export interface FrameChange {
  ws: WorkspaceId;
  before: Rect;
  after: Rect;
}

/** 工作区改名（Rename workspace…）：名字存在服务那边，撤销时再调一次 workspaces.rename。 */
export interface NameChange {
  ws: WorkspaceId;
  before: string;
  after: string;
}

export interface HistoryStep {
  /** 给人看的说明（“Move 3 windows”），也用在测试里。 */
  label: string;
  windows: WindowChange[];
  frames: FrameChange[];
  name?: NameChange;
}

export type Direction = 'undo' | 'redo';

function sameGroup(a: WindowNode['group'], b: WindowNode['group']): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** 白板能撤销的那几项一样（data、z 不算：data 是窗口自己的，z 只是谁在上面）。 */
export function sameLayout(a: WindowNode, b: WindowNode): boolean {
  return (
    sameRect(a.rect, b.rect) &&
    sameRect(a.restoreRect, b.restoreRect) &&
    a.workspaceId === b.workspaceId &&
    a.title === b.title &&
    sameGroup(a.group, b.group)
  );
}

/**
 * before → after 之间白板改了什么；什么都没改返回 null。新出现的窗口和框不记（新建会开进程，不在撤销范围里；
 * 拖动中服务开进来的窗口也不该被撤销掉），消失的框也不记（删除工作区不能撤销）。
 */
export function diffLayout(before: BoardLayout, after: BoardLayout, label: string): HistoryStep | null {
  const windows: WindowChange[] = [];
  const now = new Map(after.windows.map((w) => [w.id, w]));
  for (const b of before.windows) {
    const a = now.get(b.id) ?? null;
    if (a === b || (a && sameLayout(a, b))) continue;
    windows.push({ id: b.id, before: b, after: a });
  }
  const frames: FrameChange[] = [];
  const nowFrames = new Map(after.frames.map((f) => [f.workspaceId, f]));
  for (const b of before.frames) {
    const a = nowFrames.get(b.workspaceId);
    if (!a || sameRect(a.rect, b.rect)) continue;
    frames.push({ ws: b.workspaceId, before: b.rect, after: a.rect });
  }
  return windows.length > 0 || frames.length > 0 ? { label, windows, frames } : null;
}

/** 把 target 的白板那几项放到 cur 上，data 等别的照 cur。 */
function withLayout(cur: WindowNode, target: WindowNode): WindowNode {
  const { group: _drop, ...rest } = cur;
  const next: WindowNode = { ...rest, rect: target.rect, restoreRect: target.restoreRect, workspaceId: target.workspaceId, title: target.title };
  if (target.group !== undefined) next.group = target.group;
  return next;
}

export interface ApplyResult {
  frames: FrameNode[];
  windows: WindowNode[];
  /** 这次放回白板的窗口（撤销关闭）。 */
  restored: WindowNode[];
  /** 这次拿掉的窗口（重做关闭）。 */
  removed: WindowNode[];
  /** 真的改了东西（这一步碰到的窗口和框都不在了时为 false，调用方接着撤销下一步）。 */
  changed: boolean;
}

/**
 * 撤销（回到 before）或重做（回到 after）一步。只动这一步记下的窗口和框：
 * - 窗口还在：换回那时的位置、大小、框、名字、组；data 用现在的（终端重启过 terminalId 会变）。
 * - 窗口已经关了而目标里有它：原样放回（放在最上层）。目标里没有它（重做关闭）：拿掉。
 * - 窗口所在的框已经不在白板上（工作区删掉了）：跳过；框不在了也跳过。
 */
export function applyStep(cur: BoardLayout, step: HistoryStep, dir: Direction): ApplyResult {
  const onBoard = new Set(cur.frames.map((f) => f.workspaceId));
  const live = (w: WindowNode) => w.workspaceId === null || onBoard.has(w.workspaceId);
  const byId = new Map(cur.windows.map((w) => [w.id, w]));
  const patched = new Map<WindowId, WindowNode>();
  const gone = new Set<WindowId>();
  const restored: WindowNode[] = [];
  const removed: WindowNode[] = [];
  let z = cur.windows.reduce((m, w) => Math.max(m, w.z), 0);
  for (const ch of step.windows) {
    const target = dir === 'undo' ? ch.before : ch.after;
    const w = byId.get(ch.id);
    if (!target) {
      if (w) {
        gone.add(w.id);
        removed.push(w);
      }
      continue;
    }
    if (!live(target)) continue;
    if (w) {
      if (!sameLayout(w, target)) patched.set(w.id, withLayout(w, target));
    } else {
      z += 1;
      restored.push({ ...target, z });
    }
  }
  const windowsChanged = patched.size > 0 || restored.length > 0 || removed.length > 0;
  const windows = windowsChanged
    ? [...cur.windows.filter((w) => !gone.has(w.id)).map((w) => patched.get(w.id) ?? w), ...restored]
    : (cur.windows as WindowNode[]);
  let framesChanged = false;
  const targetRect = new Map(step.frames.map((f) => [f.ws, dir === 'undo' ? f.before : f.after]));
  const mapped = cur.frames.map((f) => {
    const r = targetRect.get(f.workspaceId);
    if (!r || sameRect(r, f.rect)) return f;
    framesChanged = true;
    return { ...f, rect: r };
  });
  // 没改的部分原样返回（引用不变，白板不会因此再存一次）
  const frames = framesChanged ? mapped : (cur.frames as FrameNode[]);
  return { frames, windows, restored, removed, changed: framesChanged || windowsChanged || !!step.name };
}

/** 撤销栈和重做栈。新的一步进来时清掉重做栈；超过 limit 时丢掉最老的。 */
export class BoardHistory {
  private undos: HistoryStep[] = [];
  private redos: HistoryStep[] = [];

  constructor(private readonly limit = HISTORY_LIMIT) {}

  push(step: HistoryStep): void {
    this.undos.push(step);
    if (this.undos.length > this.limit) this.undos.splice(0, this.undos.length - this.limit);
    this.redos = [];
  }

  /** 取出下一步要撤销 / 重做的；做完后调 done 放进另一边的栈。 */
  take(dir: Direction): HistoryStep | undefined {
    return (dir === 'undo' ? this.undos : this.redos).pop();
  }

  /** 做完了：放进另一边（撤销的进重做栈）。 */
  done(dir: Direction, step: HistoryStep): void {
    (dir === 'undo' ? this.redos : this.undos).push(step);
  }

  /** 没做成（例如终端又在运行了），放回原来的栈。 */
  putBack(dir: Direction, step: HistoryStep): void {
    (dir === 'undo' ? this.undos : this.redos).push(step);
  }

  canUndo(): boolean {
    return this.undos.length > 0;
  }

  canRedo(): boolean {
    return this.redos.length > 0;
  }

  get size(): { undo: number; redo: number } {
    return { undo: this.undos.length, redo: this.redos.length };
  }

  clear(): void {
    this.undos = [];
    this.redos = [];
  }
}
