// 提交图（N5）的纯函数：泳道排布、每一行的标签、收起已合并的旧分支。不碰 React，单测直接调。
//
// 排布：提交按拓扑顺序（新的在前）一行一个。每条泳道记着“下面等哪个提交”。
// 一行分上下两半：上半从行顶到节点，下半从节点到行底。
// - 上半：等这个提交的泳道都收进节点（不止一条时就是分叉点：别的分支从这里分出去），其余泳道直着穿过。
// - 下半：节点接着往下等第一父提交；第二个起的父提交是合并进来的分支，弧线连到已经在等它的泳道，没有就新开一条。
// 泳道不挪位置（不压缩），空出来的位置给后面新开的泳道用，线就不会横着乱跑。

import type { BranchInfo, CommitInfo, CommitRef, Workspace, WorktreeInfo } from '@agentdeck/contracts';

/** 颜色档：0 是墨黑（HEAD 和基础分支那条线），1–3 是几种暖灰，按开泳道的顺序轮流。颜色本身在 scm.css 里用 token 定。 */
export type Tone = 0 | 1 | 2 | 3;

export interface GraphLine {
  /** 起点泳道（上半在行顶，下半在节点）。 */
  from: number;
  /** 终点泳道（上半在节点，下半在行底）。from === to 是直线，否则是弧线。 */
  to: number;
  tone: Tone;
}

export interface GraphRow {
  commit: CommitInfo;
  /** 节点所在的泳道。 */
  lane: number;
  tone: Tone;
  top: GraphLine[];
  bottom: GraphLine[];
  /** 这一行下面还在跑的泳道。展开文件列表时，列表左边照着画竖线，图不断开。 */
  through: { lane: number; tone: Tone }[];
  /** 合并提交（两个以上父提交）：空心双圈。 */
  merge: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** 最宽处有几条泳道。 */
  width: number;
}

interface Slot {
  hash: string;
  tone: Tone;
}

/**
 * strong：这些提交开出来的泳道用墨黑（HEAD、基础分支顶端），其余轮流用灰。
 * 没有 parents（旧实现、假实现）时，把列表当成一条直线：每条的父提交是下一条。
 */
export function layoutGraph(commits: readonly CommitInfo[], strong: ReadonlySet<string> = new Set()): GraphLayout {
  const lanes: (Slot | null)[] = [];
  let grays = 0;
  const gray = (): Tone => ((grays++ % 3) + 1) as Tone;
  const free = (after = -1): number => {
    for (let j = after + 1; j < lanes.length; j++) if (lanes[j] === null) return j;
    return lanes.length;
  };
  const rows: GraphRow[] = [];
  let width = 0;

  commits.forEach((c, i) => {
    const before = lanes.slice();
    const hits: number[] = [];
    before.forEach((s, j) => {
      if (s?.hash === c.hash) hits.push(j);
    });

    let lane: number;
    let tone: Tone;
    if (hits.length === 0) {
      // 分支顶端：没人等它，开一条新泳道
      lane = free();
      tone = strong.has(c.hash) ? 0 : gray();
    } else {
      lane = hits[0]!;
      tone = strong.has(c.hash) || hits.some((j) => before[j]?.tone === 0) ? 0 : before[lane]!.tone;
    }

    const top: GraphLine[] = [];
    before.forEach((s, j) => {
      if (s) top.push({ from: j, to: s.hash === c.hash ? lane : j, tone: s.tone });
    });

    for (const j of hits) lanes[j] = null;
    const next = commits[i + 1];
    const parents = c.parents ?? (next ? [next.hash] : []);
    const [first, ...merged] = parents;
    lanes[lane] = first === undefined ? null : { hash: first, tone };

    const bottom: GraphLine[] = [];
    const opened = new Set<number>();
    for (const p of merged) {
      const existing = lanes.findIndex((s) => s?.hash === p);
      if (existing >= 0) {
        bottom.push({ from: lane, to: existing, tone: lanes[existing]!.tone });
        continue;
      }
      const j = free(lane);
      const t = gray();
      lanes[j] = { hash: p, tone: t };
      opened.add(j);
      bottom.push({ from: lane, to: j, tone: t });
    }
    lanes.forEach((s, j) => {
      if (!s || opened.has(j)) return;
      bottom.push({ from: j, to: j, tone: s.tone });
    });
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    const through = lanes.flatMap((s, j) => (s ? [{ lane: j, tone: s.tone }] : []));
    for (const l of [...top, ...bottom]) width = Math.max(width, l.from + 1, l.to + 1);
    width = Math.max(width, lane + 1);
    rows.push({ commit: c, lane, tone, top, bottom, through, merge: parents.length > 1 });
  });

  return { rows, width };
}

// ---- 标签 ----

export interface GraphLabel {
  name: string;
  kind: CommitRef['kind'];
  /** 这个面板的 HEAD 指着它：写成 HEAD → main。 */
  current: boolean;
  /** 白板上有框在用这个分支（它的 worktree 是某个工作区）。 */
  frame: Workspace | null;
  /** 在某个 worktree 里检出，但那个目录不在白板上。 */
  offBoard: boolean;
}

export interface GraphContext {
  /** 这个仓库的所有 worktree（哪个分支检出在哪个目录）。 */
  worktrees: readonly WorktreeInfo[];
  /** 白板上的工作区。 */
  workspaces: readonly Workspace[];
  /** branches({ mergedInto }) 的结果；没有时不收起任何分支。 */
  branches: readonly BranchInfo[];
  /** 当前分支（分离 HEAD 时 null），基础分支。 */
  current: string | null;
  base: string | null;
}

/** 分支 → 用着它的框（经过 worktree 目录对上工作区）。 */
export function framesByBranch(worktrees: readonly WorktreeInfo[], workspaces: readonly Workspace[]): Map<string, Workspace | null> {
  const map = new Map<string, Workspace | null>();
  for (const wt of worktrees) {
    if (!wt.branch) continue;
    const ws = workspaces.find((w) => w.path === wt.path || w.repos.some((r) => r.path === wt.path)) ?? null;
    if (!map.get(wt.branch)) map.set(wt.branch, ws);
  }
  return map;
}

/**
 * 收起成一行的分支：已经合并进基础分支、不在白板上（没有框在用）、不是当前分支、也不是基础分支本身。
 * 名字按字母排。
 */
export function collapsedBranches(ctx: GraphContext): string[] {
  const frames = framesByBranch(ctx.worktrees, ctx.workspaces);
  return ctx.branches
    .filter((b) => b.merged === true && !b.remote && !frames.get(b.name) && b.name !== ctx.current && b.name !== ctx.base)
    .map((b) => b.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 每一行显示的标签：本地分支（当前的排最前），本地没有同名分支的远端分支，标签。
 * hidden 里的分支（收起的）不显示。refs 都没有时（旧实现、假实现）给 HEAD 那条补上当前分支。
 */
export function labelsFor(
  commit: CommitInfo,
  ctx: GraphContext & { head: string | null; hidden: ReadonlySet<string>; anyRefs: boolean },
): GraphLabel[] {
  const frames = framesByBranch(ctx.worktrees, ctx.workspaces);
  const refs: CommitRef[] =
    commit.refs ?? (!ctx.anyRefs && ctx.current && commit.hash === ctx.head ? [{ name: ctx.current, kind: 'branch', current: true }] : []);
  const locals = new Set(refs.filter((r) => r.kind === 'branch').map((r) => r.name));
  const out: GraphLabel[] = [];
  for (const r of refs) {
    if (r.kind === 'branch' && ctx.hidden.has(r.name)) continue;
    if (r.kind === 'remote' && locals.has(r.name.slice(r.name.indexOf('/') + 1))) continue;
    if (r.kind === 'head') {
      out.push({ name: 'HEAD', kind: 'head', current: true, frame: null, offBoard: false });
      continue;
    }
    const frame = r.kind === 'branch' ? (frames.get(r.name) ?? null) : null;
    const checkedOut = r.kind === 'branch' && frames.has(r.name);
    out.push({ name: r.name, kind: r.kind, current: r.current === true, frame, offBoard: checkedOut && !frame });
  }
  const rank = (l: GraphLabel) => (l.current ? 0 : l.kind === 'branch' ? (l.frame ? 1 : 2) : l.kind === 'remote' ? 3 : 4);
  return out.sort((a, b) => rank(a) - rank(b));
}

/** 墨黑的泳道从哪些提交开出来：HEAD 和基础分支（本地或 origin/ 上的）顶端。 */
export function strongTips(commits: readonly CommitInfo[], head: string | null, base: string | null): Set<string> {
  const set = new Set<string>();
  if (head) set.add(head);
  if (base)
    for (const c of commits)
      if (c.refs?.some((r) => (r.kind === 'branch' && r.name === base) || (r.kind === 'remote' && r.name === `origin/${base}`))) set.add(c.hash);
  return set;
}

// ---- 画线 ----

/** 泳道间距和行高（px）。行高和 --row 一致。 */
export const LANE_W = 12;
export const ROW_H = 24;

export const laneX = (lane: number): number => LANE_W / 2 + lane * LANE_W + 2;

/** 一段线的 SVG path：直线，或者两端竖直的 S 形弧线。 */
export function linePath(line: GraphLine, half: 'top' | 'bottom'): string {
  const y1 = half === 'top' ? 0 : ROW_H / 2;
  const y2 = half === 'top' ? ROW_H / 2 : ROW_H;
  const x1 = laneX(line.from);
  const x2 = laneX(line.to);
  if (x1 === x2) return `M${x1} ${y1}L${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}`;
}
